// KPI engine type contracts.
//
// LoanFact is the projected loan row the metric engine operates on —
// everything else (KpiValue, KpiReport, AgingDistribution) is derived
// from a LoanFact[] + the active policy.

import type {
  PortfolioIfrsStage,
  PortfolioLoanStatus,
  PortfolioManagementVintage,
  PortfolioPolicy,
  PortfolioProductGroup,
  PortfolioSegment,
} from "../types";

// =============================================================
// Inputs
// =============================================================

/**
 * One row per loan, sourced from portfolio_loan_metric_facts (the view
 * that joins portfolio_loans with the per-loan repayment rollup).
 */
export interface LoanFact {
  loanPk: string;
  sourceLoanId: string;
  entityId: string;
  snapshotId: string;
  snapshotDate: string;

  balanceAmountMinor: bigint;
  principalAmountMinor: bigint;
  paidAmountMinor: bigint;
  pastDueMinor: bigint;
  daysPastDue: number | null;

  statusNormalized: PortfolioLoanStatus | null;
  productGroup: PortfolioProductGroup | null;
  managementVintage: PortfolioManagementVintage | null;
  portfolioSegment: PortfolioSegment | null;
  ifrsStage: PortfolioIfrsStage | null;
  isNpl: boolean;

  releasedDate: string | null;
  maturityDate: string | null;
  loanOfficerRaw: string | null;
  cohortMonth: string | null;

  cashCollectedMinor: bigint;
  writeOffMinor: bigint;
  cashCount: number;
  finiquitoCount: number;
}

export interface MetricFactBundle {
  snapshotId: string;
  snapshotDate: string;
  entityId: string;
  entityCode: string;
  entityDisplayName: string;
  policy: PortfolioPolicy;
  /** True if the active policy's ECL coverage rates are still placeholders. */
  eclPlaceholder: boolean;
  loans: LoanFact[];
}

// =============================================================
// Outputs
// =============================================================

export const AGING_BUCKETS = [
  "current",
  "1-30",
  "31-60",
  "61-90",
  "91-180",
  "181-365",
  "365+",
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/**
 * Headline KPI values for a slice of loans (the whole book, or one
 * dimension's value). All money in minor units. Counts only include
 * loans projected into the slice.
 */
export interface KpiValue {
  /** Total loans in the slice (any status). */
  countLoans: number;
  /** Open loans (status_normalized != 'closed'). */
  countOpen: number;
  /** Gross Loan Portfolio — Σ balance for OPEN loans. */
  glpMinor: bigint;
  /** Active borrowers behind open loans. NOT computed at slice level
   *  (requires distinct borrower-id pass across slices); set at the
   *  TOTAL level only by the compute function. */
  countActiveBorrowers: number;
  /** Average ticket — GLP / countOpen, in minor. */
  avgTicketMinor: bigint;
  /** Σ past_due_minor on open loans (cash actually in arrears). */
  pastDueMinor: bigint;

  /** PAR thresholds — Σ balance of OPEN loans with DPD > N. */
  par30Minor: bigint;
  par60Minor: bigint;
  par90Minor: bigint;
  par30Count: number;
  par60Count: number;
  par90Count: number;

  /** NPL = same as par90 in our policy (npl_dpd_min defaults 90). */
  nplMinor: bigint;
  nplCount: number;

  /** Σ(DPD * balance) / Σ balance for open loans. NaN if GLP=0. */
  weightedDpd: number;

  /** Stage distribution by balance. Closed excluded. */
  stage1Minor: bigint;
  stage2Minor: bigint;
  stage3Minor: bigint;

  /** ECL provisions = Σ (balance * stage_coverage_rate) over open loans. */
  provisionsMinor: bigint;
  /** Net Portfolio Value = GLP − provisions. */
  netPortfolioValueMinor: bigint;
  /** Coverage Ratio = provisions / nplMinor. NaN if nplMinor=0. */
  coverageRatio: number;
  /** Provision Rate = provisions / GLP. NaN if GLP=0. */
  provisionRate: number;

  /** NPL Ratio = nplMinor / GLP. NaN if GLP=0. */
  nplRatio: number;
  /** PAR30 / PAR60 / PAR90 ratios (Σ balance / GLP). NaN if GLP=0. */
  par30Ratio: number;
  par60Ratio: number;
  par90Ratio: number;

  /** Σ principal_amount_minor for OPEN loans (all-time disbursed still on book). */
  openPrincipalLentMinor: bigint;
  /** Σ principal_amount_minor for ALL loans in the slice. */
  totalPrincipalLentMinor: bigint;
  /** Σ paid_amount_minor for ALL loans in the slice. */
  totalPaidMinor: bigint;

  /** Legacy book (status = 'legacy_delinquent') roll-up: */
  legacyCount: number;
  legacyOutstandingMinor: bigint;
  legacyPrincipalLentMinor: bigint;
  legacyCashCollectedMinor: bigint;
  legacyWriteOffMinor: bigint;
  /** Recovery rate to date = legacy cash collected / legacy principal lent. */
  legacyRecoveryRate: number;
}

export interface AgingDistributionBucket {
  bucket: AgingBucket;
  countLoans: number;
  balanceMinor: bigint;
  /** Bucket balance / GLP. NaN if GLP=0. */
  shareOfGlp: number;
}

export interface AgingDistribution {
  glpMinor: bigint;
  buckets: AgingDistributionBucket[];
}

export interface SegmentBreakdown<TKey extends string = string> {
  key: TKey;
  value: KpiValue;
}

export interface KpiReport {
  fact: MetricFactBundle;
  total: KpiValue;
  agingDistribution: AgingDistribution;
  byEntity: SegmentBreakdown[];
  byManagementVintage: SegmentBreakdown[];
  bySegment: SegmentBreakdown[];
  byProductGroup: SegmentBreakdown[];
  byIfrsStage: SegmentBreakdown[];
  byAgingBucket: SegmentBreakdown<AgingBucket>[];
  byCohortMonth: SegmentBreakdown[];
  byLoanOfficer: SegmentBreakdown[];
}
