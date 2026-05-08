// Account-wide recompute: batch-aware pairing for every DA in the
// account, then reconcile each PR/DA's state against link presence,
// auto-confirmations from consumed PR batches, and manual operator
// overrides. (File-clock confirmation was retired in Tier 5 PR 3.)
//
// Used by the ingest pipeline at the end of every upload, by the standalone
// "Recompute" admin action, and by deleteUpload after wiping a file.
//
// Recompute is idempotent: every run wipes the account's existing AUTO
// links and re-runs the linker over all PRs and DAs. Manual operator
// pairings (match_strategy='manual') are NEVER touched. This guarantees
// that the linker always sees the full set of un-paired PRs/DAs and
// produces the same output regardless of what's currently in the DB —
// at the cost of O(N) link rewrites per recompute, which the operator
// invokes infrequently.
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
//      in a tight loop, there are corner cases — connection pooling,
//      transaction visibility — where the just-inserted link isn't visible
//      yet, and the next iteration tries to pair against an already-paired
//      PR.
//
// We pre-fetch all recon_links for the account into in-memory Sets at the
// start of recompute and use those Sets as the sole source of truth for
// pairing eligibility. After each successful link insert we mutate the
// Sets so subsequent iterations see the new link immediately, with no
// dependency on embed shape or read-after-write timing.
//
// Pairing model:
//
//   Reference-ordered batch linking. PR batches (rows sharing a
//   `Referencia`) are sorted by reference ascending; DA batches (runs
//   of consecutive sequence numbers) by start sequence ascending. Each
//   DA batch consumes a contiguous prefix of remaining PR batches
//   until its DAs are paired. PRs in any consumed PR batch that didn't
//   pair are auto-confirmed (the bank kept the funds). No date filter
//   is applied — the linker trusts reference order alone.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  groupDABatches,
  groupPRBatches,
  linkAllBatches,
  type BatchLink,
  type DARowForBatch,
  type PRRowForBatch,
} from "./batches";
import {
  aliasMatch,
  extractPRPayerName,
  namesMatch,
  normalizeName,
  type AliasMap,
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
  /** Diagnostic — DAs in the account at the start of the linker pass. */
  unpairedDaInput: number;
  /** Diagnostic — DA batches the linker produced. */
  daBatchesFound: number;
  /** Diagnostic — DA batches that linked to one or more PR batches. */
  daBatchesLinked: number;
  /** Diagnostic — PR batches the linker produced. */
  prBatchesFound: number;
  /** Diagnostic — PR batches consumed by a link (rejected + auto-confirmed). */
  prBatchesConsumed: number;
  /** Diagnostic — PRs auto-confirmed because their batch was consumed but they weren't paired. */
  prsAutoConfirmedByBatch: number;
  /** Diagnostic — DAs that the linker could not pair against any PR. In
   *  well-behaved data this is 0; non-zero signals a data error (missing
   *  PR rows, alias gap, name corruption, or genuinely-stranded DA). */
  unmatchedDaCount: number;
  /** Diagnostic — link inserts that hit a unique violation (race / stale Set). */
  unpairedLinkConflict: number;
  /** Auto links deleted at the start of the recompute (always wiped + redone). */
  autoLinksWiped: number;
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

  // 1. Pre-fetch every existing recon_links row for this account.
  //    Used for: (a) the diagnostic "preexistingLinks" count, (b) input
  //    to wipeAutoLinks below, (c) the post-wipe survivors which are the
  //    Sets fed into the state recompute.
  const { linkedPrIds, linkedDaIds, links } = await fetchLinkedTxnIds(
    supabase,
    accountId,
  );
  const preexistingLinks = linkedPrIds.size;

  // 1a. Wipe ALL auto links (auto_batch_link + legacy auto_fifo_name_amount)
  //     and remove their ids from the Sets so the linker re-creates them
  //     from scratch under the current algorithm. Manual operator pairings
  //     are preserved.
  const autoLinksWiped = await wipeAutoLinks(
    supabase,
    links,
    linkedPrIds,
    linkedDaIds,
  );

  // 2. Load operator-curated aliases. The linker consults these AFTER the
  //    prefix match fails, so this is a no-op when no aliases exist.
  const aliases = await fetchAliasMap(supabase, accountId);
  const aliasesLoaded = aliases.size;

  // 3. Batch-aware pairing. Load every unpaired PR + DA in the account
  //    (after the wipe, only manually-paired rows are linked), run the
  //    pure linker, persist the resulting auto_batch_link rows.
  const unpairedPRs = await fetchUnpairedPRs(supabase, accountId, linkedPrIds);
  const unpairedDAs = await fetchUnpairedDAs(supabase, accountId, linkedDaIds);
  const unpairedDaInput = unpairedDAs.length;

  const prBatches = groupPRBatches(unpairedPRs);
  const daBatches = groupDABatches(unpairedDAs);

  const linkResult = linkAllBatches(prBatches, daBatches, {
    nameMatcher: (prName, daName) =>
      namesMatch(prName, daName) || aliasMatch(prName, daName, aliases),
    normalize: normalizeName,
    extractPRPayer: extractPRPayerName,
  });

  let reversalsPaired = 0;
  let unpairedLinkConflict = 0;
  let unmatchedDaCount = 0;
  // The linker's confirmedPrIds is the source of truth for auto-confirm:
  // it lists every PR in a consumed PR batch that didn't pair (whether
  // the batch had any pairings or none). We use this directly — no
  // post-hoc derivation from recon_links is needed because every recompute
  // wipes + recreates links, so the in-memory linker output IS the
  // authoritative state.
  const autoConfirmedPrIds = new Set<string>();
  for (const link of linkResult.links) {
    const persisted = await persistBatchLink(
      supabase,
      link,
      uploadedBy ?? null,
      linkedPrIds,
      linkedDaIds,
    );
    reversalsPaired += persisted.paired;
    unpairedLinkConflict += persisted.conflicts;
    unmatchedDaCount += link.unmatchedDaIds.length;
    for (const id of link.confirmedPrIds) autoConfirmedPrIds.add(id);
  }
  const reversalsUnpaired = unmatchedDaCount;
  const prsAutoConfirmedByBatch = autoConfirmedPrIds.size;

  // 4. Recompute PR + DA states from the Sets + auto-confirm set.
  //    File-clock confirmation was retired in Tier 5 PR 3 — a PR confirms
  //    only via batch-link consumption or explicit operator action.
  const prStats = await recomputePRStates(
    supabase,
    accountId,
    linkedPrIds,
    autoConfirmedPrIds,
  );
  const daStats = await recomputeDAStates(supabase, accountId, linkedDaIds);

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
    daBatchesFound: daBatches.length,
    daBatchesLinked: linkResult.links.length,
    prBatchesFound: prBatches.length,
    prBatchesConsumed:
      prBatches.length - linkResult.unconsumedPRBatchReferences.length,
    prsAutoConfirmedByBatch,
    unmatchedDaCount,
    unpairedLinkConflict,
    autoLinksWiped,
    aliasesLoaded,
  };
}

