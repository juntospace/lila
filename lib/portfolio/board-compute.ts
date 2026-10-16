// Pure, testable computation functions for the Board Report (Secciones 01–06)
// Mirrors the embedded JS logic in generate_report.py (lines 625–1005)

import type { BoardDataset } from "./board";

export type Granularity = "Q" | "M" | "W" | "D";
export type PeriodPreset = "todo" | "anio" | "mes" | "semana" | "rango";

export const SEG_COLORS = ["#620494", "#3E2A7E", "#FF9A52"];

export const LOAN_COLS = [
  "Préstamo #",
  "Cliente",
  "Producto",
  "Liberado",
  "Saldo",
  "DPD",
  "Por cobrar",
  "Tramo",
];

export const PAY_COLS = [
  "Préstamo #",
  "Cliente",
  "Producto",
  "Principal",
  "Ingresos",
  "Total",
  "Por cobrar",
];

export const EXP_COLS = [
  "Préstamo #",
  "Cliente",
  "Producto",
  "Cuotas",
  "Monto programado",
];

/**
 * Adds days to an ISO date string (YYYY-MM-DD) in UTC.
 */
export function dAdd(iso: string, days: number): string {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Adds months to an ISO date string (YYYY-MM-DD), clamping the day
 * to the last valid day of the target month (e.g. 2025-01-31 + 1m -> 2025-02-28).
 */
export function addMonths(iso: string, months: number): string {
  const y = parseInt(iso.slice(0, 4), 10);
  const mo = parseInt(iso.slice(5, 7), 10) - 1;
  const d = parseInt(iso.slice(8, 10), 10);

  const totalMonths = y * 12 + mo + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;

  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  const clampedDay = Math.min(d, lastDay);

  const ys = String(targetYear).padStart(4, "0");
  const ms = String(targetMonth + 1).padStart(2, "0");
  const ds = String(clampedDay).padStart(2, "0");
  return `${ys}-${ms}-${ds}`;
}

/**
 * Returns the Monday ISO date (YYYY-MM-DD) for the week containing `iso`.
 */
export function weekStartMonday(iso: string): string {
  const dt = new Date(iso + "T00:00:00Z");
  const dow = dt.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

/**
 * Maps an ISO date (YYYY-MM-DD) or month (YYYY-MM) into a bucket key for granularity `g`.
 */
export function periodKey(dateOrMonth: string, g: Granularity): string {
  if (g === "Q") {
    const y = dateOrMonth.slice(0, 4);
    const m = parseInt(dateOrMonth.slice(5, 7), 10);
    const q = Math.floor((m - 1) / 3) + 1;
    return `${y}-Q${q}`;
  }
  if (g === "M") {
    return dateOrMonth.slice(0, 7);
  }
  if (g === "W") {
    const full =
      dateOrMonth.length === 7 ? `${dateOrMonth}-01` : dateOrMonth.slice(0, 10);
    return weekStartMonday(full);
  }
  return dateOrMonth.slice(0, 10);
}

/**
 * Button label for multi-select dimension filter dropdowns (Fase 3.2).
 */
export function fbtnLabel(selected: Set<string>, allVals: string[]): string {
  if (selected.size === 0 || selected.size >= allVals.length) {
    return "Todas";
  }
  if (selected.size === 1) {
    return Array.from(selected)[0];
  }
  return `${selected.size}/${allVals.length}`;
}

/**
 * Computes effective date window [effStart, effEnd], granularity, and fallback note.
 * Default custom range start is asof - 90 days (Fase 3.6).
 */
export function computeRangeAndGranularity(
  D: Pick<BoardDataset, "asof" | "firstMonth" | "dailyStart">,
  period: PeriodPreset,
  rangeStart = "",
  rangeEnd = "",
): {
  effStart: string;
  effEnd: string;
  gran: Granularity;
  granNote: string;
} {
  let b = D.asof;
  let a = D.firstMonth + "-01";

  if (period === "anio") a = dAdd(b, -365);
  else if (period === "mes") a = dAdd(b, -34);
  else if (period === "semana") a = dAdd(b, -6);
  else if (period === "rango") {
    a = rangeStart || dAdd(b, -90);
    b = rangeEnd || b;
  }

  if (a > b) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const span =
    (new Date(b + "T00:00:00Z").getTime() -
      new Date(a + "T00:00:00Z").getTime()) /
    864e5;

  let g: Granularity = "D";
  if (period === "todo") g = "Q";
  else if (period === "anio") g = "M";
  else if (period === "mes") g = "W";
  else if (period === "semana") g = "D";
  else {
    if (span > 730) g = "Q";
    else if (span > 120) g = "M";
    else if (span > 35) g = "W";
    else g = "D";
  }

  let note = "";
  if ((g === "W" || g === "D") && a < D.dailyStart) {
    g = "M";
    note =
      "Sin detalle diario antes de " + D.dailyStart + " — se muestra mensual";
  }

  return { effStart: a, effEnd: b, gran: g, granNote: note };
}

/**
 * Computes combo visibility and loan visibility arrays from current filter selections.
 */
export function computeVisibility(
  D: BoardDataset,
  filters: {
    selectedSegs: Set<string>;
    filterTg: Set<string>;
    filterTc: Set<string>;
    filterGc: Set<string>;
    filterMr: Set<string>;
  },
): {
  comboVis: boolean[];
  loanVis: boolean[];
  visibleOpenLoans: { id: string; d: (string | number)[] }[];
} {
  const { selectedSegs, filterTg, filterTc, filterGc, filterMr } = filters;
  const comboVis = D.combos.map(
    (c) =>
      selectedSegs.has(D.segments[c[0]]) &&
      filterTg.has(D.filtVals.tg[c[1]]) &&
      filterTc.has(D.filtVals.tc[c[2]]) &&
      filterGc.has(D.filtVals.gc[c[3]]) &&
      filterMr.has(D.filtVals.mr[c[4]]),
  );

  const loanVis = D.loanIds.map((id) => comboVis[D.details[id][10] as number]);

  const visibleOpenLoans: { id: string; d: (string | number)[] }[] = [];
  for (let k = 0; k < D.loanIds.length; k++) {
    const id = D.loanIds[k];
    const d = D.details[id];
    if (d[7] === 1 && loanVis[k]) {
      visibleOpenLoans.push({ id, d });
    }
  }

  return { comboVis, loanVis, visibleOpenLoans };
}

export interface DelinqPoint {
  date: string;
  key: string;
  d30: number;
  d90: number;
  tot: number;
  pct30: number;
  pct90: number;
}

/**
 * Aggregates delinquency series for visible combos within [a, b],
 * computes CeR 30+ delta (last.pct - first.pct), and regroups by granularity `g`
 * taking the last point of each group (Fase 3.3 & Fase 3.5).
 */
export function delinqAgg(
  D: BoardDataset,
  comboVis: boolean[],
  a: string,
  b: string,
  g: Granularity = "M",
  period: PeriodPreset = "todo",
): {
  rawPoints: DelinqPoint[];
  groupedPoints: DelinqPoint[];
  deltaCer30: number | null;
  deltaLabel: string;
} {
  const byDate = new Map<string, { d30: number; d90: number; tot: number }>();

  for (const row of D.delinq) {
    if (!comboVis[row.ci]) continue;
    if (row.date < a || row.date > b) continue;
    const cur = byDate.get(row.date) || { d30: 0, d90: 0, tot: 0 };
    cur.d30 += row.d30;
    cur.d90 += row.d90;
    cur.tot += row.tot;
    byDate.set(row.date, cur);
  }

  const sortedDates = Array.from(byDate.keys()).sort();
  const rawPoints: DelinqPoint[] = sortedDates.map((date) => {
    const v = byDate.get(date)!;
    const d30 = Math.round(v.d30 * 100) / 100;
    const d90 = Math.round(v.d90 * 100) / 100;
    const tot = Math.round(v.tot * 100) / 100;
    const pct30 = tot > 0 ? (d30 / tot) * 100 : 0;
    const pct90 = tot > 0 ? (d90 / tot) * 100 : 0;
    return {
      date,
      key: periodKey(date, g),
      d30,
      d90,
      tot,
      pct30,
      pct90,
    };
  });

  let deltaCer30: number | null = null;
  if (rawPoints.length >= 2) {
    const first = rawPoints[0];
    const last = rawPoints[rawPoints.length - 1];
    deltaCer30 = Math.round((last.pct30 - first.pct30) * 10) / 10;
  }

  const labelMap: Record<PeriodPreset, string> = {
    semana: "vs sem. ant.",
    mes: "vs mes ant.",
    anio: "vs año ant.",
    todo: "vs inicio",
    rango: "en el periodo",
  };

  // Regroup by granularity taking the LAST point of each group (Fase 3.5)
  const groupedMap = new Map<string, DelinqPoint>();
  for (const pt of rawPoints) {
    groupedMap.set(pt.key, pt);
  }
  const groupedPoints = Array.from(groupedMap.values());

  return {
    rawPoints,
    groupedPoints,
    deltaCer30,
    deltaLabel: labelMap[period] || "vs corte ant.",
  };
}

export interface CollectBucketPoint {
  key: string;
  prin: number;
  inc: number;
  total: number;
  sched: number;
  payDrillRows: (string | number)[][];
  expDrillRows: (string | number)[][];
}

export interface CollectSeriesResult {
  buckets: CollectBucketPoint[];
  totalCollected: number;
  totalScheduled: number;
  efficiencyPct: number | null;
}

/**
 * Computes Section 04 — Cobrado vs. Programado series and drilldown tables (Fase 3.4).
 * - Collected: uses `payM` for Q/M and `payD` for W/D, filtered by `loanVis`.
 * - Scheduled: for each visible loan with `ni > 0`, `td > 0`, and `released`, projects
 *   `ni` installments of `td / ni` at `addMonths(rel, q)` (monthly) or `dAdd(rel, q)` (daily)
 *   up to `asof` and within `[a, b]`.
 */
export function collectSeries(
  D: BoardDataset,
  loanVis: boolean[],
  g: Granularity,
  a: string,
  b: string,
): CollectSeriesResult {
  const bucketMap = new Map<
    string,
    {
      prin: number;
      inc: number;
      sched: number;
      loansPaid: Map<number, { prin: number; inc: number }>;
      loansSched: Map<number, { count: number; amount: number }>;
    }
  >();

  function ensureBucket(k: string) {
    if (!bucketMap.has(k)) {
      bucketMap.set(k, {
        prin: 0,
        inc: 0,
        sched: 0,
        loansPaid: new Map(),
        loansSched: new Map(),
      });
    }
    return bucketMap.get(k)!;
  }

  // 1. Collected (Real payments)
  if (g === "Q" || g === "M") {
    const startM = a.slice(0, 7);
    const endM = b.slice(0, 7);
    for (const m of Object.keys(D.payM)) {
      if (m < startM || m > endM) continue;
      const bKey = periodKey(m, g);
      const bObj = ensureBucket(bKey);
      for (const [pos, prin, inc] of D.payM[m]) {
        if (!loanVis[pos]) continue;
        bObj.prin += prin;
        bObj.inc += inc;
        const cur = bObj.loansPaid.get(pos) || { prin: 0, inc: 0 };
        bObj.loansPaid.set(pos, {
          prin: cur.prin + prin,
          inc: cur.inc + inc,
        });
      }
    }
  } else {
    for (const day of Object.keys(D.payD)) {
      if (day < a || day > b) continue;
      const bKey = periodKey(day, g);
      const bObj = ensureBucket(bKey);
      for (const [pos, prin, inc] of D.payD[day]) {
        if (!loanVis[pos]) continue;
        bObj.prin += prin;
        bObj.inc += inc;
        const cur = bObj.loansPaid.get(pos) || { prin: 0, inc: 0 };
        bObj.loansPaid.set(pos, {
          prin: cur.prin + prin,
          inc: cur.inc + inc,
        });
      }
    }
  }

  // 2. Scheduled (Projected installments from Released Date)
  const capEnd = b < D.asof ? b : D.asof;
  const startBound = g === "Q" || g === "M" ? `${a.slice(0, 7)}-01` : a;

  for (let pos = 0; pos < D.loanIds.length; pos++) {
    if (!loanVis[pos]) continue;
    const lid = D.loanIds[pos];
    const d = D.details[lid];
    if (!d) continue;

    const rel = d[6] as string;
    const td = Number(d[11] || 0);
    const ni = Math.min(Number(d[12] || 0), 1500);
    const cycle = Number(d[13] || 0);

    if (!rel || ni <= 0 || td <= 0) continue;

    const cuota = td / ni;
    for (let q = 1; q <= ni; q++) {
      const dueDate = cycle === 0 ? addMonths(rel, q) : dAdd(rel, q);
      if (dueDate > D.asof || dueDate > capEnd) break;
      if (dueDate < startBound) continue;

      const bKey = periodKey(dueDate, g);
      const bObj = ensureBucket(bKey);
      bObj.sched += cuota;
      const cur = bObj.loansSched.get(pos) || { count: 0, amount: 0 };
      bObj.loansSched.set(pos, {
        count: cur.count + 1,
        amount: cur.amount + cuota,
      });
    }
  }

  const sortedKeys = Array.from(bucketMap.keys()).sort();
  let totalCollected = 0;
  let totalScheduled = 0;

  const buckets: CollectBucketPoint[] = sortedKeys.map((key) => {
    const bObj = bucketMap.get(key)!;
    const prin = Math.round(bObj.prin * 100) / 100;
    const inc = Math.round(bObj.inc * 100) / 100;
    const total = Math.round((bObj.prin + bObj.inc) * 100) / 100;
    const sched = Math.round(bObj.sched * 100) / 100;

    totalCollected += total;
    totalScheduled += sched;

    // PAY_COLS: Préstamo #, Cliente, Producto, Principal, Ingresos, Total, Por cobrar
    const payDrillRows: (string | number)[][] = Array.from(
      bObj.loansPaid.entries(),
    )
      .map(([pos, vals]) => {
        const lid = D.loanIds[pos];
        const d = D.details[lid];
        const lPrin = Math.round(vals.prin * 100) / 100;
        const lInc = Math.round(vals.inc * 100) / 100;
        const lTot = Math.round((vals.prin + vals.inc) * 100) / 100;
        return [
          d[8], // Loan #
          d[0], // Full Name
          D.products[d[1] as number] || "(histórico)",
          lPrin,
          lInc,
          lTot,
          Number(d[9] || 0), // Pending Due
        ];
      })
      .sort((r1, r2) => (r2[5] as number) - (r1[5] as number));

    // EXP_COLS: Préstamo #, Cliente, Producto, Cuotas, Monto programado
    const expDrillRows: (string | number)[][] = Array.from(
      bObj.loansSched.entries(),
    )
      .map(([pos, vals]) => {
        const lid = D.loanIds[pos];
        const d = D.details[lid];
        return [
          d[8], // Loan #
          d[0], // Full Name
          D.products[d[1] as number] || "(histórico)",
          vals.count,
          Math.round(vals.amount * 100) / 100,
        ];
      })
      .sort((r1, r2) => (r2[4] as number) - (r1[4] as number));

    return {
      key,
      prin,
      inc,
      total,
      sched,
      payDrillRows,
      expDrillRows,
    };
  });

  totalCollected = Math.round(totalCollected * 100) / 100;
  totalScheduled = Math.round(totalScheduled * 100) / 100;
  const efficiencyPct =
    totalScheduled > 0
      ? Math.round((totalCollected / totalScheduled) * 1000) / 10
      : null;

  return {
    buckets,
    totalCollected,
    totalScheduled,
    efficiencyPct,
  };
}

/**
 * Computes Section 03 — Transposed 7x7 Migration Matrix (Fase 3.6):
 * Rows = fin (endIdx), Columns = inicio (startIdx), header "fin \ inicio".
 */
export function computeMigrationMatrix(
  D: BoardDataset,
  loanVis: boolean[],
  effStart: string,
  effEnd: string,
): {
  dA: string;
  dB: string;
  /** Transposed: rows[endIdx][startIdx] contains loanIds that moved from startIdx -> endIdx */
  rows: string[][][];
} | null {
  const dates = Object.keys(D.snapshots).sort();
  if (dates.length < 2) return null;

  const ends = dates.filter((d) => d <= effEnd);
  const dB = ends.length ? ends[ends.length - 1] : dates[dates.length - 1];

  const priors = dates.filter((d) => d < dB);
  if (!priors.length) return null;

  let dA = priors[0];
  let minDiff = Infinity;
  const targetTime = new Date(effStart + "T00:00:00Z").getTime();
  for (const d of priors) {
    const diff = Math.abs(new Date(d + "T00:00:00Z").getTime() - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      dA = d;
    }
  }

  const sA = D.snapshots[dA];
  const sB = D.snapshots[dB];
  if (!sA || !sB) return null;

  const numBuckets = D.buckets.length;
  // rows[endIdx][startIdx]
  const rows: string[][][] = Array.from({ length: numBuckets }, () =>
    Array.from({ length: numBuckets }, () => []),
  );

  for (let k = 0; k < D.loanIds.length; k++) {
    if (!loanVis[k]) continue;
    const cA = sA[k];
    const cB = sB[k];
    if (cA === "." || cB === ".") continue;
    const startIdx = parseInt(cA, 10);
    const endIdx = parseInt(cB, 10);
    if (
      startIdx >= 0 &&
      startIdx < numBuckets &&
      endIdx >= 0 &&
      endIdx < numBuckets
    ) {
      rows[endIdx][startIdx].push(D.loanIds[k]);
    }
  }

  return { dA, dB, rows };
}

