// BG (Banco General) Excel parser.
//
// Two file shapes share this module:
//
//   1. Statement (`BGPCheckingMovementsExcel` sheet) — periodic export
//      of every transaction on the account. Each row is a single
//      transaction; we classify by the `Transacción` code:
//
//        2627, 2626  — same-bank transfer-IN (loan payment candidate)
//        48          — interbank ACH-IN (loan payment candidate)
//        40          — direct deposit or Yappy
//        50          — outbound fees/transfers (non-loan)
//        2519, 2520  — outbound same-bank transfers (non-loan)
//        55          — certified checks (non-loan)
//
//   2. ACH Debit batch detail (`BGPACHRejectedDetailList` sheet) —
//      per-client outcomes for one specific outbound ACH Debit batch.
//      Preamble carries the filename, effective date, and summary
//      counts. Each detail row is one debtor.
//
// Both shapes are parsed by sniffing the first sheet's structure;
// callers can also force a parse via `parseBGStatement` / `parseBGAchDetail`.

import { createHash } from "node:crypto";

import type { WorkSheet } from "xlsx";
import * as XLSX from "xlsx";

// =============================================================
// Statement
// =============================================================

/**
 * Recognized BG `Transacción` codes. The numeric strings come from the
 * bank verbatim; we keep them as strings to avoid lossy number coercion
 * (some are 2-digit, some 4-digit). New codes from BG land in `unknown`
 * until classified.
 */
export const BG_KNOWN_CODES = [
  "2627", // Same-bank transfer-IN (web)
  "2626", // Same-bank transfer-IN (mobile?)
  "48",   // Interbank ACH-IN
  "40",   // Direct deposit / Yappy
  "50",   // Outbound fee / Yappy commission / bill payment
  "2519", // Same-bank transfer-OUT (variant a)
  "2520", // Same-bank transfer-OUT (variant b)
  "55",   // Certified check
] as const;
export type BGKnownCode = (typeof BG_KNOWN_CODES)[number];

/** Maps a BG transaction code to its loan-relevance + initial state. */
export type BGRowKind = "loan_inflow" | "non_loan" | "unknown";

export function classifyBGCode(code: string): BGRowKind {
  switch (code) {
    case "2627":
    case "2626":
    case "48":
    case "40":
      return "loan_inflow";
    case "50":
    case "2519":
    case "2520":
    case "55":
      return "non_loan";
    default:
      return "unknown";
  }
}

export interface BGStatementRow {
  postedAt: string;        // YYYY-MM-DD (date-only; BG ships timestamps but day is enough)
  reference: string;       // BG "Referencia" — may be very short (e.g. "93", "457") or a long unique id
  code: string;            // BG "Transacción"
  description: string;
  debitMinor: bigint;
  creditMinor: bigint;
  balanceMinor: bigint;
  /** Parsed payer name when the description matches a known pattern. Null otherwise. */
  payerNameRaw: string | null;
  /** Parsed "Doing Business As" (string between parentheses), if present. */
  payerDba: string | null;
  /** Parsed operator-entered comment trailer (after the name/DBA). */
  comment: string | null;
}

export interface BGStatementHeader {
  accountNumber: string;
  accountHolder: string;
  dateRangeStart: string | null;  // YYYY-MM-DD
  dateRangeEnd: string | null;
}

export interface BGStatementParseResult {
  kind: "statement";
  header: BGStatementHeader;
  rows: BGStatementRow[];
  warnings: string[];
}

const MONTHS_ES: Record<string, string> = {
  ene: "01",
  feb: "02",
  mar: "03",
  abr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  ago: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dic: "12",
};

function toIsoDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "string") {
    // ISO datetime: "2026-04-13T23:59:26.000Z"
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    // Spanish short: "13-abr-2026"
    const es = v.match(/^(\d{1,2})-([a-zé]{3})-(\d{4})/i);
    if (es) {
      const mm = MONTHS_ES[es[2].toLowerCase()];
      if (mm) return `${es[3]}-${mm}-${es[1].padStart(2, "0")}`;
    }
  }
  return null;
}

