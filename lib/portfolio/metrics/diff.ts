// Snapshot-pair metrics — comparing two snapshots (t-1, t) of the same
// entity. Roll rate, transition matrix, cure rate, growth, leading
// indicators. Pure compute, no I/O.

import { classifyAgingBucket } from "./kpis";
import type { AgingBucket, LoanFact, MetricFactBundle } from "./types";
import { AGING_BUCKETS } from "./types";

// =============================================================
// Types
// =============================================================

/**
 * One cell of the roll-rate matrix. `fromBucket` is the loan's aging
 * bucket at t-1, `toBucket` at t. balance is the loan's t-1 balance —
 * the standard roll-rate denominator is "where was this money?", so we
 * weight by where it stood, not where it landed.
 */
export interface RollCell {
  fromBucket: AgingBucket | "new" | "closed-in-window";
  toBucket: AgingBucket | "closed" | "removed";
  countLoans: number;
  balanceMinor: bigint;
}

export interface SnapshotDiffReport {
  /** Snapshot at t-1 (older) and t (newer). */
  from: MetricFactBundle;
  to: MetricFactBundle;
  /** Days between snapshots. */
  daysBetween: number;

  /** Full transition matrix — every (from, to) pair with non-zero loans. */
  rollMatrix: RollCell[];

  /** Curing (delinquent → current) — share of delinquent balance at t-1
   *  that became current at t. */
  cureRate: number;
  cureBalanceMinor: bigint;
  delinquentT0Minor: bigint;

  /** Early roll (current at t-1 → 1-30 at t). The single most
   *  diagnostic leading indicator for the new book. */
  earlyRollRate: number;
  earlyRollBalanceMinor: bigint;
  currentT0Minor: bigint;

  /** Flow rate to default — share of 61-90 at t-1 that became 91+ at t. */
  flowToDefaultRate: number;
  flowToDefaultBalanceMinor: bigint;
  band6190T0Minor: bigint;

  /** New originations between t-1 and t (loans whose released_date falls
   *  in (t-1, t]). */
  newLoanCount: number;
  newLoanPrincipalMinor: bigint;

  /** Total cash collected between snapshots — proxied as Δ paid_amount
   *  across all loans present in both snapshots. */
  cashCollectedMinor: bigint;
  /** Loans that disappeared between snapshots (closed / removed). */
  removedLoanCount: number;
  removedLoanBalanceT0Minor: bigint;

  /** Old→New migration: share of open GLP that's "new" vintage at each
   *  side, plus the delta. */
  newGlpShareFrom: number;
  newGlpShareTo: number;
  newGlpShareDelta: number;

  /** Convenience headlines for board KPI cards. */
  glpDeltaMinor: bigint;
  nplCountDelta: number;
  par30RatioDelta: number;
  countOpenDelta: number;
}

// =============================================================
// Public entry point
// =============================================================

