"use client";

import React from "react";

import { LOAN_COLS } from "@/lib/portfolio/board-compute";

export interface CohortRow {
  lab: string;
  gestion: string;
  order: number;
  count: number;
  bal: number;
  d30: number;
  d90: number;
  ids: string[];
}

interface CohortsProps {
  cohorts: CohortRow[];
  getLoanRow: (id: string) => (string | number)[];
  onTriggerModal: (
    title: string,
    subtitle: string,
    cols: string[],
    rows: (string | number)[][],
    fname: string,
  ) => void;
}

export function Cohorts({
  cohorts,
  getLoanRow,
  onTriggerModal,
}: CohortsProps) {
  const fmtMoney = (x: number) =>
    "$" + Math.round(x || 0).toLocaleString("en-US");
  const fmtPct = (x: number, d = 1) => (x || 0).toFixed(d) + "%";

  return (
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
            {cohorts.map((c) => (
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
                    type="button"
                    onClick={() =>
                      onTriggerModal(
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
  );
}

