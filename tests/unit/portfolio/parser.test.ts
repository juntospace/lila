import { describe, expect, it } from "vitest";

import { extractDateFromName, parseCsv } from "@/lib/portfolio/parser";

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

