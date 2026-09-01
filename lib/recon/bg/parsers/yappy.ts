// Parser for Banco General Yappy transactions report ("Transacciones recibidas").

import * as XLSX from "xlsx";

import type { BgParsedYappyReport } from "../types";
import {
  extractDownloadTimestamp,
  parseAmountFloat,
  parseAmountMinor,
  parseIsoDate,
  removeAccents,
} from "./utils";

export function parseBgYappyReport(
  workbookOrSheet: XLSX.WorkBook | XLSX.WorkSheet | unknown[][],
  filename: string,
): BgParsedYappyReport {
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

  const out: BgParsedYappyReport = {
    fileType: "yappy",
    filename,
    collectionPoint: null,
    downloadedAt: extractDownloadTimestamp(filename),
    rows: [],
    errors: [],
  };

  let colMap: Record<string, number> | null = null;
  let isWaitingForCollectionPoint = false;

  for (const row of rawRows) {
    if (!row || !Array.isArray(row)) continue;
    const nonEmpty = row
      .map((c, i) => ({ col: i, val: c }))
      .filter((c) => c.val != null && String(c.val).trim() !== "");

    if (nonEmpty.length === 0) continue;

    if (!colMap) {
      const texts: Record<number, string> = {};
      for (const item of nonEmpty) {
        texts[item.col] = String(item.val).trim();
      }
      const textValues = Object.values(texts);

      if (textValues.includes("Punto de cobro")) {
        isWaitingForCollectionPoint = true;
      } else if (isWaitingForCollectionPoint) {
        for (const t of textValues) {
          if (t.startsWith("@")) {
            out.collectionPoint = t;
          }
        }
        isWaitingForCollectionPoint = false;
      }

      const normalized: Record<string, number> = {};
      for (const [colStr, t] of Object.entries(texts)) {
        normalized[removeAccents(t).toLowerCase()] = Number(colStr);
      }

      if ("fecha" in normalized && "monto" in normalized && "estado" in normalized) {
        colMap = {};
        const mapping: Array<[string, string]> = [
          ["fecha", "fecha"],
          ["hora", "hora"],
          ["referencia", "referencia"],
          ["nombre del cliente", "cliente"],
          ["celular", "celular"],
          ["comentario", "comentario"],
          ["estado", "estado"],
          ["monto", "monto"],
        ];
        for (const [label, field] of mapping) {
          if (label in normalized) {
            colMap[field] = normalized[label];
          }
        }
      }
      continue;
    }

    // Process data row
    const getVal = (field: string) => {
      const idx = colMap![field];
      return idx != null && idx < row.length ? row[idx] : null;
    };

    const date = parseIsoDate(getVal("fecha"));
    const amountMinor = parseAmountMinor(getVal("monto"));
    const amount = parseAmountFloat(getVal("monto"));

    if (!date || amountMinor == null || amount == null) continue;

    const rawComment = getVal("comentario");
    const cleanedComment = rawComment != null ? String(rawComment).trim().replace(/\s+/g, " ") : "";

    out.rows.push({
      date,
      time: getVal("hora") != null ? String(getVal("hora")).trim() : "",
      reference: getVal("referencia") != null ? String(getVal("referencia")).trim() : "",
      clientName: getVal("cliente") != null ? String(getVal("cliente")).trim() : "",
      phoneNumber: getVal("celular") != null ? String(getVal("celular")).trim() : "",
      comment: cleanedComment,
      bankStatus: getVal("estado") != null ? String(getVal("estado")).trim() : "",
      amountMinor,
      amount,
    });
  }

  if (!colMap) {
    out.errors.push("Header row not found in Yappy report");
  }

  return out;
}

