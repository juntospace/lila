// Account-wide recompute: pair every unpaired DA in the account, then
// reconcile each PR/DA's state against link presence + file-clock cutoff.
//
// Used by the ingest pipeline at the end of every upload, by the standalone
// "Recompute" admin action, and by deleteUpload after wiping a file.
//
// Implementation note — why we DON'T rely on PostgREST embedded relations:
//
// Earlier versions of this code used `recon_links!fk(...)` embeds to check
// "is this PR/DA already paired". That looked elegant but had two problems:
//
//   1. PostgREST returns embedded relations as a single OBJECT (not array)
//      for 1-to-1 joins — both recon_links FKs are 1-to-1 here (pr_txn_id
//      PK, da_txn_id UNIQUE). Reading .length on an object is undefined,
//      which silently treats every paired row as unpaired (PR #7 was a fix
//      for that exact case).
//
//   2. Even after handling object-vs-array, the embed reflects only the
//      committed state at query time. Across many sequential HTTP requests
//      in a tight loop (one per DA), there are corner cases — connection
//      pooling, transaction visibility — where the just-inserted link
//      isn't visible yet, and the next iteration tries to pair against an
//      already-paired PR.
//
// We pre-fetch all recon_links for the account into in-memory Sets at the
// start of recompute and use those Sets as the sole source of truth for
// pairing eligibility. After each successful link insert we mutate the
// Sets so subsequent iterations see the new link immediately, with no
// dependency on embed shape or read-after-write timing.

import type { SupabaseClient } from "@supabase/supabase-js";

import { fileClockCutoff, pickFifoMatchPR, type PRCandidate } from "./classify";
import { parseDvtoDescription } from "./parser";

const SUPABASE_PAGE_LIMIT = 1000;
const SUPABASE_PAGE_SAFETY_CAP = 200_000;
const ID_CHUNK = 200;

export interface RecomputeStats {
  reversalsPaired: number;
  reversalsUnpaired: number;
  prsConfirmed: number;
  prsRejected: number;
  prsPending: number;
  daRejected: number;
  daPendingPair: number;
  /** DAs whose description was re-parsed and now has a return_code/payer name. */
  dasReparsed: number;
}

export async function recomputeAccount(
  supabase: SupabaseClient,
  accountId: string,
  uploadedBy?: string | null,
): Promise<RecomputeStats> {
  // 0. Self-healing reparse: re-run parseDvtoDescription against any DA
  //    with a null return_code. The parser regex has been broadened over
  //    time (RCZO support, looser separator), so previously unparseable
  //    descriptions might extract cleanly now.
  const dasReparsed = await reparseUnparsedDAs(supabase, accountId);

  // 1. Pre-fetch every existing recon_links row for this account into
  //    in-memory Sets. These are mutated as we pair more DAs and used by
  //    the candidates filter, the unpaired-DA discovery, and the final
  //    state recompute — single source of truth.
  const { linkedPrIds, linkedDaIds } = await fetchLinkedTxnIds(supabase, accountId);

  // 2. Pair every unpaired DA. tryPairDA mutates the Sets on success so
  //    the next iteration's eligibility check sees the new link.
  const unpairedDAs = await fetchUnpairedDAs(supabase, accountId, linkedDaIds);
  let reversalsPaired = 0;
  let reversalsUnpaired = 0;
  for (const da of unpairedDAs) {
    const outcome = await tryPairDA(
      supabase,
      accountId,
      da,
      uploadedBy ?? null,
      linkedPrIds,
      linkedDaIds,
    );
    if (outcome === "paired") reversalsPaired++;
    else reversalsUnpaired++;
  }

  // 3. File-clock cutoff = max posted_at across the account.
  const { data: maxRow } = await supabase
    .from("recon_transactions")
    .select("posted_at")
    .eq("account_id", accountId)
    .order("posted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cutoff = maxRow?.posted_at ? fileClockCutoff(maxRow.posted_at as string) : null;

  // 4. Recompute PR + DA states from the Sets.
  const prStats = await recomputePRStates(supabase, accountId, cutoff, linkedPrIds);
  const daStats = await recomputeDAStates(supabase, accountId, linkedDaIds);

  return {
    reversalsPaired,
    reversalsUnpaired,
    prsConfirmed: prStats.confirmed,
    prsRejected: prStats.rejected,
    prsPending: prStats.pending,
    daRejected: daStats.rejected,
    daPendingPair: daStats.pendingPair,
    dasReparsed,
  };
}

// =============================================================
// Internals
// =============================================================

interface DAForPairing {
  id: string;
  posted_at: string;
  debit_minor: string;
  payer_name_raw: string | null;
}

async function reparseUnparsedDAs(
  supabase: SupabaseClient,
  accountId: string,
): Promise<number> {
  let updated = 0;
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id, description, payer_name_raw")
      .eq("account_id", accountId)
      .eq("code", "DA")
      .is("return_code", null)
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const parsed = parseDvtoDescription((row.description as string | null) ?? "");
      if (!parsed.returnCode) continue;
      const { error: upErr } = await supabase
        .from("recon_transactions")
        .update({
          return_code: parsed.returnCode,
          payer_name_raw:
            (row.payer_name_raw as string | null) ?? parsed.payerNameRaw ?? null,
        })
        .eq("id", row.id);
      if (upErr) throw upErr;
      updated++;
    }
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }
  return updated;
}

