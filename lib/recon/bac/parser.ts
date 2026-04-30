// Pure parser for BAC bank-statement spreadsheets.
//
// Input is a 2-D matrix of cell values (the kind any Excel reader produces:
// `string | number | Date | null | undefined`). Keeping the parser library-
// agnostic lets us swap between SheetJS / ExcelJS / a CSV reader at the
// adapter layer without touching this code, and lets tests feed synthetic
// fixtures without booting any binary parser.
//
// Output is the header metadata, the raw transaction rows, and an integrity
// check (Σcredits − Σdebits + saldo_inicial == saldo_final). Classification
// (kind/state/confirmable_after) and idempotent row hashing are the ingest
// layer's job, not the parser's.

export const BAC_KNOWN_CODES = [
  'PR', // Junto-initiated ACH inbound (rejectable for 24h)
  '4C', // ACH inbound from another bank, irrevocable
  'DA', // DVTO reversal of a PR
  'AD', // Bank fee on a failed ACH
  'TX', // ITBMS tax tied to AD
  'FE', // Bank commission
  '4A', // Junto-initiated outflow
] as const;
export type BACKnownCode = (typeof BAC_KNOWN_CODES)[number];

export interface BACHeader {
  accountNumber: string;
  accountHolder: string;
  currency: string;
  saldoInicialMinor: bigint;
  saldoFinalMinor: bigint;
  dateRangeStart: string; // ISO YYYY-MM-DD
  dateRangeEnd: string;
}

export interface BACRow {
  postedAt: string; // ISO YYYY-MM-DD
  reference: string;
  code: string; // raw — may not be in BAC_KNOWN_CODES
  description: string;
  debitMinor: bigint;
  creditMinor: bigint;
  balanceMinor: bigint;
  // Populated only when description is a DVTO reversal.
  returnCode?: string;
  payerNameRaw?: string;
}

export interface BACParseResult {
  header: BACHeader;
  rows: BACRow[];
  integrity: {
    ok: boolean;
    expectedFinalMinor: bigint;
    actualFinalMinor: bigint;
    diffMinor: bigint;
  };
  warnings: string[];
}

export class BACParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'BACParseError';
  }
}

// ============================================================
// Cell helpers
// ============================================================

type Cell = unknown;

function asString(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function isBlank(v: Cell): boolean {
  return asString(v) === '';
}

// Parse "1,234.56" / "(1,234.56)" / "-1,234.56" / 1234.56 → bigint cents.
// Two-decimal currency assumed (USD/PAB).
export function parseMinor(v: Cell): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0n;
    return BigInt(Math.round(v * 100));
  }
  let s = asString(v);
  if (s === '' || s === '-' || s === '—') return 0n;

  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  // Drop currency symbols, thousand separators, whitespace.
  s = s.replace(/[^\d.]/g, '');
  if (s === '' || s === '.') return 0n;

  const [whole, frac = ''] = s.split('.');
  const cents = (frac + '00').slice(0, 2);
  const result = BigInt(whole || '0') * 100n + BigInt(cents || '0');
  return negative ? -result : result;
}

// "DD/MM/YYYY" / "DD-MM-YYYY" / Date → ISO YYYY-MM-DD, or null on failure.
export function parseSpanishDate(v: Cell): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  const s = asString(v);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  let yy = m[3];
  if (yy.length === 2) yy = (Number(yy) >= 50 ? '19' : '20') + yy;
  const iso = `${yy}-${mm}-${dd}`;
  const t = Date.parse(iso + 'T00:00:00Z');
  return Number.isNaN(t) ? null : iso;
}

// "DVTO AM04-JORGE MIGUEL DIAZ P" → { returnCode: 'AM04', payerNameRaw: '...' }.
//
// Real BAC exports vary more than the synthetic fixture: leading whitespace,
// optional space around the dash, en/em dashes, mixed-case codes, and codes
// that aren't strictly two-letters-two-digits — we've seen alphanumerics 2–8
// chars long. Be permissive on the code shape and on the separator.
export function parseDvtoDescription(
  desc: string,
): { returnCode?: string; payerNameRaw?: string } {
  const m = desc.match(/^\s*DVTO\s+([A-Z0-9]{2,8})\s*[\-–—:.]?\s*(.+)$/i);
  if (!m) return {};
  return { returnCode: m[1].toUpperCase(), payerNameRaw: m[2].trim() };
}

// ============================================================
// Header / column detection
// ============================================================

const COL_HEADER_PATTERNS: Record<keyof ColumnIndex, RegExp> = {
  fecha: /^fecha$/i,
  referencia: /^referencia$/i,
  codigo: /^c[oó]digo$/i,
  descripcion: /^descripci[oó]n$/i,
  debitos: /^d[eé]bitos?$/i,
  creditos: /^cr[eé]ditos?$/i,
  balance: /^balance/i,
};

interface ColumnIndex {
  fecha: number;
  referencia: number;
  codigo: number;
  descripcion: number;
  debitos: number;
  creditos: number;
  balance: number;
}

