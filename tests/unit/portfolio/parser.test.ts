import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  extractDateFromName,
  parseCsv,
  parsePortfolioZip,
} from "@/lib/portfolio/parser";

describe("lib/portfolio/parser · CSV parser", () => {
  it("parses standard comma-separated CSV with headers", () => {
    const csv = `Loan Id,Loan #,Full Name,Balance Amount\n101,CC-001,"Juan Perez",1500.50\n102,CC-002,"Maria Lopez",2300.00`;
    const rows = parseCsv(csv);
    expect(rows.length).toBe(2);
    expect(rows[0]["Loan Id"]).toBe("101");
    expect(rows[0]["Full Name"]).toBe("Juan Perez");
    expect(rows[1]["Balance Amount"]).toBe("2300.00");
  });

  it("handles UTF-8 BOM, semicolons and Windows CRLF", () => {
    const csv = `\uFEFFLoan Id;Loan #;Full Name;Balance Amount\r\n101;CC-001;Juan Perez;1500.50\r\n102;CC-002;Maria Lopez;2300.00\r\n`;
    const rows = parseCsv(csv);
    expect(rows.length).toBe(2);
    expect(rows[0]["Loan Id"]).toBe("101");
    expect(rows[1]["Full Name"]).toBe("Maria Lopez");
  });

  it("handles embedded commas and escaped quotes inside quoted fields", () => {
    const csv = `Loan Id,Full Name,Notes\n101,"Perez, ""El Chino"" Juan","Pago especial, verificado"\n102,"Gomez, Ana","Normal"`;
    const rows = parseCsv(csv);
    expect(rows.length).toBe(2);
    expect(rows[0]["Full Name"]).toBe('Perez, "El Chino" Juan');
    expect(rows[0]["Notes"]).toBe("Pago especial, verificado");
  });

  it("extractDateFromName extracts YYYY-MM-DD from file and folder names", () => {
    expect(extractDateFromName("2026-06-06.zip")).toBe("2026-06-06");
    expect(extractDateFromName("backup_crediclaro_2025-11-30_final.csv")).toBe("2025-11-30");
    expect(extractDateFromName("/path/to/2026-08-15/70136/loans.csv")).toBe("2026-08-15");
    expect(extractDateFromName("sin_fecha.csv")).toBeNull();
  });
});

describe("lib/portfolio/parser · ZIP parser", () => {
  it("extracts and parses loans and repayments from a valid zip archive", async () => {
    const zip = new JSZip();
    zip.file(
      "70136/loans_branch1.csv",
      `Loan Id,Loan #,Full Name,Balance Amount\n101,CC-001,"Juan Perez",1500.50\n102,CC-002,"Maria Lopez",2300.00`,
    );
    zip.file(
      "70136/repayments_branch1.csv",
      `Repayment Id,Loan #,Collection Date,Principal Paid Amount\n1,CC-001,2026-10-15,500.00`,
    );
    zip.file(
      "70136/borrowers_branch1.csv",
      `Full Name,Mobile\n"Juan Perez",12345678`,
    );

    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await parsePortfolioZip(buffer, "2026-10-20.zip");

    expect(result.snapshotDate).toBe("2026-10-20");
    expect(result.loansRaw.length).toBe(2);
    expect(result.loansRaw[0]["Loan #"]).toBe("CC-001");
    expect(result.repaymentsRaw.length).toBe(1);
    expect(result.repaymentsRaw[0]["Principal Paid Amount"]).toBe("500.00");
    expect(result.hasRepaymentsFile).toBe(true);
    expect(result.loansFileName).toBe("70136/loans_branch1.csv");
    expect(result.repaymentsFileName).toBe("70136/repayments_branch1.csv");
    expect(result.borrowersFileName).toBe("70136/borrowers_branch1.csv");
    expect(result.loansSha256).toBeTruthy();
    expect(result.repaymentsSha256).toBeTruthy();
  });

  it("extracts snapshot date from loans filename if zip name does not contain date", async () => {
    const zip = new JSZip();
    zip.file(
      "loans_2026-05-15.csv",
      `Loan Id,Loan #,Full Name,Balance Amount\n101,CC-001,"Juan Perez",1500.50`,
    );

    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await parsePortfolioZip(buffer, "backup.zip");

    expect(result.snapshotDate).toBe("2026-05-15");
    expect(result.loansRaw.length).toBe(1);
    expect(result.hasRepaymentsFile).toBe(false);
    expect(result.repaymentsRaw).toEqual([]);
    expect(result.repaymentsSha256).toBeNull();
  });

  it("throws error if loans file is missing in the zip", async () => {
    const zip = new JSZip();
    zip.file(
      "70136/repayments_branch1.csv",
      `Repayment Id,Loan #,Collection Date\n1,CC-001,2026-10-15`,
    );

    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await expect(parsePortfolioZip(buffer, "2026-10-20.zip")).rejects.toThrow(
      "No se encontró el archivo de préstamos (*loans*.csv) dentro del archivo ZIP.",
    );
  });
});

