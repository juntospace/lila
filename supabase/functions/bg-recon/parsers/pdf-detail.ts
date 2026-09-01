// Parser for historical Banco General ACH response PDFs in Edge Function.

import type { BgParsedAchDetail } from "../types.ts";
import {
  parseAmountFloat,
  parseAmountMinor,
  parseIsoDate,
} from "./utils.ts";

const RE_PDF_ACCOUNT = /CUENTA\s+DE\s+\w+\s+([\d-]{10,})/i;
const RE_PDF_HOLDER = /Titular\s+(.+)/i;
const RE_PDF_SUMMARY = /(\d+)\s+(\d+)\s+(\d+)\s+(?:D[eé]bito|Cr[eé]dito)\s+(\d{1,2}-[a-zñÑ]{3}\.?-\d{4})\s+\$([\d,]+\.\d{2})/i;
const RE_PDF_ITEM = /^(\S+)\s+(\d{4})\s+(.+?)\s+(\d{6,})\s+\$([\d,]+\.\d{2})\s+(REALIZADA|RECHAZADA.*)$/i;
const RE_ERROR_CODE = /^(R\d{2})\b/i;

export function parseBgAchDetailPdfText(
  extractedText: string,
  filename: string,
): BgParsedAchDetail {
  const out: BgParsedAchDetail = {
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
    declaredTotalAmountMinor: null,
    downloadedAt: null,
    accountNumber: null,
    holderName: null,
    rows: [],
    rejectedSumMinor: 0n,
    rejectedSum: 0,
    rejectedRowsCount: 0,
    succeededRowsCount: 0,
    succeededSumMinor: 0n,
    succeededSum: 0,
    errors: [],
  };

  const lines = extractedText.split("\n").map((l) => l.trim()).filter(Boolean);
  let pendingItem: {
    routingCode: string;
    accountNumber: string;
    amountMinor: bigint;
    amount: number;
    clientId: string;
    clientName: string;
    addenda: string;
    errorCode: string;
    errorDescription: string;
  } | null = null;

  for (const ln of lines) {
    const mAcc = RE_PDF_ACCOUNT.exec(ln);
    if (mAcc && !out.accountNumber) {
      out.accountNumber = mAcc[1];
      continue;
    }

    const mHolder = RE_PDF_HOLDER.exec(ln);
    if (mHolder && !out.holderName) {
      out.holderName = mHolder[1].trim();
      continue;
    }

    const mSum = RE_PDF_SUMMARY.exec(ln);
    if (mSum && out.totalTransactions == null) {
      out.totalTransactions = parseInt(mSum[1], 10);
      out.succeededTransactions = parseInt(mSum[2], 10);
      out.rejectedTransactions = parseInt(mSum[3], 10);
      out.effectiveDate = parseIsoDate(mSum[4]);
      out.batchDate = out.effectiveDate;
      out.batchDateStr = out.effectiveDate ? out.effectiveDate.replace(/-/g, "") : null;
      out.declaredTotalAmountMinor = parseAmountMinor(mSum[5]);
      continue;
    }

    const mItem = RE_PDF_ITEM.exec(ln);
    if (mItem) {
      const statusRaw = mItem[6].trim();
      const amountMinor = parseAmountMinor(mItem[5])!;
      const amount = parseAmountFloat(mItem[5])!;
      const isApproved = statusRaw === "REALIZADA";

      let errorCode = "";
      let errorDescription = "";

      if (!isApproved) {
        let rest = statusRaw.replace(/^RECHAZADA\s*-?\s*/i, "").trim();
        const mCode = RE_ERROR_CODE.exec(rest);
        errorCode = mCode ? mCode[1].toUpperCase() : "R??";
        errorDescription = rest;
      }

      pendingItem = {
        routingCode: mItem[2],
        accountNumber: mItem[4],
        amountMinor,
        amount,
        clientId: mItem[1],
        clientName: mItem[3].trim(),
        addenda: "",
        errorCode,
        errorDescription,
      };
      out.rows.push(pendingItem);
      continue;
    }

    if (
      pendingItem &&
      pendingItem.errorDescription &&
      !ln.startsWith("Pag.") &&
      !ln.startsWith("Copyright") &&
      !ln.startsWith("Entidad") &&
      !ln.startsWith("ID ")
    ) {
      pendingItem.errorDescription += " " + ln;
      const mCode = RE_ERROR_CODE.exec(pendingItem.errorDescription);
      if (mCode) pendingItem.errorCode = mCode[1].toUpperCase();
      continue;
    }

    pendingItem = null;
  }

  const rejectedRows = out.rows.filter((r) => r.errorCode !== "");
  const succeededRows = out.rows.filter((r) => r.errorCode === "");

  out.rejectedRowsCount = rejectedRows.length;
  out.rejectedSumMinor = rejectedRows.reduce((sum, r) => sum + r.amountMinor, 0n);
  out.rejectedSum = Number(out.rejectedSumMinor) / 100;

  out.succeededRowsCount = succeededRows.length;
  out.succeededSumMinor = succeededRows.reduce((sum, r) => sum + r.amountMinor, 0n);
  out.succeededSum = Number(out.succeededSumMinor) / 100;

  if (out.totalTransactions != null && out.rows.length !== out.totalTransactions) {
    out.errors.push(
      `PDF declares ${out.totalTransactions} transactions but ${out.rows.length} rows were read`,
    );
  }
  if (out.succeededTransactions != null && out.succeededRowsCount !== out.succeededTransactions) {
    out.errors.push(
      `Declared succeeded ${out.succeededTransactions} != rows without error ${out.succeededRowsCount}`,
    );
  }

  return out;
}

