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

import {
  fileClockCutoff,
  isWithinAchRejectionWindow,
  pickFifoMatchPR,
  type AliasMap,
  type PRCandidate,
} from "./classify";
import { parseDvtoDescription } from "./parser";

const SUPABASE_PAGE_LIMIT = 1000;
const SUPABASE_PAGE_SAFETY_CAP = 200_000;
// 100 keeps `?id=in.(uuid1,...,uuid100)` URLs well under 4 KB. PostgREST
// and the Supabase gateway can silently drop tail entries on longer URLs
// (~8 KB limit), which made revalidateLinks miss bad pairings that lived
// past chunk position 100 — diagnostic showed `revalidated=0` with bad
// pairings still in DB. Same chunk size the export route uses.
const ID_CHUNK = 100;

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
  /** Diagnostic — total recon_transactions for this account. */
  txnCount: number;
  /** Diagnostic — links found in DB at the start of the recompute (PR side). */
  preexistingLinks: number;
  /** Diagnostic — DAs that started without a link (input to the pairing loop). */
  unpairedDaInput: number;
  /** Diagnostic — DAs skipped because parser captured no payer name. */
  unpairedNoPayerName: number;
  /** Diagnostic — DAs where no PR with same amount + name was eligible. */
  unpairedNoMatch: number;
  /** Diagnostic — link inserts that hit a unique violation (race / stale Set). */
  unpairedLinkConflict: number;
  /** Existing auto links deleted because their PR/DA dates were out of the 24h window. */
  linksRevalidated: number;
  /** Diagnostic — auto links where PR.posted_at != DA.posted_at (regardless of validity). */
  crossDayLinks: number;
  /** Diagnostic — links the heal pass skipped because dates lookup was incomplete. */
  linksDateMissing: number;
  /** Diagnostic — operator-curated name aliases loaded for this account. */
  aliasesLoaded: number;
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
  const { linkedPrIds, linkedDaIds, links } = await fetchLinkedTxnIds(
    supabase,
    accountId,
  );
  const preexistingLinks = linkedPrIds.size;

  // 1.5. Load operator-curated aliases for this account. The pairing
  //      pass consults these AFTER the regular prefix match fails, so
  //      this load is a no-op when no aliases exist (which is the case
  //      until Tier 2 PR 3's manual-match action ships and is used).
  const aliases = await fetchAliasMap(supabase, accountId);
  const aliasesLoaded = aliases.size;

  // 1a. Heal: any existing AUTO link that violates the 24h ACH rejection
  //     window is invalid (the DA can't physically be the source of a PR
  //     whose 24h window had already closed). Delete those links and
  //     remove their ids from the in-memory Sets so the unpaired DAs
  //     pass below can re-pair them with the correct PR.
  //
  //     We only touch auto pairings; manual pairings (Tier 2 / future)
  //     reflect explicit operator intent and stay put.
  const healOutcome = await revalidateLinks(
    supabase,
    accountId,
    links,
    linkedPrIds,
    linkedDaIds,
  );
  const linksRevalidated = healOutcome.deleted;
  const crossDayLinks = healOutcome.crossDay;
  const linksDateMissing = healOutcome.dateMissing;

  // 2. Pair every unpaired DA. tryPairDA mutates the Sets on success so
  //    the next iteration's eligibility check sees the new link.
  const unpairedDAs = await fetchUnpairedDAs(supabase, accountId, linkedDaIds);
  const unpairedDaInput = unpairedDAs.length;
  let reversalsPaired = 0;
  let reversalsUnpaired = 0;
  let unpairedNoPayerName = 0;
  let unpairedNoMatch = 0;
  let unpairedLinkConflict = 0;
  for (const da of unpairedDAs) {
    const outcome = await tryPairDA(
      supabase,
      accountId,
      da,
      uploadedBy ?? null,
      linkedPrIds,
      linkedDaIds,
      aliases,
    );
    if (outcome === "paired") reversalsPaired++;
    else {
      reversalsUnpaired++;
      if (outcome === "no_payer_name") unpairedNoPayerName++;
      else if (outcome === "link_conflict") unpairedLinkConflict++;
      else unpairedNoMatch++;
    }
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

  // Total txn count for diagnostics (cheap; we already know it from the
  // earlier fetchAllTxnIds inside fetchLinkedTxnIds, but it's not exposed —
  // do a HEAD-count which is one round-trip).
  const { count: txnCount } = await supabase
    .from("recon_transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);

  return {
    reversalsPaired,
    reversalsUnpaired,
    prsConfirmed: prStats.confirmed,
    prsRejected: prStats.rejected,
    prsPending: prStats.pending,
    daRejected: daStats.rejected,
    daPendingPair: daStats.pendingPair,
    dasReparsed,
    txnCount: txnCount ?? 0,
    preexistingLinks,
    unpairedDaInput,
    unpairedNoPayerName,
    unpairedNoMatch,
    unpairedLinkConflict,
    linksRevalidated,
    crossDayLinks,
    linksDateMissing,
    aliasesLoaded,
  };
}

/**
 * Pre-fetch every operator-confirmed (PR-name, DA-name) alias for this
 * account into a Map<pr_name, Set<da_name>>. The pairing pass uses this
 * to accept matches that the prefix-based namesMatch would have missed
 * — but only after the prefix check fails, so behaviour is unchanged
 * when no aliases exist (which is the case before Tier 2 PR 3 ships
 * the manual-match action).
 */
async function fetchAliasMap(
  supabase: SupabaseClient,
  accountId: string,
): Promise<AliasMap> {
  const map: AliasMap = new Map();
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("name_aliases")
      .select("pr_name_normalized, da_name_normalized")
      .eq("account_id", accountId)
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const pr = row.pr_name_normalized as string;
      const da = row.da_name_normalized as string;
      const set = map.get(pr) ?? new Set<string>();
      set.add(da);
      map.set(pr, set);
    }
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }
  return map;
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

