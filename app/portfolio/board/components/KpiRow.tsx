"use client";

import React from "react";

import {
  BASE_SALDO_LABELS,
  type BaseSaldo,
} from "@/lib/portfolio/board-compute";

interface KpiRowProps {
  asof: string;
  policyVersion?: string;
  baseSaldo?: BaseSaldo;
  totalBal: number;
  totalCount: number;
  cer30Pct: number;
  cer90Pct: number;
  recoveredJun25: number;
  sentToProvision?: number;
  deltaCer30: number | null;
  deltaLabel: string;
}

export function KpiRow({
  asof,
  policyVersion = "v1.0",
  baseSaldo = "total",
  totalBal,
  totalCount,
  cer30Pct,
  cer90Pct,
  recoveredJun25,
  sentToProvision = 0,
  deltaCer30,
  deltaLabel,
}: KpiRowProps) {
  const baseLabel = BASE_SALDO_LABELS[baseSaldo];
  const fmtMoney = (x: number) =>
    "$" + Math.round(x || 0).toLocaleString("en-US");
  const fmtPct = (x: number, d = 1) => (x || 0).toFixed(d) + "%";

  const getRagColor = (v: number, greenLimit: number, amberLimit: number) => {
    if (v <= greenLimit)
      return "text-emerald-700 bg-emerald-50 border-emerald-200";
    if (v <= amberLimit) return "text-amber-700 bg-amber-50 border-amber-200";
    return "text-rose-700 bg-rose-50 border-rose-200";
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-fg-subtle">01</span>
          <h2 className="text-lg font-semibold text-fg">Resumen ejecutivo</h2>
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span className="rounded-full bg-[#F1E6F8] px-2.5 py-0.5 text-[11px] font-semibold text-[#4C0374]">
            Política {policyVersion}
          </span>
          <span>Valores según el segmento, el periodo y la base del saldo seleccionados al {asof}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {/* Card 1: Saldo abierto */}
        <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
          <div className="absolute top-0 left-0 h-1 w-full bg-[#620494]" />
          <div className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Saldo abierto
          </div>
          <div className="mt-2 text-2xl font-bold text-fg">
            {fmtMoney(totalBal)}
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            {totalCount.toLocaleString("en-US")} préstamos · {baseLabel}
          </div>
        </div>

        {/* Card 2: CeR 30+ with Delta (Fase 3.3) */}
        <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
          <div
            className={`absolute top-0 left-0 h-1 w-full ${
              cer30Pct <= 15
                ? "bg-emerald-500"
                : cer30Pct <= 28
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
                cer30Pct,
                15,
                28,
              )}`}
            >
              {fmtPct(cer30Pct)}
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-fg">
              {fmtPct(cer30Pct)}
            </span>
            {deltaCer30 !== null && (
              <span
                className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
                  deltaCer30 < 0
                    ? "text-emerald-600"
                    : deltaCer30 > 0
                      ? "text-rose-600"
                      : "text-fg-muted"
                }`}
              >
                {deltaCer30 < 0 ? "▼" : deltaCer30 > 0 ? "▲" : "="}{" "}
                {Math.abs(deltaCer30).toFixed(1)} pp {deltaLabel}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            Mora &gt; 30d (umbral alerta &gt; 15%)
          </div>
        </div>

        {/* Card 3: CeR 90+ */}
        <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
          <div
            className={`absolute top-0 left-0 h-1 w-full ${
              cer90Pct <= 8
                ? "bg-emerald-500"
                : cer90Pct <= 18
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
                cer90Pct,
                8,
                18,
              )}`}
            >
              {fmtPct(cer90Pct)}
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold text-fg">
            {fmtPct(cer90Pct)}
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            deterioro &gt; 90d · {baseLabel}
          </div>
        </div>

        {/* Card 4: Recaudado jun-25-> */}
        <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
          <div className="absolute top-0 left-0 h-1 w-full bg-emerald-600" />
          <div className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Recaudado jun-25→
          </div>
          <div className="mt-2 text-2xl font-bold text-fg">
            {fmtMoney(recoveredJun25)}
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            Cobros reales (principal + ingresos)
          </div>
        </div>

        {/* Card 5: Enviado a provisión */}
        <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
          <div className="absolute top-0 left-0 h-1 w-full bg-[#620494]" />
          <div className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Enviado a provisión
          </div>
          <div className="mt-2 text-2xl font-bold text-fg">
            {fmtMoney(sentToProvision)}
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            Traspasos a provisión · histórico
          </div>
        </div>
      </div>
    </section>
  );
}

