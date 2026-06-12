// LoanDisk daily-backup CSV parser.
//
// Three files per entity per day: borrowers / loans / repayments. The
// files are UTF-8 (the SheetJS-decoded "PrÃ©stamo" garble seen during
// inspection is purely a downstream decode bug — the bytes themselves
// are clean cp65001). We do a minimal RFC-4180 tokenize here instead
// of going through xlsx so encoding stays under our control.
//
// All money becomes `bigint` cents; all dates become ISO yyyy-mm-dd
// (LoanDisk emits DD/MM/YYYY for Panama). Every original column is
// preserved in `raw` so forward additions don't require a parser
// change.

import { createHash } from "node:crypto";

import type {
  ParsedBorrowerRow,
  ParsedCsvBundle,
  ParsedCsvFileMeta,
  ParsedLoanRow,
  ParsedRepaymentRow,
} from "./types";

// =============================================================
// Public API
// =============================================================

export interface ParseFilesArgs {
  borrowers: { filename: string; bytes: Uint8Array };
  loans: { filename: string; bytes: Uint8Array };
  repayments: { filename: string; bytes: Uint8Array };
}

export function parseLoanDiskBundle(args: ParseFilesArgs): ParsedCsvBundle {
  const borrowersGrid = parseCsv(args.borrowers.bytes);
  const loansGrid = parseCsv(args.loans.bytes);
  const repaymentsGrid = parseCsv(args.repayments.bytes);

  const borrowerRows = mapBorrowerRows(borrowersGrid);
  const loanRows = mapLoanRows(loansGrid);
  const repaymentRows = mapRepaymentRows(repaymentsGrid);

  return {
    borrowers: borrowerRows,
    loans: loanRows,
    repayments: repaymentRows,
    meta: {
      borrowers: makeMeta(args.borrowers, borrowerRows.length),
      loans: makeMeta(args.loans, loanRows.length),
      repayments: makeMeta(args.repayments, repaymentRows.length),
    },
  };
}

function makeMeta(
  file: { filename: string; bytes: Uint8Array },
  rowCount: number,
): ParsedCsvFileMeta {
  return {
    filename: file.filename,
    sha256: sha256Hex(file.bytes),
    byteSize: file.bytes.byteLength,
    rowCount,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// =============================================================
// CSV tokenizer (minimal RFC 4180)
// =============================================================

/**
 * Decodes bytes as UTF-8 and splits into rows of fields. Handles:
 *   - quoted fields ("...") with embedded commas and CRLF
 *   - escaped quotes ("") inside a quoted field
 *   - either CRLF or LF row terminators
 *   - leading BOM
 *
 * Returns a rectangular grid (header row + data rows). Empty trailing
 * row is dropped.
 */
export function parseCsv(bytes: Uint8Array): string[][] {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Strip BOM if present.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Treat \r\n as one separator.
      i += 1;
      if (src[i] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\n") {
      i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush trailing field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing all-empty rows (some exports add a blank line).
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) {
    rows.pop();
  }

  return rows;
}

// =============================================================
// Header → index lookup
// =============================================================

interface HeaderIndex {
  get(name: string): number | undefined;
  raw: string[];
}

function buildHeaderIndex(headerRow: string[]): HeaderIndex {
  const map = new Map<string, number>();
  headerRow.forEach((h, i) => map.set(h.trim(), i));
  return {
    get: (name) => map.get(name),
    raw: headerRow.map((h) => h.trim()),
  };
}

function cell(row: string[], h: HeaderIndex, name: string): string {
  const idx = h.get(name);
  if (idx === undefined) return "";
  const v = row[idx];
  return v === undefined ? "" : v;
}

function asText(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

function buildRawMap(row: string[], h: HeaderIndex): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < h.raw.length; i++) {
    out[h.raw[i]] = row[i] ?? "";
  }
  return out;
}

// =============================================================
// Value coercions
// =============================================================

/**
 * Parse a money string into cents (bigint). Accepts:
 *   "1234.56", "1,234.56", "1234", "-50.00", "(5.00)" → -500n.
 * Returns null for empty / non-numeric input. Truncates to cents.
 */
export function parseMoneyMinor(s: string): bigint | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  let body = trimmed;
  let negative = false;
  if (body.startsWith("(") && body.endsWith(")")) {
    negative = true;
    body = body.slice(1, -1);
  }
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }
  body = body.replace(/[,$\s]/g, "");
  if (body === "") return null;
  if (!/^\d+(\.\d+)?$/.test(body)) return null;
  const [whole, frac = ""] = body.split(".");
  const cents = (frac + "00").slice(0, 2);
  const total = BigInt(whole) * 100n + BigInt(cents);
  return negative ? -total : total;
}

