// Formatters and translations (English <-> Spanish) for Banco General reconciliation in Edge Function.

import type {
  BgAssignmentCategory,
  BgBatchStatus,
  BgIncomingStatus,
  BgItemStatus,
  BgPendingTaskType,
  BgReconciliationSnapshot,
  BgSuggestion,
  BgYappyStatus,
} from "./types.ts";

export const BG_BATCH_STATUS_MAP: Record<
  BgBatchStatus,
  { labelEs: string; labelEn: string; variant: "success" | "warning" | "danger" }
> = {
  settled: { labelEs: "LIQUIDADA", labelEn: "Settled", variant: "success" },
  settled_no_reversals: {
    labelEs: "LIQUIDADA SIN RECHAZOS",
    labelEn: "Settled (No Reversals)",
    variant: "success",
  },
  pending: { labelEs: "PENDIENTE", labelEn: "Pending", variant: "warning" },
  anomaly: { labelEs: "ANOMALÍA", labelEn: "Anomaly", variant: "danger" },
};

export const BG_ITEM_STATUS_MAP: Record<
  BgItemStatus,
  { labelEs: string; labelEn: string; variant: "success" | "warning" | "danger" }
> = {
  rejected: { labelEs: "RECHAZADO", labelEn: "Rejected", variant: "danger" },
  confirmed: { labelEs: "CONFIRMADO", labelEn: "Confirmed", variant: "success" },
  pending: { labelEs: "PENDIENTE", labelEn: "Pending", variant: "warning" },
};

export const BG_YAPPY_STATUS_MAP: Record<
  BgYappyStatus,
  { labelEs: string; labelEn: string; variant: "success" | "warning" | "danger" | "info" | "neutral" }
> = {
  received: { labelEs: "RECIBIDO", labelEn: "Received", variant: "success" },
  in_transit: { labelEs: "EN TRÁNSITO", labelEn: "In Transit", variant: "info" },
  pending: { labelEs: "PENDIENTE", labelEn: "Pending", variant: "warning" },
  anomaly: { labelEs: "ANOMALÍA", labelEn: "Anomaly", variant: "danger" },
  other: { labelEs: "OTRO", labelEn: "Other", variant: "neutral" },
};

export const BG_INCOMING_STATUS_MAP: Record<
  BgIncomingStatus,
  { labelEs: string; labelEn: string; variant: "success" | "warning" | "neutral" }
> = {
  received: { labelEs: "RECIBIDO", labelEn: "Received", variant: "success" },
  unassigned: { labelEs: "SIN ASIGNAR", labelEn: "Unassigned", variant: "warning" },
  non_loan: { labelEs: "NO PRÉSTAMO", labelEn: "Non-Loan", variant: "neutral" },
};

export const BG_CATEGORY_MAP: Record<
  BgAssignmentCategory,
  { labelEs: string; labelEn: string }
> = {
  loan: { labelEs: "PRESTAMO", labelEn: "Loan" },
  non_loan: { labelEs: "NO_PRESTAMO", labelEn: "Non-Loan" },
  other: { labelEs: "OTRO", labelEn: "Other" },
};

export const BG_SUGGESTION_MAP: Record<
  BgSuggestion,
  { labelEs: string; labelEn: string }
> = {
  loan: { labelEs: "PRESTAMO", labelEn: "Loan" },
  loan_probable: { labelEs: "PRESTAMO_PROBABLE", labelEn: "Probable Loan" },
};

export const BG_PENDING_TASK_TYPE_MAP: Record<
  BgPendingTaskType,
  { labelEs: string; labelEn: string }
> = {
  missing_statement: { labelEs: "FALTA_EXTRACTO", labelEn: "Missing Statement" },
  missing_ach_detail: { labelEs: "FALTA_DETALLE", labelEn: "Missing ACH Detail" },
  missing_yappy_report: { labelEs: "FALTA_REPORTE_YAPPY", labelEn: "Missing Yappy Report" },
};

export function toSpanishBatchStatus(status: BgBatchStatus): string {
  return BG_BATCH_STATUS_MAP[status]?.labelEs || status;
}

export function toEnglishBatchStatus(status: BgBatchStatus): string {
  return BG_BATCH_STATUS_MAP[status]?.labelEn || status;
}

