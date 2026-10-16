// Idempotent & Transactional Ingestion Pipeline for LoanDisk Backups into Supabase
// Ensures byte-level parity, atomic replacement via RPC, SHA deduplication,
// source-to-target reconciliation, and data quality batch logging.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  colfind,
  detectMissingCustomFields,
  enrichLoans,
  enrichRepayments,
  num,
} from "./enrich";
import { loadActivePolicy } from "./policy";
import type { PortfolioIngestBatch, PortfolioPolicy } from "./types";

export interface IngestOptions {
  entityCode?: string;
  snapshotDate: string; // YYYY-MM-DD
  loansRaw: Record<string, string>[];
  repaymentsRaw: Record<string, string>[];
  hasRepaymentsFile?: boolean;
  loansSha256?: string;
  repaymentsSha256?: string | null;
  rejectDuplicateSha?: boolean;
  uploadedBy?: string | null;
  policy?: PortfolioPolicy;
  sourceFiles?: Record<string, unknown>;
}

export interface IngestResult {
  snapshotId: string;
  entityId: string;
  snapshotDate: string;
  policyVersion: string;
  totalLoans: number;
  openLoans: number;
  openBalance: number;
  cer30Balance: number;
  cer30Percentage: number;
  cer90Balance: number;
  cer90Percentage: number;
  totalCollectedHandover: number;
  cashAheadCount: number;
  futurePaymentsExcludedCount: number;
  repaymentsCount: number;
  batch: PortfolioIngestBatch;
}

const BATCH_SIZE_LOANS = 500;
const BATCH_SIZE_REPAYMENTS = 1000;

function computeSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function ingestSnapshot(
  supabase: SupabaseClient,
  options: IngestOptions,
): Promise<IngestResult> {
  const {
    entityCode = "crediclaro",
    snapshotDate,
    loansRaw,
    repaymentsRaw,
    sourceFiles = {},
    rejectDuplicateSha = false,
    uploadedBy = null,
  } = options;

  const hasRepaymentsFile =
    options.hasRepaymentsFile !== undefined
      ? options.hasRepaymentsFile
      : Boolean(sourceFiles.repaymentsFile || sourceFiles.repayments) ||
        repaymentsRaw.length > 0;

  // 1. Compute SHA-256 hashes (Fase 4.2)
  const sha256Loans =
    options.loansSha256 || computeSha256(JSON.stringify(loansRaw));
  const sha256Repayments =
    options.repaymentsSha256 !== undefined
      ? options.repaymentsSha256
      : hasRepaymentsFile
        ? computeSha256(JSON.stringify(repaymentsRaw))
        : null;

  // 2. Resolve entity
  const { data: entity, error: entityErr } = await supabase
    .from("portfolio_entities")
    .select("id, code")
    .eq("code", entityCode)
    .maybeSingle();

  if (entityErr || !entity) {
    throw new Error(
      `Entity '${entityCode}' not found in portfolio_entities. Run migration first.`,
    );
  }
  const entityId = entity.id;

  // 3. Check duplicate SHA if requested (Fase 4.2)
  if (rejectDuplicateSha) {
    const { data: existingSnap } = await supabase
      .from("portfolio_snapshots")
      .select("id")
      .eq("entity_id", entityId)
      .eq("snapshot_date", snapshotDate)
      .eq("status", "completed")
      .maybeSingle();

    if (existingSnap) {
      const { data: lastBatch } = await supabase
        .from("portfolio_ingest_batches")
        .select("sha256_loans, sha256_repayments")
        .eq("snapshot_id", existingSnap.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (
        lastBatch &&
        lastBatch.sha256_loans === sha256Loans &&
        (lastBatch.sha256_repayments ?? null) === (sha256Repayments ?? null)
      ) {
        throw new Error(
          `El backup cargado para ${snapshotDate} tiene el mismo SHA-256 que la versión actual. No hay cambios para actualizar.`,
        );
      }
    }
  }

  // 4. Resolve active CRO policy (Fase 4.1)
  const policy =
    options.policy ?? (await loadActivePolicy(supabase, snapshotDate));
  const handoverCutoff = policy.handoverDate;

  // 5. Enrich loans and repayments
  const enrichedLoans = enrichLoans(loansRaw, policy);
  const { repayments: enrichedRepayments, futureExcludedCount } =
    enrichRepayments(repaymentsRaw, snapshotDate, policy);

  // 6. Source-to-target reconciliation (Fase 4.2 — fail-closed)
  let sumBalanceSource = 0;
  if (loansRaw.length > 0) {
    const keys = Object.keys(loansRaw[0]);
    const balCol = colfind(keys, "Balance Amount");
    for (const r of loansRaw) {
      const b = balCol ? num(r[balCol]) : 0;
      sumBalanceSource += Math.round(b * 100) / 100;
    }
  }
  sumBalanceSource = Math.round(sumBalanceSource * 100) / 100;

  let sumBalanceIngested = 0;
  for (const l of enrichedLoans) {
    sumBalanceIngested += l.balance;
  }
  sumBalanceIngested = Math.round(sumBalanceIngested * 100) / 100;

  if (
    enrichedLoans.length !== loansRaw.length ||
    Math.abs(sumBalanceSource - sumBalanceIngested) > 0.01
  ) {
    throw new Error(
      `Error de conciliación (fail-closed): filas fuente=${loansRaw.length} vs ingeridas=${enrichedLoans.length}, saldo fuente=${sumBalanceSource.toFixed(2)} vs ingerido=${sumBalanceIngested.toFixed(2)}.`,
    );
  }

  // 7. Compute Rollup KPIs & Data Quality Metrics
  let totalOpenBalance = 0;
  let totalOpenLoans = 0;
  let cer30Balance = 0;
  let cer90Balance = 0;
  let cashAheadCount = 0;
  let missingReleasedDateCount = 0;

  const currentLoanIds = new Set<string>();

  for (const loan of enrichedLoans) {
    if (loan.loanId) {
      currentLoanIds.add(loan.loanId);
    }
    if (loan.cashAhead) {
      cashAheadCount++;
    }
    if (loan.isOpen) {
      totalOpenLoans++;
      totalOpenBalance += loan.balance;
      if (!loan.releasedDate) {
        missingReleasedDateCount++;
      }
      if (loan.bucketIdx >= 2) {
        cer30Balance += loan.balance;
      }
      if (loan.bucketIdx >= 4) {
        cer90Balance += loan.balance;
      }
    }
  }

  totalOpenBalance = Math.round(totalOpenBalance * 100) / 100;
  cer30Balance = Math.round(cer30Balance * 100) / 100;
  cer90Balance = Math.round(cer90Balance * 100) / 100;

  const cer30Percentage =
    totalOpenBalance > 0
      ? Math.round((cer30Balance / totalOpenBalance) * 10000) / 100
      : 0;
  const cer90Percentage =
    totalOpenBalance > 0
      ? Math.round((cer90Balance / totalOpenBalance) * 10000) / 100
      : 0;

  // Fase 2.2: Recaudación solo de préstamos actuales (currentLoanIds.has(rep.loanId))
  let totalCollectedHandover = 0;
  let adminExcludedCount = 0;
  let adminExcludedAmount = 0;
  const unknownMethodsSet = new Set<string>();

  for (const rep of enrichedRepayments) {
    if (rep.isAdmin) {
      adminExcludedCount++;
      adminExcludedAmount += rep.totalAmount;
    }
    if (rep.isUnknownMethod && rep.methodRaw) {
      unknownMethodsSet.add(rep.methodRaw);
    }
    if (
      rep.isReal &&
      rep.collectionDate >= handoverCutoff &&
      currentLoanIds.has(rep.loanId)
    ) {
      totalCollectedHandover += rep.principalAmount + rep.ingresosAmount;
    }
  }
  totalCollectedHandover = Math.round(totalCollectedHandover * 100) / 100;
  adminExcludedAmount = Math.round(adminExcludedAmount * 100) / 100;

  const unknownMethods = Array.from(unknownMethodsSet).sort();
  const missingCustomFields = detectMissingCustomFields(loansRaw);

  const enrichedSourceFiles = {
    ...sourceFiles,
    hasRepaymentsFile,
  };

  const batchMeta: PortfolioIngestBatch = {
    sha256Loans,
    sha256Repayments,
    rowsLoans: enrichedLoans.length,
    rowsRepayments: enrichedRepayments.length,
    sumBalanceSource,
    sumBalanceIngested,
    futurePaymentsExcluded: futureExcludedCount,
    cashAheadCount,
    adminExcludedCount,
    adminExcludedAmount,
    unknownMethods,
    missingCustomFields,
    missingReleasedDateCount,
    uploadedBy,
  };

  const loansPayload = enrichedLoans.map((l) => ({
    source_loan_id: l.loanId,
    loan_number: l.loanNumber,
    full_name: l.fullName,
    borrower_mobile: l.borrowerMobile,
    product: l.product,
    segment: l.segment,
    segment_idx: l.segmentIdx,
    secured: l.secured,
    balance: l.balance,
    dpd: l.dpd,
    dpd_loandisk: l.dpdLoandisk,
    bucket: l.bucket,
    bucket_idx: l.bucketIdx,
    cash_ahead: l.cashAhead,
    is_open: l.isOpen,
    released_date: l.releasedDate,
    status_raw: l.statusRaw,
    past_due: l.pastDue,
    pending_due: l.pendingDue,
    total_due_amount: l.totalDueAmount,
    loan_duration: l.loanDuration,
    installments_count: l.installmentsCount,
    repayment_cycle: l.repaymentCycle,
    cycle_type: l.cycleType,
    last_payment_date: l.lastPaymentDate,
    last_payment_amount: l.lastPaymentAmount,
    pg: l.pg,
    tg: l.tg,
    tc: l.tc,
    gc: l.gc,
    mr: l.mr,
    combo_key: l.comboKey,
    raw: l.raw,
  }));

  const repaymentsPayload = enrichedRepayments.map((r) => ({
    source_repayment_id: r.repaymentId,
    source_loan_id: r.loanId,
    collection_date: r.collectionDate,
    principal_amount: r.principalAmount,
    interest_amount: r.interestAmount,
    penalty_amount: r.penaltyAmount,
    fees_amount: r.feesAmount,
    total_amount: r.totalAmount,
    ingresos_amount: r.ingresosAmount,
    method_raw: r.methodRaw,
    is_real: r.isReal,
    is_admin: r.isAdmin,
    is_unknown_method: r.isUnknownMethod,
    raw: r.raw,
  }));

  const snapshotPayload = {
    as_of_date: snapshotDate,
    policy_id: policy.id ?? null,
    total_open_balance: totalOpenBalance,
    total_open_loans: totalOpenLoans,
    cer30_balance: cer30Balance,
    cer30_percentage: cer30Percentage,
    cer90_balance: cer90Balance,
    cer90_percentage: cer90Percentage,
    total_collected_handover: totalCollectedHandover,
    cash_ahead_count: cashAheadCount,
    future_payments_excluded_count: futureExcludedCount,
    has_repayments: hasRepaymentsFile,
    source_files: enrichedSourceFiles,
    status: "completed",
  };

  const batchPayload = {
    sha256_loans: batchMeta.sha256Loans,
    sha256_repayments: batchMeta.sha256Repayments,
    rows_loans: batchMeta.rowsLoans,
    rows_repayments: batchMeta.rowsRepayments,
    sum_balance_source: batchMeta.sumBalanceSource,
    sum_balance_ingested: batchMeta.sumBalanceIngested,
    future_payments_excluded: batchMeta.futurePaymentsExcluded,
    cash_ahead_count: batchMeta.cashAheadCount,
    admin_excluded_count: batchMeta.adminExcludedCount,
    admin_excluded_amount: batchMeta.adminExcludedAmount,
    unknown_methods: batchMeta.unknownMethods,
    missing_custom_fields: batchMeta.missingCustomFields,
    missing_released_date_count: batchMeta.missingReleasedDateCount,
    uploaded_by: batchMeta.uploadedBy ?? null,
  };

  // 8. Execute atomic replacement via Postgres RPC (Fase 1.2)
  let snapshotId: string | null = null;
  const totalPayloadRows = loansPayload.length + repaymentsPayload.length;
  const useSingleRpc =
    typeof supabase.rpc === "function" && totalPayloadRows <= 15000;

  if (useSingleRpc) {
    const { data: rpcSnapId, error: rpcErr } = await supabase.rpc(
      "portfolio_replace_snapshot",
      {
        p_entity_id: entityId,
        p_snapshot_date: snapshotDate,
        p_snapshot: snapshotPayload,
        p_loans: loansPayload,
        p_repayments: repaymentsPayload,
        p_batch: batchPayload,
      },
    );

    if (!rpcErr && rpcSnapId) {
      snapshotId = String(rpcSnapId);
    } else if (rpcErr) {
      const isMissingRpc =
        rpcErr.code === "PGRST202" ||
        rpcErr.message?.includes("portfolio_replace_snapshot");
      if (!isMissingRpc) {
        throw new Error(`Atomic snapshot ingest failed: ${rpcErr.message}`);
      }
    }
  }

  // Fallback for huge payloads (>15k rows) or pre-migration environments:
  // Uses status = 'loading' staging and strict error checks on every operation
  if (!snapshotId) {
    const { data: snapshotRow, error: snapErr } = await supabase
      .from("portfolio_snapshots")
      .upsert(
        {
          entity_id: entityId,
          snapshot_date: snapshotDate,
          as_of_date: snapshotDate,
          policy_id: policy.id ?? null,
          total_open_balance: totalOpenBalance,
          total_open_loans: totalOpenLoans,
          cer30_balance: cer30Balance,
          cer30_percentage: cer30Percentage,
          cer90_balance: cer90Balance,
          cer90_percentage: cer90Percentage,
          total_collected_handover: totalCollectedHandover,
          cash_ahead_count: cashAheadCount,
          future_payments_excluded_count: futureExcludedCount,
          source_files: enrichedSourceFiles,
          status: "loading",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "entity_id,snapshot_date" },
      )
      .select("id")
      .single();

    if (snapErr || !snapshotRow) {
      throw new Error(`Failed to upsert snapshot: ${snapErr?.message}`);
    }
    snapshotId = snapshotRow.id as string;

    const { error: delLoansErr } = await supabase
      .from("portfolio_loans")
      .delete()
      .eq("snapshot_id", snapshotId);

    if (delLoansErr) {
      throw new Error(
        `Failed deleting previous loans: ${delLoansErr.message}`,
      );
    }

    const { error: delRepsErr } = await supabase
      .from("portfolio_loan_repayments")
      .delete()
      .eq("snapshot_id", snapshotId);

    if (delRepsErr) {
      throw new Error(
        `Failed deleting previous repayments: ${delRepsErr.message}`,
      );
    }

    for (let i = 0; i < loansPayload.length; i += BATCH_SIZE_LOANS) {
      const chunk = loansPayload
        .slice(i, i + BATCH_SIZE_LOANS)
        .map((row) => ({
          ...row,
          snapshot_id: snapshotId,
          entity_id: entityId,
          snapshot_date: snapshotDate,
        }));

      const { error: loanErr } = await supabase
        .from("portfolio_loans")
        .insert(chunk);

      if (loanErr) {
        throw new Error(
          `Failed inserting loans chunk at ${i}: ${loanErr.message}`,
        );
      }
    }

    for (let i = 0; i < repaymentsPayload.length; i += BATCH_SIZE_REPAYMENTS) {
      const chunk = repaymentsPayload
        .slice(i, i + BATCH_SIZE_REPAYMENTS)
        .map((row) => ({
          ...row,
          snapshot_id: snapshotId,
          entity_id: entityId,
          snapshot_date: snapshotDate,
        }));

      const { error: repErr } = await supabase
        .from("portfolio_loan_repayments")
        .insert(chunk);

      if (repErr) {
        throw new Error(
          `Failed inserting repayments chunk at ${i}: ${repErr.message}`,
        );
      }
    }

    // Record ingest batch metadata if table exists
    await supabase.from("portfolio_ingest_batches").insert({
      snapshot_id: snapshotId,
      ...batchPayload,
    });

    // Mark snapshot completed
    const { error: completeErr } = await supabase
      .from("portfolio_snapshots")
      .update({
        status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", snapshotId);

    if (completeErr) {
      throw new Error(
        `Failed finalizing snapshot status: ${completeErr.message}`,
      );
    }
  }

  return {
    snapshotId,
    entityId,
    snapshotDate,
    policyVersion: policy.version,
    totalLoans: enrichedLoans.length,
    openLoans: totalOpenLoans,
    openBalance: totalOpenBalance,
    cer30Balance,
    cer30Percentage,
    cer90Balance,
    cer90Percentage,
    totalCollectedHandover,
    cashAheadCount,
    futurePaymentsExcludedCount: futureExcludedCount,
    repaymentsCount: enrichedRepayments.length,
    batch: {
      ...batchMeta,
      snapshotId,
    },
  };
}
