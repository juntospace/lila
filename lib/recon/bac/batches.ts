// BAC batch-aware reconciliation primitives.
//
// The pairing model used to be per-row (FIFO + amount + name + ±1-day
// window). Real BAC behaviour is batch-driven: PRs go out in batches
// (rows sharing a `Referencia`), DAs come back in batches (runs of
// consecutive sequences across origin banks), and a DA batch is the
// bank's response to one OR MORE earlier PR batches grouped together.
// Every DA in a batch must correspond to a PR in the linked group; PRs
// in the linked group that DON'T appear among the DAs are confirmed.
//
// This module only does the matching math — pure functions, no DB or
// classifier coupling. The recompute layer is what threads these into
// recon_links + state writes (Tier 5 PR 2).
//
// Date window: a DA batch can link to PR batches whose posted date is
// either the same day or the previous working day (BAC's posting
// cadence: rejection arrives same-day or next working day after the
// originating PR batch). Holidays not yet considered.

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
  /** PR-batch references that were grouped to satisfy this DA batch. */
  prBatchReferences: string[];
  /** DA → PR pairings. Each DA in the batch appears here exactly once. */
  pairings: BatchPairing[];
  /** PR ids in the group that didn't pair — to be confirmed. */
  confirmedPrIds: string[];
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
  /** YYYY-MM-DD → previous working day, also YYYY-MM-DD. */
  previousWorkingDay: (iso: string) => string;
}

/**
 * Try to link `daBatch` to a PR-batch group built from the prefix of
 * `availablePRBatches` (which must be ordered by sequence ascending and
 * contain only PR batches that haven't already been consumed by an
 * earlier link).
 *
 * Algorithm:
 *
 *   1. Filter `availablePRBatches` down to those whose posted_at is
 *      either the same day as the DA batch or the previous working day.
 *      PR batches outside that window aren't eligible for this DA batch
 *      and are skipped (they may pair with later DA batches or stay
 *      pending until a future statement).
 *
 *   2. Walk the eligible PR batches in sequence order, accumulating
 *      them into a group. After each addition, attempt a greedy
 *      assignment of every DA in the batch to an unmatched PR in the
 *      group (exact amount + injected name match). If every DA finds
 *      a partner, the link is complete.
 *
 *   3. If we run out of eligible PR batches without satisfying every
 *      DA, return null. The DA batch stays unlinked (operator can
 *      manually pair its rows via the existing unmatched-reversals UI,
 *      or wait for a later statement that brings the missing PR batch).
 *
 * The function does NOT mutate its inputs and does NOT touch the DB.
 */
export function tryLinkDABatch(
  daBatch: DABatch,
  availablePRBatches: PRBatch[],
  options: LinkOptions,
): BatchLink | null {
  const eligible = availablePRBatches.filter((b) =>
    isInWindow(b.posted_at, daBatch.posted_at, options.previousWorkingDay),
  );

  const group: PRBatch[] = [];
  const groupRows: PRRowForBatch[] = [];

  for (const candidate of eligible) {
    group.push(candidate);
    groupRows.push(...candidate.rows);

    const pairings = greedyAssign(daBatch.rows, groupRows, options);
    if (pairings) {
      const pairedPrIds = new Set(pairings.map((p) => p.prId));
      const confirmedPrIds = groupRows
        .filter((r) => !pairedPrIds.has(r.id))
        .map((r) => r.id);
      return {
        daBatchId: daBatch.id,
        prBatchReferences: group.map((b) => b.reference),
        pairings,
        confirmedPrIds,
      };
    }
  }
  return null;
}

function isInWindow(
  prDate: string,
  daDate: string,
  previousWorkingDay: (iso: string) => string,
): boolean {
  if (prDate === daDate) return true;
  if (prDate === previousWorkingDay(daDate)) return true;
  return false;
}

/**
 * Greedy first-fit per DA: walk DAs in their batch order; for each,
 * find the first unmatched PR in the group with the same amount and a
 * name match. Returns null if any DA can't find one.
 *
 * Order matters surprisingly little here: every DA must match SOME PR
 * in the eventual group, so a failure to greedy-assign means the group
 * is genuinely insufficient — caller will append the next PR batch and
 * retry from scratch. We don't need a maximum-matching algorithm
 * because the group keeps growing until every DA can be placed.
 */
function greedyAssign(
  daRows: DABatch["rows"],
  prPool: PRRowForBatch[],
  options: LinkOptions,
): BatchPairing[] | null {
  const used = new Set<string>();
  const out: BatchPairing[] = [];
  for (const da of daRows) {
    if (!da.payerNameRaw) return null;
    const targetName = options.normalize(da.payerNameRaw);
    const match = prPool.find((pr) => {
      if (used.has(pr.id)) return false;
      if (pr.amountMinor !== da.amountMinor) return false;
      const prName = options.extractPRPayer(pr.description);
      if (!prName) return false;
      return options.nameMatcher(options.normalize(prName), targetName);
    });
    if (!match) return null;
    used.add(match.id);
    out.push({ daId: da.id, prId: match.id });
  }
  return out;
}

// =============================================================
// Driver: link as many DA batches as possible
// =============================================================

export interface BatchLinkingResult {
  links: BatchLink[];
  /** DA batches that couldn't be linked at all (waiting for more data). */
  unlinkedDABatches: DABatch[];
  /** PR batch references not consumed by any link (stay pending). */
  unconsumedPRBatchReferences: string[];
}

/**
 * Walk the DA batches in sequence order and link each against the
 * PR-batch space — greedy, first-come-first-served. Once a PR batch is
 * consumed by a link, it can't appear in another link's group.
 *
 * No DB writes; caller decides what to do with the result. Pure-ish
 * (delegates name normalization + working-day arithmetic to options).
 */
export function linkAllBatches(
  prBatches: PRBatch[],
  daBatches: DABatch[],
  options: LinkOptions,
): BatchLinkingResult {
  const remaining = [...prBatches];
  const links: BatchLink[] = [];
  const unlinkedDABatches: DABatch[] = [];

  for (const da of daBatches) {
    const link = tryLinkDABatch(da, remaining, options);
    if (!link) {
      unlinkedDABatches.push(da);
      continue;
    }
    links.push(link);
    const consumed = new Set(link.prBatchReferences);
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (consumed.has(remaining[i].reference)) {
        remaining.splice(i, 1);
      }
    }
  }

  return {
    links,
    unlinkedDABatches,
    unconsumedPRBatchReferences: remaining.map((b) => b.reference),
  };
}
