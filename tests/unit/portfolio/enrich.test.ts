import { describe, expect, it } from "vitest";

import {
  canonVal,
  detectMethodCol,
  enrichLoan,
  enrichRepayment,
  enrichRepayments,
  getBucketIdx,
  normLabel,
  num,
  pdate,
  BUCKETS,
} from "@/lib/portfolio/enrich";

describe("lib/portfolio/enrich · Motor Financiero", () => {
  describe("String and numeric normalization helpers", () => {
    it("normLabel normalizes accents and case", () => {
      expect(normLabel("Préstamo Garantizado")).toBe("prestamo garantizado");
      expect(normLabel("DÉBITO PLANILLA")).toBe("debito planilla");
      expect(normLabel(null)).toBe("");
    });

    it("pdate strictly handles day-first %d/%m/%Y dates", () => {
      expect(pdate("05/11/2024")).toBe("2024-11-05");
      expect(pdate("31/12/2025")).toBe("2025-12-31");
      expect(pdate("1/6/2025")).toBe("2025-06-01");
      expect(pdate("2025-06-01")).toBe("2025-06-01");
      expect(pdate("")).toBeNull();
      expect(pdate(null)).toBeNull();
    });

    it("num strips thousands commas and handles dirty numbers", () => {
      expect(num("1,234.56")).toBe(1234.56);
      expect(num(" 500 ")).toBe(500);
      expect(num("")).toBe(0);
      expect(num(null)).toBe(0);
    });

    it("canonVal matches canonical lists and heuristics", () => {
      const GC_VALS = ["BCS", "Michel Sanabria Rivera", "Legal - Ruben Castrejo"];
      const GC_HEUR = {
        michel: "Michel Sanabria Rivera",
        bcs: "BCS",
        legal: "Legal - Ruben Castrejo",
        castrejo: "Legal - Ruben Castrejo",
      };

      expect(canonVal("michel sanabria", GC_VALS, GC_HEUR)).toBe("Michel Sanabria Rivera");
      expect(canonVal("BCS", GC_VALS, GC_HEUR)).toBe("BCS");
      expect(canonVal("Ruben Castrejo", GC_VALS, GC_HEUR)).toBe("Legal - Ruben Castrejo");
      expect(canonVal("Desconocido", GC_VALS, GC_HEUR)).toBe("Desconocido");
    });
  });

  describe("Bucket assignment (right-closed edges)", () => {
    it("assigns exact bucket bands matching Python BUCKET_BINS", () => {
      expect(BUCKETS[getBucketIdx(0)]).toBe("Al día");
      expect(BUCKETS[getBucketIdx(-5)]).toBe("Al día");
      expect(BUCKETS[getBucketIdx(1)]).toBe("1-30");
      expect(BUCKETS[getBucketIdx(30)]).toBe("1-30");
      expect(BUCKETS[getBucketIdx(31)]).toBe("31-60");
      expect(BUCKETS[getBucketIdx(60)]).toBe("31-60");
      expect(BUCKETS[getBucketIdx(61)]).toBe("61-90");
      expect(BUCKETS[getBucketIdx(90)]).toBe("61-90");
      expect(BUCKETS[getBucketIdx(91)]).toBe("91-180");
      expect(BUCKETS[getBucketIdx(180)]).toBe("91-180");
      expect(BUCKETS[getBucketIdx(181)]).toBe("181-365");
      expect(BUCKETS[getBucketIdx(365)]).toBe("181-365");
      expect(BUCKETS[getBucketIdx(366)]).toBe("365+");
      expect(BUCKETS[getBucketIdx(1200)]).toBe("365+");
    });
  });

  describe("Open book universe (§4.2)", () => {
    it("includes loans with balance > 0.5 and active status", () => {
      const loan = enrichLoan({
        "Loan Id": "1001",
        "Balance Amount": "1500.00",
        "Loan Status Name": "Current",
        "Days Past Due": "0",
        "Loan Product": "Personal",
      });
      expect(loan.isOpen).toBe(true);
      expect(loan.balance).toBe(1500);
    });

    it("excludes fully paid and restructured loans regardless of balance", () => {
      const paid = enrichLoan({
        "Loan Id": "1002",
        "Balance Amount": "2000.00",
        "Loan Status Name": "Fully Paid",
        "Days Past Due": "0",
      });
      expect(paid.isOpen).toBe(false);

      const restructured = enrichLoan({
        "Loan Id": "1003",
        "Balance Amount": "3000.00",
        "Loan Status Name": "Restructured",
        "Days Past Due": "45",
      });
      expect(restructured.isOpen).toBe(false);
    });

    it("excludes loans with balance <= 0.5", () => {
      const dust = enrichLoan({
        "Loan Id": "1004",
        "Balance Amount": "0.45",
        "Loan Status Name": "Current",
        "Days Past Due": "0",
      });
      expect(dust.isOpen).toBe(false);
    });
  });

  describe("Product segmentation precedence (§4.3)", () => {
    it("prioritizes Adelantos over everything", () => {
      const loan = enrichLoan({
        "Loan Id": "2001",
        "Balance Amount": "5000",
        "Loan Status Name": "Current",
        "Loan Product": "Adelanto de Ventas con Garantía",
        "Prestamo Garantizado": "Si",
      });
      expect(loan.segment).toBe("Adelantos");
      expect(loan.segmentIdx).toBe(0);
      expect(loan.secured).toBe(false); // only index 1 is secured
    });

    it("assigns Personal con Garantía when Prestamo Garantizado is Si", () => {
      const loan = enrichLoan({
        "Loan Id": "2002",
        "Balance Amount": "5000",
        "Loan Status Name": "Current",
        "Loan Product": "Personal Tradicional",
        "Prestamo Garantizado": "Si",
      });
      expect(loan.segment).toBe("Personal con Garantía");
      expect(loan.segmentIdx).toBe(1);
      expect(loan.secured).toBe(true);
    });

    it("assigns Personal con Garantía when product name contains con garantia or vehicular", () => {
      const loan = enrichLoan({
        "Loan Id": "2003",
        "Balance Amount": "5000",
        "Loan Status Name": "Current",
        "Loan Product": "Préstamo Vehicular",
      });
      expect(loan.segment).toBe("Personal con Garantía");
      expect(loan.segmentIdx).toBe(1);
      expect(loan.secured).toBe(true);
    });

    it("defaults to Personal sin Garantía", () => {
      const loan = enrichLoan({
        "Loan Id": "2004",
        "Balance Amount": "5000",
        "Loan Status Name": "Current",
        "Loan Product": "Personal sin Garantía",
        "Prestamo Garantizado": "No",
      });
      expect(loan.segment).toBe("Personal sin Garantía");
      expect(loan.segmentIdx).toBe(2);
      expect(loan.secured).toBe(false);
    });
  });

  describe("Cash adjustment (cash_ahead) (§4.4)", () => {
    it("forces DPD to 0 ('Al día') when Past Due <= 0.01 but counter > 0", () => {
      const loan = enrichLoan({
        "Loan Id": "3001",
        "Balance Amount": "4500",
        "Loan Status Name": "Arrears",
        "Days Past Due": "45",
        "Past Due": "0.00",
        "Pending Due": "120.00",
      });
      expect(loan.isOpen).toBe(true);
      expect(loan.cashAhead).toBe(true);
      expect(loan.dpd).toBe(0); // Forced to Al día
      expect(loan.dpdLoandisk).toBe(45); // Preserved
      expect(loan.bucket).toBe("Al día");
      expect(loan.bucketIdx).toBe(0);
    });

    it("forces DPD to 0 ('Al día') when Pending Due <= 0.01 but counter > 0", () => {
      const loan = enrichLoan({
        "Loan Id": "3002",
        "Balance Amount": "4500",
        "Loan Status Name": "Arrears",
        "Days Past Due": "92",
        "Past Due": "500.00",
        "Pending Due": "0.00",
      });
      expect(loan.cashAhead).toBe(true);
      expect(loan.dpd).toBe(0);
      expect(loan.dpdLoandisk).toBe(92);
      expect(loan.bucket).toBe("Al día");
    });

    it("does not adjust when there is overdue amount (> 0.01 on both)", () => {
      const loan = enrichLoan({
        "Loan Id": "3003",
        "Balance Amount": "4500",
        "Loan Status Name": "Arrears",
        "Days Past Due": "45",
        "Past Due": "150.00",
        "Pending Due": "150.00",
      });
      expect(loan.cashAhead).toBe(false);
      expect(loan.dpd).toBe(45);
      expect(loan.dpdLoandisk).toBe(45);
      expect(loan.bucket).toBe("31-60");
      expect(loan.bucketIdx).toBe(2);
    });
  });

  describe("Repayment classification (§2.3 & §6.5)", () => {
    const rows: Record<string, string>[] = [
      {
        "Loan Id": "101",
        "Collection Date": "15/06/2025",
        "Principal Paid Amount": "100.00",
        "Interest Paid Amount": "25.00",
        "Payment Method": "ACH",
      },
      {
        "Loan Id": "102",
        "Collection Date": "16/06/2025",
        "Principal Paid Amount": "50.00",
        "Interest Paid Amount": "10.00",
        "Payment Method": "Traspaso de Saldo",
      },
      {
        "Loan Id": "103",
        "Collection Date": "20/06/2025",
        "Principal Paid Amount": "80.00",
        "Interest Paid Amount": "0.00",
        "Payment Method": "Tarjeta Nueva Desconocida",
      },
      {
        "Loan Id": "104",
        "Collection Date": "05/07/2025", // Future relative to cut 2025-06-30
        "Principal Paid Amount": "90.00",
        "Interest Paid Amount": "0.00",
        "Payment Method": "Yappy",
      },
    ];


    it("detects method column and classifies real vs admin", () => {
      const methodCol = detectMethodCol(rows);
      expect(methodCol).toBe("Payment Method");

      const r1 = enrichRepayment(rows[0], methodCol);
      expect(r1.isReal).toBe(true);
      expect(r1.isAdmin).toBe(false);
      expect(r1.ingresosAmount).toBe(25);

      const r2 = enrichRepayment(rows[1], methodCol);
      expect(r2.isReal).toBe(false);
      expect(r2.isAdmin).toBe(true);

      const r3 = enrichRepayment(rows[2], methodCol);
      expect(r3.isReal).toBe(true);
      expect(r3.isAdmin).toBe(false);
      expect(r3.isUnknownMethod).toBe(true);
    });

    it("filters future dated payments according to cut date", () => {
      const { repayments, futureExcludedCount } = enrichRepayments(rows, "2025-06-30");
      expect(futureExcludedCount).toBe(1);
      expect(repayments.length).toBe(3);
      expect(repayments.map((r) => r.loanId)).toEqual(["101", "102", "103"]);
    });
  });
});
