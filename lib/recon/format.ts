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
