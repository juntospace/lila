import { describe, expect, it } from "vitest";

import { buildCollectionsPlan } from "@/lib/portfolio/collections";
import {
  enrichLoans,
  enrichRepayments,
  PROV_RATES,
} from "@/lib/portfolio/enrich";

describe("lib/portfolio/parity · Mathematical Parity against Python Engine", () => {
  // A representative dataset covering edge cases:
  // - Cash ahead loans (past due = 0 or pending due = 0 with dpd > 0)
  // - Rollover / restructured loans
  // - Fully paid loans
  // - Collateralized personal vs Adelantos vs Uncollateralized
  // - Deep delinquency with recent payments (P3)
  // - Castigo threshold breaches with and without recent payments
  const sampleLoansTape: Record<string, string>[] = [
    {
      "Loan Id": "1001",
      "Loan #": "LN-001",
      "Full Name": "Carlos Mendoza",
      "Loan Product": "Adelanto de Ventas 5k",
      "Balance Amount": "3,450.75",
      "Days Past Due": "0",
      "Released Date": "15/06/2025",
      "Loan Status Name": "Current",
      "Past Due": "0.00",
      "Pending Due": "0.00",
      "Prestamo Garantizado": "Si", // Should still be Adelantos
    },
    {
      "Loan Id": "1002",
      "Loan #": "LN-002",
      "Full Name": "Ana Morales",
      "Loan Product": "Préstamo Personal",
      "Balance Amount": "2,100.00",
      "Days Past Due": "45",
      "Released Date": "10/01/2025",
      "Loan Status Name": "Arrears",
      "Past Due": "0.00", // Cash ahead! Past Due is 0 but DPD is 45
      "Pending Due": "150.00",
      "Prestamo Garantizado": "Si", // Personal con Garantía
    },
    {
      "Loan Id": "1003",
      "Loan #": "LN-003",
      "Full Name": "Pedro Castillo",
      "Loan Product": "Préstamo Personal sin Garantía",
      "Balance Amount": "1,850.50",
      "Days Past Due": "35",
      "Released Date": "20/04/2024",
      "Loan Status Name": "Arrears",
      "Past Due": "45.00", // Cheap cure candidate (P2)
      "Pending Due": "45.00",
      "Prestamo Garantizado": "No",
    },
    {
      "Loan Id": "1004",
      "Loan #": "LN-004",
      "Full Name": "Luisa Fernandez",
      "Loan Product": "Personal con Garantía de Auto",
      "Balance Amount": "6,500.00",
      "Days Past Due": "120", // Deep arrears > 90, secured
      "Released Date": "01/02/2024",
      "Loan Status Name": "Arrears",
      "Past Due": "850.00",
      "Pending Due": "850.00",
      "Last Payment Date": "10/06/2025", // Recent payment (<= 90 days from cut 2025-06-30) -> P3 candidate
      "Prestamo Garantizado": "Si",
    },
    {
      "Loan Id": "1005",
      "Loan #": "LN-005",
      "Full Name": "Roberto Gomez",
      "Loan Product": "Personal sin Garantía",
      "Balance Amount": "4,200.00",
      "Days Past Due": "210", // > 180 unsecured threshold
      "Released Date": "15/03/2023",
      "Loan Status Name": "Past Maturity",
      "Past Due": "4,200.00",
      "Pending Due": "4,200.00",
      "Last Payment Date": "15/08/2024", // > 180 days ago -> Castigo candidate!
      "Prestamo Garantizado": "No",
    },
    {
      "Loan Id": "1006",
      "Loan #": "LN-006",
      "Full Name": "Elena Rostova",
      "Loan Product": "Préstamo Personal",
      "Balance Amount": "5,000.00",
      "Days Past Due": "60",
      "Released Date": "01/05/2025",
      "Loan Status Name": "Restructured", // Rollover -> Must be excluded from open book
      "Past Due": "0.00",
      "Pending Due": "0.00",
    },
    {
      "Loan Id": "1007",
      "Loan #": "LN-007",
      "Full Name": "Marcos Diaz",
      "Loan Product": "Préstamo Personal",
      "Balance Amount": "0.20", // Small balance <= 0.5 -> Must be excluded
      "Days Past Due": "0",
      "Released Date": "01/01/2025",
      "Loan Status Name": "Current",
    },
  ];

  const sampleRepaymentsTape: Record<string, string>[] = [
    {
      "Loan Id": "1001",
      "Collection Date": "20/06/2025",
      "Principal Paid Amount": "200.00",
      "Interest Paid Amount": "50.00",
      "Payment Method": "ACH",
    },
    {
      "Loan Id": "1004",
      "Collection Date": "10/06/2025",
      "Principal Paid Amount": "150.00",
      "Interest Paid Amount": "40.00",
      "Payment Method": "Yappy",
    },
    {
      "Loan Id": "1003",
      "Collection Date": "15/06/2025",
      "Principal Paid Amount": "100.00",
      "Interest Paid Amount": "0.00",
      "Payment Method": "Traspaso a Provisión", // Admin -> excluded
    },
    {
      "Loan Id": "1001",
      "Collection Date": "05/07/2025", // Future relative to cut 2025-06-30 -> excluded
      "Principal Paid Amount": "200.00",
      "Interest Paid Amount": "50.00",
      "Payment Method": "ACH",
    },
  ];

  it("produces exact open-book universe matching Python enrich()", () => {
    const enriched = enrichLoans(sampleLoansTape);

    const openLoans = enriched.filter((l) => l.isOpen);
    expect(openLoans.length).toBe(5); // 1001, 1002, 1003, 1004, 1005
    expect(openLoans.map((l) => l.loanId)).toEqual([
      "1001",
      "1002",
      "1003",
      "1004",
      "1005",
    ]);

    // Excluded
    const closed1006 = enriched.find((l) => l.loanId === "1006");
    expect(closed1006?.isOpen).toBe(false); // Restructured

    const closed1007 = enriched.find((l) => l.loanId === "1007");
    expect(closed1007?.isOpen).toBe(false); // Dust balance <= 0.5
  });

  it("produces exact product segmentation and precedence", () => {
    const enriched = enrichLoans(sampleLoansTape);

    expect(enriched.find((l) => l.loanId === "1001")?.segment).toBe("Adelantos");
    expect(enriched.find((l) => l.loanId === "1002")?.segment).toBe(
      "Personal con Garantía",
    );
    expect(enriched.find((l) => l.loanId === "1003")?.segment).toBe(
      "Personal sin Garantía",
    );
    expect(enriched.find((l) => l.loanId === "1004")?.segment).toBe(
      "Personal con Garantía",
    );
    expect(enriched.find((l) => l.loanId === "1005")?.segment).toBe(
      "Personal sin Garantía",
    );
  });

  it("handles cash_ahead with exact preservation of dpd_loandisk", () => {
    const enriched = enrichLoans(sampleLoansTape);

    const l1002 = enriched.find((l) => l.loanId === "1002")!;
    expect(l1002.cashAhead).toBe(true);
    expect(l1002.dpd).toBe(0); // Adjusted to Al día
    expect(l1002.dpdLoandisk).toBe(45); // LoanDisk raw preserved
    expect(l1002.bucket).toBe("Al día");
    expect(l1002.bucketIdx).toBe(0);

    const l1003 = enriched.find((l) => l.loanId === "1003")!;
    expect(l1003.cashAhead).toBe(false);
    expect(l1003.dpd).toBe(35);
    expect(l1003.bucket).toBe("31-60");
    expect(l1003.bucketIdx).toBe(2);
  });

  it("computes exact provisions down to the cent across the CRO scale", () => {
    const enriched = enrichLoans(sampleLoansTape);
    const openLoans = enriched.filter((l) => l.isOpen);

    // 1001: 3450.75 in "Al día" (rate 0.01) -> 34.5075
    // 1002: 2100.00 in "Al día" (rate 0.01) -> 21.00
    // 1003: 1850.50 in "31-60" (rate 0.15) -> 277.575
    // 1004: 6500.00 in "91-180" (rate 0.50) -> 3250.00
    // 1005: 4200.00 in "181-365" (rate 0.90) -> 3780.00

    let totalProv = 0;
    for (const l of openLoans) {
      totalProv += l.balance * PROV_RATES[l.bucketIdx];
    }

    const expectedProv =
      3450.75 * 0.01 +
      2100.0 * 0.01 +
      1850.5 * 0.15 +
      6500.0 * 0.5 +
      4200.0 * 0.9;

    expect(Math.round(totalProv * 100) / 100).toBe(
      Math.round(expectedProv * 100) / 100,
    );
  });

  it("computes exact collections action plan and castigo exclusion matching Python", () => {
    const enriched = enrichLoans(sampleLoansTape);
    const asOfDate = "2025-06-30";

    const { repayments } = enrichRepayments(sampleRepaymentsTape, asOfDate);
    const lastRealMap: Record<string, string> = {};
    for (const r of repayments) {
      if (r.isReal) {
        lastRealMap[r.loanId] = r.collectionDate;
      }
    }

    const { plan, resumen } = buildCollectionsPlan({
      loans: enriched,
      asOfDate,
      lastRealPaymentMap: lastRealMap,
    });

    // 1005 is excluded as castigo: unsecured DPD = 210 (> 180) and last payment was > 180 days ago
    expect(resumen.castigo_excl).toBe(1);
    expect(resumen.castigo_saldo).toBe(4200.0);

    // Remaining open loans:
    // 1002: P1 (cash_ahead)
    // 1003: P2 (cheap cure, past_due = 45)
    // 1004: P3 (paying deep delinquency, last payment was 2025-06-10 <= 90d ago)
    // 1001: Al día with no signal -> not in action plan
    expect(plan.length).toBe(3);

    expect(plan[0].loanno).toBe("LN-002");
    expect(plan[0].prio).toBe(1);

    expect(plan[1].loanno).toBe("LN-003");
    expect(plan[1].prio).toBe(2);

    expect(plan[2].loanno).toBe("LN-004");
    expect(plan[2].prio).toBe(3);
  });
});