interface LinkRow {
  pr_txn_id: string;
  da_txn_id: string;
  match_strategy: string;
}

/**
 * Walk every recon_links row whose PR or DA lives in this account and build
 * Sets of their ids plus the raw link rows. We can't filter recon_links by
 * account_id directly (no such column), so we first list the account's
 * txn ids and then chunk a join via .in() against pr_txn_id and da_txn_id.
 */
async function fetchLinkedTxnIds(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{
  linkedPrIds: Set<string>;
  linkedDaIds: Set<string>;
  links: LinkRow[];
}> {
  const linkedPrIds = new Set<string>();
  const linkedDaIds = new Set<string>();
  const linksByPrId = new Map<string, LinkRow>();

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
        .select("pr_txn_id, da_txn_id, match_strategy")
        .in(side, chunk);
      if (error) throw error;
      for (const l of data ?? []) {
        const prId = l.pr_txn_id as string;
        linkedPrIds.add(prId);
        linkedDaIds.add(l.da_txn_id as string);
        linksByPrId.set(prId, {
          pr_txn_id: prId,
          da_txn_id: l.da_txn_id as string,
          match_strategy: l.match_strategy as string,
        });
      }
    }
  }

  return { linkedPrIds, linkedDaIds, links: Array.from(linksByPrId.values()) };
}

interface HealOutcome {
  deleted: number;
  crossDay: number;
  dateMissing: number;
}

/**
 * Inspect every existing recon_links row and delete any whose PR/DA date
 * pair violates the 24h ACH rejection window.
 *
 * Returns:
 *   - deleted:     links removed (also mutates the in-memory Sets).
 *   - crossDay:    links where PR.date != DA.date, regardless of window
 *                  validity. Diagnostic; helps us see whether the DB
 *                  actually contains cross-day pairings to evaluate.
 *   - dateMissing: links the heal pass had to skip because the date
 *                  lookup didn't return one of the rows. Diagnostic;
 *                  flags chunked-fetch gaps.
 *
 * Validates ALL links (not just auto) — Tier 2 manual pairings don't
 * exist yet, and an out-of-window pairing is wrong regardless of who
 * placed it. When manual pairings ship, we'll narrow back via match_strategy.
 */
