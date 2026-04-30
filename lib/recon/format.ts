// Money + date formatters scoped to the recon module.
//
// All amounts on this rail are USD; if/when we add Yappy or Banco General
// (which are also PAB/USD effectively in Panama), broaden as needed.

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMinorUSD(amountMinor: bigint | string | number): string {
  const minor =
    typeof amountMinor === "bigint"
      ? amountMinor
      : typeof amountMinor === "number"
        ? BigInt(Math.round(amountMinor))
        : BigInt(amountMinor);
  // Two-decimal currency: split into whole + fractional cents for safe
  // bigint → number conversion (we never expect a balance > 2^53 cents).
  const sign = minor < 0n ? -1n : 1n;
  const abs = minor < 0n ? -minor : minor;
  const whole = abs / 100n;
  const cents = abs % 100n;
  const numeric = Number(whole) + Number(cents) / 100;
  return USD.format(Number(sign) * numeric);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  // ISO YYYY-MM-DD → DD/MM/YYYY (matches BAC's locale).
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Walk back from `ref` (a UTC midnight Date) collecting the most recent
 * `n` weekdays (Mon–Fri). Returns the inclusive [from, to] range covering
 * those days, both as ISO YYYY-MM-DD. No holiday calendar yet.
 *
 * Example: ref=2026-04-07 (Tue), n=2 → { from: '2026-04-06', to: '2026-04-07' }
 */
export function lastWorkingDays(ref: Date, n: number): { from: string; to: string } {
  if (n < 1) throw new Error("lastWorkingDays: n must be >= 1");
  const dates: Date[] = [];
  const cursor = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  while (dates.length < n) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  dates.sort((a, b) => a.getTime() - b.getTime());
  return {
    from: dates[0].toISOString().slice(0, 10),
    to: dates[dates.length - 1].toISOString().slice(0, 10),
  };
}
