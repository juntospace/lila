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
import { DEFAULT_POLICY } from "./policy";
import type {
  ActionPlanItem,
  ActionPlanSummary,
  EnrichedLoan,
  PortfolioPolicy,
} from "./types";

export const TOP_N_ACTIONS = 40;

function pyRound0(val: number): number {
  if (!Number.isFinite(val) || val === 0) return 0;
  const floor = Math.floor(val);
  const diff = val - floor;
  if (Math.abs(diff - 0.5) < 1e-9) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(val);
}

function pyRound2(val: number): number {
  if (!Number.isFinite(val) || val === 0) return 0;
  const sign = val < 0 ? -1 : 1;
  const abs = Math.abs(val);
  const str = abs.toFixed(20);
  const dotIdx = str.indexOf(".");
  const intStr = str.slice(0, dotIdx);
  const fracStr = str.slice(dotIdx + 1);
  const d2Str = fracStr.slice(0, 2);
  const restStr = fracStr.slice(2);
  const halfStr = "500000000000000000";

  let cents = BigInt(intStr) * 100n + BigInt(d2Str);
  if (restStr > halfStr) {
    cents += 1n;
  } else if (restStr === halfStr && cents % 2n !== 0n) {
    cents += 1n;
  }
  return sign * (Number(cents) / 100);
}

export interface BuildPlanParams {
  loans: EnrichedLoan[];
  asOfDate: string; // YYYY-MM-DD
  prevBucketMap?: Record<string, number> | null; // loanId -> bucketIdx in previous snapshot
  lastRealPaymentMap?: Record<string, string> | null; // loanId -> last real payment YYYY-MM-DD
  hasRepaymentsFile?: boolean; // Explicit flag whether a repayments file was loaded (Fase 2.1)
  prevDate?: string | null;
  policy?: PortfolioPolicy;
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
    hasRepaymentsFile,
    prevDate = null,
    policy = DEFAULT_POLICY,
  } = params;

  const coSecured = policy.coSecured ?? policy.coSecuredDpd ?? CO_SECURED;
  const coUnsecured = policy.coUnsecured ?? policy.coUnsecuredDpd ?? CO_UNSECURED;
  const bucketNames = policy.bucketNames ?? BUCKETS;

  // Fase 2.1: If a repayments file was loaded, lpd comes exclusively from lastRealPaymentMap
  // without falling back to loan.lastPaymentDate. Only fallback when no repayments file exists.
  const useRealPaymentsOnly =
    hasRepaymentsFile !== undefined
      ? hasRepaymentsFile
      : lastRealPaymentMap !== undefined && lastRealPaymentMap !== null;

  const asOfTime = new Date(asOfDate).getTime();
  const openLoans = loans.filter((l) => l.isOpen);

  let castigoExclCount = 0;
  let castigoSaldo = 0;
  const items: ActionPlanItem[] = [];

  for (const loan of openLoans) {
    const threshold = loan.secured ? coSecured : coUnsecured;

    const lpd = useRealPaymentsOnly
      ? lastRealPaymentMap?.[loan.loanId] ?? null
      : loan.lastPaymentDate ?? null;

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
        `Rodó de tramo (${bucketNames[prevBi]} → ${bucketNames[loan.bucketIdx]})`,
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
        `Cura barata: $${pyRound0(cura).toLocaleString("en-US")} re-envejece $${pyRound0(bal).toLocaleString("en-US")}`,
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
      score: pyRound2(score),
      // Fase 2.6: Do not fallback to loanId when Loan # is empty
      loanno: loan.loanNumber ?? "",
      cliente: loan.fullName,
      cel: loan.borrowerMobile,
      seg: loan.segment,
      producto: loan.product,
      dpd,
      tramo: loan.bucket,
      saldo: pyRound2(bal),
      cura: pyRound2(cura),
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
    saldo: pyRound2(totalOpenBalance),
    accionables: items.length,
    castigo_excl: castigoExclCount,
    castigo_saldo: pyRound2(castigoSaldo),
    prev_date: prevDate,
    top40_cura: pyRound2(top40Cura),
    top40_saldo: pyRound2(top40Saldo),
  };

  return { plan: items, resumen };
}
