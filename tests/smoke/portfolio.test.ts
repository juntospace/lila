// Smoke validation for the portfolio Phase 1 pipeline.
//
// Reads the three Crediclaro sample CSVs under tmp/samples/70136 (local
// sample data, gitignored). Runs parse → classify → DQ in-memory and
// prints a summary. Confirms:
//   1. Parser handles real LoanDisk data without throwing.
//   2. Classification distributions are plausible.
//   3. DQ surfaces the issues we predicted (low borrower-join rate,
//      sparse demographics, legacy delinquents, cross-entity BAC flow).
//
// Gated behind PORTFOLIO_SMOKE=1 so the regular `pnpm test` doesn't
// require the local sample. Run with:
//   PORTFOLIO_SMOKE=1 pnpm test tests/smoke/portfolio
// or
//   PORTFOLIO_SMOKE=1 pnpm exec vitest run tests/smoke/portfolio --reporter=verbose

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { it } from "vitest";

import { resolveAllBorrowerJoins } from "@/lib/portfolio/borrower-join";
import { computeDqMetrics } from "@/lib/portfolio/dq";
import { classifyLoan } from "@/lib/portfolio/normalize";
import { parseLoanDiskBundle } from "@/lib/portfolio/parser";
import type {
  PortfolioPolicy,
  PortfolioPolicyId,
} from "@/lib/portfolio/types";

const SAMPLE_DIR = join(process.cwd(), "tmp", "samples", "70136");

const POLICY: PortfolioPolicy = {
  id: "00000000-0000-0000-0000-000000000001" as PortfolioPolicyId,
  effectiveFrom: "2026-01-01",
  chargeOffDpdThreshold: 365,
  managementCutoffDate: "2025-01-01",
  cashAdvanceAlwaysNew: true,
  stage2DpdMin: 30,
  stage3DpdMin: 90,
  nplDpdMin: 90,
  eclStage1Coverage: null,
  eclStage2Coverage: null,
  eclStage3Coverage: null,
};

function readBytes(filename: string): Uint8Array {
  return new Uint8Array(readFileSync(join(SAMPLE_DIR, filename)));
}

function countBy<T, K extends string>(rows: T[], key: (r: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const r of rows) {
    const k = key(r);
    out[k] = ((out[k] ?? 0) as number) + 1;
  }
  return out;
}

