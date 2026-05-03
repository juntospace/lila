"use server";

import { revalidatePath } from "next/cache";

import { requireReconWriter } from "@/lib/auth/guard";
import {
  extractPRPayerName,
  normalizeName,
  parseDvtoDescription,
} from "@/lib/recon/bac";
import { recomputeAccount, type RecomputeStats } from "@/lib/recon/bac/recompute";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type BackfillResult = {
  status: "ok" | "error";
  scanned: number;
  updated: number;
  message?: string;
};

/**
 * One-shot fix for DA rows whose `return_code` is null because the original
 * parser regex was stricter than real BAC descriptions. Re-runs the (now
 * permissive) parseDvtoDescription against each candidate and writes back
 * any extracted code + payer name. Idempotent: rerun is a no-op once
 * everything is filled in.
 */
export async function backfillDvtoCodes(
  accountId: string,
): Promise<BackfillResult> {
  await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  const { data: candidates, error } = await supabase
    .from("recon_transactions")
    .select("id, description, return_code, payer_name_raw")
    .eq("account_id", accountId)
    .eq("code", "DA")
    .is("return_code", null);

  if (error) return { status: "error", scanned: 0, updated: 0, message: error.message };

  let updated = 0;
  for (const row of candidates ?? []) {
    const desc = (row.description as string | null) ?? "";
    const parsed = parseDvtoDescription(desc);
    if (!parsed.returnCode) continue;
    const { error: upErr } = await supabase
      .from("recon_transactions")
      .update({
        return_code: parsed.returnCode,
        payer_name_raw: row.payer_name_raw ?? parsed.payerNameRaw ?? null,
      })
      .eq("id", row.id);
    if (!upErr) updated++;
  }

  revalidatePath(`/recon/accounts/${accountId}`);
  return { status: "ok", scanned: candidates?.length ?? 0, updated };
}

// =============================================================
// recomputeAccountAction
// =============================================================

export type RecomputeActionResult = {
  status: "ok" | "error";
  message?: string;
  stats?: RecomputeStats;
};

/**
 * Pair every unpaired DA in the account and re-evaluate PR/DA states
 * against link presence + file-clock cutoff. Idempotent. Use to heal bad
 * state from earlier ingests that hit the upsert-response 1000-row cap.
 */