function findColumnHeaderRow(matrix: Cell[][]): { rowIdx: number; cols: ColumnIndex } {
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r];
    const cols: Partial<ColumnIndex> = {};
    for (let c = 0; c < row.length; c++) {
      const cell = asString(row[c]);
      if (!cell) continue;
      for (const key of Object.keys(COL_HEADER_PATTERNS) as (keyof ColumnIndex)[]) {
        if (cols[key] !== undefined) continue;
        if (COL_HEADER_PATTERNS[key].test(cell)) {
          cols[key] = c;
          break;
        }
      }
    }
    const filled = Object.keys(cols).length;
    // Need at least Fecha + amount columns + balance to call it the header row.
    if (
      filled >= 5 &&
      cols.fecha !== undefined &&
      cols.debitos !== undefined &&
      cols.creditos !== undefined &&
      cols.balance !== undefined
    ) {
      return {
        rowIdx: r,
        cols: {
          fecha: cols.fecha!,
          referencia: cols.referencia ?? -1,
          codigo: cols.codigo ?? -1,
          descripcion: cols.descripcion ?? -1,
          debitos: cols.debitos!,
          creditos: cols.creditos!,
          balance: cols.balance!,
        },
      };
    }
  }
  throw new BACParseError(
    'Column header row not found. Expected a row with Fecha, Débitos, Créditos, and Balance.',
  );
}

// Scan the rows above the column-header row for label/value pairs.
// Tolerant to layout drift: same row, next column → value; next row, same
// column → value.
function readPreambleHeader(
  matrix: Cell[][],
  preambleEnd: number,
): {
  accountNumber: string;
  accountHolder: string;
  currency: string;
  saldoInicialMinor: bigint;
  saldoFinalMinor: bigint;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
} {
  // Anchor at start so doc titles like "Estado de Cuenta" or "Saldo
  // Disponible" don't false-match field labels.
  //
  // Label variants seen in real BAC exports:
  //   accountNumber  → "Producto" (the canonical BAC label) / "Cuenta" /
  //                    "No. de Cuenta" / "N° Cuenta" / "Núm. Cuenta" /
  //                    "Número de Cuenta"
  //   accountHolder  → "Nombre" / "Cliente" / "Titular"
  //   saldoFinal     → "Saldo Final" / "Saldo en Libros" (the book balance —
  //                    we deliberately do NOT match "Saldo Disponible" since
  //                    that subtracts retenidos/diferidos)
  const labels = {
    accountNumber:
      /^(producto|cuenta|(?:n[uú]m\.?|n[uú]mero|no\.?|n°|nro\.?)\s*(?:de\s+)?cuenta)\b/i,
    accountHolder: /^(nombre|cliente|titular)\b/i,
    currency: /^(moneda|currency)\b/i,
    saldoInicial: /^saldo\s+inicial\b/i,
    saldoFinal: /^saldo\s+(final|en\s+libros)\b/i,
    desde: /^(desde|inicio|from)\b/i,
    hasta: /^(hasta|fin|to)\b/i,
    periodo: /^per[ií]odo\b/i,
  };

  let accountNumber = '';
  let accountHolder = '';
  let currency = '';
  let saldoInicialMinor = 0n;
  let saldoFinalMinor = 0n;
  let dateRangeStart: string | null = null;
  let dateRangeEnd: string | null = null;

  const valueAfter = (r: number, c: number): Cell | undefined => {
    const row = matrix[r] ?? [];
    for (let cc = c + 1; cc < row.length; cc++) {
      if (!isBlank(row[cc])) return row[cc];
    }
    const below = matrix[r + 1] ?? [];
    return below[c];
  };

  for (let r = 0; r < preambleEnd; r++) {
    const row = matrix[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const text = asString(row[c]);
      if (!text) continue;

      if (!accountNumber && labels.accountNumber.test(text) && !/saldo/i.test(text)) {
        const v = asString(valueAfter(r, c));
        if (v) {
          // BAC's "Producto" cell sometimes embeds the currency after the
          // number ("100412600    USD"). Take the leading digit run when
          // present; otherwise drop whitespace and use as-is.
          const leadingDigits = v.match(/^\s*(\d{4,})/)?.[1];
          accountNumber = leadingDigits ?? v.replace(/\s+/g, '');
        }
      } else if (!accountHolder && labels.accountHolder.test(text)) {
        const v = asString(valueAfter(r, c));
        if (v) accountHolder = v;
      } else if (!currency && labels.currency.test(text)) {
        const v = asString(valueAfter(r, c)).toUpperCase();
        if (v) currency = v.slice(0, 3);
      } else if (saldoInicialMinor === 0n && labels.saldoInicial.test(text)) {
        saldoInicialMinor = parseMinor(valueAfter(r, c));
      } else if (saldoFinalMinor === 0n && labels.saldoFinal.test(text)) {
        saldoFinalMinor = parseMinor(valueAfter(r, c));
      } else if (!dateRangeStart && labels.desde.test(text)) {
        dateRangeStart = parseSpanishDate(valueAfter(r, c));
      } else if (!dateRangeEnd && labels.hasta.test(text)) {
        dateRangeEnd = parseSpanishDate(valueAfter(r, c));
      } else if ((!dateRangeStart || !dateRangeEnd) && labels.periodo.test(text)) {
        // "Período: 05/04/2026 - 07/04/2026" in a single cell.
        const v = asString(valueAfter(r, c)) || text;
        const m = v.match(
          /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}).*?(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/,
        );
        if (m) {
          if (!dateRangeStart) dateRangeStart = parseSpanishDate(m[1]);
          if (!dateRangeEnd) dateRangeEnd = parseSpanishDate(m[2]);
        }
      }
    }
  }

  return {
    accountNumber,
    accountHolder,
    currency: currency || 'USD',
    saldoInicialMinor,
    saldoFinalMinor,
    dateRangeStart,
    dateRangeEnd,
  };
}

