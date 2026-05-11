// BAC batch-aware reconciliation primitives.
//
// PRs go out in batches (rows sharing a `Referencia`); DAs come back in
// batches (runs of consecutive sequence numbers across origin banks).
// In practice a single DA batch is NOT always the bank's response to
// one cleanly-partitioned PR submission group — BAC commonly mixes
// returns from multiple PR batches into a single DA batch (recurring
// payees with the same name appear in both, the bank's processing
// order varies by rail/priority, etc).
//
// Matching model — partial-claim:
//
//   1. Sort PR batches by reference ascending; sort DA batches in
//      chronological order (date asc, then start sequence asc within
//      a day).
//   2. Pass 1 — walk DA batches in order. For each DA in each batch,
//      find a match anywhere in the global PR pool. "Match" = exact
//      amount + injected name match. A PR is excluded only if it has
//      already paired with a prior DA OR if its batch's posted_at is
//      AFTER this DA batch's date (the bank can't return PRs that
//      hadn't been sent yet).
//   3. PRs are individually claimed; PR batches are NOT eagerly
//      claimed. Each DA grabs only the specific PR it needs.
//   4. Pass 2 — post-hoc assignment. Each PR batch that had at least
//      one pairing is "assigned" to the DA batch that paired the
//      MOST of its PRs (the natural owner). Tie-break by earliest DA
//      batch in chronological order.
//   5. Pass 3 — build BatchLinks. Each DA batch's link contains: its
//      pairings, the PR batches assigned to it in pass 2, the un-paired
//      PRs in those batches as `confirmedPrIds`, and any DAs that
//      didn't pair anywhere as `unmatchedDaIds`.
//   6. PR batches with zero pairings remain unconsumed — they may
//      pair with DAs in a later file's upload, or stay pending for
//      operator confirmation.
//
// Why partial-claim and not strict ref-order consume-on-walk:
//   - On some days a DA batch mixes returns from PR batches in BOTH
//     submission groups (Group A and Group B). Strict consume-on-walk
//     drags the first DA batch into the second group's PR batches
//     while searching for matches, exhausting them before the second
//     DA batch can walk. Partial-claim avoids the over-claim because
//     each DA only takes the one PR it needs.
//
// In typical BAC data DA.posted_at == PR.posted_at, occasionally
// PR.posted_at + 1 working day; the algorithm doesn't enforce a strict
// upper bound — only the lower bound (DA.day >= PR.day).
//
// Critical invariant: every DA in every DA batch must end up paired.
// Any DA still un-paired at the end is surfaced via
// `BatchLink.unmatchedDaIds`. The recompute layer reports the count;
// it does not silently drop the DAs.
//
// This module only does the matching math — pure functions, no DB or
// classifier coupling. The recompute layer threads these into
// recon_links + state writes.

import {
  parseDAReference,
  parsePRReference,
  type DAReferenceParts,
  type PRReferenceParts,
} from "./references";

// =============================================================
// Inputs
// =============================================================

export interface PRRowForBatch {
  id: string;
  posted_at: string; // YYYY-MM-DD
  reference: string;
  amountMinor: bigint;
  description: string;
}

export interface DARowForBatch {
  id: string;
  posted_at: string;
  reference: string;
  amountMinor: bigint;
  payerNameRaw: string | null;
}

// =============================================================
// Outputs
// =============================================================

export interface PRBatch {
  /** All PRs in the batch share this exact `Referencia`. */
  reference: string;
  type: number;
  sequence: number;
  /** Earliest posted_at among the rows (they should all match). */
  posted_at: string;
  rows: PRRowForBatch[];
}

export interface DABatch {
  /** Synthetic id for this batch — `${type}-${start}-${end}`. */
  id: string;
  type: number;
  startSequence: number;
  endSequence: number;
  /** Earliest posted_at among the rows in this batch. */
  posted_at: string;
  rows: (DARowForBatch & { parsed: DAReferenceParts })[];
}

export interface BatchPairing {
  daId: string;
  prId: string;
}

