import type { SupabaseClient } from "@supabase/supabase-js";

import { buildCollectionsPlan } from "./collections";
import { enrichLoan } from "./enrich";
import { fetchAll } from "./fetch-all";
import { loadActivePolicy } from "./policy";
import type {
  ActionPlanItem,
  ActionPlanSummary,
  PortfolioIngestBatch,
  PortfolioPolicy,
} from "./types";

export interface LoadedCollectionsPlan {
  entityId: string;
  entityCode: string;
  snapshotId: string;
  asOfDate: string;
  plan: ActionPlanItem[];
  resumen: ActionPlanSummary;
  policy: PortfolioPolicy;
  batch: PortfolioIngestBatch | null;
}

export async function loadCollectionsPlan(
  supabase: SupabaseClient,
  entityCode = "crediclaro",
  targetDate?: string | null,
): Promise<LoadedCollectionsPlan | null> {
  // 1. Resolve entity
  const { data: entity } = await supabase
    .from("portfolio_entities")
    .select("id, code")
    .eq("code", entityCode)
    .maybeSingle();

  if (!entity) {
    return null;
  }

  // 2. Resolve target snapshot (completed only)
  let snapQuery = supabase
    .from("portfolio_snapshots")
    .select("*")
    .eq("entity_id", entity.id)
    .eq("status", "completed")
    .order("snapshot_date", { ascending: false });

  if (targetDate) {
    snapQuery = snapQuery.eq("snapshot_date", targetDate);
  }

  const { data: snapshots } = await snapQuery.limit(1);
  if (!snapshots || snapshots.length === 0) {
    return null;
  }

  const currentSnap = snapshots[0];
  const asOfDate = currentSnap.snapshot_date as string;

  // 3. Load active CRO policy for asOfDate
  const policy = await loadActivePolicy(supabase, asOfDate);

  // 4. Resolve previous snapshot (for "rolled a bucket" signal)
  const { data: priorSnapshots } = await supabase
    .from("portfolio_snapshots")
    .select("id, snapshot_date")
    .eq("entity_id", entity.id)
    .eq("status", "completed")
    .lt("snapshot_date", asOfDate)
    .order("snapshot_date", { ascending: false })
    .limit(1);

  const prevSnap = priorSnapshots?.[0];
  let prevBucketMap: Record<string, number> | null = null;
  if (prevSnap) {
    const prevLoans = await fetchAll<{
      source_loan_id: string;
      bucket_idx: number;
    }>((from, to) =>
      supabase
        .from("portfolio_loans")
        .select("source_loan_id, bucket_idx")
        .eq("snapshot_id", prevSnap.id)
        .eq("is_open", true)
        .order("id", { ascending: true })
        .range(from, to),
    );

    prevBucketMap = {};
    for (const pl of prevLoans) {
      prevBucketMap[pl.source_loan_id] = pl.bucket_idx;
    }
  }

  // 5. Load all loans for current snapshot (paginated)
  const dbLoans = await fetchAll<Record<string, unknown>>((from, to) =>
    supabase
      .from("portfolio_loans")
      .select("*")
      .eq("snapshot_id", currentSnap.id)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const enrichedLoans = dbLoans.map((l) => {
    const rawObj =
      typeof l.raw === "object" && l.raw !== null
        ? (l.raw as Record<string, string>)
        : {};

    return enrichLoan(
      {
        ...rawObj,
        "Loan Id": String(l.source_loan_id ?? ""),
        "Loan #": String(l.loan_number ?? ""),
        "Full Name": String(l.full_name ?? ""),
        "Borrower Mobile": String(l.borrower_mobile ?? ""),
        "Loan Product": String(l.product ?? ""),
        "Balance Amount": String(l.balance ?? 0),
        "Days Past Due": String(l.dpd_loandisk ?? 0),
        "Past Due": String(l.past_due ?? ""),
        "Pending Due": String(l.pending_due ?? ""),
        "Loan Status Name": String(l.status_raw ?? ""),
        "Prestamo Garantizado": String(l.pg ?? ""),
        "Tipo de Garantia": String(l.tg ?? ""),
        "Tipo de Cartera": String(l.tc ?? ""),
        "Gestor de Cobro": String(l.gc ?? ""),
        "Motor de Riesgo (Adelantos)": String(l.mr ?? ""),
        "Last Payment Date": String(l.last_payment_date ?? ""),
        "Last Payment Amount": String(l.last_payment_amount ?? ""),
      },
      policy,
    );
  });

  // 6. Load all real repayments for current snapshot (paginated)
  const realReps = await fetchAll<{
    source_loan_id: string;
    collection_date: string;
  }>((from, to) =>
    supabase
      .from("portfolio_loan_repayments")
      .select("source_loan_id, collection_date")
      .eq("snapshot_id", currentSnap.id)
      .eq("is_real", true)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const sourceFiles =
    typeof currentSnap.source_files === "object" &&
    currentSnap.source_files !== null
      ? (currentSnap.source_files as Record<string, unknown>)
      : {};

  // Explicit hasRepaymentsFile detection (Fase 2.1)
  const hasRepaymentsFile =
    typeof currentSnap.has_repayments === "boolean" &&
    currentSnap.has_repayments
      ? true
      : typeof sourceFiles.hasRepaymentsFile === "boolean"
        ? sourceFiles.hasRepaymentsFile
        : Boolean(sourceFiles.repaymentsFile) || realReps.length > 0;

  let lastRealPaymentMap: Record<string, string> | null = null;
  if (hasRepaymentsFile) {
    lastRealPaymentMap = {};
    for (const rep of realReps) {
      const cur = lastRealPaymentMap[rep.source_loan_id];
      if (!cur || rep.collection_date > cur) {
        lastRealPaymentMap[rep.source_loan_id] = rep.collection_date;
      }
    }
  }

  // 7. Load latest ingest batch for quality warnings (Fase 4.3)
  let batch: PortfolioIngestBatch | null = null;
  try {
    const { data: batchRow } = await supabase
      .from("portfolio_ingest_batches")
      .select("*")
      .eq("snapshot_id", currentSnap.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (batchRow) {
      batch = {
        id: batchRow.id,
        snapshotId: batchRow.snapshot_id,
        sha256Loans: batchRow.sha256_loans,
        sha256Repayments: batchRow.sha256_repayments,
        rowsLoans: Number(batchRow.rows_loans || 0),
        rowsRepayments: Number(batchRow.rows_repayments || 0),
        sumBalanceSource: Number(batchRow.sum_balance_source || 0),
        sumBalanceIngested: Number(batchRow.sum_balance_ingested || 0),
        futurePaymentsExcluded: Number(batchRow.future_payments_excluded || 0),
        cashAheadCount: Number(batchRow.cash_ahead_count || 0),
        adminExcludedCount: Number(batchRow.admin_excluded_count || 0),
        adminExcludedAmount: Number(batchRow.admin_excluded_amount || 0),
        unknownMethods: Array.isArray(batchRow.unknown_methods)
          ? batchRow.unknown_methods
          : [],
        missingCustomFields: Array.isArray(batchRow.missing_custom_fields)
          ? batchRow.missing_custom_fields
          : [],
        missingReleasedDateCount: Number(
          batchRow.missing_released_date_count || 0,
        ),
        uploadedBy: batchRow.uploaded_by,
        createdAt: batchRow.created_at,
      };
    }
  } catch {
    // Non-fatal if table is not yet migrated in mock environment
  }

  // 8. Compute plan
  const { plan, resumen } = buildCollectionsPlan({
    loans: enrichedLoans,
    asOfDate,
    prevBucketMap,
    lastRealPaymentMap,
    hasRepaymentsFile,
    prevDate: prevSnap?.snapshot_date ?? null,
    policy,
  });

  return {
    entityId: entity.id,
    entityCode: entity.code,
    snapshotId: currentSnap.id,
    asOfDate,
    plan,
    resumen,
    policy,
    batch,
  };
}

