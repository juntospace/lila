"use client";

import React from "react";

import type { BoardDataset } from "@/lib/portfolio/board";
import { LOAN_COLS } from "@/lib/portfolio/board-compute";

export interface DistributionRow {
  name: string;
  color: string;
  isTotal?: boolean;
  buckets: { count: number; bal: number; ids: string[] }[];
  totalBal: number;
  totalCount: number;
}

interface DistributionProps {
  data: BoardDataset;
  rows: DistributionRow[];
  prov: number;
  totalBal: number;
  getLoanRow: (id: string) => (string | number)[];
  onTriggerModal: (
    title: string,
    subtitle: string,
    cols: string[],
    rows: (string | number)[][],
    fname: string,
  ) => void;
}

export function Distribution({
  data: D,
  rows,
  prov,
  totalBal,
  getLoanRow,
  onTriggerModal,
}: DistributionProps) {
  const fmtMoney = (x: number) =>
    "$" + Math.round(x || 0).toLocaleString("en-US");
  const fmtPct = (x: number, d = 1) => (x || 0).toFixed(d) + "%";

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm font-bold text-fg-subtle">02</span>
        <h2 className="text-lg font-semibold text-fg">
          Distribución de la mora por segmento
        </h2>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
        <div className="space-y-4">
          {rows.map((row) => (
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
                      type="button"
                      onClick={() =>
                        onTriggerModal(
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
        <div className="mt-6 flex flex-wrap items-end justify-between gap-8 border-t border-border-subtle pt-4">
          <div className="flex flex-wrap gap-8">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                Provisión estimada
              </span>
              <div className="text-xl font-bold text-fg">{fmtMoney(prov)}</div>
              <div className="text-xs text-fg-muted">
                {totalBal > 0 ? fmtPct((prov / totalBal) * 100) : "0%"} de la
                cartera
              </div>
            </div>
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                Valor estimado (neto)
              </span>
              <div className="text-xl font-bold text-fg">
                {fmtMoney(totalBal - prov)}
              </div>
              <div className="text-xs text-fg-muted">saldo − provisión</div>
            </div>
          </div>

          {/* Provisioning rates footnote (Fase 3.6) */}
          <div className="text-[11px] text-fg-muted">
            <span className="font-semibold text-fg-subtle">
              Tasas de provisión por tramo:
            </span>{" "}
            {D.buckets
              .map(
                (bName, idx) =>
                  `${bName} ${Math.round((D.provRates[idx] ?? 0) * 100)}%`,
              )
              .join(" · ")}
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
  );
}