/**
 * Pre-fetch every operator-confirmed (PR-name, DA-name) alias for this
 * account into a Map<pr_name, Set<da_name>>. The pairing pass uses this
 * to accept matches that the prefix-based namesMatch would have missed.
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

const AUTO_STRATEGIES = new Set(["auto_fifo_name_amount", "auto_batch_link"]);

/**
 * Delete every auto recon_link in the account (both `auto_batch_link`
 * and the legacy `auto_fifo_name_amount` strategy) and remove their ids
 * from the in-memory Sets. Manual operator pairings stay put.
 *
 * Wiping + re-linking on every recompute makes the function idempotent
 * regardless of starting DB state — same input always produces the same
 * output, and operator-curated overrides are honoured.
 */
async function wipeAutoLinks(
  supabase: SupabaseClient,
  links: LinkRow[],
  linkedPrIds: Set<string>,
  linkedDaIds: Set<string>,
): Promise<number> {
  const autoPrIds: string[] = [];
  const autoDaIds: string[] = [];
  for (const l of links) {
    if (!AUTO_STRATEGIES.has(l.match_strategy)) continue;
    autoPrIds.push(l.pr_txn_id);
    autoDaIds.push(l.da_txn_id);
  }
  if (autoPrIds.length === 0) return 0;

  for (let i = 0; i < autoPrIds.length; i += ID_CHUNK) {
    const chunk = autoPrIds.slice(i, i + ID_CHUNK);
    const { error } = await supabase
      .from("recon_links")
      .delete()
      .in("pr_txn_id", chunk);
    if (error) throw error;
  }
  for (const id of autoPrIds) linkedPrIds.delete(id);
  for (const id of autoDaIds) linkedDaIds.delete(id);
  return autoPrIds.length;
}

async function fetchUnpairedPRs(
  supabase: SupabaseClient,
  accountId: string,
  linkedPrIds: Set<string>,
): Promise<PRRowForBatch[]> {
  const all: PRRowForBatch[] = [];
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id, posted_at, rail_native_ref, credit_minor, description")
      .eq("account_id", accountId)
      .eq("code", "PR")
      .order("posted_at", { ascending: true })
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const id = row.id as string;
      if (linkedPrIds.has(id)) continue;
      const ref = (row.rail_native_ref as string | null) ?? "";
      if (!ref) continue;
      all.push({
        id,
        posted_at: row.posted_at as string,
        reference: ref,
        amountMinor: BigInt(String(row.credit_minor)),
        description: (row.description as string | null) ?? "",
      });
    }
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }
  return all;
}

