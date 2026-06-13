// Server-side metric fact loader.
//
// Resolves the snapshot for a given entity (latest by default, or a
// specific snapshot_date), pulls the loan facts from the view, and
// attaches the active policy.
//
// The view (portfolio_loan_metric_facts) joins portfolio_loans with the
// repayment rollup, so the page renders without dragging 32k repayments
// over the wire.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { PortfolioEntityCode, PortfolioPolicy, PortfolioPolicyId } from "../types";

import type { LoanFact, MetricFactBundle } from "./types";

// Loose typing — same rationale as ingest.ts. Tighten once we wire the
// generated Database type all the way through.
type AnySupabase = SupabaseClient;

const SUPABASE_HARD_LIMIT = 10_000;

export interface LoadFactsArgs {
  entityCode: PortfolioEntityCode;
  /** Optional ISO snapshot_date. Omit to use the latest completed snapshot. */
  snapshotDate?: string;
}

export interface ResolvedSnapshot {
  snapshotId: string;
  snapshotDate: string;
  entityId: string;
  entityCode: string;
  entityDisplayName: string;
  status: string;
}

/**
 * Resolve a snapshot ID + entity info. Caller can then load facts.
 * Returns null if no completed snapshot exists for the entity.
 */
export async function resolveSnapshot(
  supabase: AnySupabase,
  args: LoadFactsArgs,
): Promise<ResolvedSnapshot | null> {
  const { data: entity, error: entityErr } = await supabase
    .from("portfolio_entities")
    .select("id, code, display_name")
    .eq("code", args.entityCode)
    .maybeSingle();
  if (entityErr || !entity) return null;

  let q = supabase
    .from("portfolio_snapshots")
    .select("id, snapshot_date, status, entity_id")
    .eq("entity_id", entity.id as string)
    .eq("status", "completed")
    .order("snapshot_date", { ascending: false })
    .limit(1);
  if (args.snapshotDate) q = q.eq("snapshot_date", args.snapshotDate);

  const { data: snap } = await q.maybeSingle();
  if (!snap) return null;

  return {
    snapshotId: snap.id as string,
    snapshotDate: snap.snapshot_date as string,
    entityId: entity.id as string,
    entityCode: entity.code as string,
    entityDisplayName: entity.display_name as string,
    status: snap.status as string,
  };
}

/**
 * Load the metric fact bundle for a resolved snapshot. Pulls loan facts
 * + active policy in two round trips.
 */
export async function loadMetricFactBundle(
  supabase: AnySupabase,
  resolved: ResolvedSnapshot,
): Promise<MetricFactBundle> {
  const policy = await loadActivePolicy(supabase, resolved.snapshotDate);

  const { data: rows, error } = await supabase
    .from("portfolio_loan_metric_facts")
    .select(
      "loan_pk, snapshot_id, entity_id, snapshot_date, source_loan_id, balance_amount_minor, principal_amount_minor, paid_amount_minor, past_due_minor, days_past_due, status_normalized, product_group, management_vintage, portfolio_segment, ifrs_stage, is_npl, released_date, maturity_date, loan_officer_raw, cohort_month, cash_collected_minor, write_off_minor, cash_count, finiquito_count",
    )
    .eq("snapshot_id", resolved.snapshotId)
    .limit(SUPABASE_HARD_LIMIT);
  if (error) {
    throw new Error(
      `portfolio_loan_metric_facts load failed for snapshot=${resolved.snapshotId}: ${error.message}`,
    );
  }

  const loans: LoanFact[] = (rows ?? []).map(mapRow);

  return {
    snapshotId: resolved.snapshotId,
    snapshotDate: resolved.snapshotDate,
    entityId: resolved.entityId,
    entityCode: resolved.entityCode,
    entityDisplayName: resolved.entityDisplayName,
    policy,
    eclPlaceholder: isEclPlaceholder(policy),
    loans,
  };
}

/**
 * Convenience wrapper — resolve + load in one call.
 */
export async function loadMetricFacts(
  supabase: AnySupabase,
  args: LoadFactsArgs,
): Promise<MetricFactBundle | null> {
  const resolved = await resolveSnapshot(supabase, args);
  if (!resolved) return null;
  return loadMetricFactBundle(supabase, resolved);
}