export function parseIntField(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse LoanDisk dates. Primary format is DD/MM/YYYY (Panama). Also
 * tolerates D/M/YYYY, DD-MM-YYYY, and already-ISO YYYY-MM-DD. Returns
 * ISO yyyy-mm-dd or null.
 */
export function parseDateIso(s: string): string | null {
  const t = s.trim();
  if (t === "") return null;
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // DD/MM/YYYY or DD-MM-YYYY or D/M/YYYY
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(t);
  if (!m) return null;
  const dd = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  let yy = Number.parseInt(m[3], 10);
  if (m[3].length === 2) yy = yy < 70 ? 2000 + yy : 1900 + yy;
  if (yy < 1900 || yy > 2999) return null;
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  // Light validity check (no per-month-day count — Date handles it).
  const d = new Date(Date.UTC(yy, mm - 1, dd));
  if (
    d.getUTCFullYear() !== yy ||
    d.getUTCMonth() !== mm - 1 ||
    d.getUTCDate() !== dd
  ) {
    return null;
  }
  return `${yy.toString().padStart(4, "0")}-${mm.toString().padStart(2, "0")}-${dd.toString().padStart(2, "0")}`;
}

/**
 * Normalize a Panamanian cédula to "N-NNNN-NNNN" canonical form when
 * the input plausibly is one (e.g. "8-768-1092" stays; "8 768 1092"
 * normalizes; arbitrary codes like "EST004" return null).
 */
export function normalizeCedula(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim().toUpperCase();
  if (t === "") return null;
  // Strip whitespace, keep digits and dashes.
  const compact = t.replace(/\s+/g, "");
  // Match patterns like 8-937-1696, PE-12-345, N-1234-5678 (Panama uses
  // up to two letters in the prefix for naturalized / juridical).
  if (/^[A-Z0-9]{1,3}-\d{1,5}-\d{1,5}$/.test(compact)) return compact;
  // Already-digits-only cédulas are rare but accepted.
  if (/^\d{7,10}$/.test(compact)) return compact;
  return null;
}

/**
 * Normalize a free-form name for fuzzy borrower↔loan join. Uppercases,
 * strips accents, collapses whitespace, sorts tokens. Two names that
 * differ only in word order (last-first vs first-last) collapse to the
 * same key. Returns null if the input has fewer than 2 word characters.
 */
export function normalizeName(s: string | null): string | null {
  if (!s) return null;
  const stripped = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (stripped.length < 2) return null;
  return stripped.sort().join(" ");
}

// =============================================================
// Row mappers
// =============================================================

function mapBorrowerRows(grid: string[][]): ParsedBorrowerRow[] {
  if (grid.length < 2) return [];
  const h = buildHeaderIndex(grid[0]);
  const out: ParsedBorrowerRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const sourceBorrowerId = cell(row, h, "Borrower Id").trim();
    if (sourceBorrowerId === "") continue;
    const fullName = asText(cell(row, h, "Full Name"));
    const uniqueNumber = asText(cell(row, h, "Unique Number"));
    out.push({
      sourceBorrowerId,
      uniqueNumber,
      cedulaNormalized: normalizeCedula(uniqueNumber),
      fullName,
      lastName: asText(cell(row, h, "Last Name")),
      firstName: asText(cell(row, h, "First Name")),
      gender: asText(cell(row, h, "Gender")),
      age: parseIntField(cell(row, h, "Age")),
      // LoanDisk header has a typo: "Date 0f Birth" (zero, not letter o).
      dateOfBirth: parseDateIso(cell(row, h, "Date 0f Birth")),
      email: asText(cell(row, h, "Email")),
      mobile: asText(cell(row, h, "Mobile")),
      landline: asText(cell(row, h, "Landline")),
      address: asText(cell(row, h, "Address")),
      city: asText(cell(row, h, "City")),
      province: asText(cell(row, h, "Province")),
      zipcode: asText(cell(row, h, "Zipcode")),
      country: asText(cell(row, h, "Country")),
      workingStatus: asText(cell(row, h, "Working Status")),
      business: asText(cell(row, h, "Business")),
      creditScore: parseIntField(cell(row, h, "Credit Score")),
      loanOfficerRaw: asText(cell(row, h, "Loan Officer")),
      borrowerStatusRaw: asText(cell(row, h, "Borrower Status Name")),
      createdDate: parseDateIso(cell(row, h, "Created Date")),
      numberOfLoans: parseIntField(cell(row, h, "Number of Loans")),
      numberOfOpenLoans: parseIntField(cell(row, h, "Number of Open Loans")),
      numberOfFullyPaidLoans: parseIntField(
        cell(row, h, "Number of Fully Paid Loans"),
      ),
      numberOfDefaultedLoans: parseIntField(
        cell(row, h, "Number of Defaulted Loans"),
      ),
      numberOfProcessingLoans: parseIntField(
        cell(row, h, "Number of Processing Loans"),
      ),
      numberOfRestructuredLoans: parseIntField(
        cell(row, h, "Number of Restructured Loans"),
      ),
      numberOfDeniedLoans: parseIntField(cell(row, h, "Number of Denied Loans")),
      numberOfNotTakenUpLoans: parseIntField(
        cell(row, h, "Number of Not Taken Up Loans"),
      ),
      totalPaidAmountMinor: parseMoneyMinor(cell(row, h, "Total Paid Amount")),
      openLoansBalanceMinor: parseMoneyMinor(
        cell(row, h, "Open Loans Balance"),
      ),
      normalizedName: normalizeName(fullName),
      raw: buildRawMap(row, h),
    });
  }
  return out;
}

