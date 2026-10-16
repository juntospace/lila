"use client";

import React, { useMemo, useState } from "react";

import type { BoardDataset } from "@/lib/portfolio/board";
import {
  collectSeries,
  computeMigrationMatrix,
  computeRangeAndGranularity,
  computeVisibility,
  dAdd,
  delinqAgg,
  LOAN_COLS,
  type PeriodPreset,
  SEG_COLORS,
} from "@/lib/portfolio/board-compute";

import { PortfolioWarningsBanner } from "../warnings-banner";
import { Cohorts, type CohortRow } from "./components/Cohorts";
import { Collections } from "./components/Collections";
import { Controls } from "./components/Controls";
import { Delinquency } from "./components/Delinquency";
import { Distribution, type DistributionRow } from "./components/Distribution";
import { KpiRow } from "./components/KpiRow";
import { LoanModal } from "./components/LoanModal";
import { Migration } from "./components/Migration";

interface BoardViewProps {
  data: BoardDataset;
}

export function BoardReportView({ data: D }: BoardViewProps) {
  // Global filter state
  const [selectedSegs, setSelectedSegs] = useState<Set<string>>(
    () => new Set(D.segments),
  );
  const [period, setPeriod] = useState<PeriodPreset>("todo");
  const [rangeStart, setRangeStart] = useState<string>(() =>
    dAdd(D.asof, -90),
  );
  const [rangeEnd, setRangeEnd] = useState<string>(() => D.asof);

  const [filterTg, setFilterTg] = useState<Set<string>>(
    () => new Set(D.filtVals.tg),
  );
  const [filterTc, setFilterTc] = useState<Set<string>>(
    () => new Set(D.filtVals.tc),
  );
  const [filterGc, setFilterGc] = useState<Set<string>>(
    () => new Set(D.filtVals.gc),
  );
  const [filterMr, setFilterMr] = useState<Set<string>>(
    () => new Set(D.filtVals.mr),
  );

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalSubtitle, setModalSubtitle] = useState("");
  const [modalCols, setModalCols] = useState<string[]>(LOAN_COLS);
  const [modalRows, setModalRows] = useState<(string | number)[][]>([]);
  const [modalFilename, setModalFilename] = useState("lila_prestamos");

  // Recompute combo and loan visibility
  const { comboVis, loanVis, visibleOpenLoans } = useMemo(
    () =>
      computeVisibility(D, {
        selectedSegs,
        filterTg,
        filterTc,
        filterGc,
        filterMr,
      }),
    [D, selectedSegs, filterTg, filterTc, filterGc, filterMr],
  );

  // Range and granularity
  const { effStart, effEnd, gran, granNote } = useMemo(
    () => computeRangeAndGranularity(D, period, rangeStart, rangeEnd),
    [D, period, rangeStart, rangeEnd],
  );

  // Delinquency series & CeR 30+ delta (Fase 3.3 & 3.5)
  const delinqData = useMemo(
    () => delinqAgg(D, comboVis, effStart, effEnd, gran, period),
    [D, comboVis, effStart, effEnd, gran, period],
  );

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

  // Section 02: Distribution & Provisioning
  const distributionData = useMemo(() => {
    const rows: DistributionRow[] = [];

    const activeSegIndices = D.segments
      .map((_, i) => i)
      .filter((i) => selectedSegs.has(D.segments[i]));

    for (const si of activeSegIndices) {
      const segName = D.segments[si];
      const per = D.buckets.map(() => ({
        count: 0,
        bal: 0,
        ids: [] as string[],
      }));
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

  // Section 03: Transposed Migration Matrix 7x7
  const migrationMatrix = useMemo(
    () => computeMigrationMatrix(D, loanVis, effStart, effEnd),
    [D, loanVis, effStart, effEnd],
  );

  // Section 04: Cobrado vs. Programado
  const collectionsSeries = useMemo(
    () => collectSeries(D, loanVis, gran, effStart, effEnd),
    [D, loanVis, gran, effStart, effEnd],
  );

  // Section 06: Cohorts
  const cohortsData = useMemo(() => {
    const byCohort = new Map<string, CohortRow>();
    const handoverYear = parseInt(D.handover.slice(0, 4), 10) || 2025;
    const handoverMonth = parseInt(D.handover.slice(5, 7), 10) || 6;

    for (const item of visibleOpenLoans) {
      const rel = item.d[6] as string;
      if (!rel) continue;
      const y = parseInt(rel.slice(0, 4), 10);
      const m = parseInt(rel.slice(5, 7), 10);

      let k: string;
      let lab: string;
      let gestion: string;
      let order: number;

      if (y < handoverYear) {
        k = String(y);
        lab = String(y);
        gestion = "Anterior";
        order = y * 10;
      } else if (y === handoverYear) {
        if (m < handoverMonth) {
          k = `${y}a`;
          lab = `${y} · ene–may`;
          gestion = "Anterior";
          order = y * 10;
        } else {
          k = `${y}b`;
          lab = `${y} · jun–dic`;
          gestion = "Nueva";
          order = y * 10 + 5;
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
  }, [D.handover, visibleOpenLoans]);

  return (
    <div className="space-y-6 pb-16">
      {/* Data Quality Warnings Banner (Fase 4.3) */}
      {D.warnings && D.warnings.length > 0 && (
        <PortfolioWarningsBanner warnings={D.warnings} />
      )}

      {/* Top Sticky Controls & Filters */}
      <Controls
        data={D}
        selectedSegs={selectedSegs}
        onChangeSegs={setSelectedSegs}
        period={period}
        onChangePeriod={setPeriod}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        onChangeRangeStart={setRangeStart}
        onChangeRangeEnd={setRangeEnd}
        filterTg={filterTg}
        onChangeTg={setFilterTg}
        filterTc={filterTc}
        onChangeTc={setFilterTc}
        filterGc={filterGc}
        onChangeGc={setFilterGc}
        filterMr={filterMr}
        onChangeMr={setFilterMr}
      />

      {/* SECTION 01: RESUMEN EJECUTIVO */}
      <KpiRow
        asof={D.asof}
        policyVersion={D.policyVersion}
        totalBal={kpis.totalBal}
        totalCount={kpis.totalCount}
        cer30Pct={kpis.cer30Pct}
        cer90Pct={kpis.cer90Pct}
        recoveredJun25={kpis.recoveredJun25}
        deltaCer30={delinqData.deltaCer30}
        deltaLabel={delinqData.deltaLabel}
      />

      {/* SECTION 02: DISTRIBUCIÓN DE LA MORA POR SEGMENTO */}
      <Distribution
        data={D}
        rows={distributionData.rows}
        prov={distributionData.prov}
        totalBal={distributionData.totalBal}
        getLoanRow={getLoanRow}
        onTriggerModal={triggerModal}
      />

      {/* SECTION 03: MATRIZ DE TRANSICIÓN 7X7 (TRANSPUESTA) */}
      <Migration
        data={D}
        matrix={migrationMatrix}
        getLoanRow={getLoanRow}
        onTriggerModal={triggerModal}
      />

      {/* SECTION 04: RECAUDACIÓN: COBRADO VS. PROGRAMADO */}
      <Collections
        series={collectionsSeries}
        granNote={granNote}
        onTriggerModal={triggerModal}
      />

      {/* SECTION 05: EVOLUCIÓN DE LA MOROSIDAD */}
      <Delinquency points={delinqData.groupedPoints} />

      {/* SECTION 06: COSECHAS */}
      <Cohorts
        cohorts={cohortsData}
        getLoanRow={getLoanRow}
        onTriggerModal={triggerModal}
      />

      {/* DRILLDOWN MODAL */}
      <LoanModal
        open={modalOpen}
        title={modalTitle}
        subtitle={modalSubtitle}
        cols={modalCols}
        rows={modalRows}
        filename={modalFilename}
        buckets={D.buckets}
        bucketColors={D.bucketColors}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
