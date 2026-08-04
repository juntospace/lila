// BAC batch-aware reconciliation primitives.
//
// PRs go out in batches (rows sharing a `Referencia`); DAs come back
// in batches (runs of consecutive sequence numbers across origin
// banks). Each PR batch is the bank's response to a specific
// submission, so:
//
//   • Each PR batch is linked to EXACTLY ONE DA batch.
//   • A single DA batch can be linked to MULTIPLE PR batches.
//   • The PRs paired in a DA batch's link all come from PR batches
//     assigned to that link.
//   • PRs in an assigned PR batch that didn't pair with any DA in the
//     linked DA batch are CONFIRMED (the bank kept the funds).
//   • Date sanity: a PR batch can only be linked to a DA batch with
//     posted_at >= the PR batch's posted_at.
//
// Matching model — day-by-day bipartite assignment:
//
//   1. Process DA batches in chronological order, grouped by day.
//   2. For each day, candidate PR batches = all PR batches with
//      posted_at <= today AND not yet claimed by any prior link.
//   3. Solve the bipartite many-to-one assignment: which PR batch goes
//      with which DA batch (or stays unassigned for tomorrow)?
//      Score = total DAs paired. Optimal assignment maximizes pairings.
//      Brute force when (N+1)^M <= 200k; otherwise a greedy fallback.
//   4. Lock the assignment. Within each (DA batch, assigned PR batches)
//      group, do greedy DA→PR matching (amount + injected name match).
//   5. Un-paired PRs in claimed batches → auto-confirmed. Un-paired
//      DAs → unmatchedDaIds (data error signal). PR batches not
//      assigned today → carry forward to the next day's pool.
//
// Why bipartite assignment vs naive greedy: BAC's actual link from
// PR-submission to DA-batch isn't always lower-ref-to-lower-seq. Some
// days the LATER PR submission gets the EARLIER DA batch (different
// rails / priorities). Naive greedy mis-assigns recurring-payee PRs
// across the two groups. Bipartite assignment finds the partition that
// maximizes pairings — equivalent to your manual deductive process of
// confirming batch links from unambiguous matches first.
//
// Critical invariant: every DA in every DA batch must end up paired
// under correct data. Any DA still un-paired is surfaced via
// `BatchLink.unmatchedDaIds`. The recompute layer reports the count.
//
// This module only does the matching math — pure functions, no DB or
// classifier coupling. The recompute layer threads these into
// recon_links + state writes.

import {
  parseDAReference,
  parsePRReference,
  type DAReferenceParts,
  type PRReferenceParts,
} from "./references.ts";

// =============================================================
// Inputs
// =============================================================

export interface PRRowForBatch {
  id: string;
  posted_at: string; // YYYY-MM-DD
  reference: string;
  amountMinor: bigint;
  description: string;
  normPayerName?: string | null;
}

