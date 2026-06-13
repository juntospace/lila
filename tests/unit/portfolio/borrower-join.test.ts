import { describe, expect, it } from "vitest";

import {
  buildBorrowerIndex,
  resolveAllBorrowerJoins,
  resolveBorrowerJoin,
} from "@/lib/portfolio/borrower-join";
import type {
  ParsedBorrowerRow,
  ParsedLoanRow,
} from "@/lib/portfolio/types";

function borrower(overrides: Partial<ParsedBorrowerRow> = {}): ParsedBorrowerRow {
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
    ...overrides,
  };
}

function loan(overrides: Partial<ParsedLoanRow> = {}): ParsedLoanRow {
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

describe("resolveBorrowerJoin", () => {
  it("exact-matches via uniqueNumber (custom code)", () => {
    const index = buildBorrowerIndex([
      borrower({ sourceBorrowerId: "B1", uniqueNumber: "EST004" }),
    ]);
    const result = resolveBorrowerJoin(
      loan({ sourceBorrowerRef: "EST004" }),
      index,
    );
    expect(result).toEqual({
      sourceLoanId: "L1",
      resolvedSourceBorrowerId: "B1",
      confidence: "exact_unique_number",
    });
  });

  it("exact-matches when borrowed-ref is the cédula format", () => {
    const index = buildBorrowerIndex([
      borrower({
        sourceBorrowerId: "B2",
        uniqueNumber: "8-937-1696",
        cedulaNormalized: "8-937-1696",
      }),
    ]);
    const result = resolveBorrowerJoin(
      loan({ sourceBorrowerRef: "8-937-1696" }),
      index,
    );
    expect(result.confidence).toBe("exact_unique_number");
    expect(result.resolvedSourceBorrowerId).toBe("B2");
  });

  it("case-insensitive matching", () => {
    const index = buildBorrowerIndex([
      borrower({ sourceBorrowerId: "B3", uniqueNumber: "odoo0034" }),
    ]);
    const result = resolveBorrowerJoin(
      loan({ sourceBorrowerRef: "ODOO0034" }),
      index,
    );
    expect(result.resolvedSourceBorrowerId).toBe("B3");
  });

  it("falls back to normalized-name when the ref doesn't match", () => {
    const index = buildBorrowerIndex([
      borrower({
        sourceBorrowerId: "B4",
        uniqueNumber: "EST004",
        fullName: "Genessis Valeria Estrada Caridad",
        normalizedName: "CARIDAD ESTRADA GENESSIS VALERIA",
      }),
    ]);
    const result = resolveBorrowerJoin(
      loan({
        sourceBorrowerRef: "DOES_NOT_EXIST",
        raw: { "Full Name": "Genessis Valeria Estrada Caridad" },
      }),
      index,
    );
    expect(result.confidence).toBe("normalized_name");
    expect(result.resolvedSourceBorrowerId).toBe("B4");
  });

  it("declines an ambiguous name match (more than one borrower)", () => {
    const index = buildBorrowerIndex([
      borrower({
        sourceBorrowerId: "B5",
        normalizedName: "DOE JANE",
      }),
      borrower({
        sourceBorrowerId: "B6",
        normalizedName: "DOE JANE",
      }),
    ]);
    const result = resolveBorrowerJoin(
      loan({ raw: { "Full Name": "Jane Doe" } }),
      index,
    );
    expect(result).toEqual({
      sourceLoanId: "L1",
      resolvedSourceBorrowerId: null,
      confidence: "unresolved",
    });
  });

  it("returns unresolved when no signals match", () => {
    const index = buildBorrowerIndex([
      borrower({ sourceBorrowerId: "B7", uniqueNumber: "A" }),
    ]);
    const result = resolveBorrowerJoin(
      loan({
        sourceBorrowerRef: "X",
        raw: { "Full Name": "Someone Else" },
      }),
      index,
    );
    expect(result.confidence).toBe("unresolved");
    expect(result.resolvedSourceBorrowerId).toBeNull();
  });
});

describe("resolveAllBorrowerJoins", () => {
  it("aligns the output array with the loans array index-for-index", () => {
    const borrowers = [
      borrower({ sourceBorrowerId: "B1", uniqueNumber: "EST004" }),
      borrower({ sourceBorrowerId: "B2", uniqueNumber: "ODOO0034" }),
    ];
    const loans = [
      loan({ sourceLoanId: "L1", sourceBorrowerRef: "EST004" }),
      loan({ sourceLoanId: "L2", sourceBorrowerRef: "WHO?" }),
      loan({ sourceLoanId: "L3", sourceBorrowerRef: "ODOO0034" }),
    ];
    const results = resolveAllBorrowerJoins(loans, borrowers);
    expect(results.map((r) => r.sourceLoanId)).toEqual(["L1", "L2", "L3"]);
    expect(results.map((r) => r.confidence)).toEqual([
      "exact_unique_number",
      "unresolved",
      "exact_unique_number",
    ]);
  });
});
