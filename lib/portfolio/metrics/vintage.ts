// Vintage / cohort time-series compute.
//
// Given a chronological history of snapshots for the same entity,
// produce per-cohort delinquency curves indexed by months-on-book.
// This is the lender's apples-to-apples comparison: "how did the 2024
// vintage look at month 6 vs. how does the 2026 vintage look at month
// 6?". Tells you whether underwriting got better or worse.
//
// Slice 2 ships the pure compute; UI consumes once enough snapshots
// exist (the back-end stays correct even with one snapshot — it'll
// just produce single-point series).

import type { MetricFactBundle } from "./types";

export interface VintageObservation {
  /** ISO YYYY-MM-DD of the snapshot this observation comes from. */
  snapshotDate: string;
  /** Months between cohort origination and snapshot date. */
  monthsOnBook: number;
  /** Open loans in this cohort at the snapshot. */
  openLoanCount: number;
  /** Open principal/balance at the snapshot. */
  glpMinor: bigint;
  /** Sum balance of loans with DPD > 30 in the cohort at the snapshot. */
  par30Minor: bigint;
  /** Sum balance of loans with DPD >= 90 in the cohort at the snapshot. */
  nplMinor: bigint;
  /** par30Minor / glpMinor — NaN if cohort GLP is 0. */
  par30Rate: number;
  /** nplMinor / glpMinor — NaN if cohort GLP is 0. */
  nplRate: number;
}

export interface VintageSeries {
  /** Origination month YYYY-MM-01. */
  cohortMonth: string;
  /** Distinct loans ever originated in this cohort (count across all
   *  snapshots, deduplicated by source_loan_id). */
  originatedLoanCount: number;
  observations: VintageObservation[];
}

export interface VintageReport {
  entityId: string;
  series: VintageSeries[];
}

/**
 * Compute vintage curves from a history of snapshots.
 * Snapshots must be sorted ascending by date and share an entity.
 */
export function computeVintageReport(
  snapshots: MetricFactBundle[],
): VintageReport {
  if (snapshots.length === 0) {
    return { entityId: "", series: [] };
  }
  const entityId = snapshots[0].entityId;
  if (snapshots.some((s) => s.entityId !== entityId)) {
    throw new Error("computeVintageReport requires snapshots from one entity");
  }
  const sorted = [...snapshots].sort((a, b) =>
    a.snapshotDate.localeCompare(b.snapshotDate),
  );

  // cohortMonth → observations[]
  const seriesByCohort = new Map<string, VintageObservation[]>();
  // cohortMonth → Set<sourceLoanId>
  const loanIdsByCohort = new Map<string, Set<string>>();

  for (const snap of sorted) {
    // Aggregate this snapshot's loans by cohort_month.
    const buckets = new Map<
      string,
      {
        openCount: number;
        glp: bigint;
        par30: bigint;
        npl: bigint;
      }
    >();
    for (const l of snap.loans) {
      if (!l.cohortMonth) continue;
      // Track every loan we've ever seen in this cohort, even closed
      // ones, so originatedLoanCount is stable across snapshots.
      let ids = loanIdsByCohort.get(l.cohortMonth);
      if (!ids) {
        ids = new Set();
        loanIdsByCohort.set(l.cohortMonth, ids);
      }
      ids.add(l.sourceLoanId);

      if (l.statusNormalized === "closed") continue;
      const dpd = l.daysPastDue ?? 0;
      let bucket = buckets.get(l.cohortMonth);
      if (!bucket) {
        bucket = { openCount: 0, glp: 0n, par30: 0n, npl: 0n };
        buckets.set(l.cohortMonth, bucket);
      }
      bucket.openCount += 1;
      bucket.glp += l.balanceAmountMinor;
      if (dpd > 30) bucket.par30 += l.balanceAmountMinor;
      if (dpd >= 90) bucket.npl += l.balanceAmountMinor;
    }

    // Emit one observation per cohort.
    for (const [cohortMonth, agg] of buckets) {
      const monthsOnBook = monthsBetween(cohortMonth, snap.snapshotDate);
      if (monthsOnBook < 0) continue; // Defensive: cohort dated AFTER snapshot.
      let observations = seriesByCohort.get(cohortMonth);
      if (!observations) {
        observations = [];
        seriesByCohort.set(cohortMonth, observations);
      }
      observations.push({
        snapshotDate: snap.snapshotDate,
        monthsOnBook,
        openLoanCount: agg.openCount,
        glpMinor: agg.glp,
        par30Minor: agg.par30,
        nplMinor: agg.npl,
        par30Rate:
          agg.glp === 0n ? Number.NaN : Number(agg.par30) / Number(agg.glp),
        nplRate:
          agg.glp === 0n ? Number.NaN : Number(agg.npl) / Number(agg.glp),
      });
    }
  }

  const series: VintageSeries[] = [];
  for (const [cohortMonth, observations] of seriesByCohort) {
    series.push({
      cohortMonth,
      originatedLoanCount: loanIdsByCohort.get(cohortMonth)?.size ?? 0,
      observations: observations.sort((a, b) => a.monthsOnBook - b.monthsOnBook),
    });
  }
  // Newest cohort first — the one most likely to need attention.
  series.sort((a, b) => b.cohortMonth.localeCompare(a.cohortMonth));
  return { entityId, series };
}

/**
 * Snapshot of every cohort's status at a fixed months-on-book. Lets the
 * UI render a "PAR30 at month 6" comparison across vintages.
 */
export interface VintageCheckpoint {
  cohortMonth: string;
  /** Closest available observation to the target MoB. May be null if
   *  no snapshot captured that point yet. */
  observation: VintageObservation | null;
}

export function vintageAtMob(
  report: VintageReport,
  targetMob: number,
): VintageCheckpoint[] {
  return report.series.map((s) => {
    const exact = s.observations.find((o) => o.monthsOnBook === targetMob);
    if (exact) return { cohortMonth: s.cohortMonth, observation: exact };
    // Fall back to the latest observation at or before the target —
    // makes the table degrade gracefully on partial history.
    const before = [...s.observations]
      .filter((o) => o.monthsOnBook <= targetMob)
      .sort((a, b) => b.monthsOnBook - a.monthsOnBook)[0];
    return { cohortMonth: s.cohortMonth, observation: before ?? null };
  });
}

// =============================================================
// Helpers
// =============================================================

/**
 * Months between an origination month (YYYY-MM-01) and a snapshot date
 * (YYYY-MM-DD). Counts whole calendar months between them — day of
 * month not relevant since cohort is fixed to month-start.
 */
function monthsBetween(cohortMonth: string, snapshotDate: string): number {
  const cY = Number(cohortMonth.slice(0, 4));
  const cM = Number(cohortMonth.slice(5, 7));
  const sY = Number(snapshotDate.slice(0, 4));
  const sM = Number(snapshotDate.slice(5, 7));
  return (sY - cY) * 12 + (sM - cM);
}

// =============================================================
// Cross-snapshot loader helper
// =============================================================

/**
 * Loader for the entire snapshot history of an entity. Pulls one
 * MetricFactBundle per snapshot date.
 *
 * Intentionally not in loaders.ts to avoid pulling vintage compute into
 * the slice-1 surface — keeping things colocated by feature.
 */
export type LoadHistoryFn = (
  entityCode: string,
) => Promise<MetricFactBundle[]>;