/** Coerces "8.33" / "1,234.56" / "" to bigint minor units. */
export function parseMinor(v: unknown): bigint {
  if (v == null || v === "") return 0n;
  if (typeof v === "number") {
    // Avoid float drift: round to nearest cent.
    return BigInt(Math.round(v * 100));
  }
  const s = String(v).replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return 0n;
  const [whole, dec = ""] = s.split(".");
  const cents = (dec + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const abs = whole.replace(/^-/, "");
  return sign * (BigInt(abs) * 100n + BigInt(cents));
}

function asString(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Pull `accountNumber` from "Numero de Cuenta: 03-43-01-106691-6" (keeps
 * the dashes as-is — that's the canonical surface form).
 */
function parseAccountNumber(s: string): string | null {
  const m = s.match(/Numero\s+de\s+Cuenta\s*:\s*([0-9\-]+)/i);
  return m ? m[1].trim() : null;
}

function parseCompany(s: string): string | null {
  const m = s.match(/Empresa\s*:\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

function parseDateRange(s: string): { start: string | null; end: string | null } {
  const m = s.match(
    /Movimientos\s+desde\s+(\d{1,2}-[a-zé]{3}-\d{4})\s+hasta\s+(\d{1,2}-[a-zé]{3}-\d{4})/i,
  );
  if (!m) return { start: null, end: null };
  return { start: toIsoDate(m[1]), end: toIsoDate(m[2]) };
}

/**
 * Description shape, when it matches:
 *
 *   BANCA EN LINEA TRANSFERENCIA DE {NAME} ({DBA})? {COMMENT}?
 *   BANCA MOVIL    TRANSFERENCIA DE {NAME} ({DBA})? {COMMENT}?
 *   ACH - {NAME}
 *
 * The bank truncates the description to ~90 chars in the export, so the
 * tail (comment) is often cut off. We pull what we can.
 */
export function parseBGDescription(desc: string): {
  payerNameRaw: string | null;
  payerDba: string | null;
  comment: string | null;
} {
  if (!desc) return { payerNameRaw: null, payerDba: null, comment: null };
  // "ACH - {NAME}"
  const ach = desc.match(/^ACH\s*-\s*(.+)$/i);
  if (ach) {
    return { payerNameRaw: ach[1].trim(), payerDba: null, comment: null };
  }
  // "BANCA {EN LINEA|MOVIL} TRANSFERENCIA DE {tail}"
  const banca = desc.match(
    /^BANCA\s+(?:EN\s+LINEA|MOVIL)\s+TRANSFERENCIA\s+DE\s+(.+)$/i,
  );
  if (banca) {
    const tail = banca[1].trim();
    // Try {NAME} ({DBA}) {COMMENT}
    const dbaMatch = tail.match(/^(.+?)\s*\(([^)]+)\)\s*(.*)$/);
    if (dbaMatch) {
      return {
        payerNameRaw: dbaMatch[1].trim(),
        payerDba: dbaMatch[2].trim(),
        comment: dbaMatch[3].trim() || null,
      };
    }
    // No DBA — split name vs comment is heuristic. The bank usually uses
    // capitalised name then a different-case comment trailer, but it's
    // not reliable enough to split safely. Keep the whole tail as the
    // name and leave comment null; operators can scan the description
    // text directly when they need it.
    return { payerNameRaw: tail, payerDba: null, comment: null };
  }
  return { payerNameRaw: null, payerDba: null, comment: null };
}

export function isBGStatementSheet(wb: XLSX.WorkBook): boolean {
  return wb.SheetNames.some((n) => /BGPCheckingMovementsExcel/i.test(n));
}

export function isBGAchDetailSheet(wb: XLSX.WorkBook): boolean {
  return wb.SheetNames.some((n) => /BGPACHRejectedDetailList/i.test(n));
}

const STATEMENT_HEADER_COLS = [
  "fecha",
  "referencia",
  "transacción",
  "descripción",
  "débito",
  "crédito",
  "saldo total",
] as const;

function findStatementHeader(rows: unknown[][]): {
  headerRow: number;
  cols: {
    fecha: number;
    referencia: number;
    transaccion: number;
    descripcion: number;
    debito: number;
    credito: number;
    saldo: number;
  };
} | null {
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] ?? []).map((c) =>
      c == null ? "" : String(c).toLowerCase().trim(),
    );
    if (STATEMENT_HEADER_COLS.every((label) => cells.includes(label))) {
      return {
        headerRow: i,
        cols: {
          fecha: cells.indexOf("fecha"),
          referencia: cells.indexOf("referencia"),
          transaccion: cells.indexOf("transacción"),
          descripcion: cells.indexOf("descripción"),
          debito: cells.indexOf("débito"),
          credito: cells.indexOf("crédito"),
          saldo: cells.indexOf("saldo total"),
        },
      };
    }
  }
  return null;
}

export class BGParseError extends Error {}

/** Parse a BG statement Excel buffer / workbook into structured rows. */
export function parseBGStatement(
  source: WorkSheet | unknown[][],
): BGStatementParseResult {
  const rows: unknown[][] = Array.isArray(source)
    ? (source as unknown[][])
    : XLSX.utils.sheet_to_json(source as WorkSheet, {
        header: 1,
        raw: true,
        defval: null,
      });

  const warnings: string[] = [];

  // Header preamble — first ~6 rows in the actual export. We scan
  // permissively in case the bank shifts things.
  let accountNumber = "";
  let accountHolder = "";
  let dateRangeStart: string | null = null;
  let dateRangeEnd: string | null = null;

  const headerInfo = findStatementHeader(rows);
  if (!headerInfo) {
    throw new BGParseError("BG statement header row not found.");
  }

  for (let i = 0; i < headerInfo.headerRow; i++) {
    const merged = rows[i]?.[0] == null ? "" : String(rows[i]![0]);
    const ac = parseAccountNumber(merged);
    if (ac) accountNumber = ac;
    const co = parseCompany(merged);
    if (co) accountHolder = co;
    const dr = parseDateRange(merged);
    if (dr.start) dateRangeStart = dr.start;
    if (dr.end) dateRangeEnd = dr.end;
  }

  if (!accountNumber) warnings.push("Account number not found in preamble.");
  if (!accountHolder) warnings.push("Account holder not found in preamble.");

  const parsedRows: BGStatementRow[] = [];
  for (let i = headerInfo.headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const postedAt = toIsoDate(row[headerInfo.cols.fecha]);
    if (!postedAt) continue; // Empty / footer line.
    const reference = asString(row[headerInfo.cols.referencia]);
    const code = asString(row[headerInfo.cols.transaccion]);
    const description = asString(row[headerInfo.cols.descripcion]);
    const debit = parseMinor(row[headerInfo.cols.debito]);
    const credit = parseMinor(row[headerInfo.cols.credito]);
    const balance = parseMinor(row[headerInfo.cols.saldo]);
    const parsed = parseBGDescription(description);
    parsedRows.push({
      postedAt,
      reference,
      code,
      description,
      debitMinor: debit,
      creditMinor: credit,
      balanceMinor: balance,
      payerNameRaw: parsed.payerNameRaw,
      payerDba: parsed.payerDba,
      comment: parsed.comment,
    });
  }

  return {
    kind: "statement",
    header: {
      accountNumber,
      accountHolder,
      dateRangeStart,
      dateRangeEnd,
    },
    rows: parsedRows,
    warnings,
  };
}

// =============================================================
// ACH Debit batch detail
// =============================================================

export interface BGAchBatchEnvelope {
  filename: string;
  effectiveDate: string;             // YYYY-MM-DD
  totalTransactions: number | null;
  succeededTransactions: number | null;
  rejectedTransactions: number | null;
}

export interface BGAchDetailRow {
  routingCode: string;
  targetAccount: string;
  amountMinor: bigint;
  beneficiaryId: string | null;
  beneficiaryName: string | null;
  addenda: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  observations: string | null;
}

export interface BGAchDetailParseResult {
  kind: "ach_detail";
  envelope: BGAchBatchEnvelope;
  rows: BGAchDetailRow[];
  warnings: string[];
}

const ACH_HEADER_COLS = [
  "codigo de ruta",
  "cuenta",
  "monto",
  "beneficiario",
  "nombre del beneficiario",
  "addenda",
  "descripcion de error",
] as const;

function findAchHeader(rows: unknown[][]): {
  headerRow: number;
  cols: {
    routing: number;
    cuenta: number;
    monto: number;
    beneficiario: number;
    nombre: number;
    addenda: number;
    error: number;
    observaciones: number;
  };
} | null {
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] ?? []).map((c) =>
      c == null ? "" : String(c).toLowerCase().trim(),
    );
    // Bank sometimes writes "DESCRIPCION DE ERROR" without accent; match
    // both. The first 7 labels must all be present.
    if (ACH_HEADER_COLS.every((label) => cells.includes(label))) {
      return {
        headerRow: i,
        cols: {
          routing: cells.indexOf("codigo de ruta"),
          cuenta: cells.indexOf("cuenta"),
          monto: cells.indexOf("monto"),
          beneficiario: cells.indexOf("beneficiario"),
          nombre: cells.indexOf("nombre del beneficiario"),
          addenda: cells.indexOf("addenda"),
          error: cells.indexOf("descripcion de error"),
          observaciones: cells.indexOf("observaciones"),
        },
      };
    }
  }
  return null;
}

