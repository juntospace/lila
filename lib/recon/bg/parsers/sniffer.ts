// Content-based file type sniffer and dispatcher for Banco General reconciliation.

import * as XLSX from "xlsx";

import type {
  BgParsedAchDetail,
  BgParsedStatement,
  BgParsedYappyReport,
} from "../types";
import { parseBgAchDetail } from "./ach-detail";
import { parseBgAchDetailPdfText } from "./pdf-detail";
import { parseBgStatement } from "./statement";
import { parseBgYappyReport } from "./yappy";

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

      if (blob.includes("CODIGO DE RUTA") || blob.includes("Archivo ACH")) {
        return parseBgAchDetail(fileBytesOrBuffer, filename);
      }
      if (blob.includes("Punto de cobro") || blob.includes("Yappy")) {
        return parseBgYappyReport(fileBytesOrBuffer, filename);
      }
      if (blob.includes("Movimientos desde") || blob.includes("Saldo")) {
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

  if (blob.includes("CODIGO DE RUTA") || blob.includes("Archivo ACH")) {
    return parseBgAchDetail(ws, filename);
  }
  if (blob.includes("Punto de cobro") || sheetName.includes("Yappy")) {
    return parseBgYappyReport(ws, filename);
  }
  if (
    blob.includes("Movimientos desde") ||
    blob.includes("Saldo") ||
    sheetName.includes("BGPExcelReport") ||
    sheetName.includes("BGPCheckingMovementsExcel") ||
    sheetName.includes("ReferencedReport")
  ) {
    return parseBgStatement(ws, filename);
  }

  return null;
}
