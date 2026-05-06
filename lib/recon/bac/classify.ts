// Pure classification, hashing, and name-matching helpers for the BAC rail.
//
// Kept free of database and I/O so the entire rule-set is testable without
// fixtures or a Supabase instance. The ingest layer (`./ingest.ts`) and
// recompute layer (`./recompute.ts`) are the only things that turn these
// decisions into row writes.
//
// Pairing math lives in `./batches.ts`; the legacy per-row FIFO matcher
// (pickFifoMatchPR) was retired in Tier 5 PR 2 alongside the file-clock
// confirmation rule (Tier 5 PR 3).

import { createHash } from "node:crypto";

import type { BACRow } from "./parser";

// =============================================================
// Classification — code → kind/state
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
  // Legacy column carried for compatibility with rows ingested before
  // Tier 5 PR 3. Populated as posted_at + 24h on PR rows so the DB column
  // stays consistent across all rows; no code reads the value anymore
  // (file-clock confirmation was retired).
  confirmableAfter: string | null;
}

// Legacy ACH-debit reversal window. Kept only because we still write
// `confirmable_after = posted_at + 24h` on PR rows for column consistency.
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

/**
 * Operator-curated alias map for pairing-by-equivalence.
 *
 * Key:   the PR-side name as it appears in the description (after
 *        extractPRPayerName + normalizeName).
 * Value: the set of DA-side names (after parseDvtoDescription +
 *        normalizeName) that operators have manually confirmed represent
 *        the same client.
 *
 * The batch linker consults this AFTER the regular prefix `namesMatch`
 * fails, so the alias map is purely additive — it cannot block any
 * pairing that the prefix rule would have made on its own.
 */
export type AliasMap = Map<string, Set<string>>;

export function aliasMatch(
  prNormalized: string,
  daNormalized: string,
  aliases: AliasMap,
): boolean {
  const set = aliases.get(prNormalized);
  return set ? set.has(daNormalized) : false;
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

// posted_at is YYYY-MM-DD; treated as UTC midnight. Used to populate the
// (now-unread) confirmable_after column at ingest time.
function addHoursToISODate(iso: string, hours: number): string {
  const t = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(t)) {
    throw new Error(`addHoursToISODate: invalid ISO date "${iso}"`);
  }
  return new Date(t + hours * 60 * 60 * 1000).toISOString();
}