/**
 * Walk every recon_links row whose PR or DA lives in this account and build
 * Sets of their ids. We can't filter recon_links by account_id directly
 * (no such column), so we first list the account's txn ids and then chunk
 * a join via .in() against pr_txn_id and da_txn_id.
 */
async function fetchLinkedTxnIds(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ linkedPrIds: Set<string>; linkedDaIds: Set<string> }> {
  const linkedPrIds = new Set<string>();
  const linkedDaIds = new Set<string>();

  const txnIds: string[] = [];
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id")
      .eq("account_id", accountId)
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) txnIds.push(r.id as string);
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }

  // Two passes (pr_txn_id and da_txn_id) so we catch links where this
  // account owns the PR side, the DA side, or both. Cross-account links
  // shouldn't normally exist, but the explicit pass is defensive.
  for (const side of ["pr_txn_id", "da_txn_id"] as const) {
    for (let i = 0; i < txnIds.length; i += ID_CHUNK) {
      const chunk = txnIds.slice(i, i + ID_CHUNK);
      const { data, error } = await supabase
        .from("recon_links")
        .select("pr_txn_id, da_txn_id")
        .in(side, chunk);
      if (error) throw error;
      for (const l of data ?? []) {
        linkedPrIds.add(l.pr_txn_id as string);
        linkedDaIds.add(l.da_txn_id as string);
      }
    }
  }

  return { linkedPrIds, linkedDaIds };
}

async function fetchUnpairedDAs(
  supabase: SupabaseClient,
  accountId: string,
  linkedDaIds: Set<string>,
): Promise<DAForPairing[]> {
  const all: DAForPairing[] = [];
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id, posted_at, debit_minor, payer_name_raw")
      .eq("account_id", accountId)
      .eq("code", "DA")
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (!linkedDaIds.has(row.id as string)) {
        all.push({
          id: row.id as string,
          posted_at: row.posted_at as string,
          debit_minor: String(row.debit_minor),
          payer_name_raw: row.payer_name_raw as string | null,
        });
      }
    }
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }
  return all;
}

