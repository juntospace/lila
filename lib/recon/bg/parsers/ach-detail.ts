// Parser for Banco General ACH Debit response files ("Detalle Transacción ACH").
// Supports Variant A ("Detalles del Archivo ACH") and Variant B ("Rechazos del Archivo ACH").

import * as XLSX from "xlsx";

import type { BgParsedAchDetail } from "../types";
import {
  extractDownloadTimestamp,
  parseAmountFloat,
  parseAmountMinor,
  parseIsoDate,
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
  let isManual = false;
  let colRoute = 0;
  let colAccount = 1;
  let colAmount = 2;
  let colClientId = 3;
  let colClientName = 4;
  let colAddenda = 5;
  let colError = 6;

  for (const row of rawRows) {
    if (!row || !Array.isArray(row)) continue;
    const nonEmpty = row.filter((c) => c != null && String(c).trim() !== "");
    if (nonEmpty.length === 0) continue;

    const s0 = String(nonEmpty[0]).trim();

    if (!inTable) {
      if (s0.startsWith("Detalles del")) {
        out.variant = "A";
        if (s0.toLowerCase().includes("manual")) {
          isManual = true;
        }
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

      if (row.some((c) => String(c ?? "").toUpperCase().includes("CODIGO DE RUTA"))) {
        inTable = true;
        const headers = row.map((c) => String(c ?? "").trim().toUpperCase());
        const fRoute = headers.findIndex((h) => h.includes("CODIGO DE RUTA") || h.includes("RUTA"));
        const fAccount = headers.findIndex((h) => h.includes("CUENTA"));
        const fAmount = headers.findIndex((h) => h.includes("MONTO"));
        const fClientId = headers.findIndex((h) => h === "BENEFICIARIO");
        const fClientName = headers.findIndex((h) => h.includes("NOMBRE DEL BENEFICIARIO") || h.includes("NOMBRE"));
        const fAddenda = headers.findIndex((h) => h.includes("ADDENDA"));
        const fError = headers.findIndex((h) => h.includes("ERROR"));

        if (fRoute !== -1) colRoute = fRoute;
        if (fAccount !== -1) colAccount = fAccount;
        if (fAmount !== -1) colAmount = fAmount;
        if (fClientId !== -1) colClientId = fClientId;
        if (fClientName !== -1) colClientName = fClientName;
        if (fAddenda !== -1) colAddenda = fAddenda;
        if (fError !== -1) colError = fError;
        continue;
      }
      continue;
    }

    // Inside detail table
    const amountMinor = parseAmountMinor(row[colAmount]);
    const amount = parseAmountFloat(row[colAmount]);
    if (amountMinor == null || amount == null) continue;

    const errorRaw = colError !== -1 && row[colError] != null ? String(row[colError]).trim() : "";
    const mErr = RE_ERROR_CODE.exec(errorRaw);
    const errorCode = mErr ? mErr[1].toUpperCase() : errorRaw ? "R??" : "";

    out.rows.push({
      routingCode: colRoute !== -1 && row[colRoute] != null ? String(row[colRoute]).trim() : "",
      accountNumber: colAccount !== -1 && row[colAccount] != null ? String(row[colAccount]).trim() : "",
      amountMinor,
      amount,
      clientId: colClientId !== -1 && row[colClientId] != null ? String(row[colClientId]).trim() : "",
      clientName: colClientName !== -1 && row[colClientName] != null ? String(row[colClientName]).trim() : "",
      addenda: colAddenda !== -1 && row[colAddenda] != null ? String(row[colAddenda]).trim() : "",
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
    if (isManual || filename.toLowerCase().includes("ach")) {
      out.batchName = filename.replace(/\.xlsx?$/i, "");
      if (out.effectiveDate) {
        out.batchDateStr = out.effectiveDate.replace(/-/g, "");
        out.batchDate = out.effectiveDate;
      }
      const allRoutes = out.rows.map((r) => r.routingCode).filter(Boolean);
      if (allRoutes.length > 0 && allRoutes.every((r) => r === "0071")) {
        out.channel = "BG";
      } else if (allRoutes.length > 0) {
        out.channel = "TER";
      }
      out.declaredTotalAmountMinor = out.rows.reduce((sum, r) => sum + r.amountMinor, 0n);
    } else {
      out.errors.push('Missing "Nombre de archivo" line: cannot identify batch');
    }
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