function fmtMoney(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${wholeStr}.${cents}`;
}

function table(rows: [string, string | number][]): string {
  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  return rows
    .map(([k, v]) => `  ${k.padEnd(labelWidth)}  ${v}`)
    .join("\n");
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

// -------------------------------------------------------------

it.runIf(process.env.PORTFOLIO_SMOKE === "1")("portfolio Phase 1 smoke validation", () => {
console.log("Portfolio Phase 1 smoke validation");
console.log("==================================");
console.log(`Sample: ${SAMPLE_DIR}`);
console.log("");

const t0 = performance.now();
const bundle = parseLoanDiskBundle({
  borrowers: { filename: "borrowers_branch1.csv", bytes: readBytes("borrowers_branch1.csv") },
  loans: { filename: "loans_branch1.csv", bytes: readBytes("loans_branch1.csv") },
  repayments: { filename: "repayments_branch1.csv", bytes: readBytes("repayments_branch1.csv") },
});
const tParse = performance.now() - t0;

console.log(`Parsed in ${tParse.toFixed(0)}ms:`);
console.log(table([
  ["borrowers rows", bundle.borrowers.length],
  ["loans rows", bundle.loans.length],
  ["repayments rows", bundle.repayments.length],
  ["borrowers sha256", bundle.meta.borrowers.sha256.slice(0, 12) + "…"],
  ["loans sha256", bundle.meta.loans.sha256.slice(0, 12) + "…"],
  ["repayments sha256", bundle.meta.repayments.sha256.slice(0, 12) + "…"],
]));
console.log("");

// --- Classification + join ---
const t1 = performance.now();
const classifications = bundle.loans.map((l) => classifyLoan(l, POLICY));
const joinResults = resolveAllBorrowerJoins(bundle.loans, bundle.borrowers);
const tClassify = performance.now() - t1;
console.log(`Classified + joined in ${tClassify.toFixed(0)}ms.`);
console.log("");

// --- Distributions ---
const productGroup = countBy(classifications, (c) => c.productGroup);
const statusNorm = countBy(classifications, (c) => c.statusNormalized);
const vintage = countBy(classifications, (c) => c.managementVintage);
const segment = countBy(classifications, (c) => c.portfolioSegment);
const stage = countBy(classifications, (c) => c.ifrsStage);
const join = countBy(joinResults, (r) => r.confidence);

console.log("Loan classification distributions:");
console.log("  product_group:");
for (const [k, v] of Object.entries(productGroup)) console.log(`    ${k.padEnd(28)} ${v}`);
console.log("  status_normalized:");
for (const [k, v] of Object.entries(statusNorm)) console.log(`    ${k.padEnd(28)} ${v}`);
console.log("  management_vintage:");
for (const [k, v] of Object.entries(vintage)) console.log(`    ${k.padEnd(28)} ${v}`);
console.log("  portfolio_segment:");
for (const [k, v] of Object.entries(segment)) console.log(`    ${k.padEnd(28)} ${v}`);
console.log("  ifrs_stage:");
for (const [k, v] of Object.entries(stage)) console.log(`    ${k.padEnd(28)} ${v}`);
console.log("  borrower_join_confidence:");
for (const [k, v] of Object.entries(join)) console.log(`    ${k.padEnd(28)} ${v}`);
const nplCount = classifications.filter((c) => c.isNpl).length;
console.log(`  is_npl (>= 90 DPD)              ${nplCount}`);
console.log("");

// --- Money totals ---
const openPrincipalSum = bundle.loans.reduce((acc, l, i) => {
  if (classifications[i].statusNormalized === "closed") return acc;
  return acc + (l.totalPrincipalBalanceMinor ?? 0n);
}, 0n);
const openBalanceSum = bundle.loans.reduce((acc, l, i) => {
  if (classifications[i].statusNormalized === "closed") return acc;
  return acc + (l.balanceAmountMinor ?? 0n);
}, 0n);
const borrowerOpenAggregate = bundle.borrowers.reduce(
  (acc, b) => acc + (b.openLoansBalanceMinor ?? 0n),
  0n,
);
const principalLent = bundle.loans.reduce(
  (acc, l) => acc + (l.principalAmountMinor ?? 0n),
  0n,
);
const paidAll = bundle.loans.reduce(
  (acc, l) => acc + (l.paidAmountMinor ?? 0n),
  0n,
);
const openBalanceBySegment = new Map<string, bigint>();
for (let i = 0; i < bundle.loans.length; i++) {
  const c = classifications[i];
  if (c.statusNormalized === "closed") continue;
  const key = c.portfolioSegment;
  openBalanceBySegment.set(
    key,
    (openBalanceBySegment.get(key) ?? 0n) +
      (bundle.loans[i].totalPrincipalBalanceMinor ?? 0n),
  );
}
console.log("Portfolio totals:");
console.log(table([
  ["total principal lent (all-time)", fmtMoney(principalLent)],
  ["total paid (all-time)", fmtMoney(paidAll)],
  ["sum borrowers.openLoansBalance", fmtMoney(borrowerOpenAggregate)],
  ["sum loans.balanceAmount (open)", fmtMoney(openBalanceSum)],
  ["sum loans.totalPrincipalBalance (open)", fmtMoney(openPrincipalSum)],
]));
console.log("  open balance by segment:");
for (const [k, v] of openBalanceBySegment) {
  console.log(`    ${k.padEnd(20)} ${fmtMoney(v)}`);
}
console.log("");

// --- DQ metrics ---
const t2 = performance.now();
const dq = computeDqMetrics({
  bundle,
  joinResults,
  loanClassifications: classifications,
});
const tDq = performance.now() - t2;
console.log(`DQ computed in ${tDq.toFixed(0)}ms.`);
console.log("");
console.log("DQ metrics:");
for (const m of dq) {
  const valueDisplay =
    m.valueNumeric === null
      ? m.valueText ?? "(see detail)"
      : m.metric.startsWith("field_completeness_") ||
          m.metric === "borrower_join_match_rate" ||
          m.metric.startsWith("control_total_")
        ? fmtPct(m.valueNumeric)
        : String(m.valueNumeric);
  console.log(
    `  [${m.severity.toUpperCase().padEnd(8)}] ${m.metric.padEnd(42)} ${valueDisplay}`,
  );
}
console.log("");

// --- Interesting deep-dives ---

// 1. Repayment bank account distribution (cross-entity BAC signal).
const bankDist = countBy(
  bundle.repayments,
  (r) => r.bankAccountPaymentRaw ?? "(null)",
);
console.log("Repayment bank account distribution:");
const sortedBanks = Object.entries(bankDist).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sortedBanks.slice(0, 10)) {
  console.log(`  ${k.padEnd(48)} ${v}`);
}
const bacJunto = bankDist["BAC ****2600 Junto"] ?? 0;
if (bacJunto > 0) {
  console.log("");
  console.log(
    `  ⚠ Cross-entity signal: ${bacJunto} repayments landed in Junto Soluciones' BAC account.`,
  );
}
console.log("");

// 2. Legacy delinquent breakdown by released year.
const legacyByYear = new Map<string, number>();
for (let i = 0; i < bundle.loans.length; i++) {
  if (classifications[i].statusNormalized !== "legacy_delinquent") continue;
  const year = (bundle.loans[i].releasedDate ?? "????").slice(0, 4);
  legacyByYear.set(year, (legacyByYear.get(year) ?? 0) + 1);
}
console.log("Legacy delinquent loans by released year:");
const sortedYears = Array.from(legacyByYear.entries()).sort();
for (const [y, n] of sortedYears) console.log(`  ${y}  ${n}`);
console.log("");

// 3. Sample 5 unresolved-join loans.
const unresolved = joinResults.filter((r) => r.confidence === "unresolved");
console.log(
  `Unresolved borrower joins: ${unresolved.length} loans (${fmtPct(unresolved.length / bundle.loans.length)}).`,
);
if (unresolved.length > 0) {
  console.log("  Sample (first 5):");
  const loanById = new Map(bundle.loans.map((l) => [l.sourceLoanId, l]));
  for (const r of unresolved.slice(0, 5)) {
    const l = loanById.get(r.sourceLoanId);
    console.log(
      `    loan_id=${r.sourceLoanId}  borrower_ref="${l?.sourceBorrowerRef ?? ""}"  name="${l?.raw["Full Name"] ?? ""}"`,
    );
  }
}
console.log("");

console.log("Smoke validation complete.");
}, 60_000);
