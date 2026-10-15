"use client";

import React, { useMemo, useState } from "react";
import { Download, X } from "lucide-react";

import type { BoardDataset } from "@/lib/portfolio/board";

interface BoardViewProps {
  data: BoardDataset;
}

const SEG_COLORS = ["#620494", "#3E2A7E", "#FF9A52"];
const LOAN_COLS = [
  "Préstamo #",
  "Cliente",
  "Producto",
  "Liberado",
  "Saldo",
  "DPD",
  "Por cobrar",
  "Tramo",
];

export function BoardReportView({ data: D }: BoardViewProps) {
  // Global filter state
  const [selectedSegs, setSelectedSegs] = useState<Set<string>>(
    () => new Set(D.segments),
  );
  const [period, setPeriod] = useState<"todo" | "anio" | "mes" | "semana" | "rango">(
    "todo",
  );
  const [rangeStart, setRangeStart] = useState<string>("");
  const [rangeEnd, setRangeEnd] = useState<string>("");

  const [filterTg] = useState<Set<string>>(() => new Set(D.filtVals.tg));
  const [filterTc] = useState<Set<string>>(() => new Set(D.filtVals.tc));
  const [filterGc] = useState<Set<string>>(() => new Set(D.filtVals.gc));
  const [filterMr] = useState<Set<string>>(() => new Set(D.filtVals.mr));

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalSubtitle, setModalSubtitle] = useState("");
  const [modalCols, setModalCols] = useState<string[]>(LOAN_COLS);
  const [modalRows, setModalRows] = useState<(string | number)[][]>([]);
  const [modalFilename, setModalFilename] = useState("lila_prestamos");

  // Recompute combo visibility
  const { loanVis, visibleOpenLoans } = useMemo(() => {
    const comboVis = D.combos.map(
      (c) =>
        selectedSegs.has(D.segments[c[0]]) &&
        filterTg.has(D.filtVals.tg[c[1]]) &&
        filterTc.has(D.filtVals.tc[c[2]]) &&
        filterGc.has(D.filtVals.gc[c[3]]) &&
        filterMr.has(D.filtVals.mr[c[4]]),
    );

    const lVis = D.loanIds.map((id) => comboVis[D.details[id][10] as number]);

    const openList: { id: string; d: (string | number)[] }[] = [];
    for (let k = 0; k < D.loanIds.length; k++) {
      const id = D.loanIds[k];
      const d = D.details[id];
      if (d[7] === 1 && lVis[k]) {
        openList.push({ id, d });
      }
    }

    return { loanVis: lVis, visibleOpenLoans: openList };
  }, [D, selectedSegs, filterTg, filterTc, filterGc, filterMr]);

  // Range and granularity
  const { effStart, effEnd } = useMemo(() => {
    let b = D.asof;
    let a = D.firstMonth + "-01";

    const dAdd = (iso: string, days: number) => {
      const dt = new Date(iso + "T00:00:00Z");
      dt.setUTCDate(dt.getUTCDate() + days);
      return dt.toISOString().slice(0, 10);
    };

    if (period === "anio") a = dAdd(b, -365);
    else if (period === "mes") a = dAdd(b, -34);
    else if (period === "semana") a = dAdd(b, -6);
    else if (period === "rango") {
      a = rangeStart || dAdd(b, -34);
      b = rangeEnd || b;
    }

    const span =
      (new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) /
      864e5;

    let g = "D";
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
      note = "Sin detalle diario antes de " + D.dailyStart + " — se muestra mensual";
    }

    return { effStart: a, effEnd: b, gran: g, granNote: note };
  }, [D, period, rangeStart, rangeEnd]);

  // Section 01: KPI Computations
  const kpis = useMemo(() => {
    const bucketAgg = D.buckets.map(() => ({ bal: 0, count: 0 }));
    let totalBal = 0;
    let totalCount = 0;

    for (const item of visibleOpenLoans) {
      const bIdx = item.d[5] as number;
      const bal = item.d[3] as number;
      bucketAgg[bIdx].bal += bal;
      bucketAgg[bIdx].count++;
      totalBal += bal;
      totalCount++;
    }

    let d30Bal = 0;
    let d90Bal = 0;
    for (let i = 2; i < 7; i++) d30Bal += bucketAgg[i].bal;
    for (let i = 4; i < 7; i++) d90Bal += bucketAgg[i].bal;

    const cer30Pct = totalBal > 0 ? (d30Bal / totalBal) * 100 : 0;
    const cer90Pct = totalBal > 0 ? (d90Bal / totalBal) * 100 : 0;

    // Recaudado jun-25->
    let recoveredJun25 = 0;
    const hm = D.handover.slice(0, 7);
    for (const m in D.payM) {
      if (m < hm) continue;
      for (const entry of D.payM[m]) {
        if (loanVis[entry[0]]) {
          recoveredJun25 += entry[1] + entry[2];
        }
      }
    }

    return {
      totalBal,
      totalCount,
      cer30Pct,
      cer90Pct,
      recoveredJun25,
      bucketAgg,
    };
  }, [D, visibleOpenLoans, loanVis]);

  // Helpers
  const fmtMoney = (x: number) =>
    "$" + Math.round(x || 0).toLocaleString("en-US");
  const fmtMoney2 = (x: number) =>
    (x || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const fmtPct = (x: number, d = 1) => (x || 0).toFixed(d) + "%";

  const getRagColor = (v: number, greenLimit: number, amberLimit: number) => {
    if (v <= greenLimit) return "text-emerald-700 bg-emerald-50 border-emerald-200";
    if (v <= amberLimit) return "text-amber-700 bg-amber-50 border-amber-200";
    return "text-rose-700 bg-rose-50 border-rose-200";
  };

  const getLoanRow = (id: string) => {
    const d = D.details[id];
    return [
      d[8], // Loan #
      d[0], // Full Name
      D.products[d[1] as number] || "(histórico)",
      d[6], // Released Date
      d[3], // Balance
      d[4], // DPD
      d[9], // Pending Due
      D.buckets[d[5] as number], // Bucket
    ];
  };

  const triggerModal = (
    title: string,
    subtitle: string,
    cols: string[],
    rows: (string | number)[][],
    fname: string,
  ) => {
    setModalTitle(title);
    setModalSubtitle(subtitle);
    setModalCols(cols);
    setModalRows(rows);
    setModalFilename(fname);
    setModalOpen(true);
  };

  const downloadCsv = () => {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      modalCols.map(q).join(";"),
      ...modalRows.map((r) => r.map(q).join(";")),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${modalFilename}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Section 02: Distribution & Provisioning
  const distributionData = useMemo(() => {
    const rows: {
      name: string;
      color: string;
      isTotal?: boolean;
      buckets: { count: number; bal: number; ids: string[] }[];
      totalBal: number;
      totalCount: number;
    }[] = [];

    const activeSegIndices = D.segments
      .map((s, i) => i)
      .filter((i) => selectedSegs.has(D.segments[i]));

    for (const si of activeSegIndices) {
      const segName = D.segments[si];
      const per = D.buckets.map(() => ({ count: 0, bal: 0, ids: [] as string[] }));
      let sBal = 0;
      let sCount = 0;

      for (const item of visibleOpenLoans) {
        if (item.d[2] === si) {
          const bIdx = item.d[5] as number;
          const bal = item.d[3] as number;
          per[bIdx].count++;
          per[bIdx].bal += bal;
          per[bIdx].ids.push(item.id);
          sBal += bal;
          sCount++;
        }
      }

      rows.push({
        name: segName,
        color: SEG_COLORS[si],
        buckets: per,
        totalBal: sBal,
        totalCount: sCount,
      });
    }

    // Total row
    const perTotal = D.buckets.map(() => ({
      count: 0,
      bal: 0,
      ids: [] as string[],
    }));
    let tBal = 0;
    let tCount = 0;

    for (const item of visibleOpenLoans) {
      const bIdx = item.d[5] as number;
      const bal = item.d[3] as number;
      perTotal[bIdx].count++;
      perTotal[bIdx].bal += bal;
      perTotal[bIdx].ids.push(item.id);
      tBal += bal;
      tCount++;
    }

    rows.push({
      name: "Total",
      color: "#1E1622",
      isTotal: true,
      buckets: perTotal,
      totalBal: tBal,
      totalCount: tCount,
    });

    let prov = 0;
    for (let i = 0; i < D.buckets.length; i++) {
      prov += perTotal[i].bal * D.provRates[i];
    }

    return { rows, prov, totalBal: tBal };
  }, [D, visibleOpenLoans, selectedSegs]);

  // Section 03: Migration Matrix 7x7
  const migrationMatrix = useMemo(() => {
    const dates = Object.keys(D.snapshots).sort();
    if (dates.length < 2) return null;

    const b = effEnd;
    const ends = dates.filter((d) => d <= b);
    const dB = ends.length ? ends[ends.length - 1] : dates[dates.length - 1];

    const priors = dates.filter((d) => d < dB);
    if (!priors.length) return null;

    // Pick closest to effStart
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

    const cells: string[][][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 7 }, () => []),
    );

    for (let k = 0; k < D.loanIds.length; k++) {
      if (!loanVis[k]) continue;
      const cA = sA[k];
      const cB = sB[k];
      if (cA === "." || cB === ".") continue;
      const startIdx = parseInt(cA, 10);
      const endIdx = parseInt(cB, 10);
      cells[startIdx][endIdx].push(D.loanIds[k]);
    }

    return { dA, dB, cells };
  }, [D, loanVis, effStart, effEnd]);

  // Section 06: Cohorts
  const cohortsData = useMemo(() => {
    const byCohort = new Map<
      string,
      {
        lab: string;
        gestion: string;
        order: number;
        count: number;
        bal: number;
        d30: number;
        d90: number;
        ids: string[];
      }
    >();

    for (const item of visibleOpenLoans) {
      const rel = item.d[6] as string;
      if (!rel) continue;
      const y = parseInt(rel.slice(0, 4), 10);
      const m = parseInt(rel.slice(5, 7), 10);

      let k: string;
      let lab: string;
      let gestion: string;
      let order: number;

      if (y < 2025) {
        k = String(y);
        lab = String(y);
        gestion = "Anterior";
        order = y * 10;
      } else if (y === 2025) {
        if (m < 6) {
          k = "2025a";
          lab = "2025 · ene–may";
          gestion = "Anterior";
          order = 20250;
        } else {
          k = "2025b";
          lab = "2025 · jun–dic";
          gestion = "Nueva";
          order = 20255;
        }
      } else {
        k = String(y);
        lab = String(y);
        gestion = "Nueva";
        order = y * 10;
      }

      if (!byCohort.has(k)) {
        byCohort.set(k, {
          lab,
          gestion,
          order,
          count: 0,
          bal: 0,
          d30: 0,
          d90: 0,
          ids: [],
        });
      }

      const cObj = byCohort.get(k)!;
      const bal = item.d[3] as number;
      const bIdx = item.d[5] as number;

      cObj.count++;
      cObj.bal += bal;
      if (bIdx >= 2) cObj.d30 += bal;
      if (bIdx >= 4) cObj.d90 += bal;
      cObj.ids.push(item.id);
    }

    return Array.from(byCohort.values()).sort((a, b) => a.order - b.order);
  }, [visibleOpenLoans]);

  return (
    <div className="space-y-6 pb-16">
      {/* Top Header / Sticky Controls */}
      <div className="sticky top-0 z-20 rounded-xl border border-border-subtle bg-bg-surface/95 p-4 shadow-sm backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Segment Chips */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Segmento
            </span>
            <div className="flex gap-1.5">
              {D.segments.map((seg, idx) => {
                const active = selectedSegs.has(seg);
                return (
                  <button
                    key={seg}
                    onClick={() => {
                      const next = new Set(selectedSegs);
                      if (active && next.size > 1) {
                        next.delete(seg);
                      } else {
                        next.add(seg);
                      }
                      setSelectedSegs(next);
                    }}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all ${
                      active
                        ? "bg-[#620494] text-white shadow-xs"
                        : "border border-border-subtle bg-bg-surface text-fg-muted hover:border-border-strong"
                    }`}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: SEG_COLORS[idx] }}
                    />
                    {seg}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Period Switcher */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Periodo
            </span>
            <div className="flex rounded-lg border border-border-subtle bg-bg-raised p-0.5 text-xs">
              {(["todo", "anio", "mes", "semana", "rango"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`rounded-md px-2.5 py-1 font-medium capitalize transition-all ${
                    period === p
                      ? "bg-bg-surface text-fg shadow-xs"
                      : "text-fg-muted hover:text-fg"
                  }`}
                >
                  {p === "anio" ? "Año" : p}
                </button>
              ))}
            </div>
          </div>

          {period === "rango" && (
            <div className="flex items-center gap-2 text-xs">
              <input
                type="date"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                className="rounded border border-border-subtle bg-bg-surface px-2 py-1 text-fg"
              />
              <span>a</span>
              <input
                type="date"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                className="rounded border border-border-subtle bg-bg-surface px-2 py-1 text-fg"
              />
            </div>
          )}
        </div>
      </div>

      {/* SECTION 01: RESUMEN EJECUTIVO */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-sm font-bold text-fg-subtle">01</span>
            <h2 className="text-lg font-semibold text-fg">Resumen ejecutivo</h2>
          </div>
          <span className="text-xs text-fg-muted">
            Valores según segmentos y periodo seleccionados al {D.asof}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Card 1: Saldo abierto */}
          <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
            <div className="absolute top-0 left-0 h-1 w-full bg-[#620494]" />
            <div className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
              Saldo abierto
            </div>
            <div className="mt-2 text-2xl font-bold text-fg">
              {fmtMoney(kpis.totalBal)}
            </div>
            <div className="mt-1 text-xs text-fg-muted">
              {kpis.totalCount.toLocaleString()} préstamos vigentes
            </div>
          </div>

          {/* Card 2: CeR 30+ */}
          <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
            <div
              className={`absolute top-0 left-0 h-1 w-full ${
                kpis.cer30Pct <= 15
                  ? "bg-emerald-500"
                  : kpis.cer30Pct <= 28
                  ? "bg-amber-500"
                  : "bg-rose-500"
              }`}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                CeR 30+
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${getRagColor(
                  kpis.cer30Pct,
                  15,
                  28,
                )}`}
              >
                {fmtPct(kpis.cer30Pct)}
              </span>
            </div>
            <div className="mt-2 text-2xl font-bold text-fg">
              {fmtPct(kpis.cer30Pct)}
            </div>
            <div className="mt-1 text-xs text-fg-muted">
              Mora &gt; 30d (umbral alerta &gt; 15%)
            </div>
          </div>

          {/* Card 3: CeR 90+ */}
          <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
            <div
              className={`absolute top-0 left-0 h-1 w-full ${
                kpis.cer90Pct <= 8
                  ? "bg-emerald-500"
                  : kpis.cer90Pct <= 18
                  ? "bg-amber-500"
                  : "bg-rose-500"
              }`}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                CeR 90+
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${getRagColor(
                  kpis.cer90Pct,
                  8,
                  18,
                )}`}
              >
                {fmtPct(kpis.cer90Pct)}
              </span>
            </div>
            <div className="mt-2 text-2xl font-bold text-fg">
              {fmtPct(kpis.cer90Pct)}
            </div>
            <div className="mt-1 text-xs text-fg-muted">
              Deterioro severo &gt; 90d (umbral &gt; 8%)
            </div>
          </div>

          {/* Card 4: Recaudado jun-25-> */}
          <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
            <div className="absolute top-0 left-0 h-1 w-full bg-emerald-600" />
            <div className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
              Recaudado jun-25→
            </div>
            <div className="mt-2 text-2xl font-bold text-fg">
              {fmtMoney(kpis.recoveredJun25)}
            </div>
            <div className="mt-1 text-xs text-fg-muted">
              Cobros reales (principal + ingresos)
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 02: DISTRIBUCIÓN DE LA MORA POR SEGMENTO */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-fg-subtle">02</span>
          <h2 className="text-lg font-semibold text-fg">
            Distribución de la mora por segmento
          </h2>
        </div>

        <div className="rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
          <div className="space-y-4">
            {distributionData.rows.map((row) => (
              <div key={row.name} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: row.color }}
                    />
                    <span className="font-semibold text-fg">{row.name}</span>
                  </div>
                  <span className="font-mono text-fg-muted">
                    {fmtMoney(row.totalBal)} · {row.totalCount} préstamos
                  </span>
                </div>

                {/* Stacked bar */}
                <div className="flex h-7 w-full overflow-hidden rounded-lg bg-bg-raised">
                  {row.buckets.map((b, bIdx) => {
                    if (row.totalBal <= 0 || b.bal <= 0) return null;
                    const widthPct = (b.bal / row.totalBal) * 100;
                    return (
                      <button
                        key={bIdx}
                        onClick={() =>
                          triggerModal(
                            `${row.name} · ${D.buckets[bIdx]}`,
                            `${fmtMoney(b.bal)} · ${b.count} préstamos`,
                            LOAN_COLS,
                            b.ids.map(getLoanRow),
                            `mora_${D.buckets[bIdx].replace(/\W+/g, "")}`,
                          )
                        }
                        style={{
                          width: `${widthPct}%`,
                          backgroundColor: D.bucketColors[bIdx],
                        }}
                        className="group relative flex items-center justify-center transition-opacity hover:opacity-90"
                        title={`${D.buckets[bIdx]}: ${fmtMoney(b.bal)} (${b.count} préstamos)`}
                      >
                        {widthPct >= 5 && (
                          <span className="text-[10px] font-bold text-white drop-shadow-xs">
                            {b.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Provisioning summary row */}
          <div className="mt-6 flex flex-wrap gap-8 border-t border-border-subtle pt-4">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                Provisión estimada
              </span>
              <div className="text-xl font-bold text-fg">
                {fmtMoney(distributionData.prov)}
              </div>
              <div className="text-xs text-fg-muted">
                {distributionData.totalBal > 0
                  ? fmtPct((distributionData.prov / distributionData.totalBal) * 100)
                  : "0%"}{" "}
                de la cartera
              </div>
            </div>
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                Valor estimado (neto)
              </span>
              <div className="text-xl font-bold text-fg">
                {fmtMoney(distributionData.totalBal - distributionData.prov)}
              </div>
              <div className="text-xs text-fg-muted">saldo − provisión</div>
            </div>
          </div>

          {/* Legend */}
          <div className="mt-4 flex flex-wrap gap-3 border-t border-border-subtle pt-3 text-xs">
            {D.buckets.map((bName, i) => (
              <div key={bName} className="flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: D.bucketColors[i] }}
                />
                <span className="text-fg-muted">{bName}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SECTION 03: MATRIZ DE TRANSICIÓN 7X7 */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-fg-subtle">03</span>
          <h2 className="text-lg font-semibold text-fg">Migración entre tramos</h2>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
          {migrationMatrix ? (
            <div>
              <div className="mb-3 text-xs text-fg-muted">
                Inicio: <b className="text-fg">{migrationMatrix.dA}</b> → Fin:{" "}
                <b className="text-fg">{migrationMatrix.dB}</b> (instantáneas más
                cercanas al periodo)
              </div>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="p-2 text-right text-[10px] font-semibold text-fg-subtle">
                      Inicio \ Fin
                    </th>
                    {D.buckets.map((b) => (
                      <th
                        key={b}
                        className="p-2 text-center text-[10px] font-semibold text-fg-subtle"
                      >
                        {b}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {D.buckets.map((startName, i) => (
                    <tr key={startName}>
                      <td className="p-2 text-right font-medium text-fg">
                        {startName}
                      </td>
                      {D.buckets.map((endName, j) => {
                        const ids = migrationMatrix.cells[i][j];
                        const count = ids.length;
                        const isDiag = i === j;
                        const isImproved = j < i;
                        const isWorse = j > i;

                        let bgClass = "bg-bg-surface text-fg-subtle";
                        if (count > 0) {
                          if (isDiag) bgClass = "bg-bg-raised text-fg font-bold";
                          else if (isImproved)
                            bgClass = "bg-emerald-100 text-emerald-800 font-bold";
                          else if (isWorse)
                            bgClass = "bg-rose-100 text-rose-800 font-bold";
                        }

                        return (
                          <td
                            key={endName}
                            onClick={() => {
                              if (count > 0) {
                                triggerModal(
                                  `Migración: ${startName} → ${endName}`,
                                  `${migrationMatrix.dA} → ${migrationMatrix.dB} · ${count} préstamos`,
                                  LOAN_COLS,
                                  ids.map(getLoanRow),
                                  `migracion_${startName}_a_${endName}`,
                                );
                              }
                            }}
                            className={`p-2 text-center rounded-sm transition-all ${bgClass} ${
                              count > 0 ? "cursor-pointer hover:opacity-80" : ""
                            }`}
                          >
                            {count > 0 ? count : "·"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border-strong p-6 text-center text-xs text-fg-muted">
              Se activa con ≥ 2 días de historial en la base de datos.
            </div>
          )}
        </div>
      </section>

      {/* SECTION 06: COSECHAS */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-fg-subtle">06</span>
          <h2 className="text-lg font-semibold text-fg">
            Cosechas por periodo de desembolso
          </h2>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border-subtle text-[10px] uppercase tracking-wider text-fg-subtle">
                <th className="py-2.5 px-3">Periodo</th>
                <th className="py-2.5 px-3">Gestión</th>
                <th className="py-2.5 px-3 text-right">Préstamos</th>
                <th className="py-2.5 px-3 text-right">Saldo</th>
                <th className="py-2.5 px-3 text-right">CeR 30+</th>
                <th className="py-2.5 px-3 text-right">CeR 90+</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {cohortsData.map((c) => (
                <tr key={c.lab} className="hover:bg-bg-raised/50">
                  <td className="py-2.5 px-3 font-mono font-medium text-fg">
                    {c.lab}
                  </td>
                  <td className="py-2.5 px-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        c.gestion === "Anterior"
                          ? "bg-stone-800 text-stone-100"
                          : "bg-[#F1E6F8] text-[#4C0374]"
                      }`}
                    >
                      {c.gestion}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono">
                    <button
                      onClick={() =>
                        triggerModal(
                          `Cosecha ${c.lab}`,
                          `${c.count} préstamos · ${fmtMoney(c.bal)}`,
                          LOAN_COLS,
                          c.ids.map(getLoanRow),
                          `cosecha_${c.lab.replace(/\W+/g, "_")}`,
                        )
                      }
                      className="cursor-pointer text-[#620494] underline hover:text-[#4C0374]"
                    >
                      {c.count}
                    </button>
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-fg">
                    {fmtMoney(c.bal)}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-fg">
                    {c.bal > 0 ? fmtPct((c.d30 / c.bal) * 100, 0) : "—"}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-fg">
                    {c.bal > 0 ? fmtPct((c.d90 / c.bal) * 100, 0) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* DRILLDOWN MODAL */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-2xl bg-bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-border-subtle p-5">
              <div>
                <h3 className="text-base font-semibold text-fg">{modalTitle}</h3>
                <p className="text-xs text-fg-muted">{modalSubtitle}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={downloadCsv}
                  className="flex items-center gap-1.5 rounded-lg bg-[#620494] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#4C0374]"
                >
                  <Download className="h-3.5 w-3.5" />
                  Descargar CSV (Excel)
                </button>
                <button
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg p-1.5 text-fg-muted hover:bg-bg-raised hover:text-fg"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="overflow-auto p-5">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="sticky top-0 border-b border-border-subtle bg-bg-surface text-[10px] uppercase tracking-wider text-fg-subtle">
                    {modalCols.map((col, idx) => (
                      <th
                        key={idx}
                        className={`py-2 px-3 ${
                          ["Saldo", "DPD", "Por cobrar"].includes(col)
                            ? "text-right"
                            : ""
                        }`}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {modalRows.map((r, rIdx) => (
                    <tr key={rIdx} className="hover:bg-bg-raised/50">
                      {r.map((val, cIdx) => {
                        const colName = modalCols[cIdx];
                        const isNum = typeof val === "number";
                        let text = String(val ?? "");
                        if (isNum) {
                          text =
                            colName === "DPD"
                              ? String(Math.round(val))
                              : fmtMoney2(val);
                        }
                        if (colName === "Tramo") {
                          const bIdx = D.buckets.indexOf(
                            String(val) as (typeof D.buckets)[number],
                          );
                          const bg =
                            bIdx >= 0 ? D.bucketColors[bIdx] : "#620494";
                          return (
                            <td key={cIdx} className="py-2 px-3">
                              <span
                                style={{ backgroundColor: bg }}
                                className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                              >
                                {text}
                              </span>
                            </td>
                          );
                        }
                        return (
                          <td
                            key={cIdx}
                            className={`py-2 px-3 font-mono ${
                              ["Saldo", "DPD", "Por cobrar"].includes(colName)
                                ? "text-right"
                                : ""
                            }`}
                          >
                            {text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

