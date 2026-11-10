"use client";

import React, { useState } from "react";

import type { DelinqPoint } from "@/lib/portfolio/board-compute";

interface DelinquencyProps {
  points: DelinqPoint[];
}

export function Delinquency({ points }: DelinquencyProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const fmtMoney = (x: number) =>
    "$" + Math.round(x || 0).toLocaleString("en-US");

  const width = 880;
  const height = 260;
  const padL = 68;
  const padR = 52;
  const padT = 20;
  const padB = 42;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxDollar = Math.max(1, ...points.map((p) => Math.max(p.d30, p.d90)));
  const n = points.length;

  const xPos = (i: number) =>
    n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW;
  const yDollar = (v: number) => padT + plotH - (v / maxDollar) * plotH;
  // Right axis: fixed 0-100% scale (Fase 3.5)
  const yPct = (pct: number) =>
    padT + plotH - (Math.min(100, Math.max(0, pct)) / 100) * plotH;

  const lineD30 = points
    .map((p, i) => `${xPos(i).toFixed(1)},${yDollar(p.d30).toFixed(1)}`)
    .join(" ");
  const linePct30 = points
    .map((p, i) => `${xPos(i).toFixed(1)},${yPct(p.pct30).toFixed(1)}`)
    .join(" ");
  const linePct90 = points
    .map((p, i) => `${xPos(i).toFixed(1)},${yPct(p.pct90).toFixed(1)}`)
    .join(" ");

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm font-bold text-fg-subtle">05</span>
        <h2 className="text-lg font-semibold text-fg">
          Evolución de la morosidad
        </h2>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs space-y-4">
        {points.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-strong p-6 text-center text-xs text-fg-muted">
            No hay puntos de morosidad en el rango y filtros seleccionados.
          </div>
        ) : (
          <>
            {points.length === 1 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Solo hay 1 instantánea en este periodo ({points[0].date}). Carga
                más cortes históricos para visualizar la tendencia temporal.
              </div>
            )}

            <div className="overflow-x-auto">
              <svg
                viewBox={`0 0 ${width} ${height}`}
                className="w-full min-w-[600px] h-auto select-none"
              >
                {/* Grid lines + Left ($) & Right (0-100%) axes */}
                {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                  const valDollar = maxDollar * t;
                  const valPct = 100 * t;
                  const y = padT + plotH - t * plotH;
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
                      {/* Left Axis: $ */}
                      <text
                        x={padL - 8}
                        y={y + 3}
                        textAnchor="end"
                        className="fill-fg-subtle text-[10px] font-mono"
                      >
                        {fmtMoney(valDollar)}
                      </text>
                      {/* Right Axis: Fixed 0-100% */}
                      <text
                        x={width - padR + 8}
                        y={y + 3}
                        textAnchor="start"
                        className="fill-fg-subtle text-[10px] font-mono"
                      >
                        {Math.round(valPct)}%
                      </text>
                    </g>
                  );
                })}

                {/* Lines when >= 2 points */}
                {points.length > 1 && (
                  <>
                    <polyline
                      fill="none"
                      stroke="#620494"
                      strokeWidth={2.5}
                      points={lineD30}
                    />
                    <polyline
                      fill="none"
                      stroke="#D9743B"
                      strokeWidth={2}
                      strokeDasharray="5 3"
                      points={linePct30}
                    />
                    <polyline
                      fill="none"
                      stroke="#973A4A"
                      strokeWidth={2}
                      strokeDasharray="2 3"
                      points={linePct90}
                    />
                  </>
                )}

                {/* Data points and X-axis labels */}
                {points.map((p, i) => {
                  const cx = xPos(i);
                  const showLabel =
                    n <= 12 || i % Math.ceil(n / 10) === 0 || i === n - 1;
                  const isHovered = hoveredIdx === i;
                  const fullTooltip = `${p.date}\nMora: ${fmtMoney(p.d30)}\n% mora: ${p.pct30.toFixed(1)}%`;

                  return (
                    <g key={p.key} className="pointer-events-none">
                      <circle
                        cx={cx}
                        cy={yDollar(p.d30)}
                        r={isHovered ? 6 : 4}
                        fill="#620494"
                        stroke={isHovered ? "#FFFFFF" : undefined}
                        strokeWidth={isHovered ? 2 : undefined}
                      >
                        <title>{fullTooltip}</title>
                      </circle>
                      <circle
                        cx={cx}
                        cy={yPct(p.pct30)}
                        r={isHovered ? 6 : 4}
                        fill="#D9743B"
                        stroke={isHovered ? "#FFFFFF" : undefined}
                        strokeWidth={isHovered ? 2 : undefined}
                      >
                        <title>{fullTooltip}</title>
                      </circle>
                      <circle
                        cx={cx}
                        cy={yPct(p.pct90)}
                        r={isHovered ? 5.5 : 3.5}
                        fill="#973A4A"
                        stroke={isHovered ? "#FFFFFF" : undefined}
                        strokeWidth={isHovered ? 1.5 : undefined}
                      >
                        <title>{`${p.date}\nCeR 90+: ${p.pct90.toFixed(1)}%`}</title>
                      </circle>

                      {showLabel && (
                        <text
                          x={cx}
                          y={height - 14}
                          textAnchor="middle"
                          className="fill-fg-muted text-[10px] font-mono"
                        >
                          {p.key}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Invisible hover columns across the plot area */}
                {points.map((p, i) => {
                  const cx = xPos(i);
                  const colW = n <= 1 ? plotW : plotW / (n - 1);
                  const xStart = n <= 1 ? padL : Math.max(padL, cx - colW / 2);
                  const xEnd =
                    n <= 1 ? padL + plotW : Math.min(width - padR, cx + colW / 2);
                  const actualW = Math.max(12, xEnd - xStart);
                  const fullTooltip = `${p.date}\nMora: ${fmtMoney(p.d30)}\n% mora: ${p.pct30.toFixed(1)}%`;

                  return (
                    <rect
                      key={`hover-col-${p.key}`}
                      x={cx - actualW / 2}
                      y={padT}
                      width={actualW}
                      height={plotH}
                      fill="transparent"
                      className="cursor-pointer"
                      onMouseEnter={() => setHoveredIdx(i)}
                      onMouseLeave={() => setHoveredIdx(null)}
                    >
                      <title>{fullTooltip}</title>
                    </rect>
                  );
                })}

                {/* Interactive Tooltip matching reference report */}
                {hoveredIdx !== null && points[hoveredIdx] && (
                  (() => {
                    const p = points[hoveredIdx];
                    const cx = xPos(hoveredIdx);
                    const tooltipW = 140;
                    const tooltipH = 58;
                    const tooltipX =
                      cx + 12 + tooltipW > width - padR
                        ? cx - tooltipW - 12
                        : cx + 12;
                    const tooltipY = Math.max(
                      padT + 4,
                      Math.min(yPct(p.pct30) - 10, height - padB - tooltipH),
                    );

                    return (
                      <g className="pointer-events-none transition-all duration-75">
                        {/* Guideline */}
                        <line
                          x1={cx}
                          y1={padT}
                          x2={cx}
                          y2={padT + plotH}
                          stroke="#71717A"
                          strokeDasharray="3 3"
                          strokeWidth={1}
                          opacity={0.7}
                        />

                        {/* Tooltip Card */}
                        <rect
                          x={tooltipX}
                          y={tooltipY}
                          width={tooltipW}
                          height={tooltipH}
                          rx={8}
                          fill="#18181B"
                          stroke="#3F3F46"
                          strokeWidth={1}
                          filter="drop-shadow(0 4px 6px rgba(0, 0, 0, 0.4))"
                        />
                        <text
                          x={tooltipX + 10}
                          y={tooltipY + 18}
                          fill="#FFFFFF"
                          fontSize="11"
                          fontWeight="700"
                          fontFamily="monospace"
                        >
                          {p.date}
                        </text>
                        <text
                          x={tooltipX + 10}
                          y={tooltipY + 34}
                          fill="#E4E4E7"
                          fontSize="11"
                        >
                          Mora: <tspan fontWeight="bold" fill="#C084FC">{fmtMoney(p.d30)}</tspan>
                        </text>
                        <text
                          x={tooltipX + 10}
                          y={tooltipY + 49}
                          fill="#E4E4E7"
                          fontSize="11"
                        >
                          % mora: <tspan fontWeight="bold" fill="#FB923C">{p.pct30.toFixed(1)}%</tspan>
                        </text>
                      </g>
                    );
                  })()
                )}
              </svg>
            </div>
          </>
        )}

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-5 border-t border-border-subtle pt-3 text-xs text-fg-muted">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#620494]" />
            <span>Saldo en mora 30+ ($ eje izq.)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#D9743B]" />
            <span>CeR 30+ (% eje der. 0–100%)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#973A4A]" />
            <span>CeR 90+ (% eje der. 0–100%)</span>
          </div>
        </div>
      </div>
    </section>
  );
}

