// Data-quality report for a portfolio snapshot.
//
// Pure computation: given the parsed bundle + the join results + the
// classifications, emit a list of DqMetric rows. The ingest pipeline
// persists these into portfolio_snapshot_dq so any deterioration is
// visible in the snapshot registry — the principle is "DQ issues are
// data, not log noise."
//
// Severity bands (intentionally simple — refine after the first weeks
// of real ingest):
//   match rate     critical < 50%, warn < 90%, else ok
//   completeness   critical < 1%,  warn < 50%, else ok
//   control total  critical > 5% drift, warn > 1%, else ok

import type {
  BorrowerJoinResult,
  DqMetric,
  LoanClassification,
  ParsedBorrowerRow,
  ParsedCsvBundle,
  ParsedLoanRow,
  PortfolioDqSeverity,
} from "./types";

interface ComputeDqArgs {
  bundle: ParsedCsvBundle;
  joinResults: BorrowerJoinResult[];
  loanClassifications: LoanClassification[]; // index-aligned with bundle.loans
}

export function computeDqMetrics(args: ComputeDqArgs): DqMetric[] {
  const { bundle, joinResults, loanClassifications } = args;
  const { borrowers, loans, repayments } = bundle;

  const metrics: DqMetric[] = [];

  // ---------- Borrower join (O2) ----------
  const totalLoans = loans.length;
  const resolved = joinResults.filter(
    (r) => r.confidence !== "unresolved",
  ).length;
  const unresolved = totalLoans - resolved;
  const matchRate = totalLoans > 0 ? resolved / totalLoans : 1;

  metrics.push({
    metric: "borrower_join_match_rate",
    valueNumeric: round4(matchRate),
    valueText: null,
    severity: bandMatchRate(matchRate),
    detail: {
      total_loans: totalLoans,
      resolved,
      unresolved,
      by_confidence: countBy(joinResults, (r) => r.confidence),
    },
  });

  metrics.push({
    metric: "borrower_join_unresolved_count",
    valueNumeric: unresolved,
    valueText: null,
    severity: unresolved === 0 ? "ok" : matchRate < 0.5 ? "critical" : "warn",
    detail: {},
  });

  // ---------- Field completeness ----------
  metrics.push(completeness(borrowers, "gender", (b) => b.gender));
  metrics.push(completeness(borrowers, "dob", (b) => b.dateOfBirth));
  metrics.push(
    completeness(borrowers, "credit_score", (b) =>
      b.creditScore === null ? null : String(b.creditScore),
    ),
  );
  metrics.push(completeness(borrowers, "working_status", (b) => b.workingStatus));
  metrics.push(completeness(borrowers, "email", (b) => b.email));
  metrics.push(completeness(borrowers, "mobile", (b) => b.mobile));

  // ---------- Control totals ----------
  // borrowers."Open Loans Balance" is total amount owed on open loans
  // (principal + interest + fees + penalty), not principal alone — so
  // compare it against loans."Balance Amount", not totalPrincipalBalance.
  // The smoke validation against the Crediclaro sample showed comparing
  // against totalPrincipalBalance produces a misleading 28% "drift" that
  // is really just the interest/fee component being excluded.
  const borrowerOpenSum = sumBigInt(borrowers, (b) =>
    b.openLoansBalanceMinor ?? 0n,
  );
  const loanOpenSum = sumBigInt(loans, (l, i) =>
    loanClassifications[i].statusNormalized === "closed"
      ? 0n
      : l.balanceAmountMinor ?? 0n,
  );
  metrics.push(
    controlTotalMetric(
      "control_total_open_balance",
      borrowerOpenSum,
      loanOpenSum,
    ),
  );

  const borrowerPaidSum = sumBigInt(
    borrowers,
    (b) => b.totalPaidAmountMinor ?? 0n,
  );
  const loanPaidSum = sumBigInt(loans, (l) => l.paidAmountMinor ?? 0n);
  metrics.push(
    controlTotalMetric(
      "control_total_paid_amount",
      borrowerPaidSum,
      loanPaidSum,
    ),
  );

  // ---------- Interest-rate sanity (DQ issue §4.5) ----------
  const outOfRange = loans.filter((l) => isInterestRateSuspicious(l)).length;
  metrics.push({
    metric: "interest_rate_out_of_range_count",
    valueNumeric: outOfRange,
    valueText: null,
    severity: outOfRange === 0 ? "ok" : "warn",
    detail: {
      criterion: "parsed_percent_gt_100",
      sample_loan_ids: loans
        .filter(isInterestRateSuspicious)
        .slice(0, 5)
        .map((l) => l.sourceLoanId),
    },
  });

  // ---------- Loan-officer field pollution (DQ issue §4.6) ----------
  const productInOfficer = loans.filter((l) =>
    looksLikeProductString(l.loanOfficerRaw),
  ).length;
  metrics.push({
    metric: "product_in_officer_field_count",
    valueNumeric: productInOfficer,
    valueText: null,
    severity: productInOfficer === 0 ? "ok" : "warn",
    detail: {},
  });

  // ---------- Legacy delinquent count (visibility) ----------
  const legacyCount = loanClassifications.filter(
    (c) => c.statusNormalized === "legacy_delinquent",
  ).length;
  metrics.push({
    metric: "legacy_delinquent_loan_count",
    valueNumeric: legacyCount,
    valueText: null,
    severity: "ok",
    detail: {},
  });

  // ---------- Repayment integrity ----------
  const loanIdSet = new Set(loans.map((l) => l.sourceLoanId));
  const orphans = repayments.filter((r) => !loanIdSet.has(r.sourceLoanId));
  metrics.push({
    metric: "orphan_repayment_count",
    valueNumeric: orphans.length,
    valueText: null,
    severity: orphans.length === 0 ? "ok" : "critical",
    detail: {
      sample_repayment_ids: orphans.slice(0, 5).map((o) => o.sourceRepaymentId),
    },
  });

  const repaymentsByLoan = countBy(repayments, (r) => r.sourceLoanId);
  const loansWithoutRepayment = loans.filter(
    (l) => !repaymentsByLoan[l.sourceLoanId],
  ).length;
  metrics.push({
    metric: "loans_with_no_repayment_count",
    valueNumeric: loansWithoutRepayment,
    valueText: null,
    severity: "ok",
    detail: {},
  });

  // ---------- Repayment method distribution ----------
  metrics.push({
    metric: "repayment_method_distribution",
    valueNumeric: null,
    valueText: null,
    severity: "ok",
    detail: {
      counts: countBy(repayments, (r) => r.method ?? "(null)"),
      cash_collection_count: repayments.filter((r) => r.isCashCollection).length,
      non_cash_count: repayments.filter((r) => !r.isCashCollection).length,
    },
  });

  // ---------- Cross-entity bank-account signal ----------
  const bankCounts = countBy(repayments, (r) =>
    r.bankAccountPaymentRaw ?? "(null)",
  );
  metrics.push({
    metric: "repayment_bank_account_distribution",
    valueNumeric: null,
    valueText: null,
    severity: "ok",
    detail: { counts: bankCounts },
  });

  return metrics;
}

