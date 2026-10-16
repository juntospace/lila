"use client";

import React from "react";

import {
  type CollectSeriesResult,
  EXP_COLS,
  PAY_COLS,
} from "@/lib/portfolio/board-compute";

interface CollectionsProps {
  series: CollectSeriesResult;
  granNote: string;
  onTriggerModal: (
    title: string,
    subtitle: string,
    cols: string[],
    rows: (string | number)[][],
    fname: string,
  ) => void;
}

export function Collections({
  series,
  granNote,
  onTriggerModal,
}: CollectionsProps) {
  const fmtMoney = (x: number) =>
    "$" + Math.round(x || 0).toLocaleString("en-US");

  const { buckets, totalCollected, totalScheduled, efficiencyPct } = series;

  const effClass =
    efficiencyPct === null
      ? "text-fg-muted bg-bg-raised border-border-subtle"
      : efficiencyPct >= 85
        ? "text-emerald-700 bg-emerald-50 border-emerald-200"
        : efficiencyPct >= 60
          ? "text-amber-700 bg-amber-50 border-amber-200"
          : "text-rose-700 bg-rose-50 border-rose-200";

  // SVG dimensions
  const width = 880;
  const height = 260;
  const padL = 64;
  const padR = 24;
  const padT = 20;
  const padB = 42;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxY = Math.max(
    1,
    ...buckets.map((b) => Math.max(b.total, b.sched)),
  );

  const n = buckets.length;
  const stepX = n > 0 ? plotW / n : plotW;
  const barW = Math.min(36, Math.max(8, stepX * 0.56));

  const yPos = (val: number) => padT + plotH - (val / maxY) * plotH;

  const schedPoints = buckets.map((b, i) => {
    const cx = padL + i * stepX + stepX / 2;
    const cy = yPos(b.sched);
    return { cx, cy, b };
  });

  const polylinePoints = schedPoints
    .map((p) => `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`)
    .join(" ");

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-fg-subtle">04</span>
          <h2 className="text-lg font-semibold text-fg">
            Recaudación: Cobrado vs. Programado
          </h2>
        </div>
        {granNote && (
          <span className="rounded-md bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 border border-amber-200">
            {granNote}
          </span>
        )}
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs space-y-5">
        {/* 3 KPI Summary Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border-subtle bg-bg-raised/40 p-4">
            <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
              Cobrado en el periodo
            </span>
            <div className="mt-1 text-xl font-bold text-fg">
              {fmtMoney(totalCollected)}
            </div>
            <div className="text-xs text-fg-muted">
              Principal + intereses y cargos reales
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle bg-bg-raised/40 p-4">
            <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
              Programado (aprox.)
            </span>
            <div className="mt-1 text-xl font-bold text-fg">
              {fmtMoney(totalScheduled)}
            </div>
            <div className="text-xs text-fg-muted">
              Proyección lineal de cuotas desde desembolso
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle bg-bg-raised/40 p-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                Eficiencia
              </span>
              <span
                className={`rounded border px-1.5 py-0.5 text-xs font-bold ${effClass}`}
              >
                {efficiencyPct !== null ? `${efficiencyPct.toFixed(1)}%` : "—"}
              </span>
            </div>
            <div className="mt-1 text-xl font-bold text-fg">
              {efficiencyPct !== null ? `${efficiencyPct.toFixed(1)}%` : "—"}
            </div>
            <div className="text-xs text-fg-muted">
              Meta ≥ 85% verde · ≥ 60% ámbar
            </div>
          </div>
        </div>

        {/* SVG Chart */}
        {buckets.length > 0 ? (
          <div className="overflow-x-auto">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full min-w-[600px] h-auto select-none"
            >
              {/* Horizontal grid lines */}
              {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                const val = maxY * t;
                const y = yPos(val);
                return (
                  <g key={t}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={width - padR}
                      y2={y}
                      stroke="#E7E4F1"
                      strokeDasharray={t === 0 ? undefined : "3 3"}
                    />
                    <text
                      x={padL - 8}
                      y={y + 3}
                      textAnchor="end"
                      className="fill-fg-subtle text-[10px] font-mono"
                    >
                      {fmtMoney(val)}
                    </text>
                  </g>
                );
              })}

              {/* Stacked Bars (Principal #620494 + Ingresos #C89CE6) */}
              {buckets.map((b, i) => {
                const cx = padL + i * stepX + stepX / 2;
                const x = cx - barW / 2;
                const prinH = (b.prin / maxY) * plotH;
                const incH = (b.inc / maxY) * plotH;
                const yPrin = padT + plotH - prinH;
                const yInc = yPrin - incH;
                const showLabel =
                  n <= 14 || i % Math.ceil(n / 12) === 0 || i === n - 1;

                return (
                  <g key={b.key}>
                    {b.total > 0 && (
                      <g
                        className="cursor-pointer transition-opacity hover:opacity-85"
                        onClick={() =>
                          onTriggerModal(
                            `Cobrado · ${b.key}`,
                            `Total: ${fmtMoney(b.total)} (Principal ${fmtMoney(b.prin)} + Ingresos ${fmtMoney(b.inc)})`,
                            PAY_COLS,
                            b.payDrillRows,
                            `cobrado_${b.key.replace(/\W+/g, "_")}`,
                          )
                        }
                      >
                        <title>{`${b.key} · Cobrado: ${fmtMoney(b.total)} (Principal: ${fmtMoney(b.prin)}, Ingresos: ${fmtMoney(b.inc)})`}</title>
                        <rect
                          x={x}
                          y={yPrin}
                          width={barW}
                          height={Math.max(0, prinH)}
                          fill="#620494"
                          rx={1}
                        />
                        <rect
                          x={x}
                          y={yInc}
                          width={barW}
                          height={Math.max(0, incH)}
                          fill="#C89CE6"
                          rx={1}
                        />
                      </g>
                    )}

                    {showLabel && (
                      <text
                        x={cx}
                        y={height - 14}
                        textAnchor="middle"
                        className="fill-fg-muted text-[10px] font-mono"
                      >
                        {b.key}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Dashed line for Scheduled */}
              {schedPoints.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#1E1622"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  points={polylinePoints}
                />
              )}

              {/* Clickable points for Scheduled */}
              {schedPoints.map(({ cx, cy, b }) =>
                b.sched > 0 ? (
                  <circle
                    key={`sched-${b.key}`}
                    cx={cx}
                    cy={cy}
                    r={4.5}
                    fill="#FFFFFF"
                    stroke="#1E1622"
                    strokeWidth={2}
                    className="cursor-pointer transition-transform hover:scale-125"
                    onClick={() =>
                      onTriggerModal(
                        `Programado · ${b.key}`,
                        `Total programado: ${fmtMoney(b.sched)} (${b.expDrillRows.length} préstamos)`,
                        EXP_COLS,
                        b.expDrillRows,
                        `programado_${b.key.replace(/\W+/g, "_")}`,
                      )
                    }
                  >
                    <title>{`${b.key} · Programado: ${fmtMoney(b.sched)}`}</title>
                  </circle>
                ) : null,
              )}
            </svg>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border-strong p-6 text-center text-xs text-fg-muted">
            No hay cobros ni cuotas programadas en la ventana seleccionada.
          </div>
        )}

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-5 border-t border-border-subtle pt-3 text-xs text-fg-muted">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-xs bg-[#620494]" />
            <span>Principal cobrado</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-xs bg-[#C89CE6]" />
            <span>Ingresos cobrados (interés + mora + cargos)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 border-b-2 border-dashed border-[#1E1622]" />
            <span>Programado (clic en barra o punto para ver préstamos)</span>
          </div>
        </div>
      </div>
    </section>
  );
}

