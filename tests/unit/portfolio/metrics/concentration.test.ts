import { describe, expect, it } from "vitest";

import {
  computeConcentration,
  computeRepeatBorrowers,
} from "@/lib/portfolio/metrics";
import type { LoanFact } from "@/lib/portfolio/metrics";

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
    managementVintage: null,
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

describe("computeConcentration", () => {
  it("groups loans under the same resolved borrower id", () => {
    const loans = [
      loan({
        sourceLoanId: "A",
        resolvedSourceBorrowerId: "B1",
        balanceAmountMinor: 500n,
      }),
      loan({
        sourceLoanId: "B",
        resolvedSourceBorrowerId: "B1",
        balanceAmountMinor: 700n,
      }),
      loan({
        sourceLoanId: "C",
        resolvedSourceBorrowerId: "B2",
        balanceAmountMinor: 300n,
      }),
    ];
    const c = computeConcentration(loans);
    expect(c.activeBorrowers).toBe(2);
    expect(c.glpMinor).toBe(1_500n);
    expect(c.top[0].borrowerId).toBe("B1");
    expect(c.top[0].glpMinor).toBe(1_200n);
    expect(c.top[0].openLoanCount).toBe(2);
    expect(c.largestExposureShare).toBeCloseTo(1200 / 1500, 4);
  });

  it("treats unresolved loans as their own borrowers (worst case for concentration)", () => {
    const loans = [
      loan({
        sourceLoanId: "A",
        resolvedSourceBorrowerId: null,
        balanceAmountMinor: 500n,
      }),
      loan({
        sourceLoanId: "B",
        resolvedSourceBorrowerId: null,
        balanceAmountMinor: 500n,
      }),
    ];
    const c = computeConcentration(loans);
    expect(c.activeBorrowers).toBe(2);
    expect(c.top.length).toBe(2);
    expect(c.top.every((e) => e.unresolved)).toBe(true);
  });

  it("excludes closed loans from open count + GLP but counts them in total", () => {
    const loans = [
      loan({
        sourceLoanId: "A",
        resolvedSourceBorrowerId: "B1",
        balanceAmountMinor: 0n,
        statusNormalized: "closed",
      }),
      loan({
        sourceLoanId: "B",
        resolvedSourceBorrowerId: "B1",
        balanceAmountMinor: 600n,
      }),
    ];
    const c = computeConcentration(loans);
    expect(c.activeBorrowers).toBe(1);
    expect(c.totalBorrowers).toBe(1);
    expect(c.top[0].openLoanCount).toBe(1);
    expect(c.top[0].loanCount).toBe(2);
  });

  it("computes top-10 and top-25 shares", () => {
    const loans = Array.from({ length: 30 }, (_, i) =>
      loan({
        sourceLoanId: `L${i}`,
        resolvedSourceBorrowerId: `B${i}`,
        balanceAmountMinor: BigInt(30 - i) * 100n, // descending
      }),
    );
    const c = computeConcentration(loans);
    const top10Sum = Array.from({ length: 10 }, (_, i) =>
      BigInt(30 - i) * 100n,
    ).reduce((a, b) => a + b, 0n);
    const totalSum = Array.from({ length: 30 }, (_, i) =>
      BigInt(30 - i) * 100n,
    ).reduce((a, b) => a + b, 0n);
    expect(c.top10Share).toBeCloseTo(Number(top10Sum) / Number(totalSum), 4);
  });

  it("returns NaN largestExposureShare on empty book", () => {
    expect(computeConcentration([]).largestExposureShare).toBeNaN();
  });
});

describe("computeRepeatBorrowers", () => {
  it("counts borrowers with ≥ 2 open loans", () => {
    const loans = [
      loan({ sourceLoanId: "1", resolvedSourceBorrowerId: "B1" }),
      loan({ sourceLoanId: "2", resolvedSourceBorrowerId: "B1" }),
      loan({ sourceLoanId: "3", resolvedSourceBorrowerId: "B2" }),
      loan({ sourceLoanId: "4", resolvedSourceBorrowerId: "B3" }),
      loan({ sourceLoanId: "5", resolvedSourceBorrowerId: "B3" }),
    ];
    const r = computeRepeatBorrowers(loans);
    expect(r.activeBorrowers).toBe(3); // B1, B2, B3
    expect(r.repeatBorrowers).toBe(2); // B1, B3
    expect(r.repeatBorrowerRate).toBeCloseTo(2 / 3, 4);
  });

  it("returns NaN when no active borrowers", () => {
    expect(computeRepeatBorrowers([]).repeatBorrowerRate).toBeNaN();
  });
});
