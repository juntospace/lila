import { describe, expect, it } from "vitest";

import {
  classifyCashCollection,
  normalizeCedula,
  normalizeName,
  parseCsv,
  parseDateIso,
  parseLoanDiskBundle,
  parseMoneyMinor,
} from "@/lib/portfolio/parser";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("parseCsv", () => {
  it("parses a simple grid", () => {
    expect(parseCsv(utf8("a,b,c\n1,2,3\n"))).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    expect(parseCsv(utf8('"Last, First",x\n"Doe, Jane",1\n'))).toEqual([
      ["Last, First", "x"],
      ["Doe, Jane", "1"],
    ]);
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    expect(parseCsv(utf8('"she said ""hi""",a\n'))).toEqual([
      ['she said "hi"', "a"],
    ]);
  });

  it("accepts CRLF terminators", () => {
    expect(parseCsv(utf8("a,b\r\n1,2\r\n"))).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("a,b\n1,2\n")]);
    expect(parseCsv(bytes)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("flushes a final row that lacks a trailing newline", () => {
    expect(parseCsv(utf8("a,b\n1,2"))).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseMoneyMinor", () => {
  it("converts decimal dollars to bigint cents", () => {
    expect(parseMoneyMinor("4478.26")).toBe(447826n);
    expect(parseMoneyMinor("0.05")).toBe(5n);
    expect(parseMoneyMinor("100")).toBe(10000n);
  });

  it("strips currency / commas", () => {
    expect(parseMoneyMinor("$1,234.56")).toBe(123456n);
    expect(parseMoneyMinor(" 1,599,478.29 ")).toBe(159947829n);
  });

  it("handles negatives — both - prefix and parens", () => {
    expect(parseMoneyMinor("-50.00")).toBe(-5000n);
    expect(parseMoneyMinor("(5.00)")).toBe(-500n);
  });

  it("returns null on garbage / empty", () => {
    expect(parseMoneyMinor("")).toBeNull();
    expect(parseMoneyMinor("abc")).toBeNull();
    expect(parseMoneyMinor("1.2.3")).toBeNull();
  });
});

describe("parseDateIso", () => {
  it("converts DD/MM/YYYY (Panama) to ISO", () => {
    expect(parseDateIso("15/09/1996")).toBe("1996-09-15");
    expect(parseDateIso("9/12/2024")).toBe("2024-12-09");
  });

  it("passes through already-ISO dates", () => {
    expect(parseDateIso("2026-04-07")).toBe("2026-04-07");
  });

  it("rejects nonsense dates", () => {
    expect(parseDateIso("31/02/2024")).toBeNull();
    expect(parseDateIso("not-a-date")).toBeNull();
    expect(parseDateIso("")).toBeNull();
  });
});

describe("normalizeCedula", () => {
  it("accepts canonical Panamanian cédulas", () => {
    expect(normalizeCedula("8-937-1696")).toBe("8-937-1696");
    expect(normalizeCedula("PE-12-345")).toBe("PE-12-345");
  });

  it("rejects custom codes that aren't cédulas", () => {
    expect(normalizeCedula("EST004")).toBeNull();
    expect(normalizeCedula("ODOO0034")).toBeNull();
    expect(normalizeCedula(null)).toBeNull();
  });
});

describe("normalizeName", () => {
  it("strips accents, uppercases, sorts tokens", () => {
    expect(normalizeName("Genéssis Valéria")).toBe("GENESSIS VALERIA");
    expect(normalizeName("Genessis Valeria")).toBe("GENESSIS VALERIA");
  });

  it("makes word order irrelevant", () => {
    expect(normalizeName("DOE, JANE")).toBe(normalizeName("JANE DOE"));
  });

  it("returns null when there's fewer than 2 tokens", () => {
    expect(normalizeName("Cher")).toBeNull();
    expect(normalizeName("")).toBeNull();
    expect(normalizeName(null)).toBeNull();
  });
});

describe("classifyCashCollection", () => {
  it("treats accounting moves as non-cash", () => {
    expect(classifyCashCollection("Traspaso a Provision")).toBe(false);
    expect(classifyCashCollection("Finiquito otorgado")).toBe(false);
    expect(classifyCashCollection("Descuento por Pronto Pago")).toBe(false);
  });

  it("treats real methods as cash", () => {
    expect(classifyCashCollection("ACH")).toBe(true);
    expect(classifyCashCollection("Yappy")).toBe(true);
    expect(classifyCashCollection(null)).toBe(true);
  });
});

describe("parseLoanDiskBundle (integration)", () => {
  it("parses three mini-CSVs into typed rows", () => {
    const borrowersCsv =
      `"Full Name","Borrower Id","Unique Number","Date 0f Birth","Total Paid Amount","Open Loans Balance","Borrower Status Name"\n` +
      `"GENESSIS VALERIA ESTRADA CARIDAD",6073556,"EST004",15/09/1996,4478.26,1888.15,"Past Maturity"\n` +
      `"NAYARITH AIDETH ESQUIVIA",6075683,"8-937-1696",30/07/1998,1089.00,4638.77,"Missed Repayment"\n`;
    const loansCsv =
      `"Loan Id","Loan #","Borrower #","Loan Product","Released Date","Principal Amount","Balance Amount","Days Past Due","Loan Status Name","Loan Duration","Bank Account (Loan Released)","Interest Rate"\n` +
      `L1,"LN-0001","EST004","Préstamo Personal sin Garantía hasta 5,000 (viejo)",10/12/2024,1500.00,500.00,12,"Past Maturity","12 Months","Banco General ****6916","36"\n` +
      `L2,"LN-0002","8-937-1696","Adelanto de Ventas desde 5.000.00",05/03/2025,5000.00,4500.00,0,"Current","6 Months","BAC ****2600 Junto","12"\n`;
    const repaymentsCsv =
      `"Repayment Id","Loan Id","Borrower #","Repayment Method","Collection Date","Principal Paid Amount","Interest Paid Amount","Penalty Paid Amount","Fees Paid Amount","Bank Account (Payments)"\n` +
      `R1,L1,"EST004",ACH,01/02/2025,200.00,50.00,0.00,0.00,"Banco General ****6916"\n` +
      `R2,L1,"EST004","Traspaso a Provision",15/02/2025,300.00,0.00,0.00,0.00,Provision\n`;

    const bundle = parseLoanDiskBundle({
      borrowers: { filename: "borrowers.csv", bytes: utf8(borrowersCsv) },
      loans: { filename: "loans.csv", bytes: utf8(loansCsv) },
      repayments: { filename: "repayments.csv", bytes: utf8(repaymentsCsv) },
    });

    expect(bundle.borrowers).toHaveLength(2);
    expect(bundle.loans).toHaveLength(2);
    expect(bundle.repayments).toHaveLength(2);

    const genesis = bundle.borrowers[0];
    expect(genesis.sourceBorrowerId).toBe("6073556");
    expect(genesis.uniqueNumber).toBe("EST004");
    expect(genesis.cedulaNormalized).toBeNull();
    expect(genesis.totalPaidAmountMinor).toBe(447826n);
    expect(genesis.openLoansBalanceMinor).toBe(188815n);
    expect(genesis.dateOfBirth).toBe("1996-09-15");

    const nayarith = bundle.borrowers[1];
    expect(nayarith.cedulaNormalized).toBe("8-937-1696");

    const loan1 = bundle.loans[0];
    expect(loan1.sourceBorrowerRef).toBe("EST004");
    expect(loan1.principalAmountMinor).toBe(150000n);
    expect(loan1.daysPastDue).toBe(12);
    expect(loan1.durationMonths).toBe(12);

    const loan2 = bundle.loans[1];
    expect(loan2.durationMonths).toBe(6);

    const r2 = bundle.repayments[1];
    expect(r2.isCashCollection).toBe(false);
    expect(r2.principalPaidMinor).toBe(30000n);
    expect(r2.totalPaidMinor).toBe(30000n);

    // File metadata.
    expect(bundle.meta.borrowers.rowCount).toBe(2);
    expect(bundle.meta.borrowers.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
