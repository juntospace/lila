// Placeholder lookup for the BAC DVTO return codes that surface as the
// `return_code` on a DA (DVTO) row. These codes come from the ACH network
// and indicate why a given pull was rejected.
//
// We don't yet have the official legend, so the map is stubbed out — the
// UI displays the raw code with an "Unmapped code" tag until we drop in
// the real mapping. When you do, just fill in the values; the call sites
// don't need to change.

const DVTO_REASONS: Record<string, string> = {
  // AM04: "...",
  // AC01: "...",
  // AC04: "...",
  // BE09: "...",
};

export function reasonForDvtoCode(code: string | null | undefined): {
  label: string;
  isMapped: boolean;
} {
  if (!code) return { label: "—", isMapped: false };
  const upper = code.trim().toUpperCase();
  const mapped = DVTO_REASONS[upper];
  if (mapped) return { label: mapped, isMapped: true };
  return { label: `Unmapped code (${upper})`, isMapped: false };
}
