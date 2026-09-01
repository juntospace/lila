// Snapshot synchronization into Supabase tables for Banco General (CCBG v2) in Edge Function.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { BgAssignmentCategory, BgReconciliationSnapshot } from "./types.ts";

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
    succeeded_rows_count: b.succeededRowsCount,
    total_amount_minor: b.totalAmount != null ? BigInt(Math.round(b.totalAmount * 100)) : null,
    rejected_amount_minor: b.rejectedAmount != null ? BigInt(Math.round(b.rejectedAmount * 100)) : null,
    succeeded_amount_minor: b.succeededAmount != null ? BigInt(Math.round(b.succeededAmount * 100)) : null,
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

  const { data: existingBatches } = await supabase
    .from("recon_bg_batches")
    .select("batch_uid, is_active")
    .eq("account_id", accountId)
    .eq("is_active", true);

  if (existingBatches) {
    const toDeactivate = existingBatches
      .filter((b) => !activeBatchUids.has(b.batch_uid))
      .map((b) => b.batch_uid);

    if (toDeactivate.length > 0) {
      await supabase
        .from("recon_bg_batches")
        .update({ is_active: false })
        .eq("account_id", accountId)
        .in("batch_uid", toDeactivate);
    }
  }

  // 3. Sync Yappy Batches & Lines
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

  const { data: existingYappyBatches } = await supabase
    .from("recon_bg_yappy_batches")
    .select("batch_uid")
    .eq("account_id", accountId)
    .eq("is_active", true);

  if (existingYappyBatches) {
    const toDeactivate = existingYappyBatches
      .filter((b) => !activeYappyBatchUids.has(b.batch_uid))
      .map((b) => b.batch_uid);

    if (toDeactivate.length > 0) {
      await supabase
        .from("recon_bg_yappy_batches")
        .update({ is_active: false })
        .eq("account_id", accountId)
        .in("batch_uid", toDeactivate);
    }
  }

  // 4. Sync Yappy Lines
  const yappyLineInserts = snapshot.yappyPayments.map((yp) => ({
    account_id: accountId,
    line_uid: yp.uid,
    batch_uid: yp.batchUid,
    payment_date: yp.date,
    payment_time: yp.time,
    reference: yp.reference,
    client_name: yp.clientName,
    phone_number: yp.phoneNumber,
    comment: yp.comment,
    amount_minor: BigInt(Math.round(yp.amount * 100)),
    bank_status: yp.bankStatus,
    status: yp.status,
    settlement_date: yp.settlementDate,
  }));

  for (let i = 0; i < yappyLineInserts.length; i += CHUNK_SIZE) {
    const chunk = yappyLineInserts.slice(i, i + CHUNK_SIZE);
    await supabase
      .from("recon_bg_yappy_lines")
      .upsert(chunk, { onConflict: "account_id,line_uid" });
  }

  // 5. Sync Pending Tasks
  await supabase
    .from("recon_bg_pending_tasks")
    .delete()
    .eq("account_id", accountId);

  const pendingTaskInserts = snapshot.pendingTasks.map((pt) => ({
    account_id: accountId,
    task_type: pt.taskType,
    missing_item: pt.missingItem,
    details: pt.details,
    affects_uid: pt.affectsUid,
    amount_minor: pt.amount != null ? BigInt(Math.round(pt.amount * 100)) : null,
    is_resolved: false,
  }));

  for (let i = 0; i < pendingTaskInserts.length; i += CHUNK_SIZE) {
    const chunk = pendingTaskInserts.slice(i, i + CHUNK_SIZE);
    await supabase.from("recon_bg_pending_tasks").insert(chunk);
  }

  // 6. Sync Audit Alerts
  await supabase
    .from("recon_bg_audit_alerts")
    .delete()
    .eq("account_id", accountId);

  const alertInserts = snapshot.alerts.map((al) => {
    let severity: "info" | "warning" | "error" = "info";
    if (al.includes("[ANOMALIA]") || al.includes("[CONFLICTO DE SNAPSHOT]")) {
      severity = "error";
    } else if (
      al.includes("[REINTENTO]") ||
      al.includes("[CADENA DE SALDO]") ||
      al.includes("[ASIGNACION SIN DESTINO]")
    ) {
      severity = "warning";
    }

    return {
      account_id: accountId,
      severity,
      alert_message: al,
    };
  });

  for (let i = 0; i < alertInserts.length; i += CHUNK_SIZE) {
    const chunk = alertInserts.slice(i, i + CHUNK_SIZE);
    await supabase.from("recon_bg_audit_alerts").insert(chunk);
  }

  return {
    batchesUpserted: batchInserts.length,
    yappyBatchesUpserted: yappyBatchInserts.length,
    yappyLinesUpserted: yappyLineInserts.length,
    coverageDaysUpserted: coverageInserts.length,
    pendingTasksUpserted: pendingTaskInserts.length,
    alertsUpserted: alertInserts.length,
  };
}

export async function fetchManualAssignments(
  supabase: SupabaseClient,
  accountId: string,
): Promise<Map<string, { category: BgAssignmentCategory; notes: string | null }>> {
  const { data } = await supabase
    .from("recon_manual_assignments")
    .select("target_uid, category, notes")
    .eq("account_id", accountId);

  const map = new Map<string, { category: BgAssignmentCategory; notes: string | null }>();
  if (data) {
    for (const row of data) {
      map.set(row.target_uid, {
        category: row.category as BgAssignmentCategory,
        notes: row.notes,
      });
    }
  }
  return map;
}

