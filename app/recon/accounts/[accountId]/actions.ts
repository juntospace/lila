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
