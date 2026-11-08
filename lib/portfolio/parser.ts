// LoanDisk CSV parser and bundle reader
// Strict string reading, BOM stripping, day-first date convention

import { createHash } from "node:crypto";
import JSZip from "jszip";

export interface ParsedCsvBundle {
  snapshotDate: string | null;
  loans: Record<string, string>[];
  repayments: Record<string, string>[];
  borrowers?: Record<string, string>[];
  sourceFiles: {
    loansFile?: string;
    repaymentsFile?: string;
    borrowersFile?: string;
    totalSize?: number;
  };
}

export interface ParsedPortfolioZip {
  snapshotDate: string | null;
  loansRaw: Record<string, string>[];
  repaymentsRaw: Record<string, string>[];
  borrowersRaw?: Record<string, string>[];
  hasRepaymentsFile: boolean;
  loansSha256: string;
  repaymentsSha256: string | null;
  loansFileName: string;
  repaymentsFileName?: string;
  borrowersFileName?: string;
}

export const DATE_REGEX = /(\d{4}-\d{2}-\d{2})/;

/**
 * Robust CSV parser that handles:
 * - UTF-8 BOM (\uFEFF)
 * - Quotes with embedded delimiters and escaped quotes ("")
 * - Windows (\r\n) and Unix (\n) line endings
 * - Preserves all values as strings
 */
export function parseCsv(content: string, delimiter = ","): Record<string, string>[] {
  // Strip BOM if present
  const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const len = text.length;
  if (len === 0) return [];

  // Auto-detect delimiter if not specified or comma doesn't appear in first line
  const firstEol = text.indexOf("\n");
  const firstLine = firstEol === -1 ? text : text.slice(0, firstEol);
  if (delimiter === "," && !firstLine.includes(",") && firstLine.includes(";")) {
    delimiter = ";";
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let insideQuotes = false;
  let fieldStart = 0;
  let fieldHasQuotes = false;

  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);

    if (code === 34 /* " */) {
      if (insideQuotes && i + 1 < len && text.charCodeAt(i + 1) === 34) {
        // Escaped quote ("") inside quoted string: skip second quote and remain inside quotes
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
      fieldHasQuotes = true;
    } else if (!insideQuotes) {
      if (text[i] === delimiter) {
        let val = text.slice(fieldStart, i).trim();
        if (fieldHasQuotes) {
          if (val.startsWith('"') && val.endsWith('"')) {
            val = val.slice(1, -1);
          }
          val = val.replace(/""/g, '"');
        }
        currentRow.push(val);
        fieldStart = i + 1;
        fieldHasQuotes = false;
      } else if (code === 10 /* \n */ || code === 13 /* \r */) {
        let val = text.slice(fieldStart, i).trim();
        if (fieldHasQuotes) {
          if (val.startsWith('"') && val.endsWith('"')) {
            val = val.slice(1, -1);
          }
          val = val.replace(/""/g, '"');
        }
        currentRow.push(val);
        if (currentRow.some((v) => v.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
        if (code === 13 && i + 1 < len && text.charCodeAt(i + 1) === 10) {
          i++;
        }
        fieldStart = i + 1;
        fieldHasQuotes = false;
      }
    }
  }

  // Push final field/row if any
  if (fieldStart < len || currentRow.length > 0) {
    let val = text.slice(fieldStart).trim();
    if (fieldHasQuotes) {
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      val = val.replace(/""/g, '"');
    }
    currentRow.push(val);
    if (currentRow.some((v) => v.length > 0)) {
      rows.push(currentRow);
    }
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.replace(/^"|"$/g, "").trim());
  const dataRows: Record<string, string>[] = new Array(rows.length - 1);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      obj[header] = row[c] ?? "";
    }
    dataRows[r - 1] = obj;
  }

  return dataRows;
}

/**
 * Extract snapshot date from file or folder name
 */
export function extractDateFromName(name: string): string | null {
  const match = name.match(DATE_REGEX);
  return match ? match[1] : null;
}

/**
 * Parse a LoanDisk ZIP backup file containing loans, repayments, and borrowers CSVs.
 */
export async function parsePortfolioZip(
  input: ArrayBuffer | Uint8Array | Buffer,
  zipFilename?: string,
): Promise<ParsedPortfolioZip> {
  const zip = await JSZip.loadAsync(input);

  // Filter out directories and hidden/metadata files (e.g. macOS __MACOSX, .DS_Store)
  const entries = Object.values(zip.files).filter((file) => {
    if (file.dir) return false;
    const base = file.name.split("/").pop() || "";
    if (base.startsWith(".") || file.name.includes("__MACOSX")) return false;
    return true;
  });

  const loansEntry = entries.find((file) => {
    const lower = file.name.toLowerCase();
    return (
      lower.endsWith(".csv") &&
      lower.includes("loans") &&
      !lower.includes("repayments") &&
      !lower.includes("borrowers")
    );
  });

  if (!loansEntry) {
    throw new Error(
      "No se encontró el archivo de préstamos (*loans*.csv) dentro del archivo ZIP.",
    );
  }

  const repaymentsEntry = entries.find((file) => {
    const lower = file.name.toLowerCase();
    return lower.endsWith(".csv") && lower.includes("repayments");
  });

  const borrowersEntry = entries.find((file) => {
    const lower = file.name.toLowerCase();
    return lower.endsWith(".csv") && lower.includes("borrowers");
  });

  const loansText = await loansEntry.async("string");
  const loansSha256 = createHash("sha256").update(loansText).digest("hex");
  const loansRaw = parseCsv(loansText);

  let repaymentsRaw: Record<string, string>[] = [];
  let repaymentsSha256: string | null = null;
  const hasRepaymentsFile = Boolean(repaymentsEntry);

  if (repaymentsEntry) {
    const repaymentsText = await repaymentsEntry.async("string");
    repaymentsSha256 = createHash("sha256").update(repaymentsText).digest("hex");
    repaymentsRaw = parseCsv(repaymentsText);
  }

  let borrowersRaw: Record<string, string>[] | undefined;
  if (borrowersEntry) {
    const borrowersText = await borrowersEntry.async("string");
    borrowersRaw = parseCsv(borrowersText);
  }

  // Deduce snapshot date: zip filename > loans filename > repayments filename
  let snapshotDate = zipFilename ? extractDateFromName(zipFilename) : null;
  if (!snapshotDate) {
    snapshotDate =
      extractDateFromName(loansEntry.name) ||
      (repaymentsEntry ? extractDateFromName(repaymentsEntry.name) : null);
  }

  return {
    snapshotDate,
    loansRaw,
    repaymentsRaw,
    borrowersRaw,
    hasRepaymentsFile,
    loansSha256,
    repaymentsSha256,
    loansFileName: loansEntry.name,
    repaymentsFileName: repaymentsEntry?.name,
    borrowersFileName: borrowersEntry?.name,
  };
}