// =============================================================
// Policy + helpers
// =============================================================

async function loadActivePolicy(
  supabase: AnySupabase,
  snapshotDate: string,
): Promise<PortfolioPolicy> {
  const { data, error } = await supabase
    .from("portfolio_policy")
    .select("*")
    .lte("effective_from", snapshotDate)
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();
  if (error || !data) {
    throw new Error(
      `portfolio_policy lookup failed for snapshot_date=${snapshotDate}: ${error?.message ?? "no row"}`,
    );
  }
  return mapPolicyRow(data);
}

function mapPolicyRow(row: Record<string, unknown>): PortfolioPolicy {
  return {
    id: row.id as PortfolioPolicyId,
    effectiveFrom: row.effective_from as string,
    chargeOffDpdThreshold: row.charge_off_dpd_threshold as number,
    managementCutoffDate: row.management_cutoff_date as string,
    cashAdvanceAlwaysNew: row.cash_advance_always_new as boolean,
    stage2DpdMin: row.stage_2_dpd_min as number,
    stage3DpdMin: row.stage_3_dpd_min as number,
    nplDpdMin: row.npl_dpd_min as number,
    eclStage1Coverage:
      row.ecl_stage_1_coverage === null
        ? null
        : Number(row.ecl_stage_1_coverage),
    eclStage2Coverage:
      row.ecl_stage_2_coverage === null
        ? null
        : Number(row.ecl_stage_2_coverage),
    eclStage3Coverage:
      row.ecl_stage_3_coverage === null
        ? null
        : Number(row.ecl_stage_3_coverage),
  };
}

/**
 * The seeded placeholder values from migration
 * 20260613090000_portfolio_policy_ecl_coverage.sql. We track these so
 * the UI can badge "placeholder" until risk supplies the real matrix.
 */
const PLACEHOLDER_RATES = {
  stage1: 0.01,
  stage2: 0.1,
  stage3: 0.5,
} as const;

function isEclPlaceholder(p: PortfolioPolicy): boolean {
  return (
    p.eclStage1Coverage === PLACEHOLDER_RATES.stage1 &&
    p.eclStage2Coverage === PLACEHOLDER_RATES.stage2 &&
    p.eclStage3Coverage === PLACEHOLDER_RATES.stage3
  );
}

function mapRow(row: Record<string, unknown>): LoanFact {
  return {
    loanPk: row.loan_pk as string,
    sourceLoanId: row.source_loan_id as string,
    entityId: row.entity_id as string,
    snapshotId: row.snapshot_id as string,
    snapshotDate: row.snapshot_date as string,
    balanceAmountMinor: toBigInt(row.balance_amount_minor),
    principalAmountMinor: toBigInt(row.principal_amount_minor),
    paidAmountMinor: toBigInt(row.paid_amount_minor),
    pastDueMinor: toBigInt(row.past_due_minor),
    daysPastDue:
      row.days_past_due === null || row.days_past_due === undefined
        ? null
        : Number(row.days_past_due),
    statusNormalized:
      (row.status_normalized as LoanFact["statusNormalized"]) ?? null,
    productGroup: (row.product_group as LoanFact["productGroup"]) ?? null,
    managementVintage:
      (row.management_vintage as LoanFact["managementVintage"]) ?? null,
    portfolioSegment:
      (row.portfolio_segment as LoanFact["portfolioSegment"]) ?? null,
    ifrsStage: (row.ifrs_stage as LoanFact["ifrsStage"]) ?? null,
    isNpl: row.is_npl === true,
    releasedDate: (row.released_date as string | null) ?? null,
    maturityDate: (row.maturity_date as string | null) ?? null,
    loanOfficerRaw: (row.loan_officer_raw as string | null) ?? null,
    cohortMonth: (row.cohort_month as string | null) ?? null,
    cashCollectedMinor: toBigInt(row.cash_collected_minor),
    writeOffMinor: toBigInt(row.write_off_minor),
    cashCount: Number(row.cash_count ?? 0),
    finiquitoCount: Number(row.finiquito_count ?? 0),
  };
}

function toBigInt(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.length > 0) {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  return 0n;
}
