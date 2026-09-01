// Parser for Banco General ACH Debit response files ("Detalle Transacción ACH").
// Supports Variant A ("Detalles del Archivo ACH") and Variant B ("Rechazos del Archivo ACH").

import * as XLSX from "xlsx";

import type { BgAchDetailRow, BgParsedAchDetail } from "../types";
import {
  extractDownloadTimestamp,
  parseAmountFloat,
  parseAmountMinor,
  parseIsoDate,
  round2,
} from "./utils";

const RE_BATCH_FILENAME = /Nombre\s+de\s+archivo\s*:\s*(.+)$/i;
const RE_SUMMARY_A = /(\d+)\s+transacciones\s+(\d+)\s+realizadas?\s+(\d+)\s+rechazadas?/i;
const RE_SUMMARY_B = /(\d+)\s+transacciones\s+rechazadas.*?Monto total de rechazos\s*\$?([\d,]+\.\d{2})/i;
const RE_EFFECTIVE_DATE = /Fecha\s+efectiva\s+(\d{1,2}-[A-Za-zñÑ]{3}\.?-\d{4})/i;
const RE_LOTE_INFO = /^(20\d{6})\s*-?\s*(.*?)\s*-\s*LOTE ACH\s*(\(MOROSOS\))?\s*(BG|TER)?\s*(\d{1,2})?/i;
const RE_RETRY = /\((\d+)\)\.txt\s*$/i;
const RE_ERROR_CODE = /^(R\d{2})\b/i;