/** "R10 NO EXISTE AUTORIZACION DEL RECIBIDOR" → { code: "R10", description: "NO EXISTE..." } */
export function parseAchError(s: string): {
  errorCode: string | null;
  errorDescription: string | null;
} {
  if (!s || !s.trim()) {
    return { errorCode: null, errorDescription: null };
  }
  const m = s.trim().match(/^([A-Z]\d{2})\s+(.+)$/);
  if (m) {
    return { errorCode: m[1], errorDescription: m[2].trim() };
  }
  // Couldn't parse a standard R-code — keep the whole string as description.
  return { errorCode: null, errorDescription: s.trim() };
}

/** "20260229 - Crediclaro - LOTE ACH BG 30.txt" → "20260229" filename stem etc. */
function parseEnvelopePreamble(rows: unknown[][]): {
  filename: string;
  effectiveDate: string | null;
  totalTransactions: number | null;
  succeededTransactions: number | null;
  rejectedTransactions: number | null;
} {
  let filename = "";
  let effectiveDate: string | null = null;
  let totalTransactions: number | null = null;
  let succeededTransactions: number | null = null;
  let rejectedTransactions: number | null = null;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cell = rows[i]?.[0] == null ? "" : String(rows[i]![0]);
    const fn = cell.match(/Nombre\s+de\s+archivo\s*:\s*(.+)$/i);
    if (fn) filename = fn[1].trim();
    const ed = cell.match(/Fecha\s+efectiva\s+(.+)$/i);
    if (ed) {
      const iso = toIsoDate(ed[1].trim());
      if (iso) effectiveDate = iso;
    }
    const summary = cell.match(
      /(\d+)\s+transacciones\s+(\d+)\s+realizada\s+(\d+)\s+rechazadas/i,
    );
    if (summary) {
      totalTransactions = Number(summary[1]);
      succeededTransactions = Number(summary[2]);
      rejectedTransactions = Number(summary[3]);
    }
  }
  return {
    filename,
    effectiveDate,
    totalTransactions,
    succeededTransactions,
    rejectedTransactions,
  };
}