function mapLoanRows(grid: string[][]): ParsedLoanRow[] {
  if (grid.length < 2) return [];
  const h = buildHeaderIndex(grid[0]);
  const out: ParsedLoanRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const sourceLoanId = cell(row, h, "Loan Id").trim();
    if (sourceLoanId === "") continue;
    out.push({
      sourceLoanId,
      sourceLoanNumber: asText(cell(row, h, "Loan #")),
      sourceBorrowerRef: asText(cell(row, h, "Borrower #")),

      productRaw: asText(cell(row, h, "Loan Product")),
      loanOfficerRaw: asText(cell(row, h, "Loan Officer")),
      releasedDate: parseDateIso(cell(row, h, "Released Date")),
      maturityDate: parseDateIso(cell(row, h, "Maturity Date")),
      durationMonths: parseDurationMonths(cell(row, h, "Loan Duration")),
      repaymentCycle: asText(cell(row, h, "Repayment Cycle")),
      interestRateRaw: asText(cell(row, h, "Interest Rate")),

      principalAmountMinor: parseMoneyMinor(cell(row, h, "Principal Amount")),
      balanceAmountMinor: parseMoneyMinor(cell(row, h, "Balance Amount")),
      totalPrincipalBalanceMinor: parseMoneyMinor(
        cell(row, h, "Total Principal Balance"),
      ),
      pendingPrincipalDueMinor: parseMoneyMinor(
        cell(row, h, "Pending Principal Due"),
      ),
      pastDueMinor: parseMoneyMinor(cell(row, h, "Past Due")),
      pendingDueMinor: parseMoneyMinor(cell(row, h, "Pending Due")),
      paidAmountMinor: parseMoneyMinor(cell(row, h, "Paid Amount")),
      totalPrincipalPaidMinor: parseMoneyMinor(
        cell(row, h, "Total Principal Paid"),
      ),
      totalInterestPaidMinor: parseMoneyMinor(
        cell(row, h, "Total Interest Paid"),
      ),
      totalPenaltyPaidMinor: parseMoneyMinor(
        cell(row, h, "Total Penalty Paid"),
      ),
      totalFeesPaidMinor: parseMoneyMinor(cell(row, h, "Total Fees Paid")),
      totalPenaltyBalanceMinor: parseMoneyMinor(
        cell(row, h, "Total Penalty Balance"),
      ),
      totalFeesBalanceMinor: parseMoneyMinor(
        cell(row, h, "Total Fees Balance"),
      ),
      totalInterestBalanceMinor: parseMoneyMinor(
        cell(row, h, "Total Interest Balance"),
      ),
      nextInstallmentAmountMinor: parseMoneyMinor(
        cell(row, h, "Next Installment Amount"),
      ),
      nextInstallmentDate: parseDateIso(cell(row, h, "Next Installment Date")),
      lastPaymentAmountMinor: parseMoneyMinor(
        cell(row, h, "Last Payment Amount"),
      ),
      lastPaymentDate: parseDateIso(cell(row, h, "Last Payment Date")),

      daysPastDue: parseIntField(cell(row, h, "Days Past Due")),
      daysPastMaturity: parseIntField(cell(row, h, "Days Past Maturity")),
      daysToMaturity: parseIntField(cell(row, h, "Days To Maturity")),

      bankAccountLoanReleased: asText(cell(row, h, "Bank Account (Loan Released)")),
      statusRaw: asText(cell(row, h, "Loan Status Name")),

      raw: buildRawMap(row, h),
    });
  }
  return out;
}

