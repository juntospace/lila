// Deterministic Reconciliation Engine for Banco General · CREDICLARO, S.A. (CCBG v2) in Edge Function.

import type {
  BgAssignmentCategory,
  BgCanonicalMovement,
  BgConsolidatedExtracts,
  BgIncomingStatus,
  BgItemStatus,
  BgOtherAccountResponse,
  BgOtherDebit,
  BgParsedAchDetail,
  BgParsedStatement,
  BgParsedYappyReport,
  BgPendingTask,
  BgReconciledBatch,
  BgReconciledIncoming,
  BgReconciledItem,
  BgReconciledYappyBatch,
  BgReconciliationSnapshot,
  BgReconControls,
  BgSuggestion,
  BgYappyStatus,
  BgYappyTransaction,
} from "./types.ts";
import { areAmountsEqual, round2 } from "./parsers/utils.ts";
import { consolidateStatements } from "./consolidation.ts";

const TOLERANCE = 0.005;
const WORKING_DAYS_WINDOW = 3;
const YAPPY_LAG_DAYS = 1;
const YAPPY_LAG_WINDOW: [number, number] = [0, 2];
const MAX_REVERSAL_PARTS = 4;
const PANAMA_HOLIDAYS: Set<string> = new Set();

const LOAN_KEYWORDS = ["prestamo", "abono", "cuota", "pago", "quincena", "crediclaro", "letra"];
const RE_LOAN_REF = /\b(cap[a-z]{0,4}\s*\d{5,12})\b/i;

