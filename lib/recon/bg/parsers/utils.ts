// Utility functions for parsing Banco General statement, ACH, and Yappy exports.

const MONTHS_ES: Record<string, number> = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dic: 12,
};

const MONTHS_EN: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const RE_DATE_TEXT = /^(\d{1,2})-([A-Za-zñÑ]{3,4})\.?-(\d{4})$/;
const RE_DATE_SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const RE_DOWNLOAD_TS = /(20\d{12})/;

export function removeAccents(str: string): string {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Parses dates from Date objects, Excel serial numbers, '17-ago-2026', '17-Aug-2026', '17/08/2026', '2026-08-17' -> ISO 'YYYY-MM-DD' */
export function parseIsoDate(val: unknown): string | null {
  if (val == null || val === "") return null;
  if (val instanceof Date) {
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, "0");
    const d = String(val.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof val === "number") {
    if (val > 30000 && val < 70000) {
      // Excel serial date number
      const dt = new Date(Math.round((val - 25569) * 86400 * 1000));
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const d = String(dt.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return null;
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mIso) return `${mIso[1]}-${mIso[2]}-${mIso[3]}`;

  const mText = RE_DATE_TEXT.exec(s);
  if (mText) {
    const day = parseInt(mText[1], 10);
    const monthRaw = removeAccents(mText[2].toLowerCase().slice(0, 3));
    const year = parseInt(mText[3], 10);
    const monthNum = MONTHS_ES[monthRaw] || MONTHS_EN[monthRaw];
    if (monthNum) {
      return `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const mSlash = RE_DATE_SLASH.exec(s);
  if (mSlash) {
    const day = parseInt(mSlash[1], 10);
    const month = parseInt(mSlash[2], 10);
    const year = parseInt(mSlash[3], 10);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return null;
}

/** Parses dollar strings or numbers ("$1,234.56", "(1,234.56)", 1234.56) to bigint cents (minor units). */
export function parseAmountMinor(val: unknown): bigint | null {
  if (val == null || val === "") return null;
  if (typeof val === "number") {
    if (isNaN(val)) return null;
    return BigInt(Math.round(val * 100));
  }
  let s = String(val)
    .trim()
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .replace(/\u00a0/g, "");
  if (!s) return null;

  const isNegative = s.startsWith("(") && s.endsWith(")");
  if (isNegative) {
    s = s.slice(1, -1);
  } else if (s.startsWith("-")) {
    // Already negative
  }

  const num = parseFloat(s);
  if (isNaN(num)) return null;

  const cents = Math.round(num * 100);
  return isNegative ? BigInt(-cents) : BigInt(cents);
}

/** Parses dollar strings or numbers to rounded 2-decimal floats. */
export function parseAmountFloat(val: unknown): number | null {
  const minor = parseAmountMinor(val);
  if (minor == null) return null;
  return Number(minor) / 100;
}

/** Extracts download timestamp from filename (e.g. "...20260821174026.xlsx"). */
export function extractDownloadTimestamp(filename: string): Date | null {
  const match = RE_DOWNLOAD_TS.exec(filename);
  if (!match) return null;
  const s = match[1];
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(4, 6), 10) - 1;
  const d = parseInt(s.slice(6, 8), 10);
  const h = parseInt(s.slice(8, 10), 10);
  const min = parseInt(s.slice(10, 12), 10);
  const sec = parseInt(s.slice(12, 14), 10);
  const dt = new Date(Date.UTC(y, m, d, h, min, sec));
  return isNaN(dt.getTime()) ? null : dt;
}

/** Helper to round floats to 2 decimals. */
export function round2(num: number): number {
  return Math.round(num * 100) / 100;
}

/** Compares two amounts within penny tolerance (0.005). */
export function areAmountsEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= 0.005;
}
