import type { SupabaseClient } from "@supabase/supabase-js";

import type { PortfolioBucket, PortfolioPolicy } from "./types";

export const DEFAULT_POLICY: PortfolioPolicy = {
  id: null,
  version: "v1.0",
  effectiveFrom: "2020-01-01",
  handoverDate: "2025-06-01",
  coUnsecured: 180,
  coSecured: 360,
  coUnsecuredDpd: 180,
  coSecuredDpd: 360,
  bucketBins: [-1, 0, 30, 60, 90, 180, 365, 1e9],
  bucketNames: [
    "Al día",
    "1-30",
    "31-60",
    "61-90",
    "91-180",
    "181-365",
    "365+",
  ],
  provRates: [0.01, 0.05, 0.15, 0.25, 0.50, 0.90, 1.00],
  realMethods: [
    "ach",
    "cheque",
    "yappy",
    "deposito en efectivo",
    "debito planilla (empleado)",
    "debito planilla",
  ],
  adminMethods: [
    "descuento por pronto pago",
    "finiquito otorgado",
    "traspaso a provision",
    "traspaso de saldo",
    "ajuste",
  ],
  notes: "Configuración base MAIA (CRO) de política de riesgo.",
};

function mapPolicyRow(row: Record<string, unknown>): PortfolioPolicy {
  const coUnsecured =
    typeof row.co_unsecured_dpd === "number"
      ? row.co_unsecured_dpd
      : DEFAULT_POLICY.coUnsecured;
  const coSecured =
    typeof row.co_secured_dpd === "number"
      ? row.co_secured_dpd
      : DEFAULT_POLICY.coSecured;

  const bucketBins = Array.isArray(row.bucket_bins)
    ? (row.bucket_bins as number[]).map(Number)
    : DEFAULT_POLICY.bucketBins;

  const bucketNames = Array.isArray(row.bucket_names)
    ? (row.bucket_names as PortfolioBucket[])
    : DEFAULT_POLICY.bucketNames;

  const provRates = Array.isArray(row.prov_rates)
    ? (row.prov_rates as number[]).map(Number)
    : DEFAULT_POLICY.provRates;

  const realMethods = Array.isArray(row.real_methods)
    ? (row.real_methods as string[]).map(String)
    : DEFAULT_POLICY.realMethods;

  const adminMethods = Array.isArray(row.admin_methods)
    ? (row.admin_methods as string[]).map(String)
    : DEFAULT_POLICY.adminMethods;

  return {
    id: typeof row.id === "string" ? row.id : null,
    version:
      typeof row.version === "string" && row.version
        ? row.version
        : DEFAULT_POLICY.version,
    effectiveFrom:
      typeof row.effective_from === "string" && row.effective_from
        ? row.effective_from
        : DEFAULT_POLICY.effectiveFrom,
    handoverDate:
      typeof row.handover_date === "string" && row.handover_date
        ? row.handover_date
        : DEFAULT_POLICY.handoverDate,
    coUnsecured,
    coSecured,
    coUnsecuredDpd: coUnsecured,
    coSecuredDpd: coSecured,
    bucketBins,
    bucketNames,
    provRates,
    realMethods,
    adminMethods,
    notes: typeof row.notes === "string" ? row.notes : null,
  };
}

/**
 * Loads the active CRO policy where effective_from <= asOf (most recent).
 * Falls back to the earliest available policy or DEFAULT_POLICY if none matches.
 */
export async function loadActivePolicy(
  supabase: SupabaseClient,
  asOf?: string,
): Promise<PortfolioPolicy> {
  try {
    let query = supabase
      .from("portfolio_policy")
      .select("*")
      .order("effective_from", { ascending: false });

    if (asOf) {
      query = query.lte("effective_from", asOf);
    }

    const { data, error } = await query.limit(1).maybeSingle();
    if (!error && data) {
      return mapPolicyRow(data as Record<string, unknown>);
    }

    // Fallback: if asOf is older than any policy's effective_from, pick the earliest policy
    const { data: fallback } = await supabase
      .from("portfolio_policy")
      .select("*")
      .order("effective_from", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (fallback) {
      return mapPolicyRow(fallback as Record<string, unknown>);
    }
  } catch {
    // Fall back to DEFAULT_POLICY when offline or mocked
  }

  return DEFAULT_POLICY;
}

