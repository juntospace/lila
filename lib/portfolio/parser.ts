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

  // Auto-detect delimiter if not specified or comma doesn't appear in first line
  const firstLine = text.split(/\r\n|\n/, 1)[0] || "";
  if (delimiter === "," && !firstLine.includes(",") && firstLine.includes(";")) {
    delimiter = ";";
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentVal = "";
  let insideQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentVal += '"';
        i += 2;
        continue;
      }
      insideQuotes = !insideQuotes;
      i++;
      continue;
    }

    if (!insideQuotes && char === delimiter) {
      currentRow.push(currentVal.trim());
      currentVal = "";
      i++;
      continue;
    }

    if (!insideQuotes && (char === "\r" || char === "\n")) {
      if (char === "\r" && nextChar === "\n") {
        i++;
      }
      currentRow.push(currentVal.trim());
      currentVal = "";
      // Only push non-empty rows
      if (currentRow.some((val) => val.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentVal += char;
    i++;
  }

  // Push final field/row if any
  if (currentVal.length > 0 || currentRow.length > 0) {
    currentRow.push(currentVal.trim());
    if (currentRow.some((val) => val.length > 0)) {
      rows.push(currentRow);
    }
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.replace(/^"|"$/g, "").trim());
  const dataRows: Record<string, string>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      obj[header] = row[c] ?? "";
    }
    dataRows.push(obj);
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

