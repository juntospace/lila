import { describe, expect, it } from "vitest";

import { computeDqMetrics } from "@/lib/portfolio/dq";
import { classifyLoan } from "@/lib/portfolio/normalize";
import { resolveAllBorrowerJoins } from "@/lib/portfolio/borrower-join";
import type {
  BorrowerJoinResult,
  DqMetric,
  ParsedBorrowerRow,
  ParsedCsvBundle,
  ParsedLoanRow,
  ParsedRepaymentRow,
  PortfolioPolicy,
  PortfolioPolicyId,
} from "@/lib/portfolio/types";

const POLICY: PortfolioPolicy = {
  id: "00000000-0000-0000-0000-000000000001" as PortfolioPolicyId,
  effectiveFrom: "2026-01-01",
  chargeOffDpdThreshold: 365,
  managementCutoffDate: "2025-01-01",
  cashAdvanceAlwaysNew: true,
  stage2DpdMin: 30,
  stage3DpdMin: 90,
  nplDpdMin: 90,
  eclStage1Coverage: null,
  eclStage2Coverage: null,
  eclStage3Coverage: null,
};

function borrower(o: Partial<ParsedBorrowerRow> = {}): ParsedBorrowerRow {
  return {
    sourceBorrowerId: "B1",
    uniqueNumber: null,
    cedulaNormalized: null,
    fullName: null,
    lastName: null,
    firstName: null,
    gender: null,
    age: null,
    dateOfBirth: null,
    email: null,
    mobile: null,
    landline: null,
    address: null,
    city: null,
    province: null,
    zipcode: null,
    country: null,
    workingStatus: null,
    business: null,
    creditScore: null,
    loanOfficerRaw: null,
    borrowerStatusRaw: null,
    createdDate: null,
    numberOfLoans: null,
    numberOfOpenLoans: null,
    numberOfFullyPaidLoans: null,
    numberOfDefaultedLoans: null,
    numberOfProcessingLoans: null,
    numberOfRestructuredLoans: null,
    numberOfDeniedLoans: null,
    numberOfNotTakenUpLoans: null,
    totalPaidAmountMinor: null,
    openLoansBalanceMinor: null,
    normalizedName: null,
    raw: {},
    ...o,
  };
}

function loan(o: Partial<ParsedLoanRow> = {}): ParsedLoanRow {
  return {
    sourceLoanId: "L1",
    sourceLoanNumber: null,
    sourceBorrowerRef: null,
    productRaw: null,
    loanOfficerRaw: null,
    releasedDate: null,
    maturityDate: null,
    durationMonths: null,
    repaymentCycle: null,
    interestRateRaw: null,
    principalAmountMinor: null,
    balanceAmountMinor: null,
    totalPrincipalBalanceMinor: null,
    pendingPrincipalDueMinor: null,
    pastDueMinor: null,
    pendingDueMinor: null,
    paidAmountMinor: null,
    totalPrincipalPaidMinor: null,
    totalInterestPaidMinor: null,
    totalPenaltyPaidMinor: null,
    totalFeesPaidMinor: null,
    totalPenaltyBalanceMinor: null,
    totalFeesBalanceMinor: null,
    totalInterestBalanceMinor: null,
    nextInstallmentAmountMinor: null,
    nextInstallmentDate: null,
    lastPaymentAmountMinor: null,
    lastPaymentDate: null,
    daysPastDue: null,
    daysPastMaturity: null,
    daysToMaturity: null,
    bankAccountLoanReleased: null,
    statusRaw: null,
    raw: {},
    ...o,
  };
}

function repayment(o: Partial<ParsedRepaymentRow> = {}): ParsedRepaymentRow {
  return {
    sourceRepaymentId: "R1",
    sourceLoanId: "L1",
    sourceBorrowerRef: null,
    collectionDate: null,
    editDate: null,
    method: null,
    isCashCollection: true,
    principalPaidMinor: 0n,
    interestPaidMinor: 0n,
    penaltyPaidMinor: 0n,
    feesPaidMinor: 0n,
    totalPaidMinor: 0n,
    collectedBy: null,
    approvedBy: null,
    loanOfficerRaw: null,
    description: null,
    bankAccountPaymentRaw: null,
    raw: {},
    ...o,
  };
}