export async function recomputeAccountAction(
  accountId: string,
): Promise<RecomputeActionResult> {
  const session = await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  try {
    const stats = await recomputeAccount(supabase, accountId, session.userId);
    revalidatePath(`/recon/accounts/${accountId}`);
    return { status: "ok", stats };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// =============================================================
// manuallyPairDA
// =============================================================

export type ManualPairResult = {
  status: "ok" | "error";
  message?: string;
};

/**
 * Operator-confirmed pairing of one DA to one PR. Used from the
 * unmatched-reversals card when the auto-pairing logic couldn't find
 * the right PR (truncated names, BAC posting fuzziness beyond ±1 day,
 * client-name drift, etc).
 *
 * Side effects in DB, in order:
 *   1. INSERT recon_links (match_strategy='manual'). PK on pr_txn_id +
 *      UNIQUE on da_txn_id mean the DB rejects if either side already
 *      has a link — friendly error in that case.
 *   2. INSERT recon_manual_actions audit row keyed on the PR.
 *   3. UPSERT name_aliases for (account, PR-normalized, DA-normalized)
 *      so the same client pairs automatically next time.
 *   4. UPDATE both rows to state='rejected'.
 *
 * Steps 2–4 don't block the operator on partial DB failures — the
 * recon_links row is the source of truth, and the next Recompute click
 * heals any drift via the existing state-recompute pass. We log
 * non-critical failures via the response message.
 */
export async function manuallyPairDA(args: {
  accountId: string;
  daTxnId: string;
  prTxnId: string;
}): Promise<ManualPairResult> {
  const session = await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  // Sanity-check both rows belong to this account and are still
  // unlinked. Defends against stale UI state.
  const { data: rows, error: lookupErr } = await supabase
    .from("recon_transactions")
    .select("id, account_id, code, description, payer_name_raw")
    .in("id", [args.daTxnId, args.prTxnId]);
  if (lookupErr) return { status: "error", message: lookupErr.message };
  if (!rows || rows.length !== 2) {
    return { status: "error", message: "DA or PR row not found." };
  }
  const da = rows.find((r) => r.id === args.daTxnId);
  const pr = rows.find((r) => r.id === args.prTxnId);
  if (!da || !pr) return { status: "error", message: "DA or PR row not found." };
  if (da.account_id !== args.accountId || pr.account_id !== args.accountId) {
    return { status: "error", message: "DA or PR is not on this account." };
  }
  if (da.code !== "DA") return { status: "error", message: "Selected DA row is not a reversal." };
  if (pr.code !== "PR") return { status: "error", message: "Selected PR row is not a credit." };

  // Step 1: insert the link (DB enforces 1-link-per-side via PK + UNIQUE).
  const { error: linkErr } = await supabase.from("recon_links").insert({
    pr_txn_id: args.prTxnId,
    da_txn_id: args.daTxnId,
    match_strategy: "manual",
    matched_by: session.userId,
  });
  if (linkErr) {
    if (linkErr.code === "23505") {
      return {
        status: "error",
        message:
          "One of these rows is already paired. Refresh and try again with a different DA or PR.",
      };
    }
    return { status: "error", message: linkErr.message };
  }

  // Step 2: audit row. Non-blocking — failure here doesn't roll back the
  // pairing, just gets logged in the response.
  const { error: auditErr } = await supabase.from("recon_manual_actions").insert({
    txn_id: args.prTxnId,
    action: "reclassify",
    prior_state: "pending",
    new_state: "rejected",
    justification: `Manual pair: DA ${args.daTxnId} → PR ${args.prTxnId}`,
    acted_by: session.userId,
  });

  // Step 3: alias write so future ingests pair the same client
  // automatically. Only if both sides have a parseable payer name.
  const prName = extractPRPayerName(pr.description as string);
  const prNormalized = prName ? normalizeName(prName) : null;
  const daNormalized = da.payer_name_raw
    ? normalizeName(da.payer_name_raw as string)
    : null;
  let aliasErrMessage: string | null = null;
  if (prNormalized && daNormalized) {
    const { error: aliasErr } = await supabase.from("name_aliases").insert({
      account_id: args.accountId,
      rail: "bac",
      pr_name_normalized: prNormalized,
      da_name_normalized: daNormalized,
      created_by: session.userId,
    });
    if (aliasErr && aliasErr.code !== "23505") {
      aliasErrMessage = aliasErr.message;
    }
  }

  // Step 4: state to 'rejected' on both rows.
  const { error: stateErr } = await supabase
    .from("recon_transactions")
    .update({ state: "rejected" })
    .in("id", [args.daTxnId, args.prTxnId]);

  revalidatePath(`/recon/accounts/${args.accountId}`);

  const warnings: string[] = [];
  if (auditErr) warnings.push(`Audit row failed: ${auditErr.message}`);
  if (aliasErrMessage) warnings.push(`Alias write failed: ${aliasErrMessage}`);
  if (stateErr) warnings.push(`State update failed: ${stateErr.message}`);

  if (warnings.length > 0) {
    return {
      status: "ok",
      message: `Paired (with warnings: ${warnings.join("; ")})`,
    };
  }
  return { status: "ok" };
}

// =============================================================
// confirmPendingPR
// =============================================================

export type ConfirmPendingResult = {
  status: "ok" | "error";
  message?: string;
};

const MIN_JUSTIFICATION = 10;
const MAX_JUSTIFICATION = 1000;

/**
 * Operator-curated confirmation of a PR that's still in `pending` (its
 * 24h ACH window hasn't closed yet, but the operator has independent
 * evidence the payment cleared). Writes the audit row first so the
 * justification is captured even if the state update later fails; the
 * Recompute pass would then heal the state on the next click.
 */
export async function confirmPendingPR(args: {
  accountId: string;
  prTxnId: string;
  justification: string;
}): Promise<ConfirmPendingResult> {
  const session = await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  const justification = args.justification.trim();
  if (justification.length < MIN_JUSTIFICATION) {
    return {
      status: "error",
      message: `Justification must be at least ${MIN_JUSTIFICATION} characters.`,
    };
  }
  if (justification.length > MAX_JUSTIFICATION) {
    return {
      status: "error",
      message: `Justification is too long (max ${MAX_JUSTIFICATION}).`,
    };
  }

  // Sanity-check the row before mutating: must be a pending PR on this
  // account. Defends against stale UI state and cross-account spoofing
  // (RLS would also block, but explicit checks give clearer errors).
  const { data: pr, error: lookupErr } = await supabase
    .from("recon_transactions")
    .select("id, account_id, code, state")
    .eq("id", args.prTxnId)
    .maybeSingle();
  if (lookupErr) return { status: "error", message: lookupErr.message };
  if (!pr) return { status: "error", message: "Row not found." };
  if (pr.account_id !== args.accountId) {
    return { status: "error", message: "Row is not on this account." };
  }
  if (pr.code !== "PR") {
    return {
      status: "error",
      message: "Only PR rows can be manually confirmed.",
    };
  }
  if (pr.state !== "pending") {
    return {
      status: "error",
      message: `Row is no longer pending (current state: ${pr.state}). Refresh and try again.`,
    };
  }

  const { error: auditErr } = await supabase
    .from("recon_manual_actions")
    .insert({
      txn_id: args.prTxnId,
      action: "force_confirm",
      prior_state: "pending",
      new_state: "confirmed",
      justification,
      acted_by: session.userId,
    });
  if (auditErr) return { status: "error", message: auditErr.message };

  const { error: stateErr } = await supabase
    .from("recon_transactions")
    .update({ state: "confirmed" })
    .eq("id", args.prTxnId);
  if (stateErr) {
    return {
      status: "ok",
      message: `Audit row written but state update failed: ${stateErr.message}. Click Recompute to heal.`,
    };
  }

  revalidatePath(`/recon/accounts/${args.accountId}`);
  return { status: "ok" };
}

// =============================================================
// revertConfirmedPR
// =============================================================

export type RevertConfirmedResult = {
  status: "ok" | "error";
  message?: string;
};

/**
 * Symmetric inverse of confirmPendingPR. Operator decides the file-clock
 * (or a previous manual confirmation) was wrong — revert the PR back to
 * `pending` so it stays open for a future DA or a fresh confirmation
 * decision. The audit row is what makes Recompute's manual-override
 * lookup honor this state on subsequent passes (Tier 3 hotfix #22).
 *
 * If the PR currently has a recon_links row (auto-rejected), this
 * action refuses — that's a separate workflow (un-pair) that we'd add
 * if/when the need shows up. Refusing here keeps the operator from
 * silently leaving a "rejected" PR with no link, which would re-flip
 * to rejected on the next Recompute and lose the operator's intent.
 */
export async function revertConfirmedPR(args: {
  accountId: string;
  prTxnId: string;
  justification: string;
}): Promise<RevertConfirmedResult> {
  const session = await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  const justification = args.justification.trim();
  if (justification.length < MIN_JUSTIFICATION) {
    return {
      status: "error",
      message: `Justification must be at least ${MIN_JUSTIFICATION} characters.`,
    };
  }
  if (justification.length > MAX_JUSTIFICATION) {
    return {
      status: "error",
      message: `Justification is too long (max ${MAX_JUSTIFICATION}).`,
    };
  }

  const { data: pr, error: lookupErr } = await supabase
    .from("recon_transactions")
    .select("id, account_id, code, state")
    .eq("id", args.prTxnId)
    .maybeSingle();
  if (lookupErr) return { status: "error", message: lookupErr.message };
  if (!pr) return { status: "error", message: "Row not found." };
  if (pr.account_id !== args.accountId) {
    return { status: "error", message: "Row is not on this account." };
  }
  if (pr.code !== "PR") {
    return { status: "error", message: "Only PR rows can be reverted." };
  }
  if (pr.state !== "confirmed") {
    return {
      status: "error",
      message: `Row is not currently confirmed (state: ${pr.state}). Refresh and try again.`,
    };
  }

  // Refuse to revert a PR that's auto-paired with a DA (a confirmed PR
  // shouldn't normally have a link — the recompute would have classified
  // it as 'rejected' instead. But defending against the edge case keeps
  // us from silently dropping the audit-trail intent.)
  const { count: linkCount } = await supabase
    .from("recon_links")
    .select("pr_txn_id", { count: "exact", head: true })
    .eq("pr_txn_id", args.prTxnId);
  if ((linkCount ?? 0) > 0) {
    return {
      status: "error",
      message:
        "This PR is paired with a DA — reverting would leave it rejected on the next Recompute. Use the unmatched-reversals flow instead.",
    };
  }

  const { error: auditErr } = await supabase
    .from("recon_manual_actions")
    .insert({
      txn_id: args.prTxnId,
      action: "reclassify",
      prior_state: "confirmed",
      new_state: "pending",
      justification,
      acted_by: session.userId,
    });
  if (auditErr) return { status: "error", message: auditErr.message };

  const { error: stateErr } = await supabase
    .from("recon_transactions")
    .update({ state: "pending" })
    .eq("id", args.prTxnId);
  if (stateErr) {
    return {
      status: "ok",
      message: `Audit row written but state update failed: ${stateErr.message}. Click Recompute to heal.`,
    };
  }

  revalidatePath(`/recon/accounts/${args.accountId}`);
  return { status: "ok" };
}

// =============================================================
// revertRejectedPR
// =============================================================

export type RevertRejectedResult = {
  status: "ok" | "error";
  message?: string;
  /** The DA id that was un-linked (freed for re-pairing). */
  freedDaId?: string | null;
};

/**
 * Operator decides a `rejected` PR's pairing was wrong (auto-FIFO picked
 * the wrong PR, or a manual match was misclicked). Reverts the PR to
 * `pending` AND un-links the DA so it can pair with the actually-correct
 * PR.
 *
 * Side effects in DB, in order:
 *   1. Validate row state (must be a rejected PR on this account).
 *   2. Look up the linked DA via recon_links.
 *   3. INSERT recon_manual_actions(action='reclassify',
 *      prior='rejected', new='pending', justification, acted_by).
 *      The manual-override lookup in recomputePRStates honors this so
 *      the revert sticks across Recompute clicks.
 *   4. DELETE recon_links where pr_txn_id = this PR. The DA is now
 *      eligible to pair again (auto on next ingest, or manually via
 *      the unmatched-reversals card).
 *   5. UPDATE the PR state='pending'.
 *   6. UPDATE the freed DA state='pending_pair' so it shows back up
 *      in the unmatched-reversals card immediately.
 */
export async function revertRejectedPR(args: {
  accountId: string;
  prTxnId: string;
  justification: string;
}): Promise<RevertRejectedResult> {
  const session = await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  const justification = args.justification.trim();
  if (justification.length < MIN_JUSTIFICATION) {
    return {
      status: "error",
      message: `Justification must be at least ${MIN_JUSTIFICATION} characters.`,
    };
  }
  if (justification.length > MAX_JUSTIFICATION) {
    return {
      status: "error",
      message: `Justification is too long (max ${MAX_JUSTIFICATION}).`,
    };
  }

  const { data: pr, error: lookupErr } = await supabase
    .from("recon_transactions")
    .select("id, account_id, code, state")
    .eq("id", args.prTxnId)
    .maybeSingle();
  if (lookupErr) return { status: "error", message: lookupErr.message };
  if (!pr) return { status: "error", message: "Row not found." };
  if (pr.account_id !== args.accountId) {
    return { status: "error", message: "Row is not on this account." };
  }
  if (pr.code !== "PR") {
    return { status: "error", message: "Only PR rows can be reverted." };
  }
  if (pr.state !== "rejected") {
    return {
      status: "error",
      message: `Row is not currently rejected (state: ${pr.state}). Refresh and try again.`,
    };
  }

  const { data: link } = await supabase
    .from("recon_links")
    .select("pr_txn_id, da_txn_id")
    .eq("pr_txn_id", args.prTxnId)
    .maybeSingle();
  const freedDaId = (link?.da_txn_id as string | null) ?? null;

  const { error: auditErr } = await supabase
    .from("recon_manual_actions")
    .insert({
      txn_id: args.prTxnId,
      action: "reclassify",
      prior_state: "rejected",
      new_state: "pending",
      justification: freedDaId
        ? `${justification}\n\n[system] freed DA ${freedDaId}`
        : justification,
      acted_by: session.userId,
    });
  if (auditErr) return { status: "error", message: auditErr.message };

  if (freedDaId) {
    const { error: linkErr } = await supabase
      .from("recon_links")
      .delete()
      .eq("pr_txn_id", args.prTxnId);
    if (linkErr) {
      return {
        status: "ok",
        message: `Audit row written but link delete failed: ${linkErr.message}. Click Recompute to heal.`,
        freedDaId,
      };
    }
  }

  const { error: prStateErr } = await supabase
    .from("recon_transactions")
    .update({ state: "pending" })
    .eq("id", args.prTxnId);
  if (prStateErr) {
    return {
      status: "ok",
      message: `PR state update failed: ${prStateErr.message}. Click Recompute to heal.`,
      freedDaId,
    };
  }

  if (freedDaId) {
    const { error: daStateErr } = await supabase
      .from("recon_transactions")
      .update({ state: "pending_pair" })
      .eq("id", freedDaId);
    if (daStateErr) {
      return {
        status: "ok",
        message: `DA state update failed: ${daStateErr.message}. Click Recompute to heal.`,
        freedDaId,
      };
    }
  }

  revalidatePath(`/recon/accounts/${args.accountId}`);
  return { status: "ok", freedDaId };
}

// =============================================================
// manuallyRejectPR
// =============================================================

export type ManuallyRejectResult = {
  status: "ok" | "error";
  message?: string;
};

/**
 * Operator marks a pending PR as rejected by picking an unpaired DA.
 * Mirror of the unmatched-reversals "Match to PR" flow but driven from
 * the PR side: the operator is sitting on a pending PR they know was
 * rejected, and chooses which DA in the account corresponds to it.
 *
 * Side effects (same audit-first pattern as the other manual actions):
 *   1. Validate PR (pending, on this account) and DA (pending_pair,
 *      on this account, unlinked).
 *   2. INSERT recon_links (match_strategy='manual').
 *   3. INSERT recon_manual_actions for the PR (reclassify
 *      pending → rejected, justification + freed/linked DA id).
 *   4. INSERT name_aliases for the (PR-name, DA-name) pair so future
 *      ingests pair the same client automatically.
 *   5. UPDATE both rows to state='rejected'.
 */
export async function manuallyRejectPR(args: {
  accountId: string;
  prTxnId: string;
  daTxnId: string;
  justification: string;
}): Promise<ManuallyRejectResult> {
  const session = await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  const justification = args.justification.trim();
  if (justification.length < MIN_JUSTIFICATION) {
    return {
      status: "error",
      message: `Justification must be at least ${MIN_JUSTIFICATION} characters.`,
    };
  }
  if (justification.length > MAX_JUSTIFICATION) {
    return {
      status: "error",
      message: `Justification is too long (max ${MAX_JUSTIFICATION}).`,
    };
  }

  const { data: rows, error: lookupErr } = await supabase
    .from("recon_transactions")
    .select("id, account_id, code, state, description, payer_name_raw")
    .in("id", [args.prTxnId, args.daTxnId]);
  if (lookupErr) return { status: "error", message: lookupErr.message };
  if (!rows || rows.length !== 2) {
    return { status: "error", message: "PR or DA row not found." };
  }
  const pr = rows.find((r) => r.id === args.prTxnId);
  const da = rows.find((r) => r.id === args.daTxnId);
  if (!pr || !da) return { status: "error", message: "PR or DA row not found." };
  if (pr.account_id !== args.accountId || da.account_id !== args.accountId) {
    return { status: "error", message: "PR or DA is not on this account." };
  }
  if (pr.code !== "PR") return { status: "error", message: "Selected PR row is not a credit." };
  if (da.code !== "DA") return { status: "error", message: "Selected DA row is not a reversal." };
  if (pr.state !== "pending") {
    return {
      status: "error",
      message: `PR is no longer pending (state: ${pr.state}). Refresh and try again.`,
    };
  }
  if (da.state !== "pending_pair") {
    return {
      status: "error",
      message: `DA is no longer unmatched (state: ${da.state}). Refresh and try again.`,
    };
  }

  // Step 2: link.
  const { error: linkErr } = await supabase.from("recon_links").insert({
    pr_txn_id: args.prTxnId,
    da_txn_id: args.daTxnId,
    match_strategy: "manual",
    matched_by: session.userId,
  });
  if (linkErr) {
    if (linkErr.code === "23505") {
      return {
        status: "error",
        message:
          "One of these rows is already paired. Refresh and try again with a different DA or PR.",
      };
    }
    return { status: "error", message: linkErr.message };
  }

  // Step 3: audit (PR side — that's the row whose state most operators
  // care about for downstream context).
  const { error: auditErr } = await supabase
    .from("recon_manual_actions")
    .insert({
      txn_id: args.prTxnId,
      action: "reclassify",
      prior_state: "pending",
      new_state: "rejected",
      justification: `${justification}\n\n[system] linked DA ${args.daTxnId}`,
      acted_by: session.userId,
    });

  // Step 4: name alias (best-effort).
  const prName = extractPRPayerName((pr.description as string) ?? "");
  const prNormalized = prName ? normalizeName(prName) : null;
  const daNormalized = da.payer_name_raw
    ? normalizeName(da.payer_name_raw as string)
    : null;
  let aliasErrMessage: string | null = null;
  if (prNormalized && daNormalized) {
    const { error: aliasErr } = await supabase.from("name_aliases").insert({
      account_id: args.accountId,
      rail: "bac",
      pr_name_normalized: prNormalized,
      da_name_normalized: daNormalized,
      created_by: session.userId,
    });
    if (aliasErr && aliasErr.code !== "23505") {
      aliasErrMessage = aliasErr.message;
    }
  }

  // Step 5: states.
  const { error: stateErr } = await supabase
    .from("recon_transactions")
    .update({ state: "rejected" })
    .in("id", [args.prTxnId, args.daTxnId]);

  revalidatePath(`/recon/accounts/${args.accountId}`);

  const warnings: string[] = [];
  if (auditErr) warnings.push(`Audit row failed: ${auditErr.message}`);
  if (aliasErrMessage) warnings.push(`Alias write failed: ${aliasErrMessage}`);
  if (stateErr) warnings.push(`State update failed: ${stateErr.message}`);

  if (warnings.length > 0) {
    return {
      status: "ok",
      message: `Linked (with warnings: ${warnings.join("; ")})`,
    };
  }
  return { status: "ok" };
}
