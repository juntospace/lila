// LoanDisk CSV parser and bundle reader
// Strict string reading, BOM stripping, day-first date convention

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

