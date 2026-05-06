// Account-wide recompute: batch-aware pairing for every unpaired DA in
// the account, then reconcile each PR/DA's state against link presence,
// auto-confirmations from consumed PR batches, manual operator overrides,
// and the file-clock cutoff.
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
// Pairing model (Tier 5):
//
//   The legacy per-row FIFO+name+amount+window matcher is gone. Real BAC
//   behaviour is batch-driven — PRs go out in batches sharing a `Referencia`,
//   DAs come back in batches of consecutive sequences, and a DA batch is
//   the bank's response to one or more linked PR batches as a group. We
//   call linkAllBatches() to compute the pairings + auto-confirmations and
//   then persist them.

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
  fileClockCutoff,
  namesMatch,
  normalizeName,
  type AliasMap,
} from "./classify";
import { parseDvtoDescription } from "./parser";
import { previousWorkingDay } from "../format";

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
  /** Diagnostic — DAs that started without a link (input to the pairing pass). */
  unpairedDaInput: number;
  /** Diagnostic — DA batches the linker produced. */
  daBatchesFound: number;
  /** Diagnostic — DA batches that linked to one or more PR batches. */
  daBatchesLinked: number;
  /** Diagnostic — DA batches with no eligible PR group (stay pending). */
  daBatchesUnlinked: number;
  /** Diagnostic — PR batches the linker produced. */
  prBatchesFound: number;
  /** Diagnostic — PR batches consumed by a link (rejected + auto-confirmed). */
  prBatchesConsumed: number;
  /** Diagnostic — PRs auto-confirmed because their batch was consumed but they weren't paired. */
  prsAutoConfirmedByBatch: number;
  /** Diagnostic — link inserts that hit a unique violation (race / stale Set). */
  unpairedLinkConflict: number;
  /** Existing auto links deleted because their PR/DA dates fell outside the batch window. */
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
  //    in-memory Sets. These are mutated as we insert more links and used
  //    by the candidates filter, the unpaired-DA discovery, and the final
  //    state recompute — single source of truth.
  const { linkedPrIds, linkedDaIds, links } = await fetchLinkedTxnIds(
    supabase,
    accountId,
  );
  const preexistingLinks = linkedPrIds.size;

  // 1.5. Load operator-curated aliases for this account. The batch-link
  //      name matcher consults these AFTER the regular prefix match
  //      fails, so this load is a no-op when no aliases exist.
  const aliases = await fetchAliasMap(supabase, accountId);
  const aliasesLoaded = aliases.size;

  // 1a. Heal: any existing AUTO link that violates the batch-window rule
  //     ("PR.day == DA.day OR PR.day == previousWorkingDay(DA.day)") is
  //     invalid. Delete those links and remove their ids from the Sets so
  //     the batch pass below can re-pair them under the new model.
  //
  //     We only touch auto pairings (auto_fifo_name_amount + auto_batch_link);
  //     manual pairings reflect explicit operator intent and stay put.
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

  // 2. Batch-aware pairing. Load every unpaired PR + DA in the account,
  //    run the pure linker, persist the resulting links, and remember
  //    which PRs were auto-confirmed by being inside a consumed PR batch.
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
    previousWorkingDay,
  });

  let reversalsPaired = 0;
  let unpairedLinkConflict = 0;
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
  }
  const reversalsUnpaired = linkResult.unlinkedDABatches.reduce(
    (acc, b) => acc + b.rows.length,
    0,
  );

  // 2a. Derive auto-confirmation from the CURRENT recon_links state, not
  //     just the pairings produced in this recompute. The BAC contract is:
  //     once a PR batch is consumed by a DA batch, every PR in that batch
  //     that didn't pair with a DA is confirmed (the bank kept the funds).
  //
  //     "Consumed" is detectable from existing auto_batch_link rows: any
  //     PR sharing a rail_native_ref with an auto_batch_link-paired PR is
  //     in a consumed batch. Without this derivation, a second recompute
  //     run forgets the consumption signal because the unpaired-DA pool
  //     is empty (the DAs are already linked), and pending PRs in those
  //     batches stay pending forever.
  //
  //     We only treat auto_batch_link as the consumption signal — manual
  //     pairings reflect operator intent on a single PR/DA, not an entire
  //     batch consumption.
  const autoConfirmedPrIds = await deriveAutoConfirmedPrIds(
    supabase,
    accountId,
    linkedPrIds,
  );
  const prsAutoConfirmedByBatch = autoConfirmedPrIds.size;

  // 3. File-clock cutoff = max posted_at across the account.
  //    Still consulted as a tertiary fallback. Tier 5 PR 3 retires it.
  const { data: maxRow } = await supabase
    .from("recon_transactions")
    .select("posted_at")
    .eq("account_id", accountId)
    .order("posted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cutoff = maxRow?.posted_at ? fileClockCutoff(maxRow.posted_at as string) : null;

  // 4. Recompute PR + DA states from the Sets + auto-confirm set.
  const prStats = await recomputePRStates(
    supabase,
    accountId,
    cutoff,
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
    daBatchesUnlinked: linkResult.unlinkedDABatches.length,
    prBatchesFound: prBatches.length,
    prBatchesConsumed:
      prBatches.length - linkResult.unconsumedPRBatchReferences.length,
    prsAutoConfirmedByBatch,
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

interface HealOutcome {
  deleted: number;
  crossDay: number;
  dateMissing: number;
}

const AUTO_STRATEGIES = new Set(["auto_fifo_name_amount", "auto_batch_link"]);

/**
 * Inspect every existing AUTO recon_links row and delete any whose
 * PR/DA date pair violates the batch-window rule:
 *
 *   PR.posted_at == DA.posted_at OR PR.posted_at == previousWorkingDay(DA.posted_at)
 *
 * Returns:
 *   - deleted:     auto links removed (also mutates the in-memory Sets).
 *   - crossDay:    links where PR.date != DA.date, regardless of validity.
 *                  Diagnostic; helps see whether the DB actually contains
 *                  cross-day pairings to evaluate.
 *   - dateMissing: links the heal pass had to skip because the date
 *                  lookup didn't return one of the rows. Diagnostic;
 *                  flags chunked-fetch gaps.
 *
 * Manual pairings reflect explicit operator intent (a chosen exception
 * to the algorithm) and are never invalidated by the heal pass.
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
    if (!AUTO_STRATEGIES.has(l.match_strategy)) continue;
    const prDate = datesById.get(l.pr_txn_id);
    const daDate = datesById.get(l.da_txn_id);
    if (!prDate || !daDate) {
      dateMissing++;
      continue;
    }
    if (prDate !== daDate) crossDay++;
    if (!isInBatchWindow(prDate, daDate)) {
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

function isInBatchWindow(prDate: string, daDate: string): boolean {
  if (prDate === daDate) return true;
  if (prDate === previousWorkingDay(daDate)) return true;
  return false;
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

/**
 * Derive the set of "PR was in a consumed batch but didn't pair" PRs by
 * inspecting current recon_links state.
 *
 * Algorithm:
 *   1. Pull every PR row's id + rail_native_ref.
 *   2. Pull every recon_links row whose match_strategy = 'auto_batch_link'
 *      and whose PR side belongs to this account.
 *   3. Collect the references of every PR that has an auto_batch_link
 *      pairing — those references identify "consumed PR batches."
 *   4. Walk all PRs again; any PR that (a) shares a consumed-batch
 *      reference, (b) has a parseable digit reference, and (c) is not
 *      itself paired (linkedPrIds), gets flagged as auto-confirmed.
 *
 * Idempotent across recomputes — derives state from the DB rather than
 * the in-flight linker output, so a second run computes the same answer
 * even when the unpaired-DA pool is empty.
 */
async function deriveAutoConfirmedPrIds(
  supabase: SupabaseClient,
  accountId: string,
  linkedPrIds: Set<string>,
): Promise<Set<string>> {
  // Step 1 — load all PRs with their references.
  type PrInfo = { id: string; ref: string | null };
  const prs: PrInfo[] = [];
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id, rail_native_ref")
      .eq("account_id", accountId)
      .eq("code", "PR")
      .order("id", { ascending: true })
      .range(cursor, cursor + SUPABASE_PAGE_LIMIT - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      prs.push({
        id: row.id as string,
        ref: (row.rail_native_ref as string | null) ?? null,
      });
    }
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }

  // Step 2 — fetch auto_batch_link links restricted to this account's PRs.
  const prIds = prs.map((p) => p.id);
  const autoBatchPrIds = new Set<string>();
  for (let i = 0; i < prIds.length; i += ID_CHUNK) {
    const chunk = prIds.slice(i, i + ID_CHUNK);
    const { data, error } = await supabase
      .from("recon_links")
      .select("pr_txn_id")
      .eq("match_strategy", "auto_batch_link")
      .in("pr_txn_id", chunk);
    if (error) throw error;
    for (const l of data ?? []) autoBatchPrIds.add(l.pr_txn_id as string);
  }

  // Step 3 — refs of consumed PR batches.
  const consumedRefs = new Set<string>();
  for (const pr of prs) {
    if (autoBatchPrIds.has(pr.id) && pr.ref) consumedRefs.add(pr.ref);
  }

  // Step 4 — every unpaired PR sharing a consumed ref is auto-confirmed.
  const out = new Set<string>();
  for (const pr of prs) {
    if (!pr.ref) continue;
    if (linkedPrIds.has(pr.id)) continue;
    if (!consumedRefs.has(pr.ref)) continue;
    out.add(pr.id);
  }
  return out;
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
  cutoff: string | null,
  linkedPrIds: Set<string>,
  autoConfirmedPrIds: Set<string>,
): Promise<{ confirmed: number; rejected: number; pending: number }> {
  type PrRow = { id: string; confirmable_after: string | null };
  const prs: PrRow[] = [];
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
      prs.push({
        id: pr.id as string,
        confirmable_after: (pr.confirmable_after as string | null) ?? null,
      });
    }
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }

  // Phase 2: load latest manual override per PR. Operator-curated state
  // beats the auto rules — if the operator manually confirmed a pending
  // PR, we must not overwrite it back to pending here.
  const overrides = await fetchManualOverrides(
    supabase,
    prs.map((p) => p.id),
  );

  // Phase 3: bucket. Order of precedence:
  //   1. Auto-rejected via recon_links (the strongest signal — a DA
  //      physically arrived for this PR).
  //   2. Operator's latest manual override, if any.
  //   3. Auto-confirmed because PR's batch was consumed and PR didn't pair.
  //   4. File-clock confirmation (confirmable_after lapsed).
  //   5. Default 'pending'.
  const buckets = {
    confirmed: [] as string[],
    rejected: [] as string[],
    pending: [] as string[],
  };
  for (const pr of prs) {
    if (linkedPrIds.has(pr.id)) {
      buckets.rejected.push(pr.id);
      continue;
    }
    const override = overrides.get(pr.id);
    if (override === "confirmed" || override === "rejected" || override === "pending") {
      buckets[override].push(pr.id);
      continue;
    }
    if (autoConfirmedPrIds.has(pr.id)) {
      buckets.confirmed.push(pr.id);
      continue;
    }
    if (
      cutoff &&
      pr.confirmable_after &&
      pr.confirmable_after <= cutoff
    ) {
      buckets.confirmed.push(pr.id);
      continue;
    }
    buckets.pending.push(pr.id);
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
