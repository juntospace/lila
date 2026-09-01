// Parser for Banco General checking account statement files ("Movimientos de Cuenta Corriente").
// Supports Layouts A (BGPExcelReport), B (BGPCheckingMovementsExcel), and C (ReferencedReport).

import * as XLSX from "xlsx";

import type { BgParsedStatement, BgStatementRow } from "../types";
import {
  extractDownloadTimestamp,
  parseAmountFloat,
  parseAmountMinor,
  parseIsoDate,
  removeAccents,
} from "./utils";

const HEADER_ALIASES: Record<string, string> = {
  fecha: "fecha",
  referencia: "referencia",
  "referencia 1": "ref1",
  "referencia 2": "ref2",
  "referencia 3": "ref3",
  "referencia 4": "ref4",
  transaccion: "codigo",
  descripcion: "descripcion",
  monto: "monto",
  debito: "debito",
  credito: "credito",
  "saldo total": "saldo",
};

const RE_PERIOD = /Movimientos\s+desde\s+(\d{1,2}-[A-Za-zñÑ]{3}\.?-\d{4})\s+hasta\s+(\d{1,2}-[A-Za-zñÑ]{3}\.?-\d{4})/i;

export function parseBgStatement(
  workbookOrSheet: XLSX.WorkBook | XLSX.WorkSheet | unknown[][],
  filename: string,
): BgParsedStatement {
  let sheet: XLSX.WorkSheet | null = null;
  let layoutTitle = "";

  if (Array.isArray(workbookOrSheet)) {
    // Array of rows
  } else if ("SheetNames" in workbookOrSheet) {
    const wb = workbookOrSheet as XLSX.WorkBook;
    const name = wb.SheetNames[0];
    layoutTitle = name || "";
    sheet = wb.Sheets[name];
  } else {
    sheet = workbookOrSheet as XLSX.WorkSheet;
  }

  const rawRows: unknown[][] = Array.isArray(workbookOrSheet)
    ? (workbookOrSheet as unknown[][])
    : XLSX.utils.sheet_to_json(sheet!, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: false,
      });

  let accountNumber: string | null = null;
  let companyName: string | null = null;
  let startDate: string | null = null;
  let endDate: string | null = null;
  let colMap: Record<string, number> | null = null;
  const rows: BgStatementRow[] = [];
  const errors: string[] = [];

  for (const row of rawRows) {
    if (!row || !Array.isArray(row)) continue;
    const nonEmpty = row
      .map((c, i) => ({ col: i, val: c }))
      .filter((c) => c.val != null && String(c.val).trim() !== "");

    if (nonEmpty.length === 0) continue;

    if (!colMap) {
      const text0 = String(nonEmpty[0].val);
      if (text0.includes("Numero de Cuenta")) {
        const parts = text0.split(":");
        if (parts.length > 1) accountNumber = parts[1].trim();
        continue;
      }
      if (text0.includes("Empresa")) {
        const parts = text0.split(":");
        if (parts.length > 1) companyName = parts[1].trim();
        continue;
      }
      const periodMatch = RE_PERIOD.exec(text0);
      if (periodMatch) {
        startDate = parseIsoDate(periodMatch[1]);
        endDate = parseIsoDate(periodMatch[2]);
        continue;
      }

      // Check if this row is the column headers row
      const normalizedRow: Record<number, string> = {};
      for (const item of nonEmpty) {
        normalizedRow[item.col] = removeAccents(String(item.val)).trim().toLowerCase();
      }

      const values = Object.values(normalizedRow);
      if (values.includes("fecha") && values.includes("descripcion")) {
        colMap = {};
        for (const [colStr, headerLabel] of Object.entries(normalizedRow)) {
          const colIdx = Number(colStr);
          if (HEADER_ALIASES[headerLabel]) {
            colMap[HEADER_ALIASES[headerLabel]] = colIdx;
          }
        }

        // Layout A handling: "Referencia" column is actually the transaction code
        if (!("codigo" in colMap) && "monto" in colMap) {
          if ("referencia" in colMap) {
            colMap.codigo = colMap.referencia;
            delete colMap.referencia;
          }
        }
      }
      continue;
    }

    // Data row processing
    const getVal = (field: string) => {
      const idx = colMap![field];
      return idx != null && idx < row.length ? row[idx] : null;
    };

    const postedDate = parseIsoDate(getVal("fecha"));
    if (!postedDate) continue; // Footer or non-data row

    const balanceMinor = parseAmountMinor(getVal("saldo"));
    let debitMinor: bigint | null = null;
    let creditMinor: bigint | null = null;

    if ("monto" in colMap) {
      // Layout A: signed amount
      const amountVal = parseAmountFloat(getVal("monto"));
      if (amountVal == null) continue;
      if (amountVal < 0) {
        debitMinor = parseAmountMinor(Math.abs(amountVal));
        creditMinor = null;
      } else if (amountVal > 0) {
        creditMinor = parseAmountMinor(amountVal);
        debitMinor = null;
      }
    } else {
      debitMinor = parseAmountMinor(getVal("debito"));
      creditMinor = parseAmountMinor(getVal("credito"));
    }

    if (debitMinor == null && creditMinor == null) continue;

    const rawCode = getVal("codigo");
    const rawDesc = getVal("descripcion");
    const rawRef1 = getVal("ref1");
    const rawRef2 = getVal("ref2");
    const rawRef3 = getVal("ref3");
    const rawRef4 = getVal("ref4");

    rows.push({
      postedDate,
      code: rawCode != null ? String(rawCode).trim() : "",
      description: rawDesc != null ? String(rawDesc).trim() : "",
      debitMinor,
      creditMinor,
      balanceMinor,
      ref1: rawRef1 != null ? String(rawRef1).trim() : "",
      ref2: rawRef2 != null ? String(rawRef2).trim() : "",
      ref3: rawRef3 != null ? String(rawRef3).trim() : undefined,
      ref4: rawRef4 != null ? String(rawRef4).trim() : undefined,
    });
  }

  if (!colMap) {
    errors.push("Header row not found in statement file");
  }

  if (!startDate || !endDate) {
    if (rows.length > 0) {
      startDate = startDate || rows.reduce((min, r) => (r.postedDate < min ? r.postedDate : min), rows[0].postedDate);
      endDate = endDate || rows.reduce((max, r) => (r.postedDate > max ? r.postedDate : max), rows[0].postedDate);
      errors.push('Missing "Movimientos desde..." line: coverage inferred from observed rows');
    }
  }

  return {
    fileType: "statement",
    filename,
    layoutTitle,
    accountNumber,
    companyName,
    startDate,
    endDate,
    downloadedAt: extractDownloadTimestamp(filename),
    rows,
    errors,
  };
}