export interface BatchLink {
  /** The DA batch's synthetic id. */
  daBatchId: string;
  /** PR-batch references consumed by this link, in reference order. */
  prBatchReferences: string[];
  /** DA → PR pairings produced by the linker. */
  pairings: BatchPairing[];
  /** PR ids in the consumed PR batches that didn't pair — to be confirmed. */
  confirmedPrIds: string[];
  /** DA ids that the linker could not pair against any PR in the consumed
   *  batches. In well-behaved data this is empty; a non-empty array
   *  signals a data error (missing PR row, alias gap, name corruption,
   *  or genuinely-stranded DA) and the recompute layer surfaces the
   *  count for the operator. */
  unmatchedDaIds: string[];
}

// =============================================================
// Grouping
// =============================================================

/**
 * Group PR rows by their raw `Referencia`. Rows with unparseable refs
 * are skipped (they won't participate in batch linking, but the caller
 * can keep them as-is — they'll fall to "unbatched" handling).
 *
 * Returned batches are ordered by `sequence` ascending (earlier batches
 * first), per BAC's "lower numbers are earlier" convention.
 */
export function groupPRBatches(rows: PRRowForBatch[]): PRBatch[] {
  const byRef = new Map<string, { parsed: PRReferenceParts; rows: PRRowForBatch[] }>();
  for (const r of rows) {
    const parsed = parsePRReference(r.reference);
    if (!parsed) continue;
    const slot = byRef.get(parsed.raw);
    if (slot) {
      slot.rows.push(r);
    } else {
      byRef.set(parsed.raw, { parsed, rows: [r] });
    }
  }
  const batches: PRBatch[] = [];
  for (const slot of byRef.values()) {
    const earliest = slot.rows.reduce(
      (acc, r) => (acc < r.posted_at ? acc : r.posted_at),
      slot.rows[0].posted_at,
    );
    batches.push({
      reference: slot.parsed.raw,
      type: slot.parsed.type,
      sequence: slot.parsed.sequence,
      posted_at: earliest,
      rows: slot.rows,
    });
  }
  batches.sort((a, b) => a.sequence - b.sequence);
  return batches;
}

/**
 * Group DA rows into batches by consecutive sequence numbers (jumps of 1
 * keep the run open; any gap closes the batch). Origin-bank prefix can
 * change row-to-row within a batch.
 *
 * Rows with unparseable references are skipped. Type prefix is also
 * required to be consistent within a batch — a change in type closes
 * the batch even if the sequence is consecutive (defensive: in real
 * data the DA type prefix is always 4, but if a non-DA row sneaks
 * through we don't want to fold it in).
 *
 * Sorting note: BAC's DA sequence counter is NOT monotonic across
 * days — it can reset, wrap, or be scoped to a window. Two days'
 * worth of data can have lower-numbered sequences on a LATER date
 * (e.g. Apr 1 has seq 23344 but Apr 7 has seq 9791). Sorting purely
 * by sequence puts Apr 7 first and breaks the linker's date stop
 * (the cursor advances through earlier-day PR batches before the
 * earlier-day DA batches get to walk). We therefore sort rows by
 * (posted_at ascending, sequence ascending), so DA batches come out
 * in chronological order with sequence as a within-day tiebreaker.
 *
 * Returned batches are ordered by `(posted_at, startSequence)` ascending.
 */
export function groupDABatches(rows: DARowForBatch[]): DABatch[] {
  const parsedRows: (DARowForBatch & { parsed: DAReferenceParts })[] = [];
  for (const r of rows) {
    const parsed = parseDAReference(r.reference);
    if (!parsed) continue;
    parsedRows.push({ ...r, parsed });
  }
  parsedRows.sort((a, b) => {
    if (a.posted_at !== b.posted_at) return a.posted_at < b.posted_at ? -1 : 1;
    return a.parsed.sequence - b.parsed.sequence;
  });

  const batches: DABatch[] = [];
  let current: typeof parsedRows = [];
  for (const r of parsedRows) {
    const last = current[current.length - 1];
    const isContiguous =
      last !== undefined &&
      last.parsed.type === r.parsed.type &&
      last.parsed.sequence + 1 === r.parsed.sequence;
    if (!isContiguous && current.length > 0) {
      batches.push(buildDABatch(current));
      current = [];
    }
    current.push(r);
  }
  if (current.length > 0) batches.push(buildDABatch(current));

  return batches;
}

