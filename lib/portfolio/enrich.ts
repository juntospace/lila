// Financial Engine — Source of Truth for Board Report & Collections Plan
// Faithful TypeScript implementation of Python generate_report.py & generar_acciones.py

import type {
  EnrichedLoan,
  EnrichedRepayment,
  PortfolioBucket,
  PortfolioSegment,
} from "./types";

export const HANDOVER_DATE = "2025-06-01"; // Management handover cutoff
export const CO_UNSECURED = 180; // Castigo threshold unsecured (days)
export const CO_SECURED = 360; // Castigo threshold secured (days)

export const BUCKETS: PortfolioBucket[] = [
  "Al día",
  "1-30",
  "31-60",
  "61-90",
  "91-180",
  "181-365",
  "365+",
];

export const BUCKET_BINS = [-1, 0, 30, 60, 90, 180, 365, 1e9];

export const BUCKET_COLORS = [
  "#37A98A",
  "#8FBE5E",
  "#E0BE45",
  "#E2953A",
  "#D9743B",
  "#CB5245",
  "#973A4A",
];

export const PROV_RATES = [0.01, 0.05, 0.15, 0.25, 0.50, 0.90, 1.00];

export const SEGMENTS: PortfolioSegment[] = [
  "Adelantos",
  "Personal con Garantía",
  "Personal sin Garantía",
];

export const REAL_METHODS = new Set([
  "ach",
  "cheque",
  "yappy",
  "deposito en efectivo",
  "debito planilla (empleado)",
  "debito planilla",
]);

export const ADMIN_METHODS = new Set([
  "descuento por pronto pago",
  "finiquito otorgado",
  "traspaso a provision",
  "traspaso de saldo",
  "ajuste",
]);

export const CLOSED_STATUSES = new Set(["fully paid", "restructured"]);

export const SIN_DATO = "(sin dato)";
export const TG_VALS = ["Automóvil", "Moto", "NA"];
export const TC_VALS = ["Heredada", "Vigente"];
export const GC_VALS = ["BCS", "Michel Sanabria Rivera", "Legal - Ruben Castrejo"];
export const MR_VALS = ["2025DIC", "2024DIC", "2021AGO", "NA"];

export const GC_HEUR: Record<string, string> = {
  michel: "Michel Sanabria Rivera",
  bcs: "BCS",
  legal: "Legal - Ruben Castrejo",
  ruben: "Legal - Ruben Castrejo",
  castrejo: "Legal - Ruben Castrejo",
};

// =============================================================
// String & Numeric Normalization Helpers
// =============================================================

export function normLabel(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

export function colfind(keys: string[], wanted: string): string | null {
  const w = normLabel(wanted);
  for (const k of keys) {
    if (normLabel(k) === w) return k;
  }
  return null;
}

export function canonVal(
  v: unknown,
  canonicalList: string[],
  heuristics?: Record<string, string>,
): string | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const n = normLabel(raw);
  for (const canon of canonicalList) {
    if (normLabel(canon) === n) return canon;
  }
  if (heuristics) {
    for (const [key, canon] of Object.entries(heuristics)) {
      if (n.includes(key)) return canon;
    }
  }
  return raw;
}