async function revalidateLinks(
  supabase: SupabaseClient,
  accountId: string,
  links: LinkRow[],
  linkedPrIds: Set<string>,
  linkedDaIds: Set<string>,
): Promise<HealOutcome> {
  if (links.length === 0) return { deleted: 0, crossDay: 0, dateMissing: 0 };

  const involvedIds = new Set<string>();
  for (const l of links) {
    involvedIds.add(l.pr_txn_id);
    involvedIds.add(l.da_txn_id);
  }
  const datesById = new Map<string, string>();
  const involved = Array.from(involvedIds);
  for (let i = 0; i < involved.length; i += ID_CHUNK) {
    const chunk = involved.slice(i, i + ID_CHUNK);
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id, posted_at")
      .in("id", chunk);
    if (error) throw error;
    for (const r of data ?? []) {
      datesById.set(r.id as string, r.posted_at as string);
    }
  }

  const invalidPrIds: string[] = [];
  const invalidDaIds: string[] = [];
  let crossDay = 0;
  let dateMissing = 0;
  for (const l of links) {
    const prDate = datesById.get(l.pr_txn_id);
    const daDate = datesById.get(l.da_txn_id);
    if (!prDate || !daDate) {
      dateMissing++;
      continue;
    }
    if (prDate !== daDate) crossDay++;
    if (!isWithinAchRejectionWindow(prDate, daDate)) {
      invalidPrIds.push(l.pr_txn_id);
      invalidDaIds.push(l.da_txn_id);
    }
  }

  if (invalidPrIds.length > 0) {
    for (let i = 0; i < invalidPrIds.length; i += ID_CHUNK) {
      const chunk = invalidPrIds.slice(i, i + ID_CHUNK);
      const { error } = await supabase
        .from("recon_links")
        .delete()
        .in("pr_txn_id", chunk);
      if (error) throw error;
    }
    for (const id of invalidPrIds) linkedPrIds.delete(id);
    for (const id of invalidDaIds) linkedDaIds.delete(id);
  }

  void accountId;
  return { deleted: invalidPrIds.length, crossDay, dateMissing };
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

type PairOutcome = "paired" | "no_payer_name" | "no_match" | "link_conflict";

async function tryPairDA(
  supabase: SupabaseClient,
  accountId: string,
  da: DAForPairing,
  uploadedBy: string | null,
  linkedPrIds: Set<string>,
  linkedDaIds: Set<string>,
  aliases: AliasMap,
): Promise<PairOutcome> {
  if (!da.payer_name_raw) return "no_payer_name";
  const daAmount = BigInt(da.debit_minor);

  // Candidates: every PR in this account with the same credit amount AND
  // whose posted date is within ±1 day of the DA. Symmetric window
  // because BAC's posting cadence sometimes places the DA one day before
  // the PR for the same physical event. Picked at the SQL level so the
  // response stays small even on accounts with thousands of same-amount
  // PRs. Deterministic secondary sort on id.
  const daDate = da.posted_at;
  const windowFloor = prevDayIso(daDate);
  const windowCeiling = nextDayIso(daDate);
  const { data: candidates, error } = await supabase
    .from("recon_transactions")
    .select("id, posted_at, credit_minor, description")
    .eq("account_id", accountId)
    .eq("code", "PR")
    .eq("credit_minor", daAmount.toString())
    .gte("posted_at", windowFloor)
    .lte("posted_at", windowCeiling)
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
    aliases,
  );
  if (!match) return "no_match";

  const { error: linkErr } = await supabase.from("recon_links").insert({
    pr_txn_id: match.id,
    da_txn_id: da.id,
    match_strategy: "auto_fifo_name_amount",
    matched_by: uploadedBy,
  });
  if (linkErr) {
    // 23505 = unique violation. The DB is the ultimate source of truth, so
    // if we lost a race (or our Set was stale), back out cleanly.
    if (linkErr.code === "23505") return "link_conflict";
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

function prevDayIso(iso: string): string {
  return new Date(Date.parse(iso + "T00:00:00Z") - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function nextDayIso(iso: string): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + 86_400_000)
    .toISOString()
    .slice(0, 10);
}