export function toSpanishItemStatus(status: BgItemStatus): string {
  return BG_ITEM_STATUS_MAP[status]?.labelEs || status;
}

export function toEnglishItemStatus(status: BgItemStatus): string {
  return BG_ITEM_STATUS_MAP[status]?.labelEn || status;
}

export function toSpanishYappyStatus(status: BgYappyStatus): string {
  return BG_YAPPY_STATUS_MAP[status]?.labelEs || status;
}

export function toEnglishYappyStatus(status: BgYappyStatus): string {
  return BG_YAPPY_STATUS_MAP[status]?.labelEn || status;
}

export function toSpanishIncomingStatus(status: BgIncomingStatus): string {
  return BG_INCOMING_STATUS_MAP[status]?.labelEs || status;
}

export function toEnglishIncomingStatus(status: BgIncomingStatus): string {
  return BG_INCOMING_STATUS_MAP[status]?.labelEn || status;
}

export function toSpanishCategory(cat: BgAssignmentCategory | null): string | null {
  if (!cat) return null;
  return BG_CATEGORY_MAP[cat]?.labelEs || cat;
}

export function toEnglishCategory(cat: BgAssignmentCategory | null): string | null {
  if (!cat) return null;
  return BG_CATEGORY_MAP[cat]?.labelEn || cat;
}

export function toSpanishSuggestion(sug: BgSuggestion | null): string | null {
  if (!sug) return null;
  return BG_SUGGESTION_MAP[sug]?.labelEs || sug;
}

export function toEnglishSuggestion(sug: BgSuggestion | null): string | null {
  if (!sug) return null;
  return BG_SUGGESTION_MAP[sug]?.labelEn || sug;
}

export function toSpanishTaskType(type: BgPendingTaskType): string {
  return BG_PENDING_TASK_TYPE_MAP[type]?.labelEs || type;
}

export function toEnglishTaskType(type: BgPendingTaskType): string {
  return BG_PENDING_TASK_TYPE_MAP[type]?.labelEn || type;
}