export interface DARowForBatch {
  id: string;
  posted_at: string;
  reference: string;
  amountMinor: bigint;
  payerNameRaw: string | null;
  normPayerName?: string | null;
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
 * Cap on enumeration scenarios. Above this, fall back to greedy. Real
 * BAC data has at most ~10 PR batches per day with 2-3 DA batches per
 * day, well under the cap. Anything larger is a data anomaly worth
 * investigating manually. Lowered to 5,000 to keep CPU runtime under 15ms.
 */
const ASSIGNMENT_ENUM_CAP = 5_000;

/**
 * Greedy DA→PR matching inside a fixed `(daBatch, prBatches)` group.
 * Returns pairings + ids of DAs that didn't find a match. Mutates
 * `usedPrIds` to include every successful pairing.
 */
function matchWithinGroup(
  daBatch: DABatch,
  prBatches: PRBatch[],
  usedPrIds: Set<string>,
  options: LinkOptions,
): { pairings: BatchPairing[]; unmatchedDaIds: string[] } {
  const pairings: BatchPairing[] = [];
  const unmatchedDaIds: string[] = [];

  for (const da of daBatch.rows) {
    const daName =
      da.normPayerName ??
      (da.payerNameRaw ? options.normalize(da.payerNameRaw) : null);
    if (!daName) {
      unmatchedDaIds.push(da.id);
      continue;
    }

    let found: PRRowForBatch | null = null;
    outer: for (const prBatch of prBatches) {
      for (const pr of prBatch.rows) {
        if (usedPrIds.has(pr.id)) continue;
        if (pr.amountMinor !== da.amountMinor) continue;

        let prName = pr.normPayerName;
        if (prName === undefined) {
          const raw = options.extractPRPayer(pr.description);
          prName = raw ? options.normalize(raw) : null;
        }
        if (!prName) continue;

        if (options.nameMatcher(prName, daName)) {
          found = pr;
          break outer;
        }
      }
    }

    if (found) {
      pairings.push({ daId: da.id, prId: found.id });
      usedPrIds.add(found.id);
    } else {
      unmatchedDaIds.push(da.id);
    }
  }
  return { pairings, unmatchedDaIds };
}

/**
 * Score a hypothetical assignment without mutating state. Returns the
 * total number of DAs that would pair if PR batches were partitioned
 * per `assignment`. Used by `solveAssignment` to compare scenarios.
 */
function scoreAssignment(
  prBatches: PRBatch[],
  daBatches: DABatch[],
  assignment: Map<string, string>,
  usedPrIds: Set<string>,
  options: LinkOptions,
): number {
  const scratch = new Set(usedPrIds);
  let total = 0;
  for (const daBatch of daBatches) {
    const assignedPRs = prBatches.filter(
      (b) => assignment.get(b.reference) === daBatch.id,
    );
    const res = matchWithinGroup(daBatch, assignedPRs, scratch, options);
    total += res.pairings.length;
  }
  return total;
}

/**
 * Solve the bipartite many-to-one assignment: each PR batch picks one
 * DA batch (or stays unassigned for a later day). Maximises total
 * pairings. Brute-force enumeration when (N+1)^M is tractable;
 * greedy-by-pair-score fallback above the cap.
 *
 * Date sanity is enforced: a PR batch can't be assigned to a DA batch
 * with posted_at < the PR batch's posted_at.
 */
function solveAssignment(
  prBatches: PRBatch[],
  daBatches: DABatch[],
  usedPrIds: Set<string>,
  options: LinkOptions,
): Map<string, string> {
  const M = prBatches.length;
  const N = daBatches.length;
  if (M === 0 || N === 0) return new Map();

  const totalScenarios = Math.pow(N + 1, M);
  if (totalScenarios > ASSIGNMENT_ENUM_CAP) {
    return solveAssignmentGreedy(prBatches, daBatches, usedPrIds, options);
  }

  let bestAssignment = new Map<string, string>();
  let bestScore = -1;
  let bestUnassigned = M + 1;

  for (let scenario = 0; scenario < totalScenarios; scenario++) {
    const assignment = new Map<string, string>();
    let unassigned = 0;
    let s = scenario;
    let valid = true;
    for (let i = 0; i < M; i++) {
      const choice = s % (N + 1);
      s = Math.floor(s / (N + 1));
      if (choice < N) {
        const da = daBatches[choice];
        if (prBatches[i].posted_at > da.posted_at) {
          valid = false;
          break;
        }
        assignment.set(prBatches[i].reference, da.id);
      } else {
        unassigned++;
      }
    }
    if (!valid) continue;
    const score = scoreAssignment(
      prBatches,
      daBatches,
      assignment,
      usedPrIds,
      options,
    );
    // Primary: max pairings. Secondary: minimum unassigned PR batches
    // (assigning more PR batches today reduces carryover load).
    if (
      score > bestScore ||
      (score === bestScore && unassigned < bestUnassigned)
    ) {
      bestScore = score;
      bestUnassigned = unassigned;
      bestAssignment = assignment;
    }
  }
  return bestAssignment;
}

/**
 * Greedy fallback when brute force is too expensive. For each
 * (PR batch, DA batch) pair, compute how many of the DA batch's DAs
 * could pair against the PR batch's PRs alone. Sort pairs by descending
 * score. Walk: assign PR batch → DA batch IF the PR batch isn't already
 * assigned and the score is non-zero. This is suboptimal in
 * pathological cases but handles the common cases fine.
 */
function solveAssignmentGreedy(
  prBatches: PRBatch[],
  daBatches: DABatch[],
  usedPrIds: Set<string>,
  options: LinkOptions,
): Map<string, string> {
  const scores: { prRef: string; daId: string; score: number }[] = [];
  for (const p of prBatches) {
    for (const d of daBatches) {
      if (p.posted_at > d.posted_at) continue;
      const scratch = new Set(usedPrIds);
      const score = matchWithinGroup(d, [p], scratch, options).pairings.length;
      if (score > 0) scores.push({ prRef: p.reference, daId: d.id, score });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const out = new Map<string, string>();
  for (const { prRef, daId } of scores) {
    if (!out.has(prRef)) out.set(prRef, daId);
  }
  return out;
}

// =============================================================
// Driver
// =============================================================

export interface BatchLinkingResult {
  links: BatchLink[];
  /** PR batch references not consumed by any link (still pending — may
   *  pair with DAs in a later statement). */
  unconsumedPRBatchReferences: string[];
}

/**
 * Process DA batches day-by-day in chronological order. Each day:
 *   - Candidate PR batches = all PR batches with posted_at <= today
 *     AND not yet claimed by a prior day's link.
 *   - Solve the bipartite assignment for today's DA batches.
 *   - Build a BatchLink per DA batch with the assigned PR batches.
 *   - Un-paired PRs in claimed batches → confirmedPrIds.
 *   - PR batches not assigned today → carry forward to the next day.
 */
export function linkAllBatches(
  prBatches: PRBatch[],
  daBatches: DABatch[],
  options: LinkOptions,
): BatchLinkingResult {
  const usedPrIds = new Set<string>();
  const claimedRefs = new Set<string>();
  const finalLinks: BatchLink[] = [];

  // Sort DA batches by (date, startSequence) — already done by
  // groupDABatches, but we don't trust the caller to have done it.
  const sortedDAs = [...daBatches].sort((a, b) => {
    if (a.posted_at !== b.posted_at) return a.posted_at < b.posted_at ? -1 : 1;
    return a.startSequence - b.startSequence;
  });

  let i = 0;
  while (i < sortedDAs.length) {
    const sameDate = sortedDAs[i].posted_at;
    const dayDAs: DABatch[] = [];
    while (i < sortedDAs.length && sortedDAs[i].posted_at === sameDate) {
      dayDAs.push(sortedDAs[i]);
      i++;
    }

    const candidates = prBatches
      .filter(
        (p) => !claimedRefs.has(p.reference) && p.posted_at <= sameDate,
      )
      .sort((a, b) => (a.reference < b.reference ? -1 : 1));

    const assignment = solveAssignment(candidates, dayDAs, usedPrIds, options);

    for (const daBatch of dayDAs) {
      const assignedPRs = candidates.filter(
        (p) => assignment.get(p.reference) === daBatch.id,
      );
      const { pairings, unmatchedDaIds } = matchWithinGroup(
        daBatch,
        assignedPRs,
        usedPrIds,
        options,
      );
      // Post-process: a PR batch that contributed ZERO pairings to its
      // assigned DA batch isn't truly linked — leave it unconsumed so
      // it can carry forward or be operator-handled. Only the batches
      // that produced at least one pairing become consumed.
      const pairedPrIds = new Set(pairings.map((p) => p.prId));
      const contributedRefs = new Set<string>();
      for (const prBatch of assignedPRs) {
        if (prBatch.rows.some((pr) => pairedPrIds.has(pr.id))) {
          contributedRefs.add(prBatch.reference);
        }
      }
      const consumedRefs: string[] = [];
      const confirmedPrIds: string[] = [];
      for (const prBatch of assignedPRs) {
        if (!contributedRefs.has(prBatch.reference)) continue;
        consumedRefs.push(prBatch.reference);
        claimedRefs.add(prBatch.reference);
        for (const pr of prBatch.rows) {
          if (!usedPrIds.has(pr.id)) confirmedPrIds.push(pr.id);
        }
      }
      finalLinks.push({
        daBatchId: daBatch.id,
        prBatchReferences: consumedRefs,
        pairings,
        confirmedPrIds,
        unmatchedDaIds,
      });
    }
  }

  const unconsumedPRBatchReferences = prBatches
    .filter((b) => !claimedRefs.has(b.reference))
    .map((b) => b.reference);

  return { links: finalLinks, unconsumedPRBatchReferences };
}
