// Daily Collections Action Plan Engine (generar_acciones.py port)
// Reuses pure enrich() logic and priorities:
//   P1  Cura sin costo / Rodó de tramo
//   P2  Cura barata / A punto de rodar
//   P3  Paga activo en mora 91+
// Excludes castigo candidates.

import {
  BUCKETS,
  CO_SECURED,
  CO_UNSECURED,
} from "./enrich";
import type {
  ActionPlanItem,
  ActionPlanSummary,
  EnrichedLoan,
} from "./types";

export const TOP_N_ACTIONS = 40;

export interface BuildPlanParams {
  loans: EnrichedLoan[];
  asOfDate: string; // YYYY-MM-DD
  prevBucketMap?: Record<string, number> | null; // loanId -> bucketIdx in previous snapshot
  lastRealPaymentMap?: Record<string, string> | null; // loanId -> last real payment YYYY-MM-DD
  prevDate?: string | null;
}

export function buildCollectionsPlan(params: BuildPlanParams): {
  plan: ActionPlanItem[];
  resumen: ActionPlanSummary;
} {
  const {
    loans,
    asOfDate,
    prevBucketMap,
    lastRealPaymentMap,
    prevDate = null,
  } = params;

  const asOfTime = new Date(asOfDate).getTime();
  const openLoans = loans.filter((l) => l.isOpen);

  let castigoExclCount = 0;
  let castigoSaldo = 0;
  const items: ActionPlanItem[] = [];

  for (const loan of openLoans) {
    const threshold = loan.secured ? CO_SECURED : CO_UNSECURED;

    // Determine last payment date (prefer last real payment, fallback to loan.lastPaymentDate)
    const lpd =
      lastRealPaymentMap && lastRealPaymentMap[loan.loanId]
        ? lastRealPaymentMap[loan.loanId]
        : loan.lastPaymentDate;

    let dsp: number | null = null;
    if (lpd) {
      const lpdTime = new Date(lpd).getTime();
      dsp = Math.floor((asOfTime - lpdTime) / (1000 * 60 * 60 * 24));
    }

    // Castigo exclusion rule (§7.1)
    const isCastigo =
      loan.dpd > threshold && (dsp === null || dsp > 180);

    if (isCastigo) {
      castigoExclCount++;
      castigoSaldo += loan.balance;
      continue;
    }

    const dpd = loan.dpd;
    const bal = loan.balance;
    const cura = Math.max(0, loan.pastDue);
    const prevBi = prevBucketMap ? prevBucketMap[loan.loanId] : undefined;

    const motivos: string[] = [];
    let prio: 1 | 2 | 3 | 9 = 9;
    let score = 0;

    // P1: Contador DPD desfasado (cash_ahead)
    if (loan.cashAhead) {
      motivos.push(
        "Contador DPD desfasado en LoanDisk (sin monto vencido): revisar/aplicar pagos",
      );
      prio = 1;
      score = bal * 10;
    }

    // P1: Rodó de tramo
    if (
      prevBi !== undefined &&
      prevBi !== null &&
      loan.bucketIdx > prevBi &&
      dpd <= 180
    ) {
      motivos.push(
        `Rodó de tramo (${BUCKETS[prevBi]} → ${BUCKETS[loan.bucketIdx]})`,
      );
      if (prio > 1) {
        prio = 1;
        score = bal * 5;
      }
    }

    // P2: Cura barata
    if (dpd > 0 && dpd <= 90 && cura > 0.01) {
      const lev = bal / Math.max(cura, 25.0);
      motivos.push(
        `Cura barata: $${Math.round(cura).toLocaleString()} re-envejece $${Math.round(bal).toLocaleString()}`,
      );
      if (prio > 2) {
        prio = 2;
        score = lev * 100;
      }
    }

    // P2: A punto de rodar
    for (const edge of [30, 60, 90, 180]) {
      if (edge - 7 < dpd && dpd <= edge) {
        motivos.push(`A ≤${Math.floor(edge - dpd) + 1} días de cruzar ${edge}d`);
        if (prio > 2) {
          prio = 2;
          score = bal * 2;
        }
        break;
      }
    }

    // P3: Paga activo en mora 91+
    if (dpd > 90 && dsp !== null && dsp <= 90) {
      motivos.push(
        `Paga activo (último hace ${dsp}d): formalizar plan${
          loan.secured ? " / rollover con garantía" : ""
        }`,
      );
      if (prio > 3) {
        prio = 3;
        score = bal * (loan.secured ? 1.5 : 1.0);
      }
    }

    // If no actionable signals matched, loan is not in today's attack plan
    if (motivos.length === 0 || prio > 3) {
      continue;
    }

    items.push({
      prio: prio as 1 | 2 | 3,
      score: Math.round(score * 100) / 100,
      loanno: loan.loanNumber || loan.loanId,
      cliente: loan.fullName,
      cel: loan.borrowerMobile,
      seg: loan.segment,
      producto: loan.product,
      dpd,
      tramo: loan.bucket,
      saldo: Math.round(bal * 100) / 100,
      cura: Math.round(cura * 100) / 100,
      ultpago: lpd ?? "",
      motivo: motivos.join(" · "),
    });
  }

  // Sort by priority ASC (1 -> 2 -> 3), then score DESC
  items.sort((a, b) => {
    if (a.prio !== b.prio) return a.prio - b.prio;
    return b.score - a.score;
  });

  const top40 = items.slice(0, TOP_N_ACTIONS);
  const top40Cura = top40.reduce((acc, it) => acc + it.cura, 0);
  const top40Saldo = top40.reduce(
    (acc, it) => (it.cura > 0 ? acc + it.saldo : acc),
    0,
  );

  const totalOpenBalance = openLoans.reduce((acc, l) => acc + l.balance, 0);

  const resumen: ActionPlanSummary = {
    abiertos: openLoans.length,
    saldo: Math.round(totalOpenBalance * 100) / 100,
    accionables: items.length,
    castigo_excl: castigoExclCount,
    castigo_saldo: Math.round(castigoSaldo * 100) / 100,
    prev_date: prevDate,
    top40_cura: Math.round(top40Cura * 100) / 100,
    top40_saldo: Math.round(top40Saldo * 100) / 100,
  };

  return { plan: items, resumen };
}