function buildDABatch(
  rows: (DARowForBatch & { parsed: DAReferenceParts })[],
): DABatch {
  const start = rows[0].parsed.sequence;
  const end = rows[rows.length - 1].parsed.sequence;
  const type = rows[0].parsed.type;
  const earliestDate = rows.reduce(
    (acc, r) => (acc < r.posted_at ? acc : r.posted_at),
    rows[0].posted_at,
  );
  return {
    id: `${type}-${start}-${end}`,
    type,
    startSequence: start,
    endSequence: end,
    posted_at: earliestDate,
    rows,
  };
}

// =============================================================
// Linking
// =============================================================

export interface LinkOptions {
  /**
   * Returns true if a PR description's parsed name matches a DA's
   * payer_name_raw. Caller injects whatever combination of prefix
   * matching + alias-map lookup it cares about. Both arguments
   * already-normalized.
   */
  nameMatcher: (prNameNormalized: string, daNameNormalized: string) => boolean;
  /** Used to widen `nameMatcher` via the operator-curated alias map. */
  normalize: (s: string) => string;
  extractPRPayer: (description: string) => string | null;
}

/**
 * Pair each DA in `daBatch` against the first available PR (across
 * `availablePRBatches`) whose amount + name match. Skips PRs already
 * in `usedPrIds` (mutated to include each successful pairing) and PRs
 * in batches posted AFTER `daBatch.posted_at` (date sanity — bank
 * can't return PRs not yet sent).
 *
 * Returns pairings + unmatched DA ids + the set of PR batch refs that
 * received at least one pairing. Batch claim and `confirmedPrIds` are
 * decided post-hoc by `linkAllBatches`; this helper only does the
 * per-DA matching pass.
 */
export function tryLinkDABatch(
  daBatch: DABatch,
  availablePRBatches: PRBatch[],
  usedPrIds: Set<string>,
  options: LinkOptions,
): BatchLink {
  const pairings: BatchPairing[] = [];
  const unmatchedDaIds: string[] = [];
  const batchRefs = new Set<string>();

  for (const da of daBatch.rows) {
    const match = findMatchAcrossBatches(
      da,
      availablePRBatches,
      daBatch.posted_at,
      usedPrIds,
      options,
    );
    if (match) {
      pairings.push({ daId: da.id, prId: match.pr.id });
      usedPrIds.add(match.pr.id);
      batchRefs.add(match.batchRef);
    } else {
      unmatchedDaIds.push(da.id);
    }
  }

  return {
    daBatchId: daBatch.id,
    prBatchReferences: Array.from(batchRefs),
    pairings,
    confirmedPrIds: [], // filled in by linkAllBatches' post-hoc pass
    unmatchedDaIds,
  };
}

/**
 * Walk PR batches in order; for each, walk its PRs in order; return
 * the first PR whose amount + name match `da` and isn't already in
 * `usedPrIds`. PR batches posted after `daPostedAt` are skipped (date
 * sanity). Returns null for DAs without a payer name (can't pair).
 */
function findMatchAcrossBatches(
  da: DABatch["rows"][number],
  prBatches: PRBatch[],
  daPostedAt: string,
  usedPrIds: Set<string>,
  options: LinkOptions,
): { pr: PRRowForBatch; batchRef: string } | null {
  if (!da.payerNameRaw) return null;
  const targetName = options.normalize(da.payerNameRaw);
  for (const prBatch of prBatches) {
    if (prBatch.posted_at > daPostedAt) continue;
    for (const pr of prBatch.rows) {
      if (usedPrIds.has(pr.id)) continue;
      if (pr.amountMinor !== da.amountMinor) continue;
      const prName = options.extractPRPayer(pr.description);
      if (!prName) continue;
      if (options.nameMatcher(options.normalize(prName), targetName)) {
        return { pr, batchRef: prBatch.reference };
      }
    }
  }
  return null;
}

// =============================================================
// Driver: link as many DA batches as possible
// =============================================================

export interface BatchLinkingResult {
  links: BatchLink[];
  /** PR batch references not consumed by any link (still pending — may
   *  pair with DAs in a later statement). */
  unconsumedPRBatchReferences: string[];
}

