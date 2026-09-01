// Content-based file type sniffer for Banco General reconciliation in Edge Function.

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
  fileBytesOrBuffer: Uint8Array | ArrayBuffer | any,
  filename: string,
  pdfText?: string,
): BgDetectedFileResult | null {
  const low = filename.toLowerCase();

  if (low.endsWith(".pdf")) {
    if (pdfText != null) {
      return parseBgAchDetailPdfText(pdfText, filename);
    }
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

  let wb: any;
  try {
    if (Array.isArray(fileBytesOrBuffer)) {
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
      if (blob.includes("Punto de cobro") || blob.includes("Yappy") || blob.includes("@financieracrediclaro")) {
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
      type: "array",
      raw: true,
      cellDates: false,
    });
  } catch {
    return null;
  }

  const sheetName = wb.SheetNames[0] || "";
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;

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
    blob.includes("Punto de cobro") ||
    blob.includes("@financieracrediclaro") ||
    sheetName.includes("Yappy")
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