// ============================================================
// Main entry point
// ============================================================

export function parseBACSheet(matrix: Cell[][]): BACParseResult {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new BACParseError('Empty sheet.');
  }

  const warnings: string[] = [];

  const { rowIdx: headerRowIdx, cols } = findColumnHeaderRow(matrix);
  const preamble = readPreambleHeader(matrix, headerRowIdx);

  const rows: BACRow[] = [];
  let firstSeenDate: string | null = null;
  let lastSeenDate: string | null = null;

  for (let r = headerRowIdx + 1; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    if (row.every(isBlank)) continue;

    const postedAt = parseSpanishDate(row[cols.fecha]);
    if (!postedAt) {
      // No parseable date in the date column → either a sub-header repeat,
      // a footer disclaimer, or a totals row. Skip silently.
      continue;
    }

    const debitMinor = parseMinor(row[cols.debitos]);
    const creditMinor = parseMinor(row[cols.creditos]);
    const balanceMinor = parseMinor(row[cols.balance]);

    if (debitMinor < 0n || creditMinor < 0n) {
      warnings.push(
        `Row ${r + 1}: negative amount in debit/credit cell (debit=${debitMinor}, credit=${creditMinor}). Coerced to absolute.`,
      );
    }
    const debit = debitMinor < 0n ? -debitMinor : debitMinor;
    const credit = creditMinor < 0n ? -creditMinor : creditMinor;

    if (debit > 0n && credit > 0n) {
      warnings.push(
        `Row ${r + 1}: row has both debit and credit values; treating credit as authoritative.`,
      );
    }

    const reference = cols.referencia >= 0 ? asString(row[cols.referencia]) : '';
    const code = cols.codigo >= 0 ? asString(row[cols.codigo]).toUpperCase() : '';
    const description = cols.descripcion >= 0 ? asString(row[cols.descripcion]) : '';

    const dvto = code === 'DA' ? parseDvtoDescription(description) : {};

    rows.push({
      postedAt,
      reference,
      code,
      description,
      debitMinor: debit,
      creditMinor: credit,
      balanceMinor,
      ...dvto,
    });

    if (!firstSeenDate || postedAt < firstSeenDate) firstSeenDate = postedAt;
    if (!lastSeenDate || postedAt > lastSeenDate) lastSeenDate = postedAt;
  }

  if (rows.length === 0) {
    throw new BACParseError('No transaction rows found below the column header.');
  }

  if (!preamble.accountNumber) {
    warnings.push('Account number not found in header preamble.');
  }
  if (!preamble.accountHolder) {
    warnings.push('Account holder name not found in header preamble.');
  }

  const totalCredit = rows.reduce((acc, r) => acc + r.creditMinor, 0n);
  const totalDebit = rows.reduce((acc, r) => acc + r.debitMinor, 0n);
  const expectedFinal = preamble.saldoInicialMinor + totalCredit - totalDebit;
  const integrityOk =
    preamble.saldoFinalMinor !== 0n && expectedFinal === preamble.saldoFinalMinor;

  if (!integrityOk && preamble.saldoFinalMinor !== 0n) {
    warnings.push(
      `Balance integrity check failed: expected ${expectedFinal}, got ${preamble.saldoFinalMinor} (diff ${expectedFinal - preamble.saldoFinalMinor}).`,
    );
  }

  const header: BACHeader = {
    accountNumber: preamble.accountNumber,
    accountHolder: preamble.accountHolder,
    currency: preamble.currency,
    saldoInicialMinor: preamble.saldoInicialMinor,
    saldoFinalMinor: preamble.saldoFinalMinor,
    // Fall back to observed date range if the preamble did not declare one.
    dateRangeStart: preamble.dateRangeStart ?? firstSeenDate ?? '',
    dateRangeEnd: preamble.dateRangeEnd ?? lastSeenDate ?? '',
  };

  return {
    header,
    rows,
    integrity: {
      ok: integrityOk,
      expectedFinalMinor: expectedFinal,
      actualFinalMinor: preamble.saldoFinalMinor,
      diffMinor: expectedFinal - preamble.saldoFinalMinor,
    },
    warnings,
  };
}
