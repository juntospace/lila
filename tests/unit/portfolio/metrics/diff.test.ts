import { describe, expect, it } from "vitest";

import {
  computeSnapshotDiff,
  layoutRollMatrix,
} from "@/lib/portfolio/metrics";
import type {
  LoanFact,
  MetricFactBundle,
} from "@/lib/portfolio/metrics";
import type {
  PortfolioPolicy,
  PortfolioPolicyId,
} from "@/lib/portfolio/types";

const POLICY: PortfolioPolicy = {
  id: "p" as PortfolioPolicyId,
  effectiveFrom: "2026-01-01",
  chargeOffDpdThreshold: 365,
  managementCutoffDate: "2025-01-01",
  cashAdvanceAlwaysNew: true,
  stage2DpdMin: 30,
  stage3DpdMin: 90,
  nplDpdMin: 90,
  eclStage1Coverage: 0.01,
  eclStage2Coverage: 0.1,
  eclStage3Coverage: 0.5,
};

function loan(o: Partial<LoanFact> = {}): LoanFact {
  return {
    loanPk: "pk",
    sourceLoanId: "L",
    sourceBorrowerRef: null,
    resolvedSourceBorrowerId: null,
    entityId: "E1",
    snapshotId: "S",
    snapshotDate: "2026-06-13",
    balanceAmountMinor: 1_000n,
    principalAmountMinor: 1_000n,
    paidAmountMinor: 0n,
    pastDueMinor: 0n,
    daysPastDue: 0,
    statusNormalized: "performing",
    productGroup: "personal_uncollateralized",
    managementVintage: "new",
    portfolioSegment: "new_personal",
    ifrsStage: "stage_1",
    isNpl: false,
    releasedDate: "2026-04-01",
    maturityDate: "2027-04-01",
    loanOfficerRaw: null,
    cohortMonth: "2026-04-01",
    cashCollectedMinor: 0n,
    writeOffMinor: 0n,
    cashCount: 0,
    finiquitoCount: 0,
    ...o,
  };
}

function bundle(
  date: string,
  loans: LoanFact[],
): MetricFactBundle {
  return {
    snapshotId: `S-${date}`,
    snapshotDate: date,
    entityId: "E1",
    entityCode: "crediclaro",
    entityDisplayName: "Crediclaro",
    policy: POLICY,
    eclPlaceholder: true,
    loans,
  };
}

