import { describe, expect, it } from "vitest";

import { buildCollectionsPlan } from "@/lib/portfolio/collections";
import { generateCollectionsWorkbook } from "@/lib/portfolio/excel";
import type { EnrichedLoan } from "@/lib/portfolio/types";

function mockLoan(overrides: Partial<EnrichedLoan>): EnrichedLoan {
  return {
    loanId: "1",
    loanNumber: "LN-001",
    fullName: "Juan Perez",
    borrowerMobile: "61234567",
    product: "Personal",
    segment: "Personal sin Garantía",
    segmentIdx: 2,
    secured: false,
    balance: 1000,
    dpd: 0,
    dpdLoandisk: 0,
    bucket: "Al día",
    bucketIdx: 0,
    cashAhead: false,
    isOpen: true,
    releasedDate: "2025-01-01",
    statusRaw: "Current",
    pastDue: 0,
    pendingDue: 0,
    totalDueAmount: 1200,
    loanDuration: "12",
    installmentsCount: 12,
    repaymentCycle: "Monthly",
    cycleType: 0,
    lastPaymentDate: "2025-06-01",
    lastPaymentAmount: 100,
    pg: "No",
    tg: "NA",
    tc: "Vigente",
    gc: "BCS",
    mr: "NA",
    comboKey: "2|NA|Vigente|BCS|NA",
    raw: {},
    ...overrides,
  };
}

describe("lib/portfolio/collections · Plan de Acción", () => {
  const asOf = "2025-06-30";

  it("excludes castigo candidates (dpd > threshold and dsp > 180)", () => {
    const castigoLoan = mockLoan({
      loanId: "C1",
      dpd: 200, // > 180 unsecured threshold
      lastPaymentDate: "2024-11-01", // > 180 days ago
      balance: 3500,
    });
    const recoverableLoan = mockLoan({
      loanId: "R1",
      dpd: 45,
      pastDue: 100,
      balance: 1200,
      lastPaymentDate: "2025-05-01",
    });

    const { plan, resumen } = buildCollectionsPlan({
      loans: [castigoLoan, recoverableLoan],
      asOfDate: asOf,
    });

    expect(resumen.castigo_excl).toBe(1);
    expect(resumen.castigo_saldo).toBe(3500);
    expect(plan.length).toBe(1);
    expect(plan[0].loanno).toBe(recoverableLoan.loanNumber);
  });

  it("classifies P1 cash_ahead loans with top score", () => {
    const loan = mockLoan({
      loanId: "P1-1",
      cashAhead: true,
      balance: 2000,
      dpd: 0,
      dpdLoandisk: 45,
    });

    const { plan } = buildCollectionsPlan({
      loans: [loan],
      asOfDate: asOf,
    });

    expect(plan.length).toBe(1);
    expect(plan[0].prio).toBe(1);
    expect(plan[0].score).toBe(2000 * 10);
    expect(plan[0].motivo).toContain("Contador DPD desfasado");
  });

  it("classifies P1 rolled a bucket", () => {
    const loan = mockLoan({
      loanId: "P1-2",
      dpd: 45,
      bucket: "31-60",
      bucketIdx: 2,
      balance: 1500,
    });

    const prevMap = { "P1-2": 1 }; // Was in "1-30" (idx 1), rolled to 2

    const { plan } = buildCollectionsPlan({
      loans: [loan],
      asOfDate: asOf,
      prevBucketMap: prevMap,
    });

    expect(plan.length).toBe(1);
    expect(plan[0].prio).toBe(1);
    expect(plan[0].score).toBe(1500 * 5);
    expect(plan[0].motivo).toContain("Rodó de tramo (1-30 → 31-60)");
  });

  it("classifies P2 cheap cure (0 < DPD <= 90 with low past due)", () => {
    const loan = mockLoan({
      loanId: "P2-1",
      dpd: 45,
      pastDue: 50,
      balance: 2500,
    });

    const { plan } = buildCollectionsPlan({
      loans: [loan],
      asOfDate: asOf,
    });

    expect(plan.length).toBe(1);
    expect(plan[0].prio).toBe(2);
    expect(plan[0].score).toBe((2500 / 50) * 100);
    expect(plan[0].motivo).toContain("Cura barata");
  });

  it("classifies P3 paying borrower in deep delinquency", () => {
    const loan = mockLoan({
      loanId: "P3-1",
      dpd: 120, // > 90
      lastPaymentDate: "2025-06-15", // 15 days ago (<= 90)
      balance: 4000,
      secured: true,
    });

    const { plan } = buildCollectionsPlan({
      loans: [loan],
      asOfDate: asOf,
    });

    expect(plan.length).toBe(1);
    expect(plan[0].prio).toBe(3);
    expect(plan[0].score).toBe(4000 * 1.5);
    expect(plan[0].motivo).toContain("Paga activo");
    expect(plan[0].motivo).toContain("rollover con garantía");
  });

  it("generates a valid Excel buffer with 3 sheets", async () => {
    const loan1 = mockLoan({ loanId: "1", cashAhead: true, balance: 1000 });
    const loan2 = mockLoan({ loanId: "2", dpd: 25, pastDue: 50, balance: 1500 });

    const { plan, resumen } = buildCollectionsPlan({
      loans: [loan1, loan2],
      asOfDate: asOf,
    });

    const buffer = await generateCollectionsWorkbook(plan, resumen, asOf);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000);
  });
});