async function fetchUnpairedDAs(
  supabase: SupabaseClient,
  accountId: string,
  linkedDaIds: Set<string>,
): Promise<DARowForBatch[]> {
  const all: DARowForBatch[] = [];
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id, posted_at, rail_native_ref, debit_minor, payer_name_raw")
      .eq("account_id", accountId)
      .eq("code", "DA")
      .order("posted_at", { ascending: true })
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const id = row.id as string;
      if (linkedDaIds.has(id)) continue;
      const ref = (row.rail_native_ref as string | null) ?? "";
      if (!ref) continue;
      all.push({
        id,
        posted_at: row.posted_at as string,
        reference: ref,
        amountMinor: BigInt(String(row.debit_minor)),
        payerNameRaw: row.payer_name_raw as string | null,
      });
    }
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }
  return all;
}

async function persistBatchLink(
  supabase: SupabaseClient,
  link: BatchLink,
  uploadedBy: string | null,
  linkedPrIds: Set<string>,
  linkedDaIds: Set<string>,
): Promise<{ paired: number; conflicts: number }> {
  let paired = 0;
  let conflicts = 0;
  for (const p of link.pairings) {
    const { error } = await supabase.from("recon_links").insert({
      pr_txn_id: p.prId,
      da_txn_id: p.daId,
      match_strategy: "auto_batch_link",
      matched_by: uploadedBy,
    });
    if (error) {
      // 23505 = unique violation. The DB is the ultimate source of truth,
      // so if we lost a race or the Set was stale, back out cleanly.
      if (error.code === "23505") {
        conflicts++;
        continue;
      }
      throw error;
    }
    linkedPrIds.add(p.prId);
    linkedDaIds.add(p.daId);
    paired++;
  }
  return { paired, conflicts };
}

async function recomputePRStates(
  supabase: SupabaseClient,
  accountId: string,
  linkedPrIds: Set<string>,
  autoConfirmedPrIds: Set<string>,
): Promise<{ confirmed: number; rejected: number; pending: number }> {
  const prIds: string[] = [];
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id")
      .eq("account_id", accountId)
      .eq("code", "PR")
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const pr of data) prIds.push(pr.id as string);
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }

  // Phase 2: load latest manual override per PR. Operator-curated state
  // beats the auto rules — if the operator manually confirmed a pending
  // PR, we must not overwrite it back to pending here.
  const overrides = await fetchManualOverrides(supabase, prIds);

  // Phase 3: bucket. Order of precedence:
  //   1. Auto-rejected via recon_links (the strongest signal — a DA
  //      physically arrived for this PR).
  //   2. Operator's latest manual override, if any.
  //   3. Auto-confirmed because PR's batch was consumed and PR didn't pair.
  //   4. Default 'pending'.
  //
  // File-clock confirmation was retired in Tier 5 PR 3. confirmable_after
  // is no longer consulted; a PR confirms only via batch-link consumption
  // or explicit operator action.
  const buckets = {
    confirmed: [] as string[],
    rejected: [] as string[],
    pending: [] as string[],
  };
  for (const id of prIds) {
    if (linkedPrIds.has(id)) {
      buckets.rejected.push(id);
      continue;
    }
    const override = overrides.get(id);
    if (override === "confirmed" || override === "rejected" || override === "pending") {
      buckets[override].push(id);
      continue;
    }
    if (autoConfirmedPrIds.has(id)) {
      buckets.confirmed.push(id);
      continue;
    }
    buckets.pending.push(id);
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

/**
 * Build a Map of `txn_id → latest new_state` from recon_manual_actions
 * for the given txn ids. "Latest" by acted_at; we walk results most-
 * recent-first and keep the first occurrence per txn_id.
 *
 * Chunked at 100 ids per .in() to dodge URL-length limits.
 */
async function fetchManualOverrides(
  supabase: SupabaseClient,
  prIds: string[],
): Promise<Map<string, string>> {
  const overrides = new Map<string, string>();
  if (prIds.length === 0) return overrides;
  for (let i = 0; i < prIds.length; i += ID_CHUNK) {
    const chunk = prIds.slice(i, i + ID_CHUNK);
    const { data, error } = await supabase
      .from("recon_manual_actions")
      .select("txn_id, new_state, acted_at")
      .in("txn_id", chunk)
      .order("acted_at", { ascending: false });
    if (error) throw error;
    for (const a of data ?? []) {
      const txnId = a.txn_id as string;
      const newState = a.new_state as string | null;
      if (!newState) continue;
      if (!overrides.has(txnId)) overrides.set(txnId, newState);
    }
  }
  return overrides;
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
