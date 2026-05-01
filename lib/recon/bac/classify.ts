// Pure classification, hashing, and FIFO pairing helpers for the BAC rail.
//
// Kept free of database and I/O so the entire rule-set is testable without
// fixtures or a Supabase instance. The ingest layer (`./ingest.ts`) is the
// only thing that turns these decisions into row writes.

import { createHash } from "node:crypto";

import type { BACRow } from "./parser";

// =============================================================
// Classification — code → kind/state/confirmable_after
// =============================================================

export type RowKind = "loan_inflow" | "reversal" | "non_loan" | "unknown";

export type RowState =
  | "pending"
  | "confirmed"
  | "rejected"
  | "non_loan"
  | "pending_pair";

export interface RowClassification {
  kind: RowKind;
  state: RowState;
  // ISO timestamp at which a pending PR becomes confirmable if no DVTO has
  // arrived. Set on PR rows (posted_at + 24h, UTC), null otherwise. Compared
  // by the ingest layer against the max posted_at observed across all
  // uploads for this account ("file-clock").
  confirmableAfter: string | null;
}

// 24h is the BAC ACH-debit reversal window: a PR credit can be reversed by a
// DA debit any time within this window. After it lapses (file-clock), the PR
// is treated as confirmed.
export const ACH_PENDING_HOURS = 24;

export function classifyBACRow(row: Pick<BACRow, "code" | "postedAt">): RowClassification {
  switch (row.code) {
    case "PR":
      return {
        kind: "loan_inflow",
        state: "pending",
        confirmableAfter: addHoursToISODate(row.postedAt, ACH_PENDING_HOURS),
      };
    case "4C":
      return { kind: "loan_inflow", state: "confirmed", confirmableAfter: null };
    case "DA":
      // Pending until the ingest layer pairs it back to a PR. If no PR is
      // found (orphan reversal), it stays as `pending_pair` for ops review.
      return { kind: "reversal", state: "pending_pair", confirmableAfter: null };
    case "AD":
    case "TX":
    case "FE":
    case "4A":
      return { kind: "non_loan", state: "non_loan", confirmableAfter: null };
    default:
      return { kind: "unknown", state: "pending", confirmableAfter: null };
  }
}

// =============================================================
// Row hashing — idempotent re-uploads collapse on (account_id, row_hash)
// =============================================================

export interface RowHashInput {
  accountId: string;
  postedAt: string;
  reference: string;
  code: string;
  description: string;
  debitMinor: bigint;
  creditMinor: bigint;
  balanceMinor: bigint;
}

export function computeRowHash(input: RowHashInput): string {
  // \x1F (unit separator) is a control char that won't appear in any field
  // we're hashing, so concatenation is unambiguous.
  const parts = [
    input.accountId,
    input.postedAt,
    input.reference,
    input.code,
    input.description,
    input.debitMinor.toString(),
    input.creditMinor.toString(),
    input.balanceMinor.toString(),
  ];
  return createHash("sha256").update(parts.join("\x1F")).digest("hex");
}

export function computeFileSha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// =============================================================
// FIFO PR ↔ DA pairing
// =============================================================

export interface PRCandidate {
  id: string;
  postedAt: string;
  rowIndex: number; // tie-breaker for same-day PRs in the same file
  creditMinor: bigint;
  description: string;
}

export interface DAToMatch {
  amountMinor: bigint;     // = debitMinor on the DA row
  payerNameRaw: string;    // parsed from "DVTO {code} {NAME}"
  postedAt: string;        // DA cannot precede the PR it reverses
}

/**
 * A DA can only reject a PR whose 24h rejection window was still open
 * when the DA arrived — that's the original rule, expressed as
 * `pr.posted_at + 24h > da.posted_at`. In real BAC data, the posting
 * cadence is fuzzy: a rejection (DA) can be posted with a date one day
 * BEFORE the corresponding payment (PR), even though the actual ACH
 * timeline always has PR before DA. This shows up as a DA on Apr 6
 * paired with a PR on Apr 7 in the bank's ledger.
 *
 * To capture both directions while still excluding the Astryht-style
 * mismatch (PR Apr 5 + DA Apr 7, two days apart), the rule becomes:
 * `|pr.posted_at − da.posted_at| <= 1 day`. PR can be the day before,
 * same day, or day after the DA — but no further.
 *
 * Anything outside that window is either already file-clock-confirmed
 * (older PR) or beyond what BAC's posting fuzziness can explain.
 */
export function isWithinAchRejectionWindow(
  prPostedAt: string,
  daPostedAt: string,
): boolean {
  if (!prPostedAt || !daPostedAt) return false;
  const tPr = Date.parse(prPostedAt + "T00:00:00Z");
  const tDa = Date.parse(daPostedAt + "T00:00:00Z");
  if (Number.isNaN(tPr) || Number.isNaN(tDa)) return false;
  const diffDays = (tPr - tDa) / 86_400_000;
  return diffDays >= -1 && diffDays <= 1;
}

// Picks the earliest unmatched PR whose amount + payer name match the DA
// AND whose 24h rejection window was still open when the DA arrived.
// First-unmatched-wins by (postedAt asc, rowIndex asc).
export function pickFifoMatchPR(
  da: DAToMatch,
  candidates: PRCandidate[],
): PRCandidate | null {
  if (!da.payerNameRaw) return null;
  const targetName = normalizeName(da.payerNameRaw);

  const ordered = [...candidates].sort((a, b) => {
    if (a.postedAt !== b.postedAt) return a.postedAt < b.postedAt ? -1 : 1;
    return a.rowIndex - b.rowIndex;
  });

  for (const pr of ordered) {
    if (pr.creditMinor !== da.amountMinor) continue;
    if (!isWithinAchRejectionWindow(pr.postedAt, da.postedAt)) continue;
    const prName = extractPRPayerName(pr.description);
    if (!prName) continue;
    if (namesMatch(normalizeName(prName), targetName)) return pr;
  }
  return null;
}

// "Tef DCD de Jorge Miguel Diaz P" → "Jorge Miguel Diaz P".
// "ACH CRE Maria Lopez"            → "Maria Lopez".
export function extractPRPayerName(desc: string): string | null {
  const m =
    desc.match(/\bDCD\s+de\s+(.+)$/i) ??
    desc.match(/\bACH\s+CRE\s+(.+)$/i) ??
    desc.match(/\bde\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// BAC truncates names in different reports at different lengths, so a strict
// equality check would miss valid pairings. Prefix-matching either direction
// handles "JORGE MIGUEL DIAZ P" vs "JORGE MIGUEL DIAZ PE" cleanly while
// still rejecting unrelated names. We require ≥ 6 chars overlap to avoid
// pathological short-prefix collisions.
export function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (shorter.length < 6) return false;
  return longer.startsWith(shorter);
}

// =============================================================
// File-clock helpers
// =============================================================

// posted_at is YYYY-MM-DD; we treat it as UTC midnight. Adding 24h gives the
// instant at which a PR becomes confirmable if no DA has arrived by then.
function addHoursToISODate(iso: string, hours: number): string {
  const t = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(t)) {
    throw new Error(`addHoursToISODate: invalid ISO date "${iso}"`);
  }
  return new Date(t + hours * 60 * 60 * 1000).toISOString();
}

// The file-clock cutoff is the latest posted_at observed across all uploads
// for an account, expressed as a UTC instant. Any pending PR whose
// confirmable_after <= this cutoff is eligible to flip to confirmed (assuming
// no DA paired against it).
export function fileClockCutoff(maxPostedAt: string): string {
  return new Date(Date.parse(maxPostedAt + "T00:00:00Z")).toISOString();
}
