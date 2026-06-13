// Concentration + repeat-borrower KPIs. Single-snapshot pure compute.
//
// Concentration is a standard investor-diligence number: how much of
// the book sits behind the top-N borrowers, and what is the largest
// single exposure as a share of GLP? Anything north of ~10% on a single
// borrower starts to be a deal-killer for senior lenders.
//
// "Borrower" here means `resolvedSourceBorrowerId`. Loans whose
// borrower didn't resolve are treated as singletons (their own
// borrower) — conservative, because that inflates apparent diversity.

import type { LoanFact } from "./types";

export interface BorrowerExposure {
  borrowerId: string;
  /** Synthetic flag — true when this exposure represents a loan we
   *  couldn't link to a borrower; counts as its own borrower. */
  unresolved: boolean;
  loanCount: number;
  openLoanCount: number;
  glpMinor: bigint;
  principalLentMinor: bigint;
}

export interface ConcentrationReport {
  totalBorrowers: number;
  /** Distinct borrowers behind OPEN loans. */
  activeBorrowers: number;
  glpMinor: bigint;
  /** Largest single borrower's GLP / total GLP. */
  largestExposureShare: number;
  /** Top-N exposures (cap at 25 by default). */
  top: BorrowerExposure[];
  /** Sum of the top-10 / GLP. */
  top10Share: number;
  /** Sum of the top-25 / GLP. */
  top25Share: number;
}

export interface RepeatBorrowerReport {
  /** Distinct borrowers with at least one OPEN loan. */
  activeBorrowers: number;
  /** Borrowers with >= 2 OPEN loans. */
  repeatBorrowers: number;
  /** repeatBorrowers / activeBorrowers. */
  repeatBorrowerRate: number;
  /** Distinct borrowers all-time on the snapshot (any status). */
  totalBorrowers: number;
}

export function computeConcentration(
  loans: LoanFact[],
  topN = 25,
): ConcentrationReport {
  const all = buildExposures(loans);
  const open = all.filter((e) => e.openLoanCount > 0);

  const glpMinor = open.reduce((acc, e) => acc + e.glpMinor, 0n);
  open.sort((a, b) => (b.glpMinor > a.glpMinor ? 1 : b.glpMinor < a.glpMinor ? -1 : 0));

  const largest = open[0]?.glpMinor ?? 0n;
  const largestExposureShare =
    glpMinor === 0n ? Number.NaN : Number(largest) / Number(glpMinor);

  const top = open.slice(0, topN);
  const top10Sum = open
    .slice(0, 10)
    .reduce((acc, e) => acc + e.glpMinor, 0n);
  const top25Sum = open
    .slice(0, 25)
    .reduce((acc, e) => acc + e.glpMinor, 0n);
  const top10Share =
    glpMinor === 0n ? Number.NaN : Number(top10Sum) / Number(glpMinor);
  const top25Share =
    glpMinor === 0n ? Number.NaN : Number(top25Sum) / Number(glpMinor);

  return {
    totalBorrowers: all.length,
    activeBorrowers: open.length,
    glpMinor,
    largestExposureShare,
    top,
    top10Share,
    top25Share,
  };
}

export function computeRepeatBorrowers(
  loans: LoanFact[],
): RepeatBorrowerReport {
  const all = buildExposures(loans);
  const active = all.filter((e) => e.openLoanCount > 0);
  const repeat = active.filter((e) => e.openLoanCount >= 2);
  const rate =
    active.length === 0 ? Number.NaN : repeat.length / active.length;
  return {
    activeBorrowers: active.length,
    repeatBorrowers: repeat.length,
    repeatBorrowerRate: rate,
    totalBorrowers: all.length,
  };
}

// =============================================================
// Helpers
// =============================================================

function buildExposures(loans: LoanFact[]): BorrowerExposure[] {
  const map = new Map<string, BorrowerExposure>();
  let unresolvedCounter = 0;
  for (const l of loans) {
    let key: string;
    let unresolved = false;
    if (l.resolvedSourceBorrowerId) {
      key = `R:${l.resolvedSourceBorrowerId}`;
    } else {
      // Each unresolved loan stands alone — bumping a counter so they
      // don't all collapse into one synthetic "unresolved" group.
      unresolvedCounter += 1;
      key = `U:${l.sourceLoanId}:${unresolvedCounter}`;
      unresolved = true;
    }
    let e = map.get(key);
    if (!e) {
      e = {
        borrowerId: l.resolvedSourceBorrowerId ?? l.sourceLoanId,
        unresolved,
        loanCount: 0,
        openLoanCount: 0,
        glpMinor: 0n,
        principalLentMinor: 0n,
      };
      map.set(key, e);
    }
    e.loanCount += 1;
    e.principalLentMinor += l.principalAmountMinor;
    if (l.statusNormalized !== "closed") {
      e.openLoanCount += 1;
      e.glpMinor += l.balanceAmountMinor;
    }
  }
  return Array.from(map.values());
}
