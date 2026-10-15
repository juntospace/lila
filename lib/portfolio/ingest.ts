// Idempotent Ingestion Pipeline for LoanDisk Backups into Supabase
// Ensures byte-level parity, cleans up previous runs of the same date,
// and computes core risk rollups.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  enrichLoans,
  enrichRepayments,
  HANDOVER_DATE,
} from "./enrich";

export interface IngestOptions {
  entityCode?: string;
  snapshotDate: string; // YYYY-MM-DD
  loansRaw: Record<string, string>[];
  repaymentsRaw: Record<string, string>[];
  sourceFiles?: Record<string, unknown>;
}

export interface IngestResult {
  snapshotId: string;
  entityId: string;
  snapshotDate: string;
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
}

const BATCH_SIZE_LOANS = 500;
const BATCH_SIZE_REPAYMENTS = 1000;

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
  } = options;

  // 1. Resolve entity
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

  // 2. Resolve policy
  const { data: policy } = await supabase
    .from("portfolio_policy")
    .select("id, handover_date")
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  const handoverCutoff = policy?.handover_date || HANDOVER_DATE;

  // 3. Enrich loans and repayments
  const enrichedLoans = enrichLoans(loansRaw);
  const { repayments: enrichedRepayments, futureExcludedCount } = enrichRepayments(
    repaymentsRaw,
    snapshotDate,
  );

  // 4. Compute Rollup KPIs
  let totalOpenBalance = 0;
  let totalOpenLoans = 0;
  let cer30Balance = 0;
  let cer90Balance = 0;
  let cashAheadCount = 0;

  for (const loan of enrichedLoans) {
    if (loan.cashAhead) {
      cashAheadCount++;
    }
    if (loan.isOpen) {
      totalOpenLoans++;
      totalOpenBalance += loan.balance;
      if (loan.bucketIdx >= 2) {
        // DPD > 30 (tramos 1-30 is idx 1, 31-60 is idx 2)
        cer30Balance += loan.balance;
      }
      if (loan.bucketIdx >= 4) {
        // DPD > 90 (tramos 91-180 is idx 4)
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

  let totalCollectedHandover = 0;
  for (const rep of enrichedRepayments) {
    if (rep.isReal && rep.collectionDate >= handoverCutoff) {
      totalCollectedHandover += rep.principalAmount + rep.ingresosAmount;
    }
  }
  totalCollectedHandover = Math.round(totalCollectedHandover * 100) / 100;

  // 5. Upsert snapshot master (Idempotent per entity + snapshotDate)
  const { data: snapshotRow, error: snapErr } = await supabase
    .from("portfolio_snapshots")
    .upsert(
      {
        entity_id: entityId,
        snapshot_date: snapshotDate,
        as_of_date: snapshotDate,
        policy_id: policy?.id ?? null,
        total_open_balance: totalOpenBalance,
        total_open_loans: totalOpenLoans,
        cer30_balance: cer30Balance,
        cer30_percentage: cer30Percentage,
        cer90_balance: cer90Balance,
        cer90_percentage: cer90Percentage,
        total_collected_handover: totalCollectedHandover,
        cash_ahead_count: cashAheadCount,
        future_payments_excluded_count: futureExcludedCount,
        source_files: sourceFiles,
        status: "completed",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "entity_id,snapshot_date" },
    )
    .select("id")
    .single();

  if (snapErr || !snapshotRow) {
    throw new Error(`Failed to upsert snapshot: ${snapErr?.message}`);
  }
  const snapshotId = snapshotRow.id;

  // 6. Delete previous loans and repayments for this snapshot to avoid duplicate rows
  await supabase
    .from("portfolio_loans")
    .delete()
    .eq("snapshot_id", snapshotId);

  await supabase
    .from("portfolio_loan_repayments")
    .delete()
    .eq("snapshot_id", snapshotId);

  // 7. Insert loans in batches
  for (let i = 0; i < enrichedLoans.length; i += BATCH_SIZE_LOANS) {
    const chunk = enrichedLoans.slice(i, i + BATCH_SIZE_LOANS);
    const rowsToInsert = chunk.map((l) => ({
      snapshot_id: snapshotId,
      entity_id: entityId,
      snapshot_date: snapshotDate,
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

    const { error: loanErr } = await supabase
      .from("portfolio_loans")
      .insert(rowsToInsert);

    if (loanErr) {
      throw new Error(`Failed inserting loans chunk at ${i}: ${loanErr.message}`);
    }
  }

  // 8. Insert repayments in batches
  for (let i = 0; i < enrichedRepayments.length; i += BATCH_SIZE_REPAYMENTS) {
    const chunk = enrichedRepayments.slice(i, i + BATCH_SIZE_REPAYMENTS);
    const rowsToInsert = chunk.map((r) => ({
      snapshot_id: snapshotId,
      entity_id: entityId,
      snapshot_date: snapshotDate,
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

    const { error: repErr } = await supabase
      .from("portfolio_loan_repayments")
      .insert(rowsToInsert);

    if (repErr) {
      throw new Error(`Failed inserting repayments chunk at ${i}: ${repErr.message}`);
    }
  }

  return {
    snapshotId,
    entityId,
    snapshotDate,
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
  };
}