const RE_BATCH_CREDIT = /^ACH - CREDICLARO/i;
const RE_REVERSAL = /^REVERSAS POR RECHAZOS ACH\s+(\d{8})/i;
const RE_YAPPY_DEP = /^DEPOSITO YAPPY\b.*?\((\d+)\s+TRANSACCION/i;
const RE_YAPPY_COM = /^COMISION TRANSACCIONES YAPPY/i;
const RE_ACH_XPRESS = /^ACH XPRESS - (.+)$/i;
const RE_ACH_IN = /^ACH - (.+)$/i;
const RE_TRANSF_IN = /^BANCA (EN LINEA|MOVIL) TRANSFERENCIA DE (.+)$/i;
const RE_DATE_REF2 = /(20\d{6})|(\d{2})(\d{2})(20\d{2})/;

function isWorkingDay(dateStr: string): boolean {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayOfWeek = d.getUTCDay();
  return dayOfWeek >= 1 && dayOfWeek <= 5 && !PANAMA_HOLIDAYS.has(dateStr);
}

function addWorkingDays(dateStr: string, daysCount: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  while (daysCount > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (isWorkingDay(iso)) {
      daysCount--;
    }
  }
  return d.toISOString().slice(0, 10);
}

function dateRange(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  const cur = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function isDateRangeCovered(
  coverageDays: Set<string>,
  startStr: string,
  endStr: string,
): { isCovered: boolean; missingDays: string[] } {
  const missing = dateRange(startStr, endStr).filter((d) => !coverageDays.has(d));
  return { isCovered: missing.length === 0, missingDays: missing };
}

function *combinations<T>(arr: T[], maxLen: number): Generator<T[]> {
  const n = arr.length;
  const max = Math.min(maxLen, n);
  function *helper(start: number, combo: T[], k: number): Generator<T[]> {
    if (combo.length === k) {
      yield [...combo];
      return;
    }
    for (let i = start; i < n; i++) {
      combo.push(arr[i]);
      yield* helper(i + 1, combo, k);
      combo.pop();
    }
  }
  for (let k = 1; k <= max; k++) {
    yield* helper(0, [], k);
  }
}

function getBatchToken(detail: { channel?: string | null; fortnight?: number | null; isDelinquent?: boolean }): string {
  const channel = detail.channel || "X";
  const fn = detail.fortnight ? String(detail.fortnight) : "";
  const morosos = detail.isDelinquent ? "M" : "";
  return `${channel}${fn}${morosos}`;
}

function classifyDebits(description: string): string {
  const d = description
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  if (d.includes("TRANSFERENCIA A")) {
    return d.includes("DESEMB") ? "desembolso probable" : "transferencia enviada";
  }
  if (d.startsWith("ACH - ")) {
    return "pago ACH enviado";
  }
  if (
    ["COMISION", "CARGO", "IMPUESTO", "FECI", "ITBMS", "CSS", "ANIP", "MUNICIPIO"].some((k) =>
      d.includes(k),
    )
  ) {
    return "gasto bancario / impuesto";
  }
  if (["ENSA", "IDAAN", "TIGO", "CABLE", "NATURGY"].some((k) => d.includes(k))) {
    return "pago de servicios";
  }
  return "otro débito";
}

function getCounterpartKey(name: string): string {
  const norm = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  const words = norm.split(/\s+/).filter(Boolean);
  return words.slice(0, 3).join(" ");
}

export function isPendingManualAssignment(item: BgReconciledIncoming): boolean {
  return item.category === null && (item.status === "unassigned" || item.suggestion === null);
}

export interface ReconcileOptions {
  expectedAccount?: string | null;
  manualAssignments?: Map<string, { category: BgAssignmentCategory; notes: string | null }>;
}

export function reconcileBancoGeneral(
  statements: BgParsedStatement[],
  achDetails: BgParsedAchDetail[],
  yappyReports: BgParsedYappyReport[],
  options: ReconcileOptions = {},
): BgReconciliationSnapshot {
  const alerts: string[] = [];
  const pendingTasks: BgPendingTask[] = [];

  const consolidated = consolidateStatements(
    statements,
    options.expectedAccount || "03-43-01-106691-6",
    alerts,
  );
  const { movements, coverageDays, provisionalDays, quarantinedDays } = consolidated;

  const batchCredits: BgCanonicalMovement[] = [];
  const reversals: BgCanonicalMovement[] = [];
  const yappyDeposits: BgCanonicalMovement[] = [];
  const yappyCommissions: BgCanonicalMovement[] = [];
  const voluntaryInflows: BgCanonicalMovement[] = [];
  const otherDebitsList: BgCanonicalMovement[] = [];

  for (const m of movements) {
    const desc = m.description;
    if (m.credit != null && m.credit > 0) {
      if (RE_BATCH_CREDIT.test(desc)) {
        let hint: string | null = null;
        const mRef2 = RE_DATE_REF2.exec(m.ref2 || "");
        if (mRef2) {
          hint = mRef2[1] ? mRef2[1] : `${mRef2[4]}${mRef2[3]}${mRef2[2]}`;
        }
        m.batchDateHint = hint;
        m.isConsumed = false;
        batchCredits.push(m);
      } else if (RE_YAPPY_DEP.test(desc)) {
        const mYp = RE_YAPPY_DEP.exec(desc);
        m.declaredCount = mYp ? parseInt(mYp[1], 10) : 0;
        m.isConsumed = false;
        yappyDeposits.push(m);
      } else {
        voluntaryInflows.push(m);
      }
    } else if (m.debit != null && m.debit > 0) {
      const mRev = RE_REVERSAL.exec(desc);
      if (mRev) {
        m.batchDateHint = mRev[1];
        m.isConsumed = false;
        reversals.push(m);
      } else if (RE_YAPPY_COM.test(desc)) {
        m.isConsumed = false;
        yappyCommissions.push(m);
      } else {
        otherDebitsList.push(m);
      }
    }
  }

  const applicableDetails: BgParsedAchDetail[] = [];
  for (const dt of achDetails) {
    if (dt.isUnreadable) {
      alerts.push(`[NO LEIDO] ${dt.filename}: no se pudo leer — no se concilia`);
      continue;
    }
    applicableDetails.push(dt);
  }

  const sameAccountDetails: BgParsedAchDetail[] = [];
  const otherAccountDetails: BgParsedAchDetail[] = [];

  for (const dt of applicableDetails) {
    if (dt.accountNumber && consolidated.accountNumber && dt.accountNumber !== consolidated.accountNumber) {
      otherAccountDetails.push(dt);
      alerts.push(
        `[OTRA CUENTA] ${dt.filename}: respuesta de la cuenta ${dt.accountNumber} (${dt.holderName || "s/t"}) — no se concilia contra ${consolidated.accountNumber}; se lista aparte`,
      );
    } else {
      sameAccountDetails.push(dt);
    }
  }

  for (const dt of sameAccountDetails) {
    if (!dt.batchDateStr) {
      if (dt.effectiveDate) {
        dt.batchDateStr = dt.effectiveDate.replace(/-/g, "");
        alerts.push(
          `[LOTE SIN FECHA] ${dt.filename}: el nombre del lote no trae fecha; se usa la fecha efectiva ${dt.effectiveDate}`,
        );
      } else {
        alerts.push(
          `[LOTE SIN FECHA] ${dt.filename}: sin fecha de lote ni fecha efectiva — no se puede conciliar; revisar el archivo`,
        );
      }
    }
  }

  const validDetails = sameAccountDetails.filter((dt) => Boolean(dt.batchDateStr));

  const physicalBatchesMap: Map<string, BgParsedAchDetail> = new Map();
  const sortedDetails = [...validDetails].sort((a, b) => {
    const varA = a.variant === "A" ? 0 : 1;
    const varB = b.variant === "A" ? 0 : 1;
    if (varA !== varB) return varA - varB;
    const timeA = a.downloadedAt ? a.downloadedAt.getTime() : 0;
    const timeB = b.downloadedAt ? b.downloadedAt.getTime() : 0;
    if (timeA !== timeB) return timeA - timeB;
    return a.filename.localeCompare(b.filename);
  });

  for (const dt of sortedDetails) {
    const key = `${dt.batchDateStr}#${getBatchToken(dt)}#${dt.retryCount}`;
    if (!physicalBatchesMap.has(key)) {
      physicalBatchesMap.set(key, dt);
      continue;
    }

    const existing = physicalBatchesMap.get(key)!;
    const isSame =
      existing.rejectedRowsCount === dt.rejectedRowsCount &&
      areAmountsEqual(existing.rejectedSum, dt.rejectedSum);

    if (isSame && existing.variant !== dt.variant) {
      alerts.push(
        `[RESPUESTA REDUNDANTE] ${dt.filename} (${dt.variant}) repite el lote de ${existing.filename} (${existing.variant}): los rechazos cruzan al centavo; se usa la variante A`,
      );
    } else if (isSame) {
      alerts.push(`[DUPLICADO] ${dt.filename} repite la respuesta ${existing.filename}: se ignora`);
    } else {
      existing.hasConflict = true;
      alerts.push(
        `[CONFLICTO DE RESPUESTA] dos versiones distintas del lote ${existing.batchName || key}: ${existing.filename} vs ${dt.filename} — el lote queda en ANOMALIA`,
      );
    }
  }

  const uniqueBatches = Array.from(physicalBatchesMap.values()).sort((a, b) => {
    if (a.batchDateStr! !== b.batchDateStr!) return a.batchDateStr!.localeCompare(b.batchDateStr!);
    if (a.retryCount !== b.retryCount) return a.retryCount - b.retryCount;
    const timeA = a.downloadedAt ? a.downloadedAt.getTime() : 0;
    const timeB = b.downloadedAt ? b.downloadedAt.getTime() : 0;
    if (timeA !== timeB) return timeA - timeB;
    return a.filename.localeCompare(b.filename);
  });

  const retryGroups: Map<string, BgParsedAchDetail[]> = new Map();
  for (const dt of uniqueBatches) {
    const baseKey = `${dt.batchDateStr} ${getBatchToken(dt)}`;
    const list = retryGroups.get(baseKey) || [];
    list.push(dt);
    retryGroups.set(baseKey, list);
  }

  for (const [baseKey, group] of retryGroups.entries()) {
    if (group.length > 1) {
      const retryList = group
        .sort((a, b) => a.retryCount - b.retryCount)
        .map((g) => `(${g.retryCount})`)
        .join(", ");
      const withSuccess = group.filter((g) => (g.succeededTransactions || g.succeededRowsCount || 0) > 0);
      alerts.push(`[REINTENTO] el lote ${baseKey} se procesó ${group.length} veces ${retryList}`);
      if (withSuccess.length > 1) {
        alerts.push(
          `[POSIBLE DOBLE COBRO] el lote ${baseKey.split(" ")[0]} tuvo realizadas en ${withSuccess.length} reintentos: verificar débitos duplicados a clientes`,
        );
      }
    }
  }

  const allBatchDates = Array.from(
    new Set([
      ...uniqueBatches.map((dt) => dt.batchDateStr!),
      ...reversals.map((r) => r.batchDateHint!).filter(Boolean),
      ...batchCredits.map((c) => c.batchDateHint || c.date.replace(/-/g, "")),
    ]),
  ).sort();

  const batches: BgReconciledBatch[] = [];
  const items: BgReconciledItem[] = [];
  const provisionalSeqMap: Map<string, number> = new Map();

  for (const fl of allBatchDates) {
    const dts = uniqueBatches.filter((dt) => dt.batchDateStr === fl);
    const revs = reversals.filter((r) => r.batchDateHint === fl);

    for (const dt of dts) {
      const batchUid = `lote#${fl}#${getBatchToken(dt)}#r${dt.retryCount}`;
      const effectiveDate = dt.effectiveDate || dt.batchDate;
      const fe = effectiveDate || `${fl.slice(0, 4)}-${fl.slice(4, 6)}-01`;

      const batchObj: BgReconciledBatch = {
        uid: batchUid,
        batchDateStr: fl,
        batchName: dt.batchName,
        channel: dt.channel,
        fortnight: dt.fortnight,
        isDelinquent: dt.isDelinquent,
        retryCount: dt.retryCount,
        variant: dt.variant,
        detailFilename: dt.filename,
        effectiveDate: dt.effectiveDate,
        creditDate: null,
        totalTransactions: dt.totalTransactions,
        succeededTransactions: dt.succeededTransactions,
        declaredRejectedTransactions: dt.rejectedTransactions,
        rejectedRowsCount: dt.rejectedRowsCount,
        succeededRowsCount: dt.succeededRowsCount,
        rejectedAmount: dt.rejectedSum,
        totalAmount: null,
        succeededAmount: null,
        itemizedSucceededAmount: dt.succeededSum || null,
        status: "pending",
        pendingReason: null,
        creditMovUid: null,
        reversalsMovUids: [],
      };

      let matchedReversals: BgCanonicalMovement[] | null = null;
      const freeReversals = revs.filter((r) => !r.isConsumed);

      if (dt.rejectedSum > TOLERANCE) {
        for (const combo of combinations(freeReversals, MAX_REVERSAL_PARTS)) {
          const sumDebit = round2(combo.reduce((s, r) => s + (r.debit || 0), 0));
          if (areAmountsEqual(sumDebit, dt.rejectedSum)) {
            matchedReversals = combo;
            break;
          }
        }
      }

      if (matchedReversals) {
        for (const r of matchedReversals) {
          r.isConsumed = true;
        }
        batchObj.reversalsMovUids = matchedReversals.map((r) => r.uid);
        if (matchedReversals.length > 1) {
          alerts.push(
            `[REVERSA PARTIDA] lote ${batchObj.uid}: rechazos cubiertos por ${matchedReversals.length} reversas`,
          );
        }
      }

      let expectedTotal: number | null = null;
      if (dt.succeededTransactions != null) {
        if (dt.succeededTransactions === 0) {
          expectedTotal = dt.rejectedSum;
        } else if (
          dt.succeededRowsCount === dt.succeededTransactions &&
          dt.succeededSum != null
        ) {
          expectedTotal = round2(dt.rejectedSum + dt.succeededSum);
        }
      }

      const creditCandidates =
        batchCredits.filter((c) => !c.isConsumed && c.batchDateHint === fl).length > 0
          ? batchCredits.filter((c) => !c.isConsumed && c.batchDateHint === fl)
          : batchCredits.filter(
              (c) => !c.isConsumed && c.batchDateHint === null && c.date === fe,
            );

      let matchedCredit: BgCanonicalMovement | null = null;
      for (const c of creditCandidates) {
        if (expectedTotal != null && !areAmountsEqual(c.credit, expectedTotal)) {
          continue;
        }
        if (expectedTotal == null && c.credit! < dt.rejectedSum - TOLERANCE) {
          continue;
        }
        matchedCredit = c;
        break;
      }

      if (matchedCredit) {
        matchedCredit.isConsumed = true;
        batchObj.creditMovUid = matchedCredit.uid;
        batchObj.totalAmount = matchedCredit.credit;
        batchObj.creditDate = matchedCredit.date;
        batchObj.succeededAmount = round2(matchedCredit.credit! - dt.rejectedSum);
      }

      const okRev = Boolean(matchedReversals) || dt.rejectedSum <= TOLERANCE;
      const okCred = matchedCredit != null;
      const endOfWindow = addWorkingDays(fe, WORKING_DAYS_WINDOW);
      const { isCovered, missingDays } = isDateRangeCovered(coverageDays, fe, endOfWindow);
      const hasProvisionalCoverage = dateRange(fe, endOfWindow).some((d) => provisionalDays.has(d));
      const isCoveredWithoutProvisional = isCovered && !hasProvisionalCoverage;

      if (dt.hasConflict) {
        batchObj.status = "anomaly";
        batchObj.pendingReason = "conflicto entre dos versiones de la respuesta del lote";
      } else if (okCred && okRev) {
        batchObj.status = "settled";
        if (batchObj.succeededAmount != null && batchObj.succeededAmount < -TOLERANCE) {
          batchObj.status = "anomaly";
          alerts.push(`[ANOMALIA] lote ${batchObj.uid}: reversas mayores que el crédito del lote`);
        }
      } else if (!isCovered) {
        batchObj.status = "pending";
        batchObj.pendingReason = `faltan movimientos de cuenta de: ${missingDays.join(", ")}`;
        pendingTasks.push({
          taskType: "missing_statement",
          affectsUid: batchObj.uid,
          missingItem: `Movimientos de Cuenta Corriente que cubran ${missingDays[0]}..${missingDays[missingDays.length - 1]}`,
          details: `lote ${dt.batchName} (efectiva ${fe})`,
          amount: !okRev ? dt.rejectedSum : null,
        });
      } else if (!isCoveredWithoutProvisional) {
        batchObj.status = "pending";
        batchObj.pendingReason = "la cobertura del extracto para la ventana del lote aún es provisional";
        pendingTasks.push({
          taskType: "missing_statement",
          affectsUid: batchObj.uid,
          missingItem: "Re-descargar movimientos cerrado el día (cobertura provisional)",
          details: `lote ${dt.batchName}`,
          amount: null,
        });
      } else {
        batchObj.status = "anomaly";
        const missingParts: string[] = [];
        if (!okCred) missingParts.push("el crédito del total");
        if (!okRev) missingParts.push(`la reversa por $${dt.rejectedSum.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
        batchObj.pendingReason = `con extracto completo no aparece ${missingParts.join(" ni ")}`;
        alerts.push(`[ANOMALIA] lote ${batchObj.uid} (${dt.batchName}): ${batchObj.pendingReason}`);
      }

      batches.push(batchObj);

      const seenAccountAmountOccurrences: Map<string, number> = new Map();
      for (const r of dt.rows) {
        const km = `${r.accountNumber}#${r.amount.toFixed(2)}`;
        const occurrence = seenAccountAmountOccurrences.get(km) || 0;
        seenAccountAmountOccurrences.set(km, occurrence + 1);

        let itemStatus: BgItemStatus;
        let reasonCode: string | null = null;
        let reasonDescription: string | null = null;

        if (r.errorCode) {
          itemStatus = "rejected";
          reasonCode = r.errorCode;
          reasonDescription = r.errorDescription || null;
        } else if (batchObj.status === "settled") {
          itemStatus = "confirmed";
        } else {
          itemStatus = "pending";
          reasonDescription = batchObj.pendingReason || "liquidación del lote sin verificar";
        }

        items.push({
          uid: `rz#${fl}#${getBatchToken(dt)}#r${dt.retryCount}#${r.accountNumber}#${r.amount.toFixed(2)}#${occurrence}`,
          itemType: "COBRO_ACH",
          batchUid: batchObj.uid,
          batchName: dt.batchName,
          effectiveDate: batchObj.effectiveDate,
          batchChannel: dt.channel,
          retryCount: dt.retryCount,
          routingCode: r.routingCode,
          clientAccountNumber: r.accountNumber,
          clientId: r.clientId,
          clientName: r.clientName,
          amount: r.amount,
          amountMinor: r.amountMinor,
          status: itemStatus,
          reasonCode,
          reasonDescription,
          addenda: r.addenda,
          sourceFilename: dt.filename,
        });
      }
    }

    for (const r of revs) {
      if (r.isConsumed) continue;
      const matchingCred = batchCredits.find(
        (c) =>
          !c.isConsumed &&
          (c.batchDateHint === fl || (c.batchDateHint == null && c.date === r.date)),
      );
      if (matchingCred) matchingCred.isConsumed = true;
      r.isConsumed = true;

      const seq = provisionalSeqMap.get(fl) || 0;
      provisionalSeqMap.set(fl, seq + 1);

      const provUid = `lote#${fl}#s${seq}`;
      const provBatch: BgReconciledBatch = {
        uid: provUid,
        batchDateStr: fl,
        batchName: null,
        channel: null,
        fortnight: null,
        isDelinquent: false,
        retryCount: 1,
        variant: null,
        detailFilename: null,
        effectiveDate: r.date,
        creditDate: matchingCred ? matchingCred.date : null,
        totalTransactions: null,
        succeededTransactions: null,
        declaredRejectedTransactions: null,
        rejectedRowsCount: 1,
        totalAmount: matchingCred ? matchingCred.credit : null,
        rejectedAmount: r.debit,
        succeededAmount: matchingCred ? round2(matchingCred.credit! - r.debit!) : null,
        status: "pending",
        pendingReason: "falta el archivo Detalle Transacción ACH del lote",
        creditMovUid: matchingCred ? matchingCred.uid : null,
        reversalsMovUids: [r.uid],
      };

      pendingTasks.push({
        taskType: "missing_ach_detail",
        affectsUid: provUid,
        missingItem: `Detalle Transacción ACH del lote ${fl}`,
        details: `reversa por $${r.debit!.toLocaleString("en-US", { minimumFractionDigits: 2 })} el ${r.date}`,
        amount: r.debit,
      });

      batches.push(provBatch);
    }

    for (const c of batchCredits) {
      const creditBatchDate = c.batchDateHint || c.date.replace(/-/g, "");
      if (c.isConsumed || creditBatchDate !== fl) continue;
      c.isConsumed = true;

      const endOfWindow = addWorkingDays(c.date, WORKING_DAYS_WINDOW);
      const { isCovered } = isDateRangeCovered(coverageDays, c.date, endOfWindow);
      const hasProvisionalCoverage = dateRange(c.date, endOfWindow).some((d) => provisionalDays.has(d));
      const seq = provisionalSeqMap.get(fl) || 0;
      provisionalSeqMap.set(fl, seq + 1);

      const provUid = `lote#${fl}#s${seq}`;
      const provBatch: BgReconciledBatch = {
        uid: provUid,
        batchDateStr: fl,
        batchName: null,
        channel: null,
        fortnight: null,
        isDelinquent: false,
        retryCount: 1,
        variant: null,
        detailFilename: null,
        effectiveDate: c.date,
        creditDate: c.date,
        totalTransactions: null,
        succeededTransactions: null,
        declaredRejectedTransactions: null,
        rejectedRowsCount: 0,
        totalAmount: c.credit,
        rejectedAmount: 0,
        succeededAmount: c.credit,
        status: "pending",
        pendingReason: null,
        creditMovUid: c.uid,
        reversalsMovUids: [],
      };

      if (isCovered && !hasProvisionalCoverage) {
        provBatch.status = "settled_no_reversals";
        pendingTasks.push({
          taskType: "missing_ach_detail",
          affectsUid: provUid,
          missingItem: `Detalle Transacción ACH del lote ${fl} (para itemizar)`,
          details: `crédito $${c.credit!.toLocaleString("en-US", { minimumFractionDigits: 2 })} sin reversas en ${WORKING_DAYS_WINDOW} días hábiles — se asume 0 rechazos`,
          amount: null,
        });
      } else {
        provBatch.status = "pending";
        provBatch.pendingReason = `esperando posibles reversas: cobertura de extracto incompleta hasta ${endOfWindow}`;
        pendingTasks.push({
          taskType: "missing_statement",
          affectsUid: provUid,
          missingItem: `Movimientos hasta ${endOfWindow} para cerrar la ventana de reversas`,
          details: `crédito de lote $${c.credit!.toLocaleString("en-US", { minimumFractionDigits: 2 })} el ${c.date}`,
          amount: null,
        });
      }

      batches.push(provBatch);
    }
  }

  const yappyTxsMap: Map<string, BgYappyTransaction> = new Map();
  const sortedReports = [...yappyReports].sort((a, b) => {
    const timeA = a.downloadedAt ? a.downloadedAt.getTime() : 0;
    const timeB = b.downloadedAt ? b.downloadedAt.getTime() : 0;
    if (timeA !== timeB) return timeA - timeB;
    return a.filename.localeCompare(b.filename);
  });

  for (const rep of sortedReports) {
    for (const row of rep.rows) {
      const key = row.reference || `${row.date}#${row.time}#${row.amount.toFixed(2)}#${row.clientName}`;
      yappyTxsMap.set(key, {
        ...row,
        uid: `yp#${row.date}#${row.reference || key}`,
        batchUid: null,
        status: "pending",
        settlementDate: null,
        isConsumed: false,
      });
    }
  }

  const yappyByDate: Map<string, BgYappyTransaction[]> = new Map();
  for (const tx of yappyTxsMap.values()) {
    if (tx.bankStatus === "Procesado") {
      const list = yappyByDate.get(tx.date) || [];
      list.push(tx);
      yappyByDate.set(tx.date, list);
    }
  }

  let yappyMinDate: string | null = null;
  let yappyMaxDate: string | null = null;
  for (const tx of yappyTxsMap.values()) {
    if (!yappyMinDate || tx.date < yappyMinDate) yappyMinDate = tx.date;
    if (!yappyMaxDate || tx.date > yappyMaxDate) yappyMaxDate = tx.date;
  }

  const yappyBatches: BgReconciledYappyBatch[] = [];
  const yappySeqMap: Map<string, number> = new Map();

  const sortedDeposits = [...yappyDeposits].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.uid.localeCompare(b.uid);
  });

  for (const depo of sortedDeposits) {
    const seq = yappySeqMap.get(depo.date) || 0;
    yappySeqMap.set(depo.date, seq + 1);

    const batchUid = `ypl#${depo.date}#${seq}`;
    const yappyBatchObj: BgReconciledYappyBatch = {
      uid: batchUid,
      creditDate: depo.date,
      transactionDate: null,
      declaredCount: depo.declaredCount || 0,
      reportCount: null,
      creditAmount: depo.credit!,
      reportAmount: null,
      feeAmount: null,
      feeRate: null,
      status: "pending",
      pendingReason: null,
      creditMovUid: depo.uid,
    };

    const commMov = yappyCommissions.find((c) => !c.isConsumed && c.date === depo.date);
    if (commMov) {
      commMov.isConsumed = true;
      yappyBatchObj.feeAmount = commMov.debit;
      yappyBatchObj.feeRate = depo.credit ? round2((commMov.debit! / depo.credit!) * 10000) / 10000 : null;
    }

    let matchedLag: number | null = null;
    let matchedGroup: BgYappyTransaction[] | null = null;
    let matchedDateT: string | null = null;

    const testLags = [YAPPY_LAG_DAYS, YAPPY_LAG_WINDOW[0], YAPPY_LAG_WINDOW[1]];
    for (const lag of testLags) {
      const d = new Date(`${depo.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - lag);
      const diaT = d.toISOString().slice(0, 10);
      const group = (yappyByDate.get(diaT) || []).filter((t) => !t.isConsumed);
      const sumAmount = round2(group.reduce((s, t) => s + t.amount, 0));

      if (
        group.length === depo.declaredCount &&
        areAmountsEqual(sumAmount, depo.credit)
      ) {
        matchedLag = lag;
        matchedGroup = group;
        matchedDateT = diaT;
        break;
      }
    }

    if (matchedGroup && matchedDateT && matchedLag != null) {
      for (const t of matchedGroup) {
        t.isConsumed = true;
        t.batchUid = batchUid;
      }
      yappyBatchObj.status = "settled";
      yappyBatchObj.transactionDate = matchedDateT;
      yappyBatchObj.reportCount = matchedGroup.length;
      yappyBatchObj.reportAmount = round2(matchedGroup.reduce((s, t) => s + t.amount, 0));

      if (matchedLag !== YAPPY_LAG_DAYS) {
        alerts.push(
          `[YAPPY] ${batchUid}: liquidó con desfase T+${matchedLag} (lo normal es T+${YAPPY_LAG_DAYS})`,
        );
      }
    } else {
      const d = new Date(`${depo.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - YAPPY_LAG_DAYS);
      const diaT = d.toISOString().slice(0, 10);
      const hasReportForDay = yappyByDate.has(diaT);

      if (hasReportForDay) {
        const group = (yappyByDate.get(diaT) || []).filter((t) => !t.isConsumed);
        const sumAmount = round2(group.reduce((s, t) => s + t.amount, 0));
        yappyBatchObj.status = "anomaly";
        yappyBatchObj.transactionDate = diaT;
        yappyBatchObj.reportCount = group.length;
        yappyBatchObj.reportAmount = sumAmount;
        yappyBatchObj.pendingReason = `el reporte del ${diaT} suma $${sumAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} y el depósito es $${depo.credit!.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
        alerts.push(`[ANOMALIA YAPPY] ${batchUid}: ${yappyBatchObj.pendingReason}`);
      } else {
        yappyBatchObj.status = "pending";
        yappyBatchObj.pendingReason = `falta el reporte Yappy que cubra el ${diaT}`;
        pendingTasks.push({
          taskType: "missing_yappy_report",
          affectsUid: batchUid,
          missingItem: `Transacciones Yappy del ${diaT}`,
          details: `depósito $${depo.credit!.toLocaleString("en-US", { minimumFractionDigits: 2 })} (${depo.declaredCount} transacciones) acreditado el ${depo.date}`,
          amount: depo.credit,
        });
      }
    }

    yappyBatches.push(yappyBatchObj);
  }

  for (const t of yappyTxsMap.values()) {
    if (t.bankStatus !== "Procesado" || t.isConsumed) continue;
    const d = new Date(`${t.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + YAPPY_LAG_DAYS);
    const depositDate = d.toISOString().slice(0, 10);

    if (coverageDays.has(depositDate) && !provisionalDays.has(depositDate)) {
      t.reconStatus = "anomaly";
      alerts.push(
        `[ANOMALIA YAPPY] pago ${t.uid} ($${t.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} de ${t.clientName}) sin depósito el ${depositDate} pese a extracto completo`,
      );
    } else {
      t.reconStatus = "pending";
      pendingTasks.push({
        taskType: "missing_statement",
        affectsUid: t.uid,
        missingItem: `Movimientos que cubran ${depositDate}`,
        details: `pago Yappy de ${t.clientName} $${t.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} del ${t.date}`,
        amount: t.amount,
      });
    }
  }

  const yappyPayments: BgYappyTransaction[] = [];
  const sortedYappyTxs = Array.from(yappyTxsMap.values()).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.time.localeCompare(b.time);
  });

  for (const t of sortedYappyTxs) {
    let finalStatus: BgYappyStatus;
    if (t.bankStatus === "Procesado") {
      finalStatus = t.isConsumed ? "received" : t.reconStatus || "pending";
    } else if (
      t.bankStatus
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .startsWith("en trans")
    ) {
      finalStatus = "in_transit";
    } else {
      finalStatus = "other";
      alerts.push(`[YAPPY] estado desconocido '${t.bankStatus}' en ${t.uid}`);
    }

    const d = new Date(`${t.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + YAPPY_LAG_DAYS);
    const settlementDate = t.batchUid ? d.toISOString().slice(0, 10) : null;

    yappyPayments.push({
      ...t,
      status: finalStatus,
      settlementDate,
    });
  }

  const incoming: BgReconciledIncoming[] = [];
  const assignments = options.manualAssignments || new Map();

  for (const m of voluntaryInflows) {
    const desc = m.description;
    let channel = "Otro crédito";
    let counterpart = "";

    const mTransf = RE_TRANSF_IN.exec(desc);
    if (mTransf) {
      channel =
        mTransf[1] === "EN LINEA"
          ? "Transferencia BG (banca en línea)"
          : "Transferencia BG (banca móvil)";
      counterpart = mTransf[2].trim();
    } else if (RE_ACH_XPRESS.test(desc)) {
      channel = "ACH Xpress";
      counterpart = RE_ACH_XPRESS.exec(desc)![1].trim();
    } else if (RE_ACH_IN.test(desc)) {
      channel = "ACH interbancario";
      counterpart = RE_ACH_IN.exec(desc)![1].trim();
    } else if (desc.toUpperCase().startsWith("DEPOSITO")) {
      channel = "Depósito";
    } else if (desc.toUpperCase().includes("YAPPY")) {
      channel = "Yappy (otro)";
    }

    const fullText = `${m.ref2 || ""} ${desc}`;
    const mLoanRef = RE_LOAN_REF.exec(fullText);
    const detectedLoanRef = mLoanRef ? mLoanRef[1].replace(/\s+/g, "").toUpperCase() : "";

    let suggestion: BgSuggestion | null = null;
    const lowerText = fullText
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    if (detectedLoanRef) {
      suggestion = "loan";
    } else if (LOAN_KEYWORDS.some((k) => lowerText.includes(k))) {
      suggestion = "loan";
    } else if (channel === "ACH Xpress") {
      suggestion = "loan";
    }

    const uid = `${m.date}#m${m.uid.split("#")[2]}`;
    const asg = assignments.get(uid) || assignments.get(m.uid);

    let incomingStatus: BgIncomingStatus =
      ["Depósito", "Otro crédito", "Yappy (otro)"].includes(channel)
        ? "unassigned"
        : "received";

    if (asg) {
      incomingStatus = asg.category !== "non_loan" ? "received" : "non_loan";
    }

    incoming.push({
      uid,
      movUid: m.uid,
      paymentType: "PAGO_CLIENTE",
      date: m.date,
      channel,
      counterpart,
      transferReference: m.ref1 || "",
      paymentReference: m.ref2 || "",
      detectedLoanRef,
      description: desc,
      amount: m.credit!,
      amountMinor: m.creditMinor!,
      status: incomingStatus,
      category: asg ? asg.category : null,
      suggestion,
      assignmentNotes: asg ? asg.notes : null,
    });
  }

  const counterpartsWithLoanRef: Set<string> = new Set();
  const datesByCounterpart: Map<string, Set<string>> = new Map();

  for (const inc of incoming) {
    if (!inc.counterpart) continue;
    const cpKey = getCounterpartKey(inc.counterpart);
    if (!cpKey) continue;

    if (inc.detectedLoanRef) {
      counterpartsWithLoanRef.add(cpKey);
    }
    const dates = datesByCounterpart.get(cpKey) || new Set();
    dates.add(inc.date);
    datesByCounterpart.set(cpKey, dates);
  }

  for (const inc of incoming) {
    if (inc.suggestion != null || !inc.counterpart) continue;
    const cpKey = getCounterpartKey(inc.counterpart);
    if (counterpartsWithLoanRef.has(cpKey)) {
      inc.suggestion = "loan";
    } else if ((datesByCounterpart.get(cpKey)?.size || 0) >= 3) {
      inc.suggestion = "loan_probable";
    }
  }

  const usedUids = new Set([...incoming.map((x) => x.uid), ...incoming.map((x) => x.movUid)]);
  for (const asgUid of assignments.keys()) {
    if (!usedUids.has(asgUid)) {
      alerts.push(
        `[ASIGNACION SIN DESTINO] el uid '${asgUid}' de asignaciones no corresponde a ningún ingreso de esta corrida (¿uid viejo o mal copiado?)`,
      );
    }
  }

  for (const c of yappyCommissions) {
    if (!c.isConsumed) {
      alerts.push(
        `[YAPPY] comisión ${c.uid} ($${c.debit!.toLocaleString("en-US", { minimumFractionDigits: 2 })}) sin depósito el mismo día`,
      );
    }
  }

  const otherDebits: BgOtherDebit[] = otherDebitsList.map((m) => ({
    uid: m.uid,
    date: m.date,
    description: m.description,
    amount: m.debit!,
    category: classifyDebits(m.description),
    paymentReference: m.ref2 || "",
  }));

  const otherAccountResponses: BgOtherAccountResponse[] = otherAccountDetails.map((dt) => ({
    filename: dt.filename,
    accountNumber: dt.accountNumber || null,
    holderName: dt.holderName || null,
    effectiveDate: dt.effectiveDate,
    totalTransactions: dt.totalTransactions,
    succeededTransactions: dt.succeededTransactions,
    rejectedTransactions: dt.rejectedTransactions,
    totalAmount: dt.declaredTotalAmountMinor
      ? Number(dt.declaredTotalAmountMinor) / 100
      : round2(dt.rejectedSum + dt.succeededSum),
    rows: dt.rows.map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName,
      clientAccountNumber: r.accountNumber,
      amount: r.amount,
      status: r.errorCode ? "RECHAZADO" : "REALIZADA",
      reasonCode: r.errorCode || null,
      reasonDescription: r.errorDescription || null,
    })),
  }));

  const sortedCov = Array.from(coverageDays).sort();
  const unassignedIncoming = incoming.filter((x) => x.status === "unassigned");
  const pendingAssignmentIncoming = incoming.filter(isPendingManualAssignment);

  const controls: BgReconControls = {
    filesReadCount: statements.length + achDetails.length + yappyReports.length,
    coveredDaysCount: sortedCov.length,
    quarantinedDays: Array.from(quarantinedDays).sort(),
    provisionalCoverageDays: Array.from(provisionalDays).sort(),
    totalBatchesCount: batches.length,
    settledBatchesCount: batches.filter((b) => b.status === "settled").length,
    totalYappyBatchesCount: yappyBatches.length,
    settledYappyBatchesCount: yappyBatches.filter((b) => b.status === "settled").length,
    batchesConservation: batches.every(
      (b) =>
        b.totalAmount == null ||
        b.rejectedAmount == null ||
        b.succeededAmount == null ||
        areAmountsEqual(b.totalAmount - b.rejectedAmount, b.succeededAmount),
    )
      ? "OK"
      : "FAIL",
    incomingCount: incoming.length,
    incomingTotalAmount: round2(incoming.reduce((s, x) => s + x.amount, 0)),
    unassignedCount: unassignedIncoming.length,
    unassignedTotalAmount: round2(unassignedIncoming.reduce((s, x) => s + x.amount, 0)),
    pendingAssignmentCount: pendingAssignmentIncoming.length,
    pendingAssignmentTotalAmount: round2(pendingAssignmentIncoming.reduce((s, x) => s + x.amount, 0)),
  };

  return {
    version: "ccbg-2.0",
    generatedFrom: [
      ...statements.map((s) => s.filename),
      ...achDetails.map((a) => a.filename),
      ...yappyReports.map((y) => y.filename),
    ].sort(),
    accountNumber: consolidated.accountNumber,
    companyName: consolidated.companyName,
    period: sortedCov.length > 0 ? [sortedCov[0], sortedCov[sortedCov.length - 1]] : null,
    coverageDays: sortedCov,
    yappyReportRange: yappyMinDate && yappyMaxDate ? [yappyMinDate, yappyMaxDate] : null,
    batches,
    items,
    yappyBatches,
    yappyPayments,
    incoming,
    otherDebits,
    pendingTasks,
    alerts,
    controls,
    otherAccountResponses,
  };
}

