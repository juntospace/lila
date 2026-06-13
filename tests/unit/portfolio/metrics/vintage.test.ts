import { describe, expect, it } from "vitest";

import {
  computeVintageReport,
  vintageAtMob,
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
    productGroup: null,
    managementVintage: "new",
    portfolioSegment: null,
    ifrsStage: "stage_1",
    isNpl: false,
    releasedDate: null,
    maturityDate: null,
    loanOfficerRaw: null,
    cohortMonth: null,
    cashCollectedMinor: 0n,
    writeOffMinor: 0n,
    cashCount: 0,
    finiquitoCount: 0,
    ...o,
  };
}

function bundle(date: string, loans: LoanFact[]): MetricFactBundle {
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

describe("computeVintageReport", () => {
  it("produces a series per cohort across multiple snapshots", () => {
    // Cohort 2026-04 has one loan that progressively gets worse.
    const snapshots = [
      bundle("2026-04-30", [
        loan({
          sourceLoanId: "A",
          cohortMonth: "2026-04-01",
          balanceAmountMinor: 1_000n,
          daysPastDue: 0,
        }),
      ]),
      bundle("2026-07-31", [
        loan({
          sourceLoanId: "A",
          cohortMonth: "2026-04-01",
          balanceAmountMinor: 900n,
          daysPastDue: 45,
        }),
      ]),
      bundle("2026-10-31", [
        loan({
          sourceLoanId: "A",
          cohortMonth: "2026-04-01",
          balanceAmountMinor: 800n,
          daysPastDue: 120,
        }),
      ]),
    ];
    const report = computeVintageReport(snapshots);
    const s = report.series.find((s) => s.cohortMonth === "2026-04-01");
    expect(s?.observations).toHaveLength(3);
    expect(s?.observations[0].monthsOnBook).toBe(0);
    expect(s?.observations[1].monthsOnBook).toBe(3);
    expect(s?.observations[2].monthsOnBook).toBe(6);
    expect(s?.observations[2].nplRate).toBe(1);
    expect(s?.observations[1].par30Rate).toBe(1);
  });

  it("tracks originatedLoanCount across closed and open loans", () => {
    const snapshots = [
      bundle("2026-06-13", [
        loan({ sourceLoanId: "A", cohortMonth: "2026-04-01" }),
        loan({ sourceLoanId: "B", cohortMonth: "2026-04-01", statusNormalized: "closed", balanceAmountMinor: 0n }),
      ]),
    ];
    const report = computeVintageReport(snapshots);
    const s = report.series.find((s) => s.cohortMonth === "2026-04-01");
    expect(s?.originatedLoanCount).toBe(2);
    expect(s?.observations[0].openLoanCount).toBe(1);
  });

  it("rejects mixed-entity history", () => {
    const a = bundle("2026-06-13", []);
    const b = { ...bundle("2026-06-14", []), entityId: "OTHER" };
    expect(() => computeVintageReport([a, b])).toThrow();
  });

  it("returns empty report for empty input", () => {
    const report = computeVintageReport([]);
    expect(report.series).toHaveLength(0);
  });
});

describe("vintageAtMob", () => {
  it("picks the exact-MoB observation when available", () => {
    const snapshots = [
      bundle("2026-04-30", [
        loan({ sourceLoanId: "A", cohortMonth: "2026-04-01" }),
      ]),
      bundle("2026-07-31", [
        loan({
          sourceLoanId: "A",
          cohortMonth: "2026-04-01",
          daysPastDue: 100,
        }),
      ]),
    ];
    const report = computeVintageReport(snapshots);
    const mob3 = vintageAtMob(report, 3);
    const cohort = mob3.find((c) => c.cohortMonth === "2026-04-01");
    expect(cohort?.observation?.monthsOnBook).toBe(3);
    expect(cohort?.observation?.nplRate).toBe(1);
  });

  it("falls back to the latest observation at or before target", () => {
    const snapshots = [
      bundle("2026-04-30", [
        loan({ sourceLoanId: "A", cohortMonth: "2026-04-01" }),
      ]),
    ];
    const report = computeVintageReport(snapshots);
    const mob6 = vintageAtMob(report, 6);
    const cohort = mob6.find((c) => c.cohortMonth === "2026-04-01");
    // Only MoB=0 was captured, so checkpoint @6 falls back to MoB=0.
    expect(cohort?.observation?.monthsOnBook).toBe(0);
  });

  it("returns null observation when no snapshot at or before target", () => {
    const snapshots = [
      bundle("2026-10-31", [
        loan({ sourceLoanId: "A", cohortMonth: "2026-04-01" }),
      ]),
    ];
    const report = computeVintageReport(snapshots);
    // 2026-10 vs cohort 2026-04 = 6 months on book.
    const mob3 = vintageAtMob(report, 3);
    const cohort = mob3.find((c) => c.cohortMonth === "2026-04-01");
    // No observation at or before 3 — only 6 exists. Should fall back to null.
    expect(cohort?.observation).toBeNull();
  });
});
