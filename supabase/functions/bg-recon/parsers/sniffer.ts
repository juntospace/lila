// Content-based file type sniffer and dispatcher for Banco General reconciliation.

import * as XLSX from "xlsx";

import type {
  BgParsedAchDetail,
  BgParsedStatement,
  BgParsedYappyReport,
} from "../types.ts";
import { parseBgAchDetail } from "./ach-detail.ts";
import { parseBgAchDetailPdfText } from "./pdf-detail.ts";
import { parseBgStatement } from "./statement.ts";
import { parseBgYappyReport } from "./yappy.ts";

export type BgDetectedFileResult =
  | BgParsedStatement
  | BgParsedAchDetail
  | BgParsedYappyReport;

export function detectAndParseBgFile(
  fileBytesOrBuffer: Uint8Array | ArrayBuffer | Buffer | unknown[][],
  filename: string,
  pdfText?: string,
): BgDetectedFileResult | null {
  const low = filename.toLowerCase();

  if (low.endsWith(".pdf")) {
    if (pdfText != null) {
      return parseBgAchDetailPdfText(pdfText, filename);
    }
    // PDF without text provided
    return {
      fileType: "ach_detail",
      filename,
      variant: "PDF",
      batchName: filename,
      batchDateStr: null,
      batchDate: null,
      channel: null,
      isDelinquent: false,
      fortnight: null,
      retryCount: 1,
      effectiveDate: null,
      totalTransactions: null,
      succeededTransactions: null,
      rejectedTransactions: null,
      declaredRejectionsAmountMinor: null,
      downloadedAt: null,
      rows: [],
      rejectedSumMinor: 0n,
      rejectedSum: 0,
      rejectedRowsCount: 0,
      succeededRowsCount: 0,
      succeededSumMinor: 0n,
      succeededSum: 0,
      errors: ["PDF file requires text extraction"],
      isUnreadable: true,
    };
  }

  // Parse with SheetJS
  let wb: XLSX.WorkBook;
  try {
    if (Array.isArray(fileBytesOrBuffer)) {
      // In-memory array of rows
      const blob = fileBytesOrBuffer
        .slice(0, 15)
        .flat()
        .filter(Boolean)
        .map(String)
        .join(" ");

      if (
        blob.includes("CODIGO DE RUTA") ||
        blob.includes("Archivo ACH") ||
        blob.includes("BGPACHRejectedDetailList")
      ) {
        return parseBgAchDetail(fileBytesOrBuffer, filename);
      }
      if (
        /punto de cobro/i.test(blob) ||
        /yappy/i.test(blob) ||
        /financieracrediclaro/i.test(blob) ||
        /yappy/i.test(filename)
      ) {
        return parseBgYappyReport(fileBytesOrBuffer, filename);
      }
      if (
        blob.includes("Movimientos desde") ||
        blob.includes("Numero de Cuenta") ||
        blob.includes("BGPExcelReport") ||
        blob.includes("BGPCheckingMovementsExcel") ||
        blob.includes("ReferencedReport")
      ) {
        return parseBgStatement(fileBytesOrBuffer, filename);
      }
      return null;
    }

    wb = XLSX.read(fileBytesOrBuffer, {
      type: "buffer",
      raw: true,
      cellDates: false,
    });
  } catch {
    return null;
  }

  const sheetName = wb.SheetNames[0] || "";
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;

  // Sniff the first 15 rows
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
  });

  const preview = rawRows
    .slice(0, 15)
    .flat()
    .filter(Boolean)
    .map(String);

  const blob = preview.join(" ");

  if (
    blob.includes("CODIGO DE RUTA") ||
    blob.includes("Archivo ACH") ||
    sheetName.includes("BGPACHRejectedDetailList")
  ) {
    return parseBgAchDetail(ws, filename);
  }
  if (
    /punto de cobro/i.test(blob) ||
    /financieracrediclaro/i.test(blob) ||
    /yappy/i.test(sheetName) ||
    /yappy/i.test(blob) ||
    /yappy/i.test(filename)
  ) {
    return parseBgYappyReport(ws, filename);
  }
  if (
    blob.includes("Movimientos desde") ||
    blob.includes("Numero de Cuenta") ||
    sheetName.includes("BGPExcelReport") ||
    sheetName.includes("BGPCheckingMovementsExcel") ||
    sheetName.includes("ReferencedReport")
  ) {
    return parseBgStatement(ws, filename);
  }

  return null;
}

export const BG_PARSER_VERSION = 1;

/**
 * Safely serializes a BgDetectedFileResult into a JSON-compatible object
 * for storage in PostgreSQL jsonb, converting BigInt and Date to serializable formats.
 */
export function serializeBgParsedFile(
  parsed: BgDetectedFileResult,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(parsed, (_key, value) => {
      if (typeof value === "bigint") {
        return { __type: "bigint", value: value.toString() };
      }
      return value;
    }),
  );
}

/**
 * Deserializes a jsonb object back into a native BgDetectedFileResult,
 * restoring BigInt and Date instances.
 */
export function deserializeBgParsedFile(
  data: unknown,
): BgDetectedFileResult {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid parsed_payload data");
  }

  const revived = JSON.parse(
    JSON.stringify(data),
    (key, value) => {
      if (
        value &&
        typeof value === "object" &&
        value.__type === "bigint" &&
        typeof value.value === "string"
      ) {
        return BigInt(value.value);
      }
      if (
        (key === "downloadedAt") &&
        typeof value === "string"
      ) {
        return new Date(value);
      }
      return value;
    },
  ) as BgDetectedFileResult;

  // Ensure top-level BigInts that may not have been tagged or were plain strings/numbers in some rows
  if (revived.fileType === "ach_detail") {
    revived.rejectedSumMinor = BigInt(String(revived.rejectedSumMinor ?? 0));
    revived.succeededSumMinor = BigInt(String(revived.succeededSumMinor ?? 0));
    if (revived.declaredRejectionsAmountMinor != null) {
      revived.declaredRejectionsAmountMinor = BigInt(String(revived.declaredRejectionsAmountMinor));
    }
    if (revived.declaredTotalAmountMinor != null) {
      revived.declaredTotalAmountMinor = BigInt(String(revived.declaredTotalAmountMinor));
    }
    for (const row of revived.rows) {
      row.amountMinor = BigInt(String(row.amountMinor ?? 0));
    }
  } else if (revived.fileType === "statement") {
    for (const row of revived.rows) {
      if (row.debitMinor != null) row.debitMinor = BigInt(String(row.debitMinor));
      if (row.creditMinor != null) row.creditMinor = BigInt(String(row.creditMinor));
      if (row.balanceMinor != null) row.balanceMinor = BigInt(String(row.balanceMinor));
    }
  } else if (revived.fileType === "yappy") {
    for (const row of revived.rows) {
      row.amountMinor = BigInt(String(row.amountMinor ?? 0));
    }
  }

  return revived;
}
