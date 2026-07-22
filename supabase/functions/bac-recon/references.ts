// BAC reference-number parsing for batch-aware reconciliation.
//
// PR references encode (rightmost 5 digits = batch sequence, leftmost
// digits = transaction-type prefix, usually "62"):
//
//   6227489  →  type=62, sequence=27489
//   6227522  →  type=62, sequence=27522
//
// DA references encode (rightmost 5 = sequence, 6th from right = type
// prefix usually "4", remaining 1–3 leftmost digits = origin-bank code):
//
//   7423348      →  bank=7   (Banco General), type=4, sequence=23348
//   149423344    →  bank=149 (St. Georges), type=4, sequence=23344
//   158423346    →  bank=158 (Banesco), type=4, sequence=23346
//
// Within a DA batch the sequence is global (counts up regardless of
// origin bank); the bank prefix can change row-to-row inside the same
// run of consecutive sequences.

const DIGIT_RE = /^\d+$/;

export interface PRReferenceParts {
  raw: string;
  /** Leftmost digits — transaction-type prefix (usually "62"). */
  type: number;
  /** Rightmost 5 digits — batch sequence. Lower = earlier batch. */
  sequence: number;
}

export interface DAReferenceParts {
  raw: string;
  /** 6th digit from the right — transaction-type prefix (usually "4"). */
  type: number;
  /** Leftmost 1–3 digits — origin-bank code (e.g. 7=BG, 149=St.Georges). */
  originBank: number;
  /** Rightmost 5 digits — sequence. Consecutive across an entire DA batch. */
  sequence: number;
}

/**
 * Parse a PR `Referencia`. Returns null for empty/non-digit/too-short input.
 * Accepts whitespace around the digits but rejects anything mixed with letters.
 *
 * Minimum length 6: 1+ type digit + 5 sequence digits.
 */
export function parsePRReference(ref: string | null | undefined): PRReferenceParts | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!DIGIT_RE.test(trimmed)) return null;
  if (trimmed.length < 6) return null;
  const sequence = Number(trimmed.slice(-5));
  const type = Number(trimmed.slice(0, -5));
  if (!Number.isFinite(sequence) || !Number.isFinite(type)) return null;
  return { raw: trimmed, type, sequence };
}

/**
 * Parse a DA `Referencia`. Returns null for empty/non-digit/too-short input.
 *
 * Minimum length 7: 1 bank-code digit + 1 type digit + 5 sequence digits.
 */
export function parseDAReference(ref: string | null | undefined): DAReferenceParts | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!DIGIT_RE.test(trimmed)) return null;
  if (trimmed.length < 7) return null;
  const sequence = Number(trimmed.slice(-5));
  const type = Number(trimmed.slice(-6, -5));
  const originBank = Number(trimmed.slice(0, -6));
  if (
    !Number.isFinite(sequence) ||
    !Number.isFinite(type) ||
    !Number.isFinite(originBank)
  ) {
    return null;
  }
  return { raw: trimmed, type, originBank, sequence };
}