export function computeSnapshotDiff(
  from: MetricFactBundle,
  to: MetricFactBundle,
): SnapshotDiffReport {
  if (from.entityId !== to.entityId) {
    throw new Error(
      `computeSnapshotDiff requires same entity (${from.entityId} vs ${to.entityId})`,
    );
  }
  if (from.snapshotDate > to.snapshotDate) {
    throw new Error(
      `from snapshot (${from.snapshotDate}) must be earlier than to (${to.snapshotDate})`,
    );
  }

  const daysBetween = daysBetweenIso(from.snapshotDate, to.snapshotDate);

  const fromById = new Map(from.loans.map((l) => [l.sourceLoanId, l]));
  const toById = new Map(to.loans.map((l) => [l.sourceLoanId, l]));

  // ---- Transition matrix ----
  const cells = new Map<string, RollCell>();
  const pushCell = (
    fromBucket: RollCell["fromBucket"],
    toBucket: RollCell["toBucket"],
    balanceMinor: bigint,
  ) => {
    const key = `${fromBucket}→${toBucket}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { fromBucket, toBucket, countLoans: 0, balanceMinor: 0n };
      cells.set(key, cell);
    }
    cell.countLoans += 1;
    cell.balanceMinor += balanceMinor;
  };

  // Loans present in t-1
  for (const f of from.loans) {
    const fromBucket = aging(f);
    const t = toById.get(f.sourceLoanId);
    if (!t) {
      // Disappeared in t.
      pushCell(fromBucket, "removed", f.balanceAmountMinor);
      continue;
    }
    if (t.statusNormalized === "closed") {
      pushCell(fromBucket, "closed", f.balanceAmountMinor);
      continue;
    }
    pushCell(fromBucket, aging(t), f.balanceAmountMinor);
  }
  // Loans new in t (not in t-1)
  for (const t of to.loans) {
    if (fromById.has(t.sourceLoanId)) continue;
    if (t.statusNormalized === "closed") {
      pushCell("new", "closed", t.balanceAmountMinor);
      continue;
    }
    pushCell("new", aging(t), t.balanceAmountMinor);
  }

  const rollMatrix = Array.from(cells.values());

  // ---- Cure rate ----
  let cureBalanceMinor = 0n;
  let delinquentT0Minor = 0n;
  for (const f of from.loans) {
    const fb = aging(f);
    if (fb === "current") continue;
    if (f.statusNormalized === "closed") continue;
    delinquentT0Minor += f.balanceAmountMinor;
    const t = toById.get(f.sourceLoanId);
    if (!t) continue;
    if (t.statusNormalized === "closed") continue;
    if (aging(t) === "current") cureBalanceMinor += f.balanceAmountMinor;
  }
  const cureRate =
    delinquentT0Minor === 0n
      ? Number.NaN
      : Number(cureBalanceMinor) / Number(delinquentT0Minor);

  // ---- Early roll rate ----
  let earlyRollBalanceMinor = 0n;
  let currentT0Minor = 0n;
  for (const f of from.loans) {
    if (aging(f) !== "current") continue;
    if (f.statusNormalized === "closed") continue;
    currentT0Minor += f.balanceAmountMinor;
    const t = toById.get(f.sourceLoanId);
    if (!t || t.statusNormalized === "closed") continue;
    if (aging(t) === "1-30") earlyRollBalanceMinor += f.balanceAmountMinor;
  }
  const earlyRollRate =
    currentT0Minor === 0n
      ? Number.NaN
      : Number(earlyRollBalanceMinor) / Number(currentT0Minor);

  // ---- Flow rate to default ----
  let flowToDefaultBalanceMinor = 0n;
  let band6190T0Minor = 0n;
  for (const f of from.loans) {
    if (aging(f) !== "61-90") continue;
    if (f.statusNormalized === "closed") continue;
    band6190T0Minor += f.balanceAmountMinor;
    const t = toById.get(f.sourceLoanId);
    if (!t || t.statusNormalized === "closed") continue;
    const tb = aging(t);
    if (tb === "91-180" || tb === "181-365" || tb === "365+") {
      flowToDefaultBalanceMinor += f.balanceAmountMinor;
    }
  }
  const flowToDefaultRate =
    band6190T0Minor === 0n
      ? Number.NaN
      : Number(flowToDefaultBalanceMinor) / Number(band6190T0Minor);

  // ---- New originations (released_date in (from, to]) ----
  let newLoanCount = 0;
  let newLoanPrincipalMinor = 0n;
  for (const t of to.loans) {
    if (!t.releasedDate) continue;
    if (t.releasedDate > from.snapshotDate && t.releasedDate <= to.snapshotDate) {
      newLoanCount += 1;
      newLoanPrincipalMinor += t.principalAmountMinor;
    }
  }

  // ---- Cash collected (proxy via Δ paid_amount on shared loans) ----
  let cashCollectedMinor = 0n;
  let removedLoanCount = 0;
  let removedLoanBalanceT0Minor = 0n;
  for (const f of from.loans) {
    const t = toById.get(f.sourceLoanId);
    if (!t) {
      removedLoanCount += 1;
      removedLoanBalanceT0Minor += f.balanceAmountMinor;
      continue;
    }
    const delta = t.paidAmountMinor - f.paidAmountMinor;
    if (delta > 0n) cashCollectedMinor += delta;
  }
  // Cash collected on new loans is also revenue in the window.
  for (const t of to.loans) {
    if (fromById.has(t.sourceLoanId)) continue;
    cashCollectedMinor += t.paidAmountMinor;
  }

  // ---- Old → New migration ----
  const fromGlp = sumOpenBalance(from.loans);
  const toGlp = sumOpenBalance(to.loans);
  const fromNewGlp = sumOpenBalanceMatching(
    from.loans,
    (l) => l.managementVintage === "new",
  );
  const toNewGlp = sumOpenBalanceMatching(
    to.loans,
    (l) => l.managementVintage === "new",
  );
  const newGlpShareFrom =
    fromGlp === 0n ? Number.NaN : Number(fromNewGlp) / Number(fromGlp);
  const newGlpShareTo =
    toGlp === 0n ? Number.NaN : Number(toNewGlp) / Number(toGlp);
  const newGlpShareDelta =
    Number.isFinite(newGlpShareFrom) && Number.isFinite(newGlpShareTo)
      ? newGlpShareTo - newGlpShareFrom
      : Number.NaN;

  // ---- Headline deltas ----
  const fromOpen = from.loans.filter(
    (l) => l.statusNormalized !== "closed",
  ).length;
  const toOpen = to.loans.filter(
    (l) => l.statusNormalized !== "closed",
  ).length;
  const fromPar30Minor = sumOpenBalanceMatching(
    from.loans,
    (l) => (l.daysPastDue ?? 0) > 30,
  );
  const toPar30Minor = sumOpenBalanceMatching(
    to.loans,
    (l) => (l.daysPastDue ?? 0) > 30,
  );
  const fromPar30Ratio =
    fromGlp === 0n ? Number.NaN : Number(fromPar30Minor) / Number(fromGlp);
  const toPar30Ratio =
    toGlp === 0n ? Number.NaN : Number(toPar30Minor) / Number(toGlp);
  const par30RatioDelta =
    Number.isFinite(fromPar30Ratio) && Number.isFinite(toPar30Ratio)
      ? toPar30Ratio - fromPar30Ratio
      : Number.NaN;
  const fromNplCount = from.loans.filter(
    (l) => l.statusNormalized !== "closed" && (l.daysPastDue ?? 0) >= 90,
  ).length;
  const toNplCount = to.loans.filter(
    (l) => l.statusNormalized !== "closed" && (l.daysPastDue ?? 0) >= 90,
  ).length;

  return {
    from,
    to,
    daysBetween,
    rollMatrix,
    cureRate,
    cureBalanceMinor,
    delinquentT0Minor,
    earlyRollRate,
    earlyRollBalanceMinor,
    currentT0Minor,
    flowToDefaultRate,
    flowToDefaultBalanceMinor,
    band6190T0Minor,
    newLoanCount,
    newLoanPrincipalMinor,
    cashCollectedMinor,
    removedLoanCount,
    removedLoanBalanceT0Minor,
    newGlpShareFrom,
    newGlpShareTo,
    newGlpShareDelta,
    glpDeltaMinor: toGlp - fromGlp,
    nplCountDelta: toNplCount - fromNplCount,
    par30RatioDelta,
    countOpenDelta: toOpen - fromOpen,
  };
}

// =============================================================
// Helpers
// =============================================================

function aging(l: LoanFact): AgingBucket {
  return classifyAgingBucket(l.daysPastDue);
}

function sumOpenBalance(loans: LoanFact[]): bigint {
  let s = 0n;
  for (const l of loans) {
    if (l.statusNormalized === "closed") continue;
    s += l.balanceAmountMinor;
  }
  return s;
}

function sumOpenBalanceMatching(
  loans: LoanFact[],
  match: (l: LoanFact) => boolean,
): bigint {
  let s = 0n;
  for (const l of loans) {
    if (l.statusNormalized === "closed") continue;
    if (!match(l)) continue;
    s += l.balanceAmountMinor;
  }
  return s;
}

function daysBetweenIso(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

// =============================================================
// Matrix layout helper for the UI
// =============================================================

/**
 * Layout the roll matrix as a 2D table indexed by from/to bucket. Rows
 * include "new" (originated in window) and columns include "closed" and
 * "removed". Returns numeric balance per cell in minor units (bigint).
 */
export interface MatrixLayout {
  fromBuckets: ReadonlyArray<RollCell["fromBucket"]>;
  toBuckets: ReadonlyArray<RollCell["toBucket"]>;
  /** [fromBucket][toBucket] → balance */
  balance: Record<string, Record<string, bigint>>;
  /** [fromBucket][toBucket] → count */
  count: Record<string, Record<string, number>>;
}

export const FROM_AXIS: ReadonlyArray<RollCell["fromBucket"]> = [
  ...AGING_BUCKETS,
  "new",
];
export const TO_AXIS: ReadonlyArray<RollCell["toBucket"]> = [
  ...AGING_BUCKETS,
  "closed",
  "removed",
];

export function layoutRollMatrix(cells: RollCell[]): MatrixLayout {
  const balance: Record<string, Record<string, bigint>> = {};
  const count: Record<string, Record<string, number>> = {};
  for (const fb of FROM_AXIS) {
    balance[fb] = {};
    count[fb] = {};
    for (const tb of TO_AXIS) {
      balance[fb][tb] = 0n;
      count[fb][tb] = 0;
    }
  }
  for (const c of cells) {
    balance[c.fromBucket][c.toBucket] = c.balanceMinor;
    count[c.fromBucket][c.toBucket] = c.countLoans;
  }
  return {
    fromBuckets: FROM_AXIS,
    toBuckets: TO_AXIS,
    balance,
    count,
  };
}
