// Snapshot synchronization into Supabase tables for Banco General (CCBG v2).
// Implements idempotent upserts and snapshot soft-delete (is_active = false).

import type { SupabaseClient } from "@supabase/supabase-js";

import type { BgAssignmentCategory, BgReconciliationSnapshot } from "./types";

export interface SyncSnapshotResult {
  batchesUpserted: number;
  yappyBatchesUpserted: number;
  yappyLinesUpserted: number;
  coverageDaysUpserted: number;
  pendingTasksUpserted: number;
  alertsUpserted: number;
}

export async function syncSnapshotToDatabase(
  supabase: SupabaseClient,
  accountId: string,
  snapshot: BgReconciliationSnapshot,
): Promise<SyncSnapshotResult> {
  const CHUNK_SIZE = 500;

  // 1. Sync Coverage
  const allCoverageDates = Array.from(
    new Set([
      ...snapshot.coverageDays,
      ...snapshot.controls.quarantinedDays,
      ...snapshot.controls.provisionalCoverageDays,
    ]),
  );

  const coverageInserts = allCoverageDates.map((dateStr) => ({
    account_id: accountId,
    coverage_date: dateStr,
    is_provisional: snapshot.controls.provisionalCoverageDays.includes(dateStr),
    is_quarantined: snapshot.controls.quarantinedDays.includes(dateStr),
    source_filenames: snapshot.generatedFrom,
  }));

  for (let i = 0; i < coverageInserts.length; i += CHUNK_SIZE) {
    const chunk = coverageInserts.slice(i, i + CHUNK_SIZE);
    await supabase
      .from("recon_bg_coverage")
      .upsert(chunk, { onConflict: "account_id,coverage_date" });
  }

  // 2. Sync ACH Batches
  const activeBatchUids = new Set(snapshot.batches.map((b) => b.uid));
  const batchInserts = snapshot.batches.map((b) => ({
    account_id: accountId,
    batch_uid: b.uid,
    batch_date_str: b.batchDateStr,
    batch_filename: b.detailFilename,
    channel: b.channel,
    fortnight: b.fortnight,
    is_delinquent: b.isDelinquent,
    retry_count: b.retryCount,
    variant: b.variant,
    effective_date: b.effectiveDate,
    credit_date: b.creditDate,
    total_transactions: b.totalTransactions,
    succeeded_transactions: b.succeededTransactions,
    declared_rejected_transactions: b.declaredRejectedTransactions,
    rejected_rows_count: b.rejectedRowsCount,
    succeeded_rows_count: b.succeededRowsCount ?? 0,
    total_amount_minor: b.totalAmount != null ? BigInt(Math.round(b.totalAmount * 100)) : null,
    rejected_amount_minor: b.rejectedAmount != null ? BigInt(Math.round(b.rejectedAmount * 100)) : null,
    succeeded_amount_minor: b.succeededAmount != null ? BigInt(Math.round(b.succeededAmount * 100)) : null,
    itemized_succeeded_amount_minor:
      b.itemizedSucceededAmount != null
        ? BigInt(Math.round(b.itemizedSucceededAmount * 100))
        : null,
    status: b.status,
    pending_reason: b.pendingReason,
    credit_mov_uid: b.creditMovUid,
    reversals_mov_uids: b.reversalsMovUids,
    is_active: true,
  }));

  for (let i = 0; i < batchInserts.length; i += CHUNK_SIZE) {
    const chunk = batchInserts.slice(i, i + CHUNK_SIZE);
    await supabase
      .from("recon_bg_batches")
      .upsert(chunk, { onConflict: "account_id,batch_uid" });
  }

  // Soft-delete inactive batches (e.g. provisional batches replaced by detail)
  if (activeBatchUids.size > 0) {
    const { data: existingBatches } = await supabase
      .from("recon_bg_batches")
      .select("batch_uid")
      .eq("account_id", accountId)
      .eq("is_active", true);

    const uidsToDeactivate = (existingBatches || [])
      .map((row) => row.batch_uid as string)
      .filter((uid) => !activeBatchUids.has(uid));

    if (uidsToDeactivate.length > 0) {
      await supabase
        .from("recon_bg_batches")
        .update({ is_active: false })
        .eq("account_id", accountId)
        .in("batch_uid", uidsToDeactivate);
    }
  }

  // 3. Sync Yappy Batches
  const activeYappyBatchUids = new Set(snapshot.yappyBatches.map((yb) => yb.uid));
  const yappyBatchInserts = snapshot.yappyBatches.map((yb) => ({
    account_id: accountId,
    batch_uid: yb.uid,
    credit_date: yb.creditDate,
    transaction_date: yb.transactionDate,
    declared_count: yb.declaredCount,
    report_count: yb.reportCount,
    credit_amount_minor: BigInt(Math.round(yb.creditAmount * 100)),
    report_amount_minor: yb.reportAmount != null ? BigInt(Math.round(yb.reportAmount * 100)) : null,
    fee_amount_minor: yb.feeAmount != null ? BigInt(Math.round(yb.feeAmount * 100)) : null,
    fee_rate: yb.feeRate,
    status: yb.status,
    pending_reason: yb.pendingReason,
    credit_mov_uid: yb.creditMovUid,
    is_active: true,
  }));

  for (let i = 0; i < yappyBatchInserts.length; i += CHUNK_SIZE) {
    const chunk = yappyBatchInserts.slice(i, i + CHUNK_SIZE);
    await supabase
      .from("recon_bg_yappy_batches")
      .upsert(chunk, { onConflict: "account_id,batch_uid" });
  }

  // Soft-delete inactive Yappy batches
  if (activeYappyBatchUids.size > 0) {
    const { data: existingYappyBatches } = await supabase
      .from("recon_bg_yappy_batches")
      .select("batch_uid")
      .eq("account_id", accountId)
      .eq("is_active", true);

    const uidsToDeactivate = (existingYappyBatches || [])
      .map((row) => row.batch_uid as string)
      .filter((uid) => !activeYappyBatchUids.has(uid));

    if (uidsToDeactivate.length > 0) {
      await supabase
        .from("recon_bg_yappy_batches")
        .update({ is_active: false })
        .eq("account_id", accountId)
        .in("batch_uid", uidsToDeactivate);
    }
  }

  // 4. Sync Yappy Lines
  const yappyLineInserts = snapshot.yappyPayments.map((yp) => ({
    account_id: accountId,
    line_uid: yp.uid,
    posted_date: yp.date,
    posted_time: yp.time,
    reference: yp.reference,
    client_name: yp.clientName,
    phone_number: yp.phoneNumber,
    comment: yp.comment,
    amount_minor: yp.amountMinor,
    bank_status: yp.bankStatus,
    status: yp.status,
    settlement_batch_uid: yp.batchUid,
    settlement_date: yp.settlementDate,
    is_active: true,
  }));

  for (let i = 0; i < yappyLineInserts.length; i += CHUNK_SIZE) {
    const chunk = yappyLineInserts.slice(i, i + CHUNK_SIZE);
    await supabase
      .from("recon_bg_yappy_lines")
      .upsert(chunk, { onConflict: "account_id,line_uid" });
  }

  // 5. Replace Pending Tasks
  await supabase
    .from("recon_bg_pending_tasks")
    .delete()
    .eq("account_id", accountId);

  const pendingInserts = snapshot.pendingTasks.map((pt) => ({
    account_id: accountId,
    task_type: pt.taskType,
    missing_item: pt.missingItem,
    details: pt.details,
    affects_uid: pt.affectsUid,
    amount_minor: pt.amount != null ? BigInt(Math.round(pt.amount * 100)) : null,
    is_resolved: false,
  }));

  for (let i = 0; i < pendingInserts.length; i += CHUNK_SIZE) {
    const chunk = pendingInserts.slice(i, i + CHUNK_SIZE);
    await supabase.from("recon_bg_pending_tasks").insert(chunk);
  }

  // 6. Replace Audit Alerts
  await supabase
    .from("recon_bg_audit_alerts")
    .delete()
    .eq("account_id", accountId);

  const alertInserts = snapshot.alerts.map((msg) => ({
    account_id: accountId,
    message: msg,
    severity: msg.includes("ANOMALIA") || msg.includes("CONFLICTO") ? "error" : "warn",
  }));

  for (let i = 0; i < alertInserts.length; i += CHUNK_SIZE) {
    const chunk = alertInserts.slice(i, i + CHUNK_SIZE);
    await supabase.from("recon_bg_audit_alerts").insert(chunk);
  }

  return {
    batchesUpserted: batchInserts.length,
    yappyBatchesUpserted: yappyBatchInserts.length,
    yappyLinesUpserted: yappyLineInserts.length,
    coverageDaysUpserted: coverageInserts.length,
    pendingTasksUpserted: pendingInserts.length,
    alertsUpserted: alertInserts.length,
  };
}

/** Fetches manual assignments for an account from the database. */
export async function fetchManualAssignments(
  supabase: SupabaseClient,
  accountId: string,
): Promise<Map<string, { category: BgAssignmentCategory; notes: string | null }>> {
  const { data, error } = await supabase
    .from("recon_manual_assignments")
    .select("target_uid, category, notes")
    .eq("account_id", accountId);

  const map = new Map<string, { category: BgAssignmentCategory; notes: string | null }>();
  if (error || !data) return map;

  for (const row of data) {
    map.set(row.target_uid, {
      category: row.category as BgAssignmentCategory,
      notes: row.notes || null,
    });
  }
  return map;
}