/** Clamps an invalid calendar batch date (e.g. "20260229") to the last valid day of the month. */
export function validateBatchDate(rawYyyymmdd: string, errors: string[]): string | null {
  const y = parseInt(rawYyyymmdd.slice(0, 4), 10);
  const m = parseInt(rawYyyymmdd.slice(4, 6), 10);
  let d = parseInt(rawYyyymmdd.slice(6, 8), 10);

  if (m < 1 || m > 12) {
    errors.push(`Invalid batch date: ${rawYyyymmdd} (month ${m})`);
    return null;
  }

  // Find max days in month
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > lastDay) {
    d = lastDay;
  }

  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseBgAchDetail(
  workbookOrSheet: XLSX.WorkBook | XLSX.WorkSheet | unknown[][],
  filename: string,
): BgParsedAchDetail {
  let sheet: XLSX.WorkSheet | null = null;

  if (Array.isArray(workbookOrSheet)) {
    // Array of rows
  } else if ("SheetNames" in workbookOrSheet) {
    const wb = workbookOrSheet as XLSX.WorkBook;
    const name = wb.SheetNames[0];
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

  const out: BgParsedAchDetail = {
    fileType: "ach_detail",
    filename,
    variant: "A",
    batchName: null,
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
    downloadedAt: extractDownloadTimestamp(filename),
    rows: [],
    rejectedSumMinor: 0n,
    rejectedSum: 0,
    rejectedRowsCount: 0,
    succeededRowsCount: 0,
    succeededSumMinor: 0n,
    succeededSum: 0,
    errors: [],
  };

  let inTable = false;

  for (const row of rawRows) {
    if (!row || !Array.isArray(row)) continue;
    const nonEmpty = row.filter((c) => c != null && String(c).trim() !== "");
    if (nonEmpty.length === 0) continue;

    const s0 = String(nonEmpty[0]).trim();

    if (!inTable) {
      if (s0.startsWith("Detalles del")) {
        out.variant = "A";
        continue;
      }
      if (s0.startsWith("Rechazos del")) {
        out.variant = "B";
        continue;
      }

      const fnMatch = RE_BATCH_FILENAME.exec(s0);
      if (fnMatch) {
        out.batchName = fnMatch[1].trim();
        const infoMatch = RE_LOTE_INFO.exec(out.batchName);
        if (infoMatch) {
          out.batchDateStr = infoMatch[1];
          out.batchDate = validateBatchDate(infoMatch[1], out.errors);
          out.isDelinquent = Boolean(infoMatch[3]);
          out.channel = infoMatch[4] ? infoMatch[4].toUpperCase() : null;
          out.fortnight = infoMatch[5] ? parseInt(infoMatch[5], 10) : null;
        }
        const retryMatch = RE_RETRY.exec(out.batchName);
        if (retryMatch) {
          out.retryCount = parseInt(retryMatch[1], 10);
        }
        continue;
      }

      const sumAMatch = RE_SUMMARY_A.exec(s0);
      if (sumAMatch) {
        out.totalTransactions = parseInt(sumAMatch[1], 10);
        out.succeededTransactions = parseInt(sumAMatch[2], 10);
        out.rejectedTransactions = parseInt(sumAMatch[3], 10);
        continue;
      }

      const sumBMatch = RE_SUMMARY_B.exec(s0);
      if (sumBMatch) {
        out.totalTransactions = parseInt(sumBMatch[1], 10);
        out.rejectedTransactions = parseInt(sumBMatch[1], 10);
        out.declaredRejectionsAmountMinor = parseAmountMinor(sumBMatch[2]);
        continue;
      }

      const effMatch = RE_EFFECTIVE_DATE.exec(s0);
      if (effMatch) {
        out.effectiveDate = parseIsoDate(effMatch[1]);
        continue;
      }

      if (s0 === "CODIGO DE RUTA") {
        inTable = true;
        continue;
      }
      continue;
    }

    // Inside detail table: CODIGO DE RUTA | CUENTA | MONTO | BENEFICIARIO | NOMBRE DEL BENEFICIARIO | ADDENDA | DESCRIPCION DE ERROR | OBSERVACIONES
    const amountMinor = parseAmountMinor(row[2]);
    const amount = parseAmountFloat(row[2]);
    if (amountMinor == null || amount == null) continue;

    const errorRaw = row[6] != null ? String(row[6]).trim() : "";
    const mErr = RE_ERROR_CODE.exec(errorRaw);
    const errorCode = mErr ? mErr[1].toUpperCase() : errorRaw ? "R??" : "";

    out.rows.push({
      routingCode: row[0] != null ? String(row[0]).trim() : "",
      accountNumber: row[1] != null ? String(row[1]).trim() : "",
      amountMinor,
      amount,
      clientId: row[3] != null ? String(row[3]).trim() : "",
      clientName: row[4] != null ? String(row[4]).trim() : "",
      addenda: row[5] != null ? String(row[5]).trim() : "",
      errorCode,
      errorDescription: errorRaw,
    });
  }

  const rejectedRows = out.rows.filter((r) => r.errorCode !== "");
  const succeededRows = out.rows.filter((r) => r.errorCode === "");

  out.rejectedRowsCount = rejectedRows.length;
  out.rejectedSumMinor = rejectedRows.reduce((sum, r) => sum + r.amountMinor, 0n);
  out.rejectedSum = Number(out.rejectedSumMinor) / 100;

  out.succeededRowsCount = succeededRows.length;
  out.succeededSumMinor = succeededRows.reduce((sum, r) => sum + r.amountMinor, 0n);
  out.succeededSum = Number(out.succeededSumMinor) / 100;

  if (!out.batchName) {
    out.errors.push('Missing "Nombre de archivo" line: cannot identify batch');
  }
  if (!out.effectiveDate) {
    out.errors.push('Missing "Fecha efectiva"');
  }
  if (out.rejectedTransactions != null && out.rejectedRowsCount !== out.rejectedTransactions) {
    out.errors.push(
      `Inconsistent count: summary declares ${out.rejectedTransactions} rejected, but list contains ${out.rejectedRowsCount} error rows` +
        (out.succeededRowsCount > 0 ? ` and ${out.succeededRowsCount} without error` : ""),
    );
  }
  if (out.declaredRejectionsAmountMinor != null) {
    const declaredFloat = Number(out.declaredRejectionsAmountMinor) / 100;
    if (Math.abs(declaredFloat - out.rejectedSum) > 0.005) {
      out.errors.push(
        `Declared rejected amount $${declaredFloat.toFixed(2)} != sum of rows $${out.rejectedSum.toFixed(2)}`,
      );
    }
  }

  return out;
}