export function toCanonicalJsonContract(snap: BgReconciliationSnapshot): Record<string, unknown> {
  return {
    version: snap.version,
    generated_from: snap.generatedFrom,
    cuenta: snap.accountNumber,
    empresa: snap.companyName,
    period: snap.period,
    coverage_days: snap.coverageDays,
    reporte_yappy_rango: snap.yappyReportRange,
    batches: snap.batches.map((b) => ({
      uid: b.uid,
      lote: b.batchName,
      fecha_lote: b.batchDateStr,
      canal: b.channel,
      quincena: b.fortnight,
      morosos: b.isDelinquent,
      reintento: b.retryCount,
      variante: b.variant,
      fecha_efectiva: b.effectiveDate,
      fecha_credito: b.creditDate,
      transacciones: b.totalTransactions,
      realizadas: b.succeededTransactions,
      rechazadas_declaradas: b.declaredRejectedTransactions,
      rechazos_filas: b.rejectedRowsCount,
      monto_total: b.totalAmount,
      monto_rechazado: b.rejectedAmount,
      monto_realizado: b.succeededAmount,
      realizadas_filas: b.succeededRowsCount,
      monto_realizado_itemizado: b.itemizedSucceededAmount ?? null,
      estado: toSpanishBatchStatus(b.status).replace(/\s+/g, "_"),
      motivo_pendiente: b.pendingReason,
      credito_mov: b.creditMovUid,
      reversas_mov: b.reversalsMovUids,
      archivo_detalle: b.detailFilename,
    })),
    items: snap.items.map((i) => ({
      uid: i.uid,
      tipo: i.itemType,
      lote_uid: i.batchUid,
      lote: i.batchName,
      fecha_efectiva: i.effectiveDate,
      canal_lote: i.batchChannel,
      reintento: i.retryCount,
      ruta: i.routingCode,
      cuenta_cliente: i.clientAccountNumber,
      id_cliente: i.clientId,
      nombre: i.clientName,
      monto: i.amount,
      estado: toSpanishItemStatus(i.status),
      motivo: i.reasonCode,
      motivo_descripcion: i.reasonDescription,
      addenda: i.addenda,
      archivo: i.sourceFilename,
    })),
    yappy_lotes: snap.yappyBatches.map((yb) => ({
      uid: yb.uid,
      fecha_credito: yb.creditDate,
      fecha_transacciones: yb.transactionDate,
      n_declarado: yb.declaredCount,
      n_reporte: yb.reportCount,
      monto_credito: yb.creditAmount,
      monto_reporte: yb.reportAmount,
      comision: yb.feeAmount,
      tasa_comision: yb.feeRate,
      estado: toSpanishBatchStatus(yb.status),
      motivo_pendiente: yb.pendingReason,
      credito_mov: yb.creditMovUid,
    })),
    yappy: snap.yappyPayments.map((yp) => ({
      uid: yp.uid,
      fecha: yp.date,
      hora: yp.time,
      referencia: yp.reference,
      cliente: yp.clientName,
      celular: yp.phoneNumber,
      comentario: yp.comment,
      monto: yp.amount,
      estado_banco: yp.bankStatus,
      estado: toSpanishYappyStatus(yp.status).replace(/\s+/g, "_"),
      lote_uid: yp.batchUid,
      fecha_liquidacion: yp.settlementDate,
    })),
    incoming: snap.incoming.map((inc) => ({
      uid: inc.uid,
      mov_uid: inc.movUid,
      tipo: inc.paymentType,
      fecha: inc.date,
      canal: inc.channel,
      contraparte: inc.counterpart,
      referencia_transferencia: inc.transferReference,
      referencia_pago: inc.paymentReference,
      ref_prestamo_detectada: inc.detectedLoanRef,
      descripcion: inc.description,
      monto: inc.amount,
      estado: toSpanishIncomingStatus(inc.status).replace(/\s+/g, "_"),
      categoria: toSpanishCategory(inc.category),
      sugerencia: toSpanishSuggestion(inc.suggestion),
      nota_asignacion: inc.assignmentNotes,
    })),
    otros_debitos: snap.otherDebits.map((od) => ({
      uid: od.uid,
      fecha: od.date,
      categoria: od.category,
      monto: od.amount,
      descripcion: od.description,
      referencia_pago: od.paymentReference,
    })),
    pendientes: snap.pendingTasks.map((pt) => ({
      tipo: toSpanishTaskType(pt.taskType),
      que_falta: pt.missingItem,
      detalle: pt.details,
      afecta: pt.affectsUid,
      monto: pt.amount,
    })),
    alerts: snap.alerts,
    controls: {
      archivos_leidos: snap.controls.filesReadCount,
      dias_cubiertos: snap.controls.coveredDaysCount,
      dias_en_cuarentena: snap.controls.quarantinedDays,
      cobertura_provisional: snap.controls.provisionalCoverageDays,
      lotes_total: snap.controls.totalBatchesCount,
      lotes_liquidados_al_centavo: snap.controls.settledBatchesCount,
      yappy_lotes_total: snap.controls.totalYappyBatchesCount,
      yappy_lotes_cuadrados: snap.controls.settledYappyBatchesCount,
      conservacion_lotes: snap.controls.batchesConservation,
      ingresos_n: snap.controls.incomingCount,
      ingresos_monto: snap.controls.incomingTotalAmount,
      sin_asignar_n: snap.controls.unassignedCount,
      sin_asignar_monto: snap.controls.unassignedTotalAmount,
      por_asignar_n: snap.controls.pendingAssignmentCount,
      por_asignar_monto: snap.controls.pendingAssignmentTotalAmount,
    },
    respuestas_otras_cuentas: snap.otherAccountResponses.map((oar) => ({
      archivo: oar.filename,
      cuenta: oar.accountNumber,
      titular: oar.holderName,
      fecha_efectiva: oar.effectiveDate,
      transacciones: oar.totalTransactions,
      realizadas: oar.succeededTransactions,
      rechazadas: oar.rejectedTransactions,
      monto_total: oar.totalAmount,
      filas: oar.rows.map((r) => ({
        id_cliente: r.clientId,
        nombre: r.clientName,
        cuenta_cliente: r.clientAccountNumber,
        monto: r.amount,
        estado: r.status,
        motivo: r.reasonCode,
        motivo_descripcion: r.reasonDescription,
      })),
    })),
  };
}