describe("computeSnapshotDiff", () => {
  it("computes cure rate when a delinquent loan returns to current", () => {
    const fromB = bundle("2026-06-10", [
      loan({ sourceLoanId: "A", daysPastDue: 45, statusNormalized: "delinquent", balanceAmountMinor: 500n }),
      loan({ sourceLoanId: "B", daysPastDue: 100, statusNormalized: "delinquent", balanceAmountMinor: 500n }),
    ]);
    const toB = bundle("2026-06-13", [
      loan({ sourceLoanId: "A", daysPastDue: 0, statusNormalized: "performing", balanceAmountMinor: 500n }),
      loan({ sourceLoanId: "B", daysPastDue: 105, statusNormalized: "delinquent", balanceAmountMinor: 500n }),
    ]);
    const diff = computeSnapshotDiff(fromB, toB);
    // Delinquent balance at t-1 = 1000 (A + B). A cured.
    expect(diff.delinquentT0Minor).toBe(1_000n);
    expect(diff.cureBalanceMinor).toBe(500n);
    expect(diff.cureRate).toBe(0.5);
  });

  it("computes early roll rate (current → 1-30)", () => {
    const fromB = bundle("2026-06-10", [
      loan({ sourceLoanId: "A", daysPastDue: 0, balanceAmountMinor: 1000n }),
      loan({ sourceLoanId: "B", daysPastDue: 0, balanceAmountMinor: 1000n }),
    ]);
    const toB = bundle("2026-06-13", [
      loan({ sourceLoanId: "A", daysPastDue: 10, statusNormalized: "delinquent", balanceAmountMinor: 1000n }),
      loan({ sourceLoanId: "B", daysPastDue: 0, balanceAmountMinor: 1000n }),
    ]);
    const diff = computeSnapshotDiff(fromB, toB);
    expect(diff.currentT0Minor).toBe(2_000n);
    expect(diff.earlyRollBalanceMinor).toBe(1_000n);
    expect(diff.earlyRollRate).toBe(0.5);
  });

  it("computes flow to default (61-90 → 91+)", () => {
    const fromB = bundle("2026-06-10", [
      loan({ sourceLoanId: "A", daysPastDue: 70, statusNormalized: "delinquent", balanceAmountMinor: 1_000n }),
      loan({ sourceLoanId: "B", daysPastDue: 80, statusNormalized: "delinquent", balanceAmountMinor: 1_000n }),
    ]);
    const toB = bundle("2026-06-13", [
      loan({ sourceLoanId: "A", daysPastDue: 95, statusNormalized: "delinquent", balanceAmountMinor: 1_000n }),
      loan({ sourceLoanId: "B", daysPastDue: 85, statusNormalized: "delinquent", balanceAmountMinor: 1_000n }),
    ]);
    const diff = computeSnapshotDiff(fromB, toB);
    expect(diff.band6190T0Minor).toBe(2_000n);
    expect(diff.flowToDefaultBalanceMinor).toBe(1_000n);
    expect(diff.flowToDefaultRate).toBe(0.5);
  });

  it("counts new originations whose released_date falls in the window", () => {
    const fromB = bundle("2026-06-01", [
      loan({ sourceLoanId: "A", releasedDate: "2026-05-01" }),
    ]);
    const toB = bundle("2026-06-13", [
      loan({ sourceLoanId: "A", releasedDate: "2026-05-01" }),
      loan({ sourceLoanId: "B", releasedDate: "2026-06-05", principalAmountMinor: 3_000n }),
      loan({ sourceLoanId: "C", releasedDate: "2026-06-13", principalAmountMinor: 1_500n }),
    ]);
    const diff = computeSnapshotDiff(fromB, toB);
    expect(diff.newLoanCount).toBe(2); // B and C
    expect(diff.newLoanPrincipalMinor).toBe(4_500n);
  });

  it("treats removed loans as removed in the matrix and reports the count", () => {
    const fromB = bundle("2026-06-10", [
      loan({ sourceLoanId: "A", balanceAmountMinor: 500n }),
      loan({ sourceLoanId: "B", balanceAmountMinor: 800n }),
    ]);
    const toB = bundle("2026-06-13", [
      loan({ sourceLoanId: "A", balanceAmountMinor: 500n }),
    ]);
    const diff = computeSnapshotDiff(fromB, toB);
    expect(diff.removedLoanCount).toBe(1);
    expect(diff.removedLoanBalanceT0Minor).toBe(800n);
    const layout = layoutRollMatrix(diff.rollMatrix);
    expect(layout.balance.current.removed).toBe(800n);
  });

  it("buckets loans that closed in the window under 'closed' column", () => {
    const fromB = bundle("2026-06-10", [
      loan({ sourceLoanId: "A", balanceAmountMinor: 1_000n }),
    ]);
    const toB = bundle("2026-06-13", [
      loan({
        sourceLoanId: "A",
        statusNormalized: "closed",
        balanceAmountMinor: 0n,
      }),
    ]);
    const diff = computeSnapshotDiff(fromB, toB);
    const layout = layoutRollMatrix(diff.rollMatrix);
    expect(layout.balance.current.closed).toBe(1_000n);
    expect(layout.count.current.closed).toBe(1);
  });

  it("computes cash collected as Δ paid_amount across shared loans", () => {
    const fromB = bundle("2026-06-10", [
      loan({ sourceLoanId: "A", paidAmountMinor: 100n }),
      loan({ sourceLoanId: "B", paidAmountMinor: 200n }),
    ]);
    const toB = bundle("2026-06-13", [
      loan({ sourceLoanId: "A", paidAmountMinor: 150n }), // +50
      loan({ sourceLoanId: "B", paidAmountMinor: 200n }), // unchanged
      loan({ sourceLoanId: "C", paidAmountMinor: 75n, releasedDate: "2026-06-12" }), // new, all 75
    ]);
    const diff = computeSnapshotDiff(fromB, toB);
    expect(diff.cashCollectedMinor).toBe(125n);
  });

  it("computes old→new migration share", () => {
    const fromB = bundle("2026-06-10", [
      loan({
        sourceLoanId: "A",
        managementVintage: "old",
        balanceAmountMinor: 800n,
      }),
      loan({
        sourceLoanId: "B",
        managementVintage: "new",
        balanceAmountMinor: 200n,
      }),
    ]);
    const toB = bundle("2026-06-13", [
      loan({
        sourceLoanId: "A",
        managementVintage: "old",
        balanceAmountMinor: 750n,
      }),
      loan({
        sourceLoanId: "B",
        managementVintage: "new",
        balanceAmountMinor: 200n,
      }),
      loan({
        sourceLoanId: "C",
        managementVintage: "new",
        balanceAmountMinor: 300n,
        releasedDate: "2026-06-12",
      }),
    ]);
    const diff = computeSnapshotDiff(fromB, toB);
    expect(diff.newGlpShareFrom).toBeCloseTo(0.2, 4);
    expect(diff.newGlpShareTo).toBeCloseTo(500 / 1250, 4);
    expect(diff.newGlpShareDelta).toBeCloseTo(500 / 1250 - 0.2, 4);
  });

  it("rejects diffs with mismatched entities", () => {
    const fromB = bundle("2026-06-10", []);
    const wrongEntity = { ...bundle("2026-06-13", []), entityId: "OTHER" };
    expect(() => computeSnapshotDiff(fromB, wrongEntity)).toThrow();
  });

  it("rejects reversed snapshot order", () => {
    const a = bundle("2026-06-13", []);
    const b = bundle("2026-06-10", []);
    expect(() => computeSnapshotDiff(a, b)).toThrow();
  });
});
