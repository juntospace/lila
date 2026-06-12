// Loan normalization + classification.
//
// Given a parsed loan row + the active policy, decide:
//   - product_group         (LoanDisk product name → enum)
//   - status_normalized     (LoanDisk status + DPD → enum, applying the
//                            charge-off / legacy threshold)
//   - management_vintage    (released_date vs cutoff, Cash Advance override)
//   - portfolio_segment     (rollup of product_group × management_vintage)
//   - ifrs_stage            (DPD bucketed by stage_2/3 thresholds)
//   - is_npl                (DPD >= npl_dpd_min)
//
// All policy values flow in from the active portfolio_policy row so the
// classification of any past snapshot can be re-derived if the policy
// changes.

import type {
  LoanClassification,
  ParsedLoanRow,
  PortfolioIfrsStage,
  PortfolioLoanStatus,
  PortfolioManagementVintage,
  PortfolioPolicy,
  PortfolioProductGroup,
  PortfolioSegment,
} from "./types";

// =============================================================
// Product group
// =============================================================

/**
 * Map a LoanDisk product name to a stable product_group. The Crediclaro
 * export uses Spanish names with accents; we lowercase + strip accents
 * before matching to be resilient to small text changes.
 *
 * Observed inputs (Crediclaro sample):
 *   "Préstamo Personal sin Garantía hasta 5,000 (viejo)" → personal_uncollateralized
 *   "Adelanto de Ventas desde 5.000.00"                  → cash_advance
 *   "Préstamo con Garantía de Auto"                      → personal_collateralized
 */
export function classifyProductGroup(
  productRaw: string | null,
): PortfolioProductGroup {
  if (!productRaw) return "other";
  const t = productRaw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

  // Cash Advance (Adelanto de Ventas) — Junto's base business.
  if (t.includes("adelanto de ventas") || t.includes("cash advance")) {
    return "cash_advance";
  }
  // Collateralized personal — "con garantia" / "with collateral".
  if (
    t.includes("con garantia") ||
    t.includes("with collateral") ||
    t.includes("garantia de auto") ||
    t.includes("garantia hipotecaria")
  ) {
    return "personal_collateralized";
  }
  // Non-collateralized personal — "sin garantia" / explicit "personal".
  if (
    t.includes("sin garantia") ||
    t.includes("prestamo personal") ||
    t.includes("personal sin")
  ) {
    return "personal_uncollateralized";
  }
  return "other";
}

// =============================================================
// Status (normalized to active/closed/legacy buckets)
// =============================================================

/**
 * LoanDisk status strings observed in the Crediclaro sample:
 *   Fully Paid, Restructured       → closed (out of book)
 *   Current, Due Today             → performing
 *   Missed Repayment, Arrears,
 *   Past Maturity                  → performing if DPD == 0, else
 *                                    delinquent / legacy_delinquent
 *
 * The legacy split applies regardless of the status string because the
 * sample shows "Past Maturity" loans with DPD ranging from a few days
 * to thousands; the policy threshold is the source of truth, not the
 * label.
 */
export function classifyStatus(
  statusRaw: string | null,
  daysPastDue: number | null,
  policy: PortfolioPolicy,
): PortfolioLoanStatus {
  const s = (statusRaw ?? "").trim().toLowerCase();
  if (s === "fully paid" || s === "restructured") return "closed";

  const dpd = daysPastDue ?? 0;
  if (dpd > policy.chargeOffDpdThreshold) return "legacy_delinquent";
  if (dpd > 0) return "delinquent";
  return "performing";
}

// =============================================================
// Management vintage
// =============================================================

/**
 * Old vs new management. Cash Advance is always tagged "new" (it's the
 * current management's base product line) when the policy flag says so.
 * If released_date is missing we conservatively call it "old" — an
 * undated origination shouldn't quietly inflate the new-portfolio view.
 */
export function classifyManagementVintage(
  productGroup: PortfolioProductGroup,
  releasedDate: string | null,
  policy: PortfolioPolicy,
): PortfolioManagementVintage {
  if (policy.cashAdvanceAlwaysNew && productGroup === "cash_advance") {
    return "new";
  }
  if (!releasedDate) return "old";
  // ISO date string comparison is lexicographic-correct for YYYY-MM-DD.
  return releasedDate >= policy.managementCutoffDate ? "new" : "old";
}

// =============================================================
// Portfolio segment
// =============================================================

export function classifyPortfolioSegment(
  productGroup: PortfolioProductGroup,
  managementVintage: PortfolioManagementVintage,
): PortfolioSegment {
  if (productGroup === "cash_advance") return "cash_advance";
  if (
    productGroup === "personal_collateralized" ||
    productGroup === "personal_uncollateralized"
  ) {
    return managementVintage === "new" ? "new_personal" : "old_personal";
  }
  return "other";
}

// =============================================================
// IFRS stage + NPL flag
// =============================================================

export function classifyIfrsStage(
  statusNormalized: PortfolioLoanStatus,
  daysPastDue: number | null,
  policy: PortfolioPolicy,
): PortfolioIfrsStage {
  if (statusNormalized === "closed") return "closed";
  const dpd = daysPastDue ?? 0;
  if (dpd >= policy.stage3DpdMin) return "stage_3";
  if (dpd >= policy.stage2DpdMin) return "stage_2";
  return "stage_1";
}

export function isNpl(
  daysPastDue: number | null,
  policy: PortfolioPolicy,
): boolean {
  const dpd = daysPastDue ?? 0;
  return dpd >= policy.nplDpdMin;
}

// =============================================================
// Top-level classify
// =============================================================

export function classifyLoan(
  loan: ParsedLoanRow,
  policy: PortfolioPolicy,
): LoanClassification {
  const productGroup = classifyProductGroup(loan.productRaw);
  const statusNormalized = classifyStatus(
    loan.statusRaw,
    loan.daysPastDue,
    policy,
  );
  const managementVintage = classifyManagementVintage(
    productGroup,
    loan.releasedDate,
    policy,
  );
  const portfolioSegment = classifyPortfolioSegment(
    productGroup,
    managementVintage,
  );
  const ifrsStage = classifyIfrsStage(statusNormalized, loan.daysPastDue, policy);
  return {
    productGroup,
    statusNormalized,
    managementVintage,
    portfolioSegment,
    ifrsStage,
    isNpl: isNpl(loan.daysPastDue, policy),
  };
}