export function num(s: unknown): number {
  if (s === null || s === undefined) return 0;
  const clean = String(s).replace(/,/g, "").trim();
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

/**
 * Parses day-first dates (%d/%m/%Y) from LoanDisk exports to ISO string (YYYY-MM-DD).
 */
export function pdate(s: unknown): string | null {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;

  // If already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // Day-first: DD/MM/YYYY or DD-MM-YYYY
  const m = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (!m) return null;

  const d = m[1].padStart(2, "0");
  const mo = m[2].padStart(2, "0");
  const y = m[3];
  return `${y}-${mo}-${d}`;
}

/**
 * Computes right-closed bucket index based on BUCKET_BINS:
 * [-1, 0, 30, 60, 90, 180, 365, 1e9]
 */
export function getBucketIdx(dpd: number): number {
  if (dpd <= 0) return 0; // "Al día"
  if (dpd <= 30) return 1; // "1-30"
  if (dpd <= 60) return 2; // "31-60"
  if (dpd <= 90) return 3; // "61-90"
  if (dpd <= 180) return 4; // "91-180"
  if (dpd <= 365) return 5; // "181-365"
  return 6; // "365+"
}

// =============================================================
// Core Loan Enrichment — enrich()
// =============================================================

export function enrichLoan(raw: Record<string, string>): EnrichedLoan {
  const keys = Object.keys(raw);

  const getCol = (name: string): string => {
    const k = colfind(keys, name);
    return k ? raw[k] ?? "" : "";
  };

  const balance = num(getCol("Balance Amount"));
  const rawDpd = num(getCol("Days Past Due"));
  const releasedDate = pdate(getCol("Released Date"));
  const statusRaw = getCol("Loan Status Name").trim();

  // 1. Open-book universe (§4.2)
  const isClosed = CLOSED_STATUSES.has(statusRaw.toLowerCase());
  const isOpen = balance > 0.5 && !isClosed;

  // 2. Custom fields with dirty normalization (§4.6)
  const pgRaw = getCol("Prestamo Garantizado");
  const tgRaw = getCol("Tipo de Garantia");
  const tcRaw = getCol("Tipo de Cartera");
  const gcRaw = getCol("Gestor de Cobro");
  const mrRaw = getCol("Motor de Riesgo (Adelantos)");

  const pg = canonVal(pgRaw, ["Si", "No"]);
  const tg = canonVal(tgRaw, TG_VALS);
  const tc = canonVal(tcRaw, TC_VALS);
  const gc = canonVal(gcRaw, GC_VALS, GC_HEUR);
  const mr = canonVal(mrRaw, MR_VALS);

  // 3. Product segmentation with strict precedence (§4.3)
  const loanProduct = getCol("Loan Product");
  const lowProduct = loanProduct.toLowerCase();

  let segIdx = 2; // Default: Personal sin Garantía
  if (lowProduct.includes("con garant") || lowProduct.includes("vehicular")) {
    segIdx = 1;
  }
  const pgn = normLabel(pg);
  if (pgn === "si") segIdx = 1;
  if (pgn === "no") segIdx = 2;
  if (lowProduct.includes("adelanto")) {
    segIdx = 0; // Adelantos always by product name, overrides all
  }

  const segment = SEGMENTS[segIdx];
  const secured = segIdx === 1;

  // 4. Cash adjustment (cash_ahead) (§4.4)
  const pastCol = colfind(keys, "Past Due");
  const pendCol = colfind(keys, "Pending Due");

  const hasPast = pastCol !== null && raw[pastCol] !== undefined && raw[pastCol].trim() !== "";
  const hasPend = pendCol !== null && raw[pendCol] !== undefined && raw[pendCol].trim() !== "";

  const pastDue = hasPast ? num(raw[pastCol!]) : 0;
  const pendingDue = hasPend ? num(raw[pendCol!]) : 0;

  const cashAhead =
    ((hasPast && pastDue <= 0.01) || (hasPend && pendingDue <= 0.01)) &&
    rawDpd > 0 &&
    isOpen;

  // If cash_ahead, force dpd = 0 ("Al día"), preserve dpdLoandisk for audit
  const dpd = cashAhead ? 0 : rawDpd;
  const bucketIdx = getBucketIdx(dpd);
  const bucket = BUCKETS[bucketIdx];

  // Duration, Total Due, Installments, Repayment cycle
  const loanDuration = getCol("Loan Duration");
  const durMatch = loanDuration.match(/(\d+)/);
  const installmentsCount = durMatch ? parseInt(durMatch[1], 10) : null;

  const repaymentCycle = getCol("Repayment Cycle");
  const cycleType = repaymentCycle.toLowerCase().includes("month") ? 0 : 1;

  const totalDueAmount = num(getCol("Total Due Amount"));
  const lastPaymentDate = pdate(getCol("Last Payment Date"));
  const lastPaymentAmount = num(getCol("Last Payment Amount"));

  const comboKey = `${segIdx}|${tg ?? SIN_DATO}|${tc ?? SIN_DATO}|${gc ?? SIN_DATO}|${mr ?? SIN_DATO}`;

  return {
    loanId: String(getCol("Loan Id") || raw["id"] || "").trim(),
    loanNumber: String(getCol("Loan #") || "").trim(),
    fullName: String(getCol("Full Name") || "").trim(),
    borrowerMobile: String(getCol("Borrower Mobile") || "").trim(),
    product: loanProduct.trim(),
    segment,
    segmentIdx: segIdx,
    secured,
    balance: Math.round(balance * 100) / 100,
    dpd: Math.round(dpd),
    dpdLoandisk: Math.round(rawDpd),
    bucket,
    bucketIdx,
    cashAhead,
    isOpen,
    releasedDate,
    statusRaw,
    pastDue: Math.round(pastDue * 100) / 100,
    pendingDue: Math.round(pendingDue * 100) / 100,
    totalDueAmount: Math.round(totalDueAmount * 100) / 100,
    loanDuration: loanDuration.trim(),
    installmentsCount,
    repaymentCycle: repaymentCycle.trim(),
    cycleType,
    lastPaymentDate,
    lastPaymentAmount: Math.round(lastPaymentAmount * 100) / 100,
    pg,
    tg,
    tc,
    gc,
    mr,
    comboKey,
    raw,
  };
}

export function enrichLoans(rows: Record<string, string>[]): EnrichedLoan[] {
  return rows.map(enrichLoan);
}

// =============================================================
// Repayment Classification & Processing
// =============================================================

export function detectMethodCol(rows: Record<string, string>[]): string | null {
  if (!rows || rows.length === 0) return null;
  const known = new Set([...REAL_METHODS, ...ADMIN_METHODS]);
  const sample = rows.slice(0, 200);
  const cols = Object.keys(rows[0]);

  let bestCol: string | null = null;
  let bestHits = 0;

  for (const c of cols) {
    let hits = 0;
    for (const r of sample) {
      const v = normLabel(r[c]);
      if (v && known.has(v)) {
        hits++;
      }
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestCol = c;
    }
  }

  return bestHits >= 1 ? bestCol : null;
}

export function enrichRepayment(
  raw: Record<string, string>,
  methodCol: string | null,
): EnrichedRepayment {
  const keys = Object.keys(raw);
  const getCol = (name: string): string => {
    const k = colfind(keys, name);
    return k ? raw[k] ?? "" : "";
  };

  const prin = num(getCol("Principal Paid Amount"));
  const interest = num(getCol("Interest Paid Amount"));
  const penalty = num(getCol("Penalty Paid Amount"));
  const fees = num(getCol("Fees Paid Amount"));
  const total = num(getCol("Total Paid Amount")) || prin + interest + penalty + fees;
  const ingresos = interest + penalty + fees;

  const collectionDate = pdate(getCol("Collection Date")) || "";
  const methodRaw = methodCol ? (raw[methodCol] ?? "").trim() : "";
  const methodNorm = normLabel(methodRaw);

  let isReal = true;
  let isAdmin = false;
  let isUnknownMethod = false;

  if (methodCol && methodNorm) {
    if (ADMIN_METHODS.has(methodNorm)) {
      isAdmin = true;
      isReal = false;
    } else if (REAL_METHODS.has(methodNorm)) {
      isReal = true;
      isAdmin = false;
    } else {
      // Unknown method counts as real but is flagged (§6.5 / §2.3)
      isReal = true;
      isAdmin = false;
      isUnknownMethod = true;
    }
  }

  return {
    repaymentId: String(getCol("Repayment Id") || raw["id"] || "").trim(),
    loanId: String(getCol("Loan Id") || "").trim(),
    collectionDate,
    principalAmount: Math.round(prin * 100) / 100,
    interestAmount: Math.round(interest * 100) / 100,
    penaltyAmount: Math.round(penalty * 100) / 100,
    feesAmount: Math.round(fees * 100) / 100,
    totalAmount: Math.round(total * 100) / 100,
    ingresosAmount: Math.round(ingresos * 100) / 100,
    methodRaw,
    isReal,
    isAdmin,
    isUnknownMethod,
    raw,
  };
}

export function enrichRepayments(
  rows: Record<string, string>[],
  cutDate?: string,
): { repayments: EnrichedRepayment[]; futureExcludedCount: number } {
  const methodCol = detectMethodCol(rows);
  let futureExcludedCount = 0;
  const list: EnrichedRepayment[] = [];

  for (const r of rows) {
    const rep = enrichRepayment(r, methodCol);
    if (!rep.collectionDate) continue;

    // Filter future dated payments (§3.2 & §1.3)
    if (cutDate && rep.collectionDate > cutDate) {
      futureExcludedCount++;
      continue;
    }
    list.push(rep);
  }

  return { repayments: list, futureExcludedCount };
}