/**
 * LoanDisk's "Loan Duration" comes as "24 Months", "12 Months", "6 Months",
 * occasionally "365 Days" for daily-cycle loans. Returns months as int.
 * Daily-cycle durations are converted (rounded up) so a single field is
 * usable downstream.
 */
function parseDurationMonths(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (t === "") return null;
  const m = /^(\d+)\s*(month|months|day|days|year|years)?$/.exec(t);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "months").replace(/s$/, "");
  if (unit === "month") return n;
  if (unit === "year") return n * 12;
  if (unit === "day") return Math.max(1, Math.ceil(n / 30));
  return n;
}

function mapRepaymentRows(grid: string[][]): ParsedRepaymentRow[] {
  if (grid.length < 2) return [];
  const h = buildHeaderIndex(grid[0]);
  const out: ParsedRepaymentRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const sourceRepaymentId = cell(row, h, "Repayment Id").trim();
    const sourceLoanId = cell(row, h, "Loan Id").trim();
    if (sourceRepaymentId === "" || sourceLoanId === "") continue;
    const method = asText(cell(row, h, "Repayment Method"));
    const principal = parseMoneyMinor(cell(row, h, "Principal Paid Amount")) ?? 0n;
    const interest = parseMoneyMinor(cell(row, h, "Interest Paid Amount")) ?? 0n;
    const penalty = parseMoneyMinor(cell(row, h, "Penalty Paid Amount")) ?? 0n;
    const fees = parseMoneyMinor(cell(row, h, "Fees Paid Amount")) ?? 0n;
    out.push({
      sourceRepaymentId,
      sourceLoanId,
      sourceBorrowerRef: asText(cell(row, h, "Borrower #")),
      collectionDate: parseDateIso(cell(row, h, "Collection Date")),
      editDate: parseDateIso(cell(row, h, "Edit Date")),
      method,
      isCashCollection: classifyCashCollection(method),
      principalPaidMinor: principal,
      interestPaidMinor: interest,
      penaltyPaidMinor: penalty,
      feesPaidMinor: fees,
      totalPaidMinor: principal + interest + penalty + fees,
      collectedBy: asText(cell(row, h, "Collected By")),
      approvedBy: asText(cell(row, h, "Approved By")),
      loanOfficerRaw: asText(cell(row, h, "Loan Officer")),
      description: asText(cell(row, h, "Description")),
      bankAccountPaymentRaw: asText(cell(row, h, "Bank Account (Payments)")),
      raw: buildRawMap(row, h),
    });
  }
  return out;
}

/**
 * Non-cash methods seen in the Crediclaro export:
 *   "Traspaso a Provision" — write-off to provision.
 *   "Finiquito otorgado"   — settlement granted.
 *   "Descuento por Pronto Pago" — discount, not collected cash.
 * Everything else is treated as cash. Returning false here keeps these
 * out of headline collection-cash-flow metrics downstream.
 */
export function classifyCashCollection(method: string | null): boolean {
  if (!method) return true;
  const m = method.trim().toLowerCase();
  if (m.startsWith("traspaso a provision")) return false;
  if (m.startsWith("finiquito")) return false;
  if (m.startsWith("descuento por pronto pago")) return false;
  return true;
}
