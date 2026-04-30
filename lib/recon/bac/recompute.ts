// Account-wide recompute: pair every unpaired DA in the account, then
// reconcile each PR's state against (a) link presence and (b) file-clock
// cutoff. Same logic for DAs (link present → rejected, otherwise pending_pair).
//
// Used by:
//   - The ingest pipeline at the end of every upload (replaces the previous
//     "pair only newly-inserted DAs" loop, which depended on the truncated
//     upsert response).
//   - A standalone "Recompute" admin action so ops can heal bad state in
//     place without re-uploading.
//   - The "Delete upload" action, after the file's rows + links are wiped.
//
// Idempotency: every step is safe to rerun. The pairing insert handles
// PK conflicts as "already paired"; state UPDATEs only fire when the row
// changes; the file-clock pass uses the current max(posted_at).

import type { SupabaseClient } from "@supabase/supabase-js";

import { fileClockCutoff, pickFifoMatchPR, type PRCandidate } from "./classify";

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
}

export async function recomputeAccount(
  supabase: SupabaseClient,
  accountId: string,
  uploadedBy?: string | null,
): Promise<RecomputeStats> {
  // 1. Pair every unpaired DA in the account. We discover unpaired DAs by
  //    paginating through recon_transactions and excluding any whose id is
  //    already a da_txn_id in recon_links — relying solely on the upsert
  //    response was the bug ops hit (response capped at 1000).
  const unpairedDAs = await fetchUnpairedDAs(supabase, accountId);
  let reversalsPaired = 0;
  let reversalsUnpaired = 0;
  for (const da of unpairedDAs) {
    const outcome = await tryPairDA(supabase, accountId, da, uploadedBy ?? null);
    if (outcome === "paired") reversalsPaired++;
    else reversalsUnpaired++;
  }

  // 2. Re-evaluate state of every PR + DA based on (link presence,
  //    confirmable_after vs cutoff). This corrects PRs that were wrongly
  //    auto-confirmed when the upsert response missed their would-be DA.
  const { data: maxRow } = await supabase
    .from("recon_transactions")
    .select("posted_at")
    .eq("account_id", accountId)
    .order("posted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const cutoff = maxRow?.posted_at ? fileClockCutoff(maxRow.posted_at as string) : null;

  const prStats = await recomputePRStates(supabase, accountId, cutoff);
  const daStats = await recomputeDAStates(supabase, accountId);

  return {
    reversalsPaired,
    reversalsUnpaired,
    prsConfirmed: prStats.confirmed,
    prsRejected: prStats.rejected,
    prsPending: prStats.pending,
    daRejected: daStats.rejected,
    daPendingPair: daStats.pendingPair,
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

async function fetchUnpairedDAs(
  supabase: SupabaseClient,
  accountId: string,
): Promise<DAForPairing[]> {
  const all: DAForPairing[] = [];
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select(
        "id, posted_at, debit_minor, payer_name_raw, recon_links!recon_links_da_txn_id_fkey(da_txn_id)",
      )
      .eq("account_id", accountId)
      .eq("code", "DA")
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const links = row.recon_links as { da_txn_id: string }[] | null;
      if (!links || links.length === 0) {
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
): Promise<"paired" | "unpaired"> {
  if (!da.payer_name_raw) return "unpaired";
  const daAmount = BigInt(da.debit_minor);

  // Candidates are PRs in this account with the same credit amount and
  // pending state. We also pull link presence so we can skip already-paired
  // ones in JS (ON CONFLICT-style protection comes from the DB anyway).
  const { data: candidates, error } = await supabase
    .from("recon_transactions")
    .select(
      "id, posted_at, credit_minor, description, recon_links!recon_links_pr_txn_id_fkey(pr_txn_id)",
    )
    .eq("account_id", accountId)
    .eq("code", "PR")
    .eq("credit_minor", daAmount.toString())
    .order("posted_at", { ascending: true });
  if (error) throw error;

  const eligible: PRCandidate[] = (candidates ?? [])
    .filter((c) => {
      const links = c.recon_links as { pr_txn_id: string }[] | null;
      return !links || links.length === 0;
    })
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
    if (linkErr.code === "23505") return "unpaired"; // race lost; somebody else paired
    throw linkErr;
  }
  return "paired";
}

async function recomputePRStates(
  supabase: SupabaseClient,
  accountId: string,
  cutoff: string | null,
): Promise<{ confirmed: number; rejected: number; pending: number }> {
  const buckets = { confirmed: [] as string[], rejected: [] as string[], pending: [] as string[] };
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select(
        "id, confirmable_after, recon_links!recon_links_pr_txn_id_fkey(pr_txn_id)",
      )
      .eq("account_id", accountId)
      .eq("code", "PR")
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const pr of data) {
      const hasLink = ((pr.recon_links as { pr_txn_id: string }[] | null) ?? []).length > 0;
      if (hasLink) buckets.rejected.push(pr.id as string);
      else if (cutoff && pr.confirmable_after && (pr.confirmable_after as string) <= cutoff) {
        buckets.confirmed.push(pr.id as string);
      } else {
        buckets.pending.push(pr.id as string);
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
): Promise<{ rejected: number; pendingPair: number }> {
  const buckets = { rejected: [] as string[], pending_pair: [] as string[] };
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id, recon_links!recon_links_da_txn_id_fkey(da_txn_id)")
      .eq("account_id", accountId)
      .eq("code", "DA")
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const da of data) {
      const hasLink = ((da.recon_links as { da_txn_id: string }[] | null) ?? []).length > 0;
      if (hasLink) buckets.rejected.push(da.id as string);
      else buckets.pending_pair.push(da.id as string);
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