function bundle(args: {
  borrowers: ParsedBorrowerRow[];
  loans: ParsedLoanRow[];
  repayments: ParsedRepaymentRow[];
}): ParsedCsvBundle {
  return {
    borrowers: args.borrowers,
    loans: args.loans,
    repayments: args.repayments,
    meta: {
      borrowers: { filename: "b.csv", sha256: "x", byteSize: 0, rowCount: args.borrowers.length },
      loans: { filename: "l.csv", sha256: "y", byteSize: 0, rowCount: args.loans.length },
      repayments: { filename: "r.csv", sha256: "z", byteSize: 0, rowCount: args.repayments.length },
    },
  };
}

function findMetric(metrics: DqMetric[], name: string): DqMetric {
  const m = metrics.find((x) => x.metric === name);
  if (!m) throw new Error(`metric ${name} not found`);
  return m;
}

describe("computeDqMetrics", () => {
  it("computes borrower-join match rate and flags critical at < 50%", () => {
    const borrowers = [borrower({ sourceBorrowerId: "B1", uniqueNumber: "A" })];
    const loans = [
      loan({ sourceLoanId: "L1", sourceBorrowerRef: "A" }),
      loan({ sourceLoanId: "L2", sourceBorrowerRef: "?" }),
      loan({ sourceLoanId: "L3", sourceBorrowerRef: "?" }),
    ];
    const join = resolveAllBorrowerJoins(loans, borrowers);
    const cls = loans.map((l) => classifyLoan(l, POLICY));
    const metrics = computeDqMetrics({
      bundle: bundle({ borrowers, loans, repayments: [] }),
      joinResults: join,
      loanClassifications: cls,
    });
    const rate = findMetric(metrics, "borrower_join_match_rate");
    expect(rate.valueNumeric).toBeCloseTo(1 / 3, 4);
    expect(rate.severity).toBe("critical");
  });

  it("flags borrower-join match rate as warn between 50% and 90%", () => {
    const borrowers = [
      borrower({ sourceBorrowerId: "B1", uniqueNumber: "A" }),
      borrower({ sourceBorrowerId: "B2", uniqueNumber: "B" }),
    ];
    const loans = [
      loan({ sourceLoanId: "L1", sourceBorrowerRef: "A" }),
      loan({ sourceLoanId: "L2", sourceBorrowerRef: "?" }),
    ];
    const join = resolveAllBorrowerJoins(loans, borrowers);
    const cls = loans.map((l) => classifyLoan(l, POLICY));
    const metrics = computeDqMetrics({
      bundle: bundle({ borrowers, loans, repayments: [] }),
      joinResults: join,
      loanClassifications: cls,
    });
    expect(findMetric(metrics, "borrower_join_match_rate").severity).toBe(
      "warn",
    );
  });

  it("flags 0%-populated demographic fields as critical", () => {
    const borrowers = [borrower(), borrower({ sourceBorrowerId: "B2" })];
    const metrics = computeDqMetrics({
      bundle: bundle({ borrowers, loans: [], repayments: [] }),
      joinResults: [],
      loanClassifications: [],
    });
    expect(findMetric(metrics, "field_completeness_credit_score").severity).toBe(
      "critical",
    );
    expect(findMetric(metrics, "field_completeness_gender").severity).toBe(
      "critical",
    );
  });

  it("scores demographic fields as ok when fully populated", () => {
    const borrowers = [
      borrower({ sourceBorrowerId: "B1", gender: "Female" }),
      borrower({ sourceBorrowerId: "B2", gender: "Male" }),
    ];
    const metrics = computeDqMetrics({
      bundle: bundle({ borrowers, loans: [], repayments: [] }),
      joinResults: [],
      loanClassifications: [],
    });
    const gender = findMetric(metrics, "field_completeness_gender");
    expect(gender.valueNumeric).toBe(1);
    expect(gender.severity).toBe("ok");
  });

  it("flags an interest rate > 100% as suspicious", () => {
    const loans = [
      loan({ sourceLoanId: "L1", interestRateRaw: "36" }),
      loan({ sourceLoanId: "L2", interestRateRaw: "812.5" }),
    ];
    const cls = loans.map((l) => classifyLoan(l, POLICY));
    const metrics = computeDqMetrics({
      bundle: bundle({ borrowers: [], loans, repayments: [] }),
      joinResults: loans.map(
        (l): BorrowerJoinResult => ({
          sourceLoanId: l.sourceLoanId,
          resolvedSourceBorrowerId: null,
          confidence: "unresolved",
        }),
      ),
      loanClassifications: cls,
    });
    const out = findMetric(metrics, "interest_rate_out_of_range_count");
    expect(out.valueNumeric).toBe(1);
    expect(out.severity).toBe("warn");
  });

  it("detects product names polluting the loan-officer field", () => {
    const loans = [
      loan({ sourceLoanId: "L1", loanOfficerRaw: "Xochitl Perez" }),
      loan({
        sourceLoanId: "L2",
        loanOfficerRaw: "PRESTAMO CON GARANTIA DE AUTO",
      }),
    ];
    const cls = loans.map((l) => classifyLoan(l, POLICY));
    const metrics = computeDqMetrics({
      bundle: bundle({ borrowers: [], loans, repayments: [] }),
      joinResults: loans.map(
        (l): BorrowerJoinResult => ({
          sourceLoanId: l.sourceLoanId,
          resolvedSourceBorrowerId: null,
          confidence: "unresolved",
        }),
      ),
      loanClassifications: cls,
    });
    expect(findMetric(metrics, "product_in_officer_field_count").valueNumeric).toBe(
      1,
    );
  });

  it("flags orphan repayments as critical", () => {
    const loans = [loan({ sourceLoanId: "L1" })];
    const repayments = [
      repayment({ sourceRepaymentId: "R1", sourceLoanId: "L1" }),
      repayment({ sourceRepaymentId: "R2", sourceLoanId: "MISSING" }),
    ];
    const cls = loans.map((l) => classifyLoan(l, POLICY));
    const metrics = computeDqMetrics({
      bundle: bundle({ borrowers: [], loans, repayments }),
      joinResults: [
        { sourceLoanId: "L1", resolvedSourceBorrowerId: null, confidence: "unresolved" },
      ],
      loanClassifications: cls,
    });
    const orphans = findMetric(metrics, "orphan_repayment_count");
    expect(orphans.valueNumeric).toBe(1);
    expect(orphans.severity).toBe("critical");
  });

  it("computes control-total drift between borrower-table aggregate and per-loan sum", () => {
    const borrowers = [
      borrower({ sourceBorrowerId: "B1", openLoansBalanceMinor: 100000n }),
    ];
    const loans = [
      loan({
        sourceLoanId: "L1",
        statusRaw: "Current",
        daysPastDue: 0,
        totalPrincipalBalanceMinor: 99000n, // 1% drift
      }),
    ];
    const cls = loans.map((l) => classifyLoan(l, POLICY));
    const metrics = computeDqMetrics({
      bundle: bundle({ borrowers, loans, repayments: [] }),
      joinResults: [
        { sourceLoanId: "L1", resolvedSourceBorrowerId: null, confidence: "unresolved" },
      ],
      loanClassifications: cls,
    });
    const drift = findMetric(metrics, "control_total_open_balance");
    expect(drift.valueNumeric).toBeCloseTo(0.01, 4);
    // 1% drift is on the boundary; warn band starts at > 1%, so this is still ok.
    expect(drift.severity).toBe("ok");
  });

  it("treats Traspaso a Provision repayments as non-cash in the distribution", () => {
    const loans = [loan({ sourceLoanId: "L1" })];
    const repayments = [
      repayment({ sourceRepaymentId: "R1", sourceLoanId: "L1", method: "ACH" }),
      repayment({
        sourceRepaymentId: "R2",
        sourceLoanId: "L1",
        method: "Traspaso a Provision",
        isCashCollection: false,
      }),
    ];
    const cls = loans.map((l) => classifyLoan(l, POLICY));
    const metrics = computeDqMetrics({
      bundle: bundle({ borrowers: [], loans, repayments }),
      joinResults: [
        { sourceLoanId: "L1", resolvedSourceBorrowerId: null, confidence: "unresolved" },
      ],
      loanClassifications: cls,
    });
    const dist = findMetric(metrics, "repayment_method_distribution");
    expect(dist.detail).toMatchObject({
      cash_collection_count: 1,
      non_cash_count: 1,
    });
  });
});
