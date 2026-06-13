// Resolve loans.Borrower # → portfolio_borrowers.source_borrower_id.
//
// The LoanDisk export does NOT carry a direct foreign key from the loans
// file to the borrowers file: `borrowers.Borrower Id` is numeric (e.g.
// 6073556) while `loans.Borrower #` is the borrower's `Unique Number`
// (cédula like "8-937-1696" or a short code like "EST004"). We match by:
//
//   1. exact_unique_number   — loan.Borrower # == borrower.uniqueNumber
//                              (case-insensitive, trimmed). Also matches
//                              normalized cédula → normalized cédula.
//   2. normalized_name       — loan's borrower name normalizes to the
//                              same key as exactly one borrower (zero
//                              for ambiguous; we never silently pick).
//   3. unresolved            — nothing matched.
//
// This is best-effort: when LoanDisk later supplies a stable FK (open
// question O2), we can collapse to a single-strategy resolver and
// retire the fuzzy step.

import { normalizeCedula, normalizeName } from "./parser";
import type {
  BorrowerJoinResult,
  ParsedBorrowerRow,
  ParsedLoanRow,
} from "./types";

interface BorrowerIndex {
  byUniqueNumber: Map<string, string>;       // key → source_borrower_id
  byCedula: Map<string, string>;
  byNormalizedName: Map<string, string[]>;   // can be ambiguous
}

function canonKey(s: string): string {
  return s.trim().toUpperCase();
}

export function buildBorrowerIndex(
  borrowers: ParsedBorrowerRow[],
): BorrowerIndex {
  const byUniqueNumber = new Map<string, string>();
  const byCedula = new Map<string, string>();
  const byNormalizedName = new Map<string, string[]>();

  for (const b of borrowers) {
    if (b.uniqueNumber) {
      const key = canonKey(b.uniqueNumber);
      if (!byUniqueNumber.has(key)) byUniqueNumber.set(key, b.sourceBorrowerId);
    }
    if (b.cedulaNormalized) {
      const key = canonKey(b.cedulaNormalized);
      if (!byCedula.has(key)) byCedula.set(key, b.sourceBorrowerId);
    }
    if (b.normalizedName) {
      const list = byNormalizedName.get(b.normalizedName);
      if (list) list.push(b.sourceBorrowerId);
      else byNormalizedName.set(b.normalizedName, [b.sourceBorrowerId]);
    }
  }

  return { byUniqueNumber, byCedula, byNormalizedName };
}

/**
 * Best name available on a loan row. Loans expose "Full Name" plus
 * "Last Name" / "First Name" — we prefer Full Name when present and
 * fall back to a "First Last" composition.
 */
function loanBorrowerName(loan: ParsedLoanRow): string | null {
  const full = loan.raw["Full Name"];
  if (full && full.trim() !== "") return full;
  const first = loan.raw["First Name"];
  const last = loan.raw["Last Name"];
  const composed = [first, last].filter((x) => x && x.trim() !== "").join(" ");
  return composed === "" ? null : composed;
}

export function resolveBorrowerJoin(
  loan: ParsedLoanRow,
  index: BorrowerIndex,
): BorrowerJoinResult {
  const base = { sourceLoanId: loan.sourceLoanId } as const;

  // 1. Direct Unique Number match.
  if (loan.sourceBorrowerRef) {
    const key = canonKey(loan.sourceBorrowerRef);
    const direct = index.byUniqueNumber.get(key);
    if (direct) {
      return {
        ...base,
        resolvedSourceBorrowerId: direct,
        confidence: "exact_unique_number",
      };
    }
    // The ref might already be a cédula; try the normalized-cédula path.
    const cedula = normalizeCedula(loan.sourceBorrowerRef);
    if (cedula) {
      const viaCedula = index.byCedula.get(canonKey(cedula));
      if (viaCedula) {
        return {
          ...base,
          resolvedSourceBorrowerId: viaCedula,
          confidence: "exact_unique_number",
        };
      }
    }
  }

  // 2. Normalized-name fallback. Only commit if exactly one borrower
  //    normalizes to the same key — ambiguous matches stay unresolved.
  const nameKey = normalizeName(loanBorrowerName(loan));
  if (nameKey) {
    const candidates = index.byNormalizedName.get(nameKey);
    if (candidates && candidates.length === 1) {
      return {
        ...base,
        resolvedSourceBorrowerId: candidates[0],
        confidence: "normalized_name",
      };
    }
  }

  return { ...base, resolvedSourceBorrowerId: null, confidence: "unresolved" };
}

export function resolveAllBorrowerJoins(
  loans: ParsedLoanRow[],
  borrowers: ParsedBorrowerRow[],
): BorrowerJoinResult[] {
  const index = buildBorrowerIndex(borrowers);
  return loans.map((l) => resolveBorrowerJoin(l, index));
}
