import { describe, expect, it } from "vitest";

import {
  classifyIfrsStage,
  classifyLoan,
  classifyManagementVintage,
  classifyPortfolioSegment,
  classifyProductGroup,
  classifyStatus,
  isNpl,
} from "@/lib/portfolio/normalize";
import type {
  ParsedLoanRow,
  PortfolioPolicy,
  PortfolioPolicyId,
} from "@/lib/portfolio/types";

const DEFAULT_POLICY: PortfolioPolicy = {
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

function fixture(overrides: Partial<ParsedLoanRow> = {}): ParsedLoanRow {
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
    ...overrides,
  };
}

describe("classifyProductGroup", () => {
  it("maps personal non-collateralized", () => {
    expect(
      classifyProductGroup("Préstamo Personal sin Garantía hasta 5,000 (viejo)"),
    ).toBe("personal_uncollateralized");
  });

  it("maps cash advance", () => {
    expect(classifyProductGroup("Adelanto de Ventas desde 5.000.00")).toBe(
      "cash_advance",
    );
  });

  it("maps collateralized personal", () => {
    expect(classifyProductGroup("Préstamo con Garantía de Auto")).toBe(
      "personal_collateralized",
    );
  });

  it("returns other for unrecognized / null", () => {
    expect(classifyProductGroup("Something Else")).toBe("other");
    expect(classifyProductGroup(null)).toBe("other");
  });
});

describe("classifyStatus", () => {
  it("treats Fully Paid / Restructured as closed regardless of DPD", () => {
    expect(classifyStatus("Fully Paid", 0, DEFAULT_POLICY)).toBe("closed");
    expect(classifyStatus("Restructured", 999, DEFAULT_POLICY)).toBe("closed");
  });

  it("treats DPD==0 as performing", () => {
    expect(classifyStatus("Current", 0, DEFAULT_POLICY)).toBe("performing");
    expect(classifyStatus("Past Maturity", 0, DEFAULT_POLICY)).toBe(
      "performing",
    );
  });

  it("treats 0 < DPD <= 365 as delinquent", () => {
    expect(classifyStatus("Past Maturity", 90, DEFAULT_POLICY)).toBe(
      "delinquent",
    );
    expect(classifyStatus("Missed Repayment", 365, DEFAULT_POLICY)).toBe(
      "delinquent",
    );
  });

  it("treats DPD > 365 as legacy_delinquent", () => {
    expect(classifyStatus("Past Maturity", 366, DEFAULT_POLICY)).toBe(
      "legacy_delinquent",
    );
    expect(classifyStatus("Past Maturity", 2500, DEFAULT_POLICY)).toBe(
      "legacy_delinquent",
    );
  });
});

describe("classifyManagementVintage", () => {
  it("forces cash advance to new", () => {
    expect(
      classifyManagementVintage("cash_advance", "2020-05-01", DEFAULT_POLICY),
    ).toBe("new");
  });

  it("uses released_date vs cutoff for personal", () => {
    expect(
      classifyManagementVintage(
        "personal_uncollateralized",
        "2025-01-01",
        DEFAULT_POLICY,
      ),
    ).toBe("new");
    expect(
      classifyManagementVintage(
        "personal_uncollateralized",
        "2024-12-31",
        DEFAULT_POLICY,
      ),
    ).toBe("old");
  });

  it("treats undated personal as old", () => {
    expect(
      classifyManagementVintage("personal_uncollateralized", null, DEFAULT_POLICY),
    ).toBe("old");
  });
});

describe("classifyPortfolioSegment", () => {
  it("rolls up the three strategic segments", () => {
    expect(classifyPortfolioSegment("personal_uncollateralized", "old")).toBe(
      "old_personal",
    );
    expect(classifyPortfolioSegment("personal_collateralized", "new")).toBe(
      "new_personal",
    );
    expect(classifyPortfolioSegment("cash_advance", "new")).toBe("cash_advance");
    expect(classifyPortfolioSegment("other", "new")).toBe("other");
  });
});

describe("classifyIfrsStage", () => {
  it("returns closed when the loan is closed", () => {
    expect(classifyIfrsStage("closed", 0, DEFAULT_POLICY)).toBe("closed");
  });

  it("buckets by DPD against policy thresholds", () => {
    expect(classifyIfrsStage("performing", 0, DEFAULT_POLICY)).toBe("stage_1");
    expect(classifyIfrsStage("delinquent", 29, DEFAULT_POLICY)).toBe("stage_1");
    expect(classifyIfrsStage("delinquent", 30, DEFAULT_POLICY)).toBe("stage_2");
    expect(classifyIfrsStage("delinquent", 89, DEFAULT_POLICY)).toBe("stage_2");
    expect(classifyIfrsStage("delinquent", 90, DEFAULT_POLICY)).toBe("stage_3");
    expect(classifyIfrsStage("legacy_delinquent", 2000, DEFAULT_POLICY)).toBe(
      "stage_3",
    );
  });
});

describe("isNpl", () => {
  it("flips at the NPL threshold", () => {
    expect(isNpl(89, DEFAULT_POLICY)).toBe(false);
    expect(isNpl(90, DEFAULT_POLICY)).toBe(true);
    expect(isNpl(null, DEFAULT_POLICY)).toBe(false);
  });
});

describe("classifyLoan (top-level)", () => {
  it("classifies a delinquent personal loan from 2024 (old, mid-DPD)", () => {
    const loan = fixture({
      productRaw: "Préstamo Personal sin Garantía hasta 5,000 (viejo)",
      releasedDate: "2024-12-10",
      statusRaw: "Past Maturity",
      daysPastDue: 120,
    });
    expect(classifyLoan(loan, DEFAULT_POLICY)).toEqual({
      productGroup: "personal_uncollateralized",
      statusNormalized: "delinquent",
      managementVintage: "old",
      portfolioSegment: "old_personal",
      ifrsStage: "stage_3",
      isNpl: true,
    });
  });

  it("classifies a cash-advance loan from 2026 (new, performing)", () => {
    const loan = fixture({
      productRaw: "Adelanto de Ventas desde 5.000.00",
      releasedDate: "2026-03-15",
      statusRaw: "Current",
      daysPastDue: 0,
    });
    expect(classifyLoan(loan, DEFAULT_POLICY)).toEqual({
      productGroup: "cash_advance",
      statusNormalized: "performing",
      managementVintage: "new",
      portfolioSegment: "cash_advance",
      ifrsStage: "stage_1",
      isNpl: false,
    });
  });

  it("classifies a legacy delinquent (DPD ≫ 365)", () => {
    const loan = fixture({
      productRaw: "Préstamo Personal sin Garantía hasta 5,000 (viejo)",
      releasedDate: "2018-06-01",
      statusRaw: "Past Maturity",
      daysPastDue: 2500,
    });
    const result = classifyLoan(loan, DEFAULT_POLICY);
    expect(result.statusNormalized).toBe("legacy_delinquent");
    expect(result.portfolioSegment).toBe("old_personal");
    expect(result.isNpl).toBe(true);
  });
});
