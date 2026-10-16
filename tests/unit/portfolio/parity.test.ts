import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  buildBoardDatasetFromEnriched,
  formatQualityWarnings,
} from "@/lib/portfolio/board";
import { buildCollectionsPlan } from "@/lib/portfolio/collections";
import {
  detectMethodCol,
  enrichLoan,
  enrichLoans,
  enrichRepayments,
  num,
  PROV_RATES,
} from "@/lib/portfolio/enrich";
import { generateCollectionsWorkbook } from "@/lib/portfolio/excel";
import { fetchAll } from "@/lib/portfolio/fetch-all";
import { DEFAULT_POLICY } from "@/lib/portfolio/policy";

describe("lib/portfolio/parity · Mathematical Parity against Python Engine", () => {
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
      "Prestamo Garantizado": "Si",
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
      "Past Due": "0.00",
      "Pending Due": "150.00",
      "Prestamo Garantizado": "Si",
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
      "Past Due": "45.00",
      "Pending Due": "45.00",
      "Prestamo Garantizado": "No",
    },
    {
      "Loan Id": "1004",
      "Loan #": "LN-004",
      "Full Name": "Luisa Fernandez",
      "Loan Product": "Personal con Garantía de Auto",
      "Balance Amount": "6,500.00",
      "Days Past Due": "120",
      "Released Date": "01/02/2024",
      "Loan Status Name": "Arrears",
      "Past Due": "850.00",
      "Pending Due": "850.00",
      "Last Payment Date": "10/06/2025",
      "Prestamo Garantizado": "Si",
    },
    {
      "Loan Id": "1005",
      "Loan #": "LN-005",
      "Full Name": "Roberto Gomez",
      "Loan Product": "Personal sin Garantía",
      "Balance Amount": "4,200.00",
      "Days Past Due": "210",
      "Released Date": "15/03/2023",
      "Loan Status Name": "Past Maturity",
      "Past Due": "4,200.00",
      "Pending Due": "4,200.00",
      "Last Payment Date": "15/08/2024",
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
      "Loan Status Name": "Restructured",
      "Past Due": "0.00",
      "Pending Due": "0.00",
    },
    {
      "Loan Id": "1007",
      "Loan #": "LN-007",
      "Full Name": "Marcos Diaz",
      "Loan Product": "Préstamo Personal",
      "Balance Amount": "0.20",
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
      "Payment Method": "Traspaso a Provisión",
    },
    {
      "Loan Id": "1001",
      "Collection Date": "05/07/2025",
      "Principal Paid Amount": "200.00",
      "Interest Paid Amount": "50.00",
      "Payment Method": "ACH",
    },
  ];

  it("produces exact open-book universe matching Python enrich()", () => {
    const enriched = enrichLoans(sampleLoansTape);
    const openLoans = enriched.filter((l) => l.isOpen);
    expect(openLoans.length).toBe(5);
    expect(openLoans.map((l) => l.loanId)).toEqual([
      "1001",
      "1002",
      "1003",
      "1004",
      "1005",
    ]);
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
  });

  it("handles cash_ahead with exact preservation of dpd_loandisk", () => {
    const enriched = enrichLoans(sampleLoansTape);
    const l1002 = enriched.find((l) => l.loanId === "1002")!;
    expect(l1002.cashAhead).toBe(true);
    expect(l1002.dpd).toBe(0);
    expect(l1002.dpdLoandisk).toBe(45);
    expect(l1002.bucket).toBe("Al día");
    expect(l1002.bucketIdx).toBe(0);
  });

  it("computes exact provisions down to the cent across the CRO scale", () => {
    const enriched = enrichLoans(sampleLoansTape);
    const openLoans = enriched.filter((l) => l.isOpen);

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
      hasRepaymentsFile: true,
    });

    expect(resumen.castigo_excl).toBe(1);
    expect(resumen.castigo_saldo).toBe(4200.0);
    expect(plan.length).toBe(3);
    expect(plan[0].loanno).toBe("LN-002");
    expect(plan[0].prio).toBe(1);
    expect(plan[1].loanno).toBe("LN-003");
    expect(plan[1].prio).toBe(2);
    expect(plan[2].loanno).toBe("LN-004");
    expect(plan[2].prio).toBe(3);
  });

  // =============================================================
  // Fase 2 Specific Parity Tests (2.1 through 2.8)
  // =============================================================

  it("[2.1] does not fallback to loan.lastPaymentDate when hasRepaymentsFile is true", () => {
    // Loan 2001 has a recent Last Payment Date on the loan record (probably an admin adjustment),
    // but NO real payment in the repayments file.
    const loans = enrichLoans([
      {
        "Loan Id": "2001",
        "Loan #": "LN-2001",
        "Full Name": "Test Sin Pago Real",
        "Loan Product": "Personal sin Garantía",
        "Balance Amount": "3000",
        "Days Past Due": "195", // > 180 unsecured threshold
        "Past Due": "500",
        "Pending Due": "500",
        "Loan Status Name": "Arrears",
        "Last Payment Date": "25/06/2025", // Would look like 5 days ago if fallback happened!
      },
    ]);

    // With hasRepaymentsFile = true and empty lastRealPaymentMap:
    // lpd must be null -> dsp is null -> excluded as castigo!
    const withRepFile = buildCollectionsPlan({
      loans,
      asOfDate: "2025-06-30",
      lastRealPaymentMap: {},
      hasRepaymentsFile: true,
    });
    expect(withRepFile.resumen.castigo_excl).toBe(1);
    expect(withRepFile.plan.length).toBe(0);

    // Only when hasRepaymentsFile = false does it fallback to loan.lastPaymentDate
    const withoutRepFile = buildCollectionsPlan({
      loans,
      asOfDate: "2025-06-30",
      lastRealPaymentMap: null,
      hasRepaymentsFile: false,
    });
    expect(withoutRepFile.resumen.castigo_excl).toBe(0);
    expect(withoutRepFile.plan.length).toBe(1);
    expect(withoutRepFile.plan[0].prio).toBe(3);
  });

  it("[2.2] filters repayments in board dataset to only loans present in current snapshot", () => {
    const currentLoans = enrichLoans([
      {
        "Loan Id": "L1",
        "Loan #": "LN-1",
        "Full Name": "Active Borrower",
        "Loan Product": "Adelanto",
        "Balance Amount": "1000",
        "Days Past Due": "0",
        "Loan Status Name": "Current",
      },
    ]);
    const { repayments } = enrichRepayments(
      [
        {
          "Loan Id": "L1",
          "Collection Date": "15/06/2025",
          "Principal Paid Amount": "100",
          "Interest Paid Amount": "20",
          "Payment Method": "ACH",
        },
        {
          "Loan Id": "L_ORPHAN", // Not in current snapshot loans!
          "Collection Date": "15/06/2025",
          "Principal Paid Amount": "500",
          "Interest Paid Amount": "50",
          "Payment Method": "ACH",
        },
      ],
      "2025-06-30",
    );

    const ds = buildBoardDatasetFromEnriched({
      asof: "2025-06-30",
      snapshotsByDate: { "2025-06-30": currentLoans },
      repayments,
    });

    // Only L1's payment ($100 + $20) should be in payM["2025-06"] and payD["2025-06-15"]
    expect(ds.payM["2025-06"]).toEqual([[0, 100, 20]]);
    expect(ds.payD["2025-06-15"]).toEqual([[0, 100, 20]]);
  });

  it("[2.3] detectMethodCol counts distinct recognized values within first 200 unique values, not row occurrences", () => {
    // Column "Notes" has "ACH" repeated 10 times (1 distinct recognized value).
    // Column "RealMethod" has "ACH", "Yappy", "Cheque" once each (3 distinct recognized values).
    const rows: Record<string, string>[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push({
        Notes: "ACH",
        RealMethod: i === 0 ? "ACH" : i === 1 ? "Yappy" : i === 2 ? "Cheque" : "Otro",
      });
    }

    expect(detectMethodCol(rows)).toBe("RealMethod");
  });

  it("[2.4] parses Days Past Due without stripping commas (invalid or comma-formatted values yield 0)", () => {
    const lComma = enrichLoan({
      "Loan Id": "1",
      "Balance Amount": "1000",
      "Days Past Due": "1,200", // pd.to_numeric("1,200", errors="coerce") -> NaN -> 0
      "Past Due": "100",
      "Pending Due": "100",
      "Loan Status Name": "Arrears",
    });
    expect(lComma.dpdLoandisk).toBe(0);
    expect(lComma.dpd).toBe(0);

    const lValid = enrichLoan({
      "Loan Id": "2",
      "Balance Amount": "1000",
      "Days Past Due": "45",
      "Past Due": "100",
      "Pending Due": "100",
      "Loan Status Name": "Arrears",
    });
    expect(lValid.dpdLoandisk).toBe(45);
    expect(lValid.dpd).toBe(45);
  });

  it("[2.5] strict num() uses Number() instead of parseFloat so '12abc' yields 0", () => {
    expect(num("12abc")).toBe(0);
    expect(num("45.5xyz")).toBe(0);
    expect(num("1,250.75")).toBe(1250.75);
    expect(num("$3,000.00")).toBe(3000);
    expect(num("")).toBe(0);
    expect(num(null)).toBe(0);
  });

  it("[2.6] does not fallback loanno to loanId when Loan # is empty", () => {
    const loan = enrichLoan({
      "Loan Id": "9999",
      "Loan #": "",
      "Full Name": "Sin Numero",
      "Loan Product": "Personal",
      "Balance Amount": "1500",
      "Days Past Due": "40",
      "Past Due": "50",
      "Pending Due": "50",
      "Loan Status Name": "Arrears",
    });

    const { plan } = buildCollectionsPlan({
      loans: [loan],
      asOfDate: "2025-06-30",
      hasRepaymentsFile: false,
    });

    expect(plan.length).toBe(1);
    expect(plan[0].loanno).toBe("");
  });

  it("[2.7] caps installments at 1500 and keeps totalDue only when > 0", () => {
    const loan = enrichLoan({
      "Loan Id": "3001",
      "Loan #": "LN-3001",
      "Full Name": "Long Duration",
      "Loan Product": "Personal",
      "Balance Amount": "1000",
      "Days Past Due": "0",
      "Loan Duration": "2400 Days",
      "Total Due Amount": "-150.00",
      "Loan Status Name": "Current",
    });

    expect(loan.installmentsCount).toBe(1500);
    expect(loan.totalDueAmount).toBe(0);

    const ds = buildBoardDatasetFromEnriched({
      asof: "2025-06-30",
      snapshotsByDate: { "2025-06-30": [loan] },
      repayments: [],
    });
    expect(ds.details["3001"][11]).toBe(0); // totalDue
    expect(ds.details["3001"][12]).toBe(1500); // installments
  });

  it("[2.8] Excel workbook matches Python openpyxl styling (no color on Resumen A1, no centered data cells)", async () => {
    const enriched = enrichLoans(sampleLoansTape);
    const { plan, resumen } = buildCollectionsPlan({
      loans: enriched,
      asOfDate: "2025-06-30",
      hasRepaymentsFile: false,
    });

    const buf = await generateCollectionsWorkbook(plan, resumen, "2025-06-30");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);

    const wsHoy = wb.getWorksheet("Hoy")!;
    // Header row 4 is centered
    expect(wsHoy.getRow(4).getCell(1).alignment?.horizontal).toBe("center");
    // Data row 5 has NO horizontal alignment on Prio, DPD, Tramo, or Ultimo pago
    expect(wsHoy.getRow(5).getCell(1).alignment).toBeUndefined();
    expect(wsHoy.getRow(5).getCell(6).alignment).toBeUndefined();
    expect(wsHoy.getRow(5).getCell(7).alignment).toBeUndefined();
    expect(wsHoy.getRow(5).getCell(10).alignment).toBeUndefined();

    // Resumen A1 has no font color
    const wsRes = wb.getWorksheet("Resumen")!;
    expect(wsRes.getCell("A1").font?.bold).toBe(true);
    expect(wsRes.getCell("A1").font?.color).toBeUndefined();
  });

  it("[1.1] fetchAll paginates > 2,500 loans and > 5,000 repayments without 1,000-row truncation", async () => {
    const fakeLoans = Array.from({ length: 2650 }, (_, i) => ({
      id: `uuid-loan-${i}`,
      source_loan_id: String(10000 + i),
    }));
    const fakeReps = Array.from({ length: 5420 }, (_, i) => ({
      id: `uuid-rep-${i}`,
      source_repayment_id: `REP-${i}`,
    }));

    const fetchedLoans = await fetchAll(async (from, to) => ({
      data: fakeLoans.slice(from, to + 1),
      error: null,
    }));
    const fetchedReps = await fetchAll(async (from, to) => ({
      data: fakeReps.slice(from, to + 1),
      error: null,
    }));

    expect(fetchedLoans).toHaveLength(2650);
    expect(fetchedLoans[0].source_loan_id).toBe("10000");
    expect(fetchedLoans[2649].source_loan_id).toBe("12649");

    expect(fetchedReps).toHaveLength(5420);
    expect(fetchedReps[0].source_repayment_id).toBe("REP-0");
    expect(fetchedReps[5419].source_repayment_id).toBe("REP-5419");
  });

  it("[4.1 & 4.2] applies custom CRO policy parameters and formats quality warnings", () => {
    const customPolicy = {
      ...DEFAULT_POLICY,
      version: "v2.1",
      coUnsecured: 120,
      coUnsecuredDpd: 120,
    };

    const loan = enrichLoan(
      {
        "Loan Id": "7001",
        "Loan #": "LN-7001",
        "Full Name": "Custom Policy Test",
        "Loan Product": "Personal sin Garantía",
        "Balance Amount": "2000",
        "Days Past Due": "150", // > 120 custom coUnsecured (would not be castigo under default 180)
        "Past Due": "300",
        "Loan Status Name": "Arrears",
      },
      customPolicy,
    );

    const { resumen } = buildCollectionsPlan({
      loans: [loan],
      asOfDate: "2025-06-30",
      hasRepaymentsFile: true,
      lastRealPaymentMap: {},
      policy: customPolicy,
    });
    expect(resumen.castigo_excl).toBe(1);

    const warnings = formatQualityWarnings({
      id: "batch-1",
      snapshotId: "snap-1",
      sha256Loans: "abc",
      sha256Repayments: "def",
      rowsLoans: 1540,
      rowsRepayments: 5194,
      sumBalanceSource: 100000,
      sumBalanceIngested: 100000,
      futurePaymentsExcluded: 4,
      cashAheadCount: 12,
      adminExcludedCount: 8,
      adminExcludedAmount: 1450.5,
      unknownMethods: ["Crypto Transfer", "Kiosk Cash"],
      missingCustomFields: [],
      missingReleasedDateCount: 0,
    });

    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("4 pago(s) con fecha posterior al corte");
    expect(warnings[1]).toContain('12 préstamo(s) reclasificado(s) a "Al día"');
    expect(warnings[2]).toContain("8 movimiento(s) administrativo(s) excluido(s)");
    expect(warnings[3]).toContain("Crypto Transfer, Kiosk Cash");
  });
});