/**
 * Three-pass orchestrator over all DA batches:
 *
 *   Pass 1 — Pair each DA against any available PR (partial-claim).
 *     Walks DA batches in chronological order; for each DA finds the
 *     first matching PR across the global pool. Records pairings per
 *     DA batch; PRs themselves are individually claimed (not batches).
 *
 *   Pass 2 — Post-hoc batch assignment. For each PR batch that had at
 *     least one pairing, assign it to the DA batch that paired the
 *     MOST of its PRs (the natural owner). Tie-break by earliest DA
 *     batch in chronological order.
 *
 *   Pass 3 — Build BatchLinks. Each DA batch's link carries: its own
 *     pairings, the PR batches it was assigned in pass 2, the un-paired
 *     PRs in those batches as `confirmedPrIds`, and any DAs that didn't
 *     pair anywhere as `unmatchedDaIds`.
 *
 *   PR batches with zero pairings remain unconsumed — they may pair
 *   with DAs in a future file's upload, or stay pending for operator
 *   confirmation.
 */
export function linkAllBatches(
  prBatches: PRBatch[],
  daBatches: DABatch[],
  options: LinkOptions,
): BatchLinkingResult {
  const usedPrIds = new Set<string>();
  const pass1Links: BatchLink[] = [];

  // Pass 1: pair each DA against the global pool.
  for (const daBatch of daBatches) {
    pass1Links.push(tryLinkDABatch(daBatch, prBatches, usedPrIds, options));
  }

  // Pass 2: count pairings per (prBatchRef, daBatchId) so we can pick
  // the DA batch that "owns" each touched PR batch.
  const prToBatchRef = new Map<string, string>();
  for (const prBatch of prBatches) {
    for (const pr of prBatch.rows) prToBatchRef.set(pr.id, prBatch.reference);
  }
  const countsByPrBatch = new Map<string, Map<string, number>>();
  const daBatchOrder = new Map<string, number>();
  for (let i = 0; i < daBatches.length; i++) daBatchOrder.set(daBatches[i].id, i);
  for (const link of pass1Links) {
    for (const p of link.pairings) {
      const prBatchRef = prToBatchRef.get(p.prId);
      if (!prBatchRef) continue;
      const sub = countsByPrBatch.get(prBatchRef) ?? new Map<string, number>();
      sub.set(link.daBatchId, (sub.get(link.daBatchId) ?? 0) + 1);
      countsByPrBatch.set(prBatchRef, sub);
    }
  }
  const prBatchOwner = new Map<string, string>();
  for (const [prBatchRef, counts] of countsByPrBatch) {
    let bestDaBatch = "";
    let bestCount = -1;
    let bestOrdinal = Infinity;
    for (const [daBatchId, count] of counts) {
      const ord = daBatchOrder.get(daBatchId) ?? Infinity;
      if (count > bestCount || (count === bestCount && ord < bestOrdinal)) {
        bestCount = count;
        bestDaBatch = daBatchId;
        bestOrdinal = ord;
      }
    }
    prBatchOwner.set(prBatchRef, bestDaBatch);
  }

  // Pass 3: build final links with consumedRefs + confirmedPrIds.
  const finalLinks: BatchLink[] = [];
  for (const link of pass1Links) {
    const consumedRefs: string[] = [];
    const confirmedPrIds: string[] = [];
    for (const prBatch of prBatches) {
      if (prBatchOwner.get(prBatch.reference) !== link.daBatchId) continue;
      consumedRefs.push(prBatch.reference);
      for (const pr of prBatch.rows) {
        if (!usedPrIds.has(pr.id)) confirmedPrIds.push(pr.id);
      }
    }
    finalLinks.push({
      daBatchId: link.daBatchId,
      prBatchReferences: consumedRefs,
      pairings: link.pairings,
      confirmedPrIds,
      unmatchedDaIds: link.unmatchedDaIds,
    });
  }

  const unconsumedPRBatchReferences = prBatches
    .filter((b) => !prBatchOwner.has(b.reference))
    .map((b) => b.reference);

  return { links: finalLinks, unconsumedPRBatchReferences };
}