// =============================================================
// Helpers
// =============================================================

function bandMatchRate(rate: number): PortfolioDqSeverity {
  if (rate < 0.5) return "critical";
  if (rate < 0.9) return "warn";
  return "ok";
}

function bandCompleteness(rate: number): PortfolioDqSeverity {
  if (rate < 0.01) return "critical";
  if (rate < 0.5) return "warn";
  return "ok";
}

function bandControlTotalDrift(drift: number): PortfolioDqSeverity {
  if (drift > 0.05) return "critical";
  if (drift > 0.01) return "warn";
  return "ok";
}

function completeness(
  rows: ParsedBorrowerRow[],
  field: string,
  pick: (r: ParsedBorrowerRow) => string | null,
): DqMetric {
  const total = rows.length;
  const filled = rows.filter((r) => pick(r) !== null).length;
  const rate = total === 0 ? 1 : filled / total;
  return {
    metric: `field_completeness_${field}`,
    valueNumeric: round4(rate),
    valueText: null,
    severity: bandCompleteness(rate),
    detail: { filled, total },
  };
}

function controlTotalMetric(
  name: string,
  borrowerSum: bigint,
  loanSum: bigint,
): DqMetric {
  const diff = borrowerSum - loanSum;
  const denom = borrowerSum === 0n ? 1n : absBigInt(borrowerSum);
  const drift = Number(absBigInt(diff)) / Number(denom);
  return {
    metric: name,
    valueNumeric: round4(drift),
    valueText: null,
    severity: bandControlTotalDrift(drift),
    detail: {
      borrower_sum_minor: borrowerSum.toString(),
      loan_sum_minor: loanSum.toString(),
      diff_minor: diff.toString(),
    },
  };
}

function isInterestRateSuspicious(loan: ParsedLoanRow): boolean {
  const raw = loan.interestRateRaw;
  if (!raw) return false;
  const cleaned = raw.replace(/[%\s]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) && n > 100;
}

function looksLikeProductString(s: string | null): boolean {
  if (!s) return false;
  const upper = s.toUpperCase();
  // Officers don't have "PRESTAMO" / "GARANTIA" in their name — these
  // are product names accidentally placed in the officer column.
  return (
    upper.includes("PRESTAMO") ||
    upper.includes("PRÉSTAMO") ||
    upper.includes("GARANTIA") ||
    upper.includes("GARANTÍA") ||
    upper.includes("ADELANTO DE VENTAS")
  );
}

function sumBigInt<T>(rows: T[], pick: (r: T, i: number) => bigint): bigint {
  let s = 0n;
  for (let i = 0; i < rows.length; i++) s += pick(rows[i], i);
  return s;
}

function absBigInt(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Re-export so the ingest layer can satisfy its type imports from one place.
export type { DqMetric } from "./types";
