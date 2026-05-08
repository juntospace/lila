// BAC batch-aware reconciliation primitives.
//
// PRs go out in batches (rows sharing a `Referencia`); DAs come back in
// batches (runs of consecutive sequence numbers across origin banks); a
// DA batch is the bank's response to one OR MORE earlier PR batches.
// The matching is **reference-ordered with a date sanity-check**:
//
//   1. Sort PR batches by reference ascending; sort DA batches by start
//      sequence ascending.
//   2. Walk DA batches in order. For each DA batch, walk PR batches in
//      reference order starting from the first un-consumed one. Each PR
//      batch is matched against the DA batch's still-un-paired DAs by
//      (amount + injected name match). Un-paired PRs in any consumed PR
//      batch are confirmed (the bank kept the funds).
//   3. **Date stop**: a PR batch posted AFTER the current DA batch's
//      date is never consumable — the bank can't return a PR that
//      hadn't been sent yet. The walk stops at the first such PR batch
//      and any remaining DAs become unmatched (a data-error signal).
//      The skipped PR batch carries forward to the next DA batch.
//   4. The walk also stops as soon as the DA batch's DAs are all paired.
//   5. The next DA batch starts with the next un-consumed PR batch (the
//      cursor is global; we never reuse a PR batch).
//
// In typical BAC data DA.posted_at == PR.posted_at, occasionally
// PR.posted_at + 1 working day; the algorithm doesn't enforce a strict
// upper bound — only the lower bound (DA.day >= PR.day).
//
// Critical invariant: every DA in every DA batch must end up paired. If
// any DA in a batch is left un-paired after the walk terminates, that's
// surfaced via `BatchLink.unmatchedDaIds`. The recompute layer reports
// the count; it does not silently drop the DAs.
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
 * Returned batches are ordered by `startSequence` ascending.
 */
export function groupDABatches(rows: DARowForBatch[]): DABatch[] {
  const parsedRows: (DARowForBatch & { parsed: DAReferenceParts })[] = [];
  for (const r of rows) {
    const parsed = parseDAReference(r.reference);
    if (!parsed) continue;
    parsedRows.push({ ...r, parsed });
  }
  parsedRows.sort((a, b) => a.parsed.sequence - b.parsed.sequence);

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
 * Link `daBatch` to a contiguous prefix of `availablePRBatches`,
 * matching by (amount + name) and stopping at the first PR batch
 * posted AFTER the DA batch's date. `availablePRBatches` must already
 * be sorted by reference ascending; `daBatch.rows` in their natural
 * order within the batch.
 *
 * Algorithm:
 *
 *   1. Walk PR batches in reference order. For each PR batch:
 *      - If `prBatch.posted_at > daBatch.posted_at`, stop. The PR
 *        batch is from a date after the DA arrived — it can't be a
 *        source for these DAs (the bank can't return a PR that hadn't
 *        been sent). The PR batch is left for a later DA batch.
 *      - Otherwise consume the batch: try to pair every still-unmatched
 *        DA against an unmatched PR in this single PR batch (one PR
 *        batch at a time, NOT a merged pool).
 *   2. After each consumed PR batch, the un-paired PRs in that batch
 *      go into `confirmedPrIds`. The PR batch was consumed by this DA
 *      batch; PRs the bank didn't return are confirmed.
 *   3. Stop pulling more PR batches as soon as every DA is paired.
 *   4. Any DA still un-paired at the end goes into `unmatchedDaIds` —
 *      the data-error signal.
 *
 * The function does NOT mutate its inputs and does NOT touch the DB.
 */
export function tryLinkDABatch(
  daBatch: DABatch,
  availablePRBatches: PRBatch[],
  options: LinkOptions,
): BatchLink {
  const pairings: BatchPairing[] = [];
  const confirmedPrIds: string[] = [];
  const consumedRefs: string[] = [];
  let remainingDAs: DABatch["rows"] = daBatch.rows;

  for (const prBatch of availablePRBatches) {
    if (remainingDAs.length === 0) break;
    // Date sanity check: PR batches posted AFTER this DA batch's date
    // can't be its source. They belong to a future DA batch.
    if (prBatch.posted_at > daBatch.posted_at) break;

    consumedRefs.push(prBatch.reference);

    const usedPrIds = new Set<string>();
    const stillUnmatched: DABatch["rows"] = [];
    for (const da of remainingDAs) {
      const match = findMatchInBatch(da, prBatch.rows, usedPrIds, options);
      if (match) {
        pairings.push({ daId: da.id, prId: match.id });
        usedPrIds.add(match.id);
      } else {
        stillUnmatched.push(da);
      }
    }
    remainingDAs = stillUnmatched;

    // PRs in this consumed batch that didn't pair are confirmed —
    // regardless of whether we stop here or continue to the next batch.
    for (const pr of prBatch.rows) {
      if (!usedPrIds.has(pr.id)) confirmedPrIds.push(pr.id);
    }
  }

  return {
    daBatchId: daBatch.id,
    prBatchReferences: consumedRefs,
    pairings,
    confirmedPrIds,
    unmatchedDaIds: remainingDAs.map((d) => d.id),
  };
}

/**
 * Find the first PR in `prRows` not yet in `usedPrIds` with matching
 * amount + name. DAs without a payer name can't match anything and
 * return null (the recompute layer treats those as un-pairable).
 */
function findMatchInBatch(
  da: DABatch["rows"][number],
  prRows: PRRowForBatch[],
  usedPrIds: Set<string>,
  options: LinkOptions,
): PRRowForBatch | null {
  if (!da.payerNameRaw) return null;
  const targetName = options.normalize(da.payerNameRaw);
  for (const pr of prRows) {
    if (usedPrIds.has(pr.id)) continue;
    if (pr.amountMinor !== da.amountMinor) continue;
    const prName = options.extractPRPayer(pr.description);
    if (!prName) continue;
    if (options.nameMatcher(options.normalize(prName), targetName)) return pr;
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
 * Walk DA batches in reference order, threading a single PR-batch
 * cursor across the whole sequence. DA batch K starts where DA batch
 * K-1 left off — once a PR batch is consumed (matched against any DA
 * batch), it cannot be reused.
 *
 * Returns one `BatchLink` per DA batch. Even DA batches with un-paired
 * DAs are returned (the caller inspects `unmatchedDaIds` and surfaces
 * the count).
 *
 * No DB writes; caller decides what to do with the result.
 */
export function linkAllBatches(
  prBatches: PRBatch[],
  daBatches: DABatch[],
  options: LinkOptions,
): BatchLinkingResult {
  const links: BatchLink[] = [];
  let prCursor = 0;

  for (const daBatch of daBatches) {
    const available = prBatches.slice(prCursor);
    const link = tryLinkDABatch(daBatch, available, options);
    links.push(link);
    prCursor += link.prBatchReferences.length;
  }

  return {
    links,
    unconsumedPRBatchReferences: prBatches.slice(prCursor).map((b) => b.reference),
  };
}
