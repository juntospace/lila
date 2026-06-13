import { describe, expect, it } from "vitest";

import {
  classifyAgingBucket,
  computeKpiReport,
  computeKpiValue,
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
  id: "00000000-0000-0000-0000-000000000001" as PortfolioPolicyId,
  effectiveFrom: "2026-06-13",
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

function loan(overrides: Partial<LoanFact> = {}): LoanFact {
  return {
    loanPk: "pk-1",
    sourceLoanId: "L1",
    sourceBorrowerRef: null,
    resolvedSourceBorrowerId: null,
    entityId: "E1",
    snapshotId: "S1",
    snapshotDate: "2026-06-13",
    balanceAmountMinor: 100_000n,
    principalAmountMinor: 100_000n,
    paidAmountMinor: 0n,
    pastDueMinor: 0n,
    daysPastDue: 0,
    statusNormalized: "performing",
    productGroup: "personal_uncollateralized",
    managementVintage: "new",
    portfolioSegment: "new_personal",
    ifrsStage: "stage_1",
    isNpl: false,
    releasedDate: "2026-03-01",
    maturityDate: "2027-03-01",
    loanOfficerRaw: "Officer A",
    cohortMonth: "2026-03-01",
    cashCollectedMinor: 0n,
    writeOffMinor: 0n,
    cashCount: 0,
    finiquitoCount: 0,
    ...overrides,
  };
}

function bundle(overrides: Partial<MetricFactBundle> = {}): MetricFactBundle {
  return {
    snapshotId: "S1",
    snapshotDate: "2026-06-13",
    entityId: "E1",
    entityCode: "crediclaro",
    entityDisplayName: "Crediclaro",
    policy: POLICY,
    eclPlaceholder: true,
    loans: [],
    ...overrides,
  };
}

describe("classifyAgingBucket", () => {
  it("buckets DPD into the canonical ranges", () => {
    expect(classifyAgingBucket(0)).toBe("current");
    expect(classifyAgingBucket(null)).toBe("current");
    expect(classifyAgingBucket(1)).toBe("1-30");
    expect(classifyAgingBucket(30)).toBe("1-30");
    expect(classifyAgingBucket(31)).toBe("31-60");
    expect(classifyAgingBucket(60)).toBe("31-60");
    expect(classifyAgingBucket(90)).toBe("61-90");
    expect(classifyAgingBucket(91)).toBe("91-180");
    expect(classifyAgingBucket(180)).toBe("91-180");
    expect(classifyAgingBucket(181)).toBe("181-365");
    expect(classifyAgingBucket(365)).toBe("181-365");
    expect(classifyAgingBucket(366)).toBe("365+");
    expect(classifyAgingBucket(5000)).toBe("365+");
  });
});

describe("computeKpiValue", () => {
  it("computes GLP and counts from open loans only", () => {
    const loans = [
      loan({ sourceLoanId: "A", statusNormalized: "performing", balanceAmountMinor: 100n }),
      loan({ sourceLoanId: "B", statusNormalized: "delinquent", balanceAmountMinor: 200n }),
      loan({ sourceLoanId: "C", statusNormalized: "closed", balanceAmountMinor: 999n }),
    ];
    const v = computeKpiValue(loans, bundle());
    expect(v.countLoans).toBe(3);
    expect(v.countOpen).toBe(2);
    expect(v.glpMinor).toBe(300n);
    expect(v.avgTicketMinor).toBe(150n);
  });

  it("applies the policy's PAR thresholds strictly (> N days)", () => {
    const loans = [
      loan({ daysPastDue: 30, balanceAmountMinor: 100n, statusNormalized: "delinquent" }),
      loan({ daysPastDue: 31, balanceAmountMinor: 100n, statusNormalized: "delinquent" }),
      loan({ daysPastDue: 90, balanceAmountMinor: 100n, statusNormalized: "delinquent" }),
      loan({ daysPastDue: 91, balanceAmountMinor: 100n, statusNormalized: "delinquent" }),
    ];
    const v = computeKpiValue(loans, bundle());
    // PAR30 = DPD > 30 → 31, 90, 91 = 3 loans
    expect(v.par30Count).toBe(3);
    expect(v.par30Minor).toBe(300n);
    // PAR60 = DPD > 60 → 90, 91 = 2
    expect(v.par60Count).toBe(2);
    expect(v.par60Minor).toBe(200n);
    // PAR90 = DPD > 90 → 91 = 1
    expect(v.par90Count).toBe(1);
    expect(v.par90Minor).toBe(100n);
    // NPL = DPD >= 90 → 90, 91 = 2
    expect(v.nplCount).toBe(2);
    expect(v.nplMinor).toBe(200n);
  });

  it("computes weighted-average DPD by balance", () => {
    const loans = [
      loan({ daysPastDue: 10, balanceAmountMinor: 100n }),
      loan({ daysPastDue: 100, balanceAmountMinor: 900n }),
    ];
    const v = computeKpiValue(loans, bundle());
    // (10*100 + 100*900) / (100+900) = 91000/1000 = 91
    expect(v.weightedDpd).toBe(91);
  });

  it("applies ECL coverage by stage", () => {
    const loans = [
      loan({ ifrsStage: "stage_1", balanceAmountMinor: 10_000n }), // 1% → 100
      loan({ ifrsStage: "stage_2", balanceAmountMinor: 10_000n }), // 10% → 1000
      loan({ ifrsStage: "stage_3", balanceAmountMinor: 10_000n }), // 50% → 5000
    ];
    const v = computeKpiValue(loans, bundle());
    expect(v.stage1Minor).toBe(10_000n);
    expect(v.stage2Minor).toBe(10_000n);
    expect(v.stage3Minor).toBe(10_000n);
    expect(v.provisionsMinor).toBe(6_100n);
    expect(v.netPortfolioValueMinor).toBe(30_000n - 6_100n);
    // Coverage ratio = provisions / NPL. NPL is the stage_3 loan (DPD≥90 not
    // strictly required — is_npl unused here, only DPD). The DPD on
    // stage_3 default loan was set to 0 in fixture, so nplMinor=0.
    // To test coverage, set DPDs explicitly:
  });

  it("computes coverage ratio = provisions / NPL", () => {
    const loans = [
      loan({ ifrsStage: "stage_3", balanceAmountMinor: 1000n, daysPastDue: 100, statusNormalized: "delinquent" }),
    ];
    const v = computeKpiValue(loans, bundle());
    expect(v.nplMinor).toBe(1000n);
    expect(v.provisionsMinor).toBe(500n);
    expect(v.coverageRatio).toBe(0.5);
  });

  it("returns NaN ratios when GLP is zero", () => {
    const v = computeKpiValue([], bundle());
    expect(v.glpMinor).toBe(0n);
    expect(v.par30Ratio).toBeNaN();
    expect(v.nplRatio).toBeNaN();
    expect(v.provisionRate).toBeNaN();
    expect(v.weightedDpd).toBeNaN();
  });

  it("excludes closed loans from open-book money totals but counts them in totalPrincipalLent", () => {
    const loans = [
      loan({ statusNormalized: "closed", principalAmountMinor: 1_000n, balanceAmountMinor: 0n, paidAmountMinor: 1_000n }),
      loan({ statusNormalized: "performing", principalAmountMinor: 500n, balanceAmountMinor: 400n }),
    ];
    const v = computeKpiValue(loans, bundle());
    expect(v.glpMinor).toBe(400n);
    expect(v.openPrincipalLentMinor).toBe(500n);
    expect(v.totalPrincipalLentMinor).toBe(1_500n);
    expect(v.totalPaidMinor).toBe(1_000n);
  });

  it("rolls up legacy book sub-metrics", () => {
    const loans = [
      loan({
        statusNormalized: "legacy_delinquent",
        principalAmountMinor: 1_000n,
        balanceAmountMinor: 200n,
        cashCollectedMinor: 500n,
        writeOffMinor: 300n,
      }),
      loan({
        statusNormalized: "legacy_delinquent",
        principalAmountMinor: 2_000n,
        balanceAmountMinor: 500n,
        cashCollectedMinor: 0n,
      }),
      loan({ statusNormalized: "performing", principalAmountMinor: 100n }),
    ];
    const v = computeKpiValue(loans, bundle());
    expect(v.legacyCount).toBe(2);
    expect(v.legacyPrincipalLentMinor).toBe(3_000n);
    expect(v.legacyCashCollectedMinor).toBe(500n);
    expect(v.legacyOutstandingMinor).toBe(700n);
    expect(v.legacyWriteOffMinor).toBe(300n);
    expect(v.legacyRecoveryRate).toBeCloseTo(500 / 3000, 4);
  });
});

describe("computeKpiReport", () => {
  it("slices a mixed book across all dimensions", () => {
    const loans = [
      // Old-personal delinquent
      loan({
        sourceLoanId: "A",
        portfolioSegment: "old_personal",
        managementVintage: "old",
        productGroup: "personal_uncollateralized",
        ifrsStage: "stage_3",
        statusNormalized: "delinquent",
        balanceAmountMinor: 1_000n,
        daysPastDue: 100,
        cohortMonth: "2023-05-01",
        loanOfficerRaw: "Officer X",
      }),
      // New cash advance performing
      loan({
        sourceLoanId: "B",
        portfolioSegment: "cash_advance",
        managementVintage: "new",
        productGroup: "cash_advance",
        ifrsStage: "stage_1",
        statusNormalized: "performing",
        balanceAmountMinor: 5_000n,
        daysPastDue: 0,
        cohortMonth: "2026-04-01",
        loanOfficerRaw: "Officer Y",
      }),
      // Closed
      loan({
        sourceLoanId: "C",
        portfolioSegment: "old_personal",
        managementVintage: "old",
        productGroup: "personal_uncollateralized",
        ifrsStage: "closed",
        statusNormalized: "closed",
        balanceAmountMinor: 0n,
        daysPastDue: 0,
      }),
    ];
    const report = computeKpiReport(bundle({ loans }));
    expect(report.total.countLoans).toBe(3);
    expect(report.total.countOpen).toBe(2);
    expect(report.total.glpMinor).toBe(6_000n);

    // by management vintage — sorted by GLP desc, "new" wins (5000) over "old" (1000)
    expect(report.byManagementVintage[0].key).toBe("new");
    expect(report.byManagementVintage[0].value.glpMinor).toBe(5_000n);
    expect(report.byManagementVintage[1].key).toBe("old");
    expect(report.byManagementVintage[1].value.glpMinor).toBe(1_000n);

    // by segment
    const cashAdvance = report.bySegment.find((s) => s.key === "cash_advance");
    const oldPersonal = report.bySegment.find((s) => s.key === "old_personal");
    expect(cashAdvance?.value.glpMinor).toBe(5_000n);
    expect(oldPersonal?.value.glpMinor).toBe(1_000n);
    expect(oldPersonal?.value.countLoans).toBe(2); // closed C + open A

    // by IFRS stage (excluding closed loans is handled at the byAgingBucket level
    // but the byIfrsStage report includes all loan stages including 'closed')
    const stage3 = report.byIfrsStage.find((s) => s.key === "stage_3");
    expect(stage3?.value.glpMinor).toBe(1_000n);

    // by aging bucket — open loans only
    const current = report.byAgingBucket.find((s) => s.key === "current");
    const range91 = report.byAgingBucket.find((s) => s.key === "91-180");
    expect(current?.value.glpMinor).toBe(5_000n);
    expect(range91?.value.glpMinor).toBe(1_000n);

    // by cohort — three distinct cohorts since C kept the fixture default
    expect(report.byCohortMonth.length).toBe(3);
    const cohort2026 = report.byCohortMonth.find((c) => c.key === "2026-04-01");
    expect(cohort2026?.value.glpMinor).toBe(5_000n);

    // by officer — A, B, and C (which kept the fixture default officer)
    expect(report.byLoanOfficer.length).toBe(3);
  });

  it("produces an aging distribution that sums to GLP", () => {
    const loans = [
      loan({ daysPastDue: 0, balanceAmountMinor: 100n, statusNormalized: "performing" }),
      loan({ daysPastDue: 15, balanceAmountMinor: 200n, statusNormalized: "delinquent" }),
      loan({ daysPastDue: 200, balanceAmountMinor: 300n, statusNormalized: "delinquent" }),
      loan({ daysPastDue: 1000, balanceAmountMinor: 400n, statusNormalized: "legacy_delinquent" }),
      loan({ daysPastDue: 0, balanceAmountMinor: 999n, statusNormalized: "closed" }),
    ];
    const report = computeKpiReport(bundle({ loans }));
    const total = report.agingDistribution.buckets.reduce(
      (acc, b) => acc + b.balanceMinor,
      0n,
    );
    expect(total).toBe(report.total.glpMinor);
    expect(total).toBe(1_000n);
    // Spot-check shares are coherent.
    const current = report.agingDistribution.buckets.find(
      (b) => b.bucket === "current",
    )!;
    expect(current.balanceMinor).toBe(100n);
    expect(current.shareOfGlp).toBeCloseTo(0.1, 4);
  });
});
