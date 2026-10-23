"use client";

import React, { useState } from "react";
import { Download, Search, Sparkles } from "lucide-react";

import type { ActionPlanItem, ActionPlanSummary } from "@/lib/portfolio/types";

interface CollectionsViewProps {
  plan: ActionPlanItem[];
  resumen: ActionPlanSummary;
  snapshotDate: string;
  policyVersion?: string;
}

export function CollectionsView({
  plan,
  resumen,
  snapshotDate,
  policyVersion = "v1.0",
}: CollectionsViewProps) {
  const [activeTab, setActiveTab] = useState<"hoy" | "todos" | "resumen">("hoy");
  const [search, setSearch] = useState("");
  const [prioFilter, setPrioFilter] = useState<number | null>(null);

  const top40 = plan.slice(0, 40);
  const displayedItems = activeTab === "hoy" ? top40 : plan;

  const filteredItems = displayedItems.filter((item) => {
    if (prioFilter !== null && item.prio !== prioFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        item.cliente.toLowerCase().includes(q) ||
        item.loanno.toLowerCase().includes(q) ||
        item.cel.includes(q) ||
        item.motivo.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const fmtMoney = (x: number) =>
    "$" +
    Math.round(x || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const getPrioBadge = (p: 1 | 2 | 3) => {
    switch (p) {
      case 1:
        return (
          <span className="inline-flex items-center rounded-md border border-rose-500/30 bg-rose-500/15 px-2 py-0.5 text-[11px] font-bold text-rose-400">
            P1
          </span>
        );
      case 2:
        return (
          <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-400">
            P2
          </span>
        );
      case 3:
        return (
          <span className="inline-flex items-center rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-400">
            P3
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Action Bar & Summary Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border-subtle bg-bg-surface p-4 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/15 text-purple-300">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-fg">
              Plan Diario de Cobranzas · {snapshotDate}
            </h2>
            <p className="text-xs text-fg-muted">
              {resumen.accionables} cuentas accionables priorizadas para hoy ·{" "}
              {resumen.castigo_excl} cuentas excluidas por castigo
            </p>
          </div>
        </div>

        <a
          href={`/portfolio/collections/export?date=${snapshotDate}`}
          download={`acciones_${snapshotDate}.xlsx`}
          className="flex items-center gap-2 rounded-lg bg-[#620494] px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-[#4C0374]"
        >
          <Download className="h-4 w-4" />
          Descargar Excel (.xlsx)
        </a>
      </div>

      {/* KPI Cards Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border-subtle bg-bg-surface p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
            Cobro objetivo Top 40
          </span>
          <div className="mt-1 font-mono text-xl font-bold text-emerald-400">
            {fmtMoney(resumen.top40_cura)}
          </div>
          <div className="text-xs text-fg-muted">
            Suma de montos a cobrar en el Top
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-bg-surface p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
            Saldo que se re-envejece
          </span>
          <div className="mt-1 text-xl font-bold text-fg">
            {fmtMoney(resumen.top40_saldo)}
          </div>
          <div className="text-xs text-fg-muted">
            Cartera que vuelve a &quot;Al día&quot; si pagan
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-bg-surface p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
            Cuentas accionables
          </span>
          <div className="mt-1 text-xl font-bold text-fg">
            {resumen.accionables}
          </div>
          <div className="text-xs text-fg-muted">
            De {resumen.abiertos} préstamos abiertos
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-bg-surface p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
            Excluidos por castigo
          </span>
          <div className="mt-1 text-xl font-bold text-stone-500">
            {resumen.castigo_excl} ({fmtMoney(resumen.castigo_saldo)})
          </div>
          <div className="text-xs text-fg-muted">
            Umbral vencido sin pagos ≥ 180d
          </div>
        </div>
      </div>

      {/* Navigation Tabs & Filters */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle pb-3">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab("hoy")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "hoy"
                ? "bg-[#620494] text-white"
                : "border border-border-subtle bg-bg-surface text-fg-muted hover:text-fg"
            }`}
          >
            Hoy (Top 40)
          </button>
          <button
            onClick={() => setActiveTab("todos")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "todos"
                ? "bg-[#620494] text-white"
                : "border border-border-subtle bg-bg-surface text-fg-muted hover:text-fg"
            }`}
          >
            Todos los accionables ({plan.length})
          </button>
          <button
            onClick={() => setActiveTab("resumen")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "resumen"
                ? "bg-[#620494] text-white"
                : "border border-border-subtle bg-bg-surface text-fg-muted hover:text-fg"
            }`}
          >
            Resumen ejecutivo
          </button>
        </div>

        {activeTab !== "resumen" && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-1 text-xs">
              <Search className="h-3.5 w-3.5 text-fg-subtle" />
              <input
                type="text"
                placeholder="Buscar cliente, préstamo o teléfono..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48 bg-transparent text-fg placeholder:text-fg-subtle focus:outline-hidden"
              />
            </div>

            <div className="flex gap-1 text-xs">
              <button
                onClick={() => setPrioFilter(null)}
                className={`rounded px-2.5 py-1 text-xs transition ${
                  prioFilter === null
                    ? "border border-border bg-bg-raised font-bold text-fg"
                    : "border border-transparent text-fg-muted hover:text-fg"
                }`}
              >
                Todas
              </button>
              <button
                onClick={() => setPrioFilter(1)}
                className={`rounded px-2.5 py-1 text-xs transition ${
                  prioFilter === 1
                    ? "border border-rose-500/40 bg-rose-500/20 font-bold text-rose-300"
                    : "border border-transparent text-fg-muted hover:text-fg"
                }`}
              >
                P1
              </button>
              <button
                onClick={() => setPrioFilter(2)}
                className={`rounded px-2.5 py-1 text-xs transition ${
                  prioFilter === 2
                    ? "border border-amber-500/40 bg-amber-500/20 font-bold text-amber-300"
                    : "border border-transparent text-fg-muted hover:text-fg"
                }`}
              >
                P2
              </button>
              <button
                onClick={() => setPrioFilter(3)}
                className={`rounded px-2.5 py-1 text-xs transition ${
                  prioFilter === 3
                    ? "border border-emerald-500/40 bg-emerald-500/20 font-bold text-emerald-300"
                    : "border border-transparent text-fg-muted hover:text-fg"
                }`}
              >
                P3
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Tab 1 & 2: Items Table */}
      {activeTab !== "resumen" && (
        <div className="overflow-x-auto rounded-xl border border-border-subtle bg-bg-surface shadow-xs">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-raised/60 text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                <th className="py-2.5 px-3 text-center whitespace-nowrap">Prio</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Préstamo #</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Cliente</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Celular</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Segmento</th>
                <th className="py-2.5 px-3 text-center whitespace-nowrap">DPD</th>
                <th className="py-2.5 px-3 text-center whitespace-nowrap">Tramo</th>
                <th className="py-2.5 px-3 text-right whitespace-nowrap">Saldo</th>
                <th className="py-2.5 px-3 text-right whitespace-nowrap">Monto a cobrar</th>
                <th className="py-2.5 px-3 text-center whitespace-nowrap">Último pago</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Motivo / Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {filteredItems.map((item, idx) => (
                <tr key={idx} className="transition-colors hover:bg-bg-raised/40">
                  <td className="py-2.5 px-3 text-center whitespace-nowrap">
                    {getPrioBadge(item.prio)}
                  </td>
                  <td className="py-2.5 px-3 font-mono font-medium text-fg whitespace-nowrap">
                    {item.loanno}
                  </td>
                  <td className="py-2.5 px-3 font-medium text-fg whitespace-nowrap">
                    {item.cliente}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-fg-muted whitespace-nowrap">
                    {item.cel || "—"}
                  </td>
                  <td className="py-2.5 px-3 text-fg-muted whitespace-nowrap">{item.seg}</td>
                  <td className="py-2.5 px-3 text-center font-mono font-bold text-fg tabular-nums whitespace-nowrap">
                    {item.dpd}
                  </td>
                  <td className="py-2.5 px-3 text-center whitespace-nowrap">
                    <span className="rounded-full border border-border-subtle bg-bg-raised px-2 py-0.5 text-[10px] font-medium text-fg-muted">
                      {item.tramo}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold text-fg tabular-nums whitespace-nowrap">
                    {fmtMoney(item.saldo)}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-400 tabular-nums whitespace-nowrap">
                    {fmtMoney(item.cura)}
                  </td>
                  <td className="py-2.5 px-3 text-center font-mono text-fg-muted tabular-nums whitespace-nowrap">
                    {item.ultpago || "—"}
                  </td>
                  <td className="py-2.5 px-3 text-fg-muted">{item.motivo}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredItems.length === 0 && (
            <div className="p-8 text-center text-xs text-fg-muted">
              No se encontraron cuentas con los filtros seleccionados.
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Resumen Ejecutivo Sheet */}
      {activeTab === "resumen" && (
        <div className="max-w-2xl rounded-xl border border-border-subtle bg-bg-surface p-6 shadow-xs">
          <h3 className="mb-4 text-base font-semibold text-fg">
            Resumen Operativo de Cobranzas
          </h3>
          <div className="divide-y divide-border-subtle text-xs">
            <div className="flex justify-between py-2.5">
              <span className="text-fg-muted">Política CRO</span>
              <span className="font-mono font-bold text-purple-400">
                Política {policyVersion}
              </span>
            </div>
            <div className="flex justify-between py-2.5">
              <span className="text-fg-muted">Fecha del batch</span>
              <span className="font-mono font-bold text-fg">{snapshotDate}</span>
            </div>
            <div className="flex justify-between py-2.5">
              <span className="text-fg-muted">
                Instantánea previa (para &quot;rodó de tramo&quot;)
              </span>
              <span className="font-mono font-bold text-fg">
                {resumen.prev_date || "(sin historial suficiente)"}
              </span>
            </div>
            <div className="flex justify-between py-2.5">
              <span className="text-fg-muted">Préstamos abiertos</span>
              <span className="font-mono font-bold text-fg">
                {resumen.abiertos}
              </span>
            </div>
            <div className="flex justify-between py-2.5">
              <span className="text-fg-muted">Saldo abierto total</span>
              <span className="font-mono font-bold text-fg">
                {fmtMoney(resumen.saldo)}
              </span>
            </div>
            <div className="flex justify-between py-2.5">
              <span className="text-fg-muted">Préstamos accionables</span>
              <span className="font-mono font-bold text-fg">
                {resumen.accionables}
              </span>
            </div>
            <div className="flex justify-between py-2.5">
              <span className="text-fg-muted">
                Excluidos por castigo (umbral vencido, sin pagos ≥ 180d)
              </span>
              <span className="font-mono font-bold text-fg">
                {resumen.castigo_excl}
              </span>
            </div>
            <div className="flex justify-between py-2.5">
              <span className="text-fg-muted">Saldo excluido por castigo</span>
              <span className="font-mono font-bold text-fg">
                {fmtMoney(resumen.castigo_saldo)}
              </span>
            </div>
            <div className="flex justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5">
              <span className="font-semibold text-emerald-300">
                Cobro objetivo del Top (suma &quot;Monto a cobrar&quot;)
              </span>
              <span className="font-mono font-bold text-emerald-400">
                {fmtMoney(resumen.top40_cura)}
              </span>
            </div>
            <div className="flex justify-between rounded-lg border border-purple-500/20 bg-purple-500/10 px-3 py-2.5">
              <span className="font-semibold text-purple-300">
                Saldo que ese cobro re-envejece
              </span>
              <span className="font-mono font-bold text-purple-300">
                {fmtMoney(resumen.top40_saldo)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