export function parseBGAchDetail(
  source: WorkSheet | unknown[][],
): BGAchDetailParseResult {
  const rows: unknown[][] = Array.isArray(source)
    ? (source as unknown[][])
    : XLSX.utils.sheet_to_json(source as WorkSheet, {
        header: 1,
        raw: true,
        defval: null,
      });

  const warnings: string[] = [];
  const preamble = parseEnvelopePreamble(rows);
  if (!preamble.filename) warnings.push("Batch filename not found in preamble.");
  if (!preamble.effectiveDate) {
    throw new BGParseError("BG ACH detail file is missing the effective date.");
  }

  const headerInfo = findAchHeader(rows);
  if (!headerInfo) {
    throw new BGParseError("BG ACH detail header row not found.");
  }

  const parsedRows: BGAchDetailRow[] = [];
  for (let i = headerInfo.headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const routing = asString(row[headerInfo.cols.routing]);
    if (!routing) continue; // Empty / footer line.
    const cuenta = asString(row[headerInfo.cols.cuenta]);
    const amount = parseMinor(row[headerInfo.cols.monto]);
    const beneficiario = asString(row[headerInfo.cols.beneficiario]) || null;
    const nombre = asString(row[headerInfo.cols.nombre]) || null;
    const addenda = asString(row[headerInfo.cols.addenda]) || null;
    const errorRaw = asString(row[headerInfo.cols.error]);
    const observaciones =
      headerInfo.cols.observaciones >= 0
        ? asString(row[headerInfo.cols.observaciones]) || null
        : null;
    const { errorCode, errorDescription } = parseAchError(errorRaw);

    parsedRows.push({
      routingCode: routing,
      targetAccount: cuenta,
      amountMinor: amount,
      beneficiaryId: beneficiario,
      beneficiaryName: nombre,
      addenda,
      errorCode,
      errorDescription,
      observations: observaciones,
    });
  }

  return {
    kind: "ach_detail",
    envelope: {
      filename: preamble.filename,
      effectiveDate: preamble.effectiveDate,
      totalTransactions: preamble.totalTransactions,
      succeededTransactions: preamble.succeededTransactions,
      rejectedTransactions: preamble.rejectedTransactions,
    },
    rows: parsedRows,
    warnings,
  };
}