async function tryPairDA(
  supabase: SupabaseClient,
  accountId: string,
  da: DAForPairing,
  uploadedBy: string | null,
  linkedPrIds: Set<string>,
  linkedDaIds: Set<string>,
): Promise<"paired" | "unpaired"> {
  if (!da.payer_name_raw) return "unpaired";
  const daAmount = BigInt(da.debit_minor);

  // Candidates: every PR in this account with the same credit amount.
  // We add a deterministic secondary sort on id so repeated runs over the
  // same data make the same pairings (matters when many same-day same-name
  // PRs share an amount, e.g. Karla 10/10/10).
  const { data: candidates, error } = await supabase
    .from("recon_transactions")
    .select("id, posted_at, credit_minor, description")
    .eq("account_id", accountId)
    .eq("code", "PR")
    .eq("credit_minor", daAmount.toString())
    .order("posted_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;

  // Eligible = not already paired in our in-memory Set. The Set is mutated
  // synchronously after every successful link insert, so the next DA
  // iteration sees the latest pairing without depending on PostgREST
  // embed shape or read-after-write visibility.
  const eligible: PRCandidate[] = (candidates ?? [])
    .filter((c) => !linkedPrIds.has(c.id as string))
    .map((c, idx) => ({
      id: c.id as string,
      postedAt: c.posted_at as string,
      rowIndex: idx,
      creditMinor: BigInt(String(c.credit_minor)),
      description: c.description as string,
    }));

  const match = pickFifoMatchPR(
    {
      amountMinor: daAmount,
      payerNameRaw: da.payer_name_raw,
      postedAt: da.posted_at,
    },
    eligible,
  );
  if (!match) return "unpaired";

  const { error: linkErr } = await supabase.from("recon_links").insert({
    pr_txn_id: match.id,
    da_txn_id: da.id,
    match_strategy: "auto_fifo_name_amount",
    matched_by: uploadedBy,
  });
  if (linkErr) {
    // 23505 = unique violation. The DB is the ultimate source of truth, so
    // if we lost a race (or our Set was stale), back out cleanly.
    if (linkErr.code === "23505") return "unpaired";
    throw linkErr;
  }

  linkedPrIds.add(match.id);
  linkedDaIds.add(da.id);
  return "paired";
}

async function recomputePRStates(
  supabase: SupabaseClient,
  accountId: string,
  cutoff: string | null,
  linkedPrIds: Set<string>,
): Promise<{ confirmed: number; rejected: number; pending: number }> {
  const buckets = {
    confirmed: [] as string[],
    rejected: [] as string[],
    pending: [] as string[],
  };
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id, confirmable_after")
      .eq("account_id", accountId)
      .eq("code", "PR")
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const pr of data) {
      const id = pr.id as string;
      if (linkedPrIds.has(id)) {
        buckets.rejected.push(id);
      } else if (
        cutoff &&
        pr.confirmable_after &&
        (pr.confirmable_after as string) <= cutoff
      ) {
        buckets.confirmed.push(id);
      } else {
        buckets.pending.push(id);
      }
    }
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }
  await applyStateUpdates(supabase, "rejected", buckets.rejected);
  await applyStateUpdates(supabase, "confirmed", buckets.confirmed);
  await applyStateUpdates(supabase, "pending", buckets.pending);
  return {
    confirmed: buckets.confirmed.length,
    rejected: buckets.rejected.length,
    pending: buckets.pending.length,
  };
}

async function recomputeDAStates(
  supabase: SupabaseClient,
  accountId: string,
  linkedDaIds: Set<string>,
): Promise<{ rejected: number; pendingPair: number }> {
  const buckets = { rejected: [] as string[], pending_pair: [] as string[] };
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id")
      .eq("account_id", accountId)
      .eq("code", "DA")
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const da of data) {
      const id = da.id as string;
      if (linkedDaIds.has(id)) buckets.rejected.push(id);
      else buckets.pending_pair.push(id);
    }
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }
  await applyStateUpdates(supabase, "rejected", buckets.rejected);
  await applyStateUpdates(supabase, "pending_pair", buckets.pending_pair);
  return { rejected: buckets.rejected.length, pendingPair: buckets.pending_pair.length };
}

async function applyStateUpdates(
  supabase: SupabaseClient,
  state: string,
  ids: string[],
): Promise<void> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { error } = await supabase
      .from("recon_transactions")
      .update({ state })
      .in("id", chunk);
    if (error) throw error;
  }
}