// =============================================================
// Auto-detection
// =============================================================

export type BGParseResult = BGStatementParseResult | BGAchDetailParseResult;

/**
 * Parse a workbook by sniffing its first sheet name. Throws if the
 * sheet isn't a recognized BG export.
 */
export function parseBGWorkbook(wb: XLSX.WorkBook): BGParseResult {
  if (isBGStatementSheet(wb)) {
    const name = wb.SheetNames.find((n) =>
      /BGPCheckingMovementsExcel/i.test(n),
    )!;
    return parseBGStatement(wb.Sheets[name]);
  }
  if (isBGAchDetailSheet(wb)) {
    const name = wb.SheetNames.find((n) =>
      /BGPACHRejectedDetailList/i.test(n),
    )!;
    return parseBGAchDetail(wb.Sheets[name]);
  }
  throw new BGParseError(
    `Unknown BG sheet — expected BGPCheckingMovementsExcel or BGPACHRejectedDetailList. Got: ${wb.SheetNames.join(", ")}`,
  );
}

// =============================================================
// Row hashing (idempotent re-uploads collapse on (account_id, row_hash))
// =============================================================

export interface BGStatementRowHashInput {
  accountId: string;
  postedAt: string;
  reference: string;
  code: string;
  description: string;
  debitMinor: bigint;
  creditMinor: bigint;
  balanceMinor: bigint;
}

export function computeBGStatementRowHash(i: BGStatementRowHashInput): string {
  const payload = [
    i.accountId,
    i.postedAt,
    i.reference,
    i.code,
    i.description,
    i.debitMinor.toString(),
    i.creditMinor.toString(),
    i.balanceMinor.toString(),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

export interface BGAchDetailRowHashInput {
  accountId: string;
  batchFilename: string;
  routingCode: string;
  targetAccount: string;
  amountMinor: bigint;
  beneficiaryId: string | null;
  errorCode: string | null;
}

export function computeBGAchDetailRowHash(i: BGAchDetailRowHashInput): string {
  const payload = [
    i.accountId,
    i.batchFilename,
    i.routingCode,
    i.targetAccount,
    i.amountMinor.toString(),
    i.beneficiaryId ?? "",
    i.errorCode ?? "",
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}
