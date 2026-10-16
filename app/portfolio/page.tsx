import Link from "next/link";
import {
  BarChart3,
  Calendar,
  Download,
  Layers,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import { requireOperator } from "@/lib/auth/guard";
import { getPortfolioClient } from "@/lib/portfolio/client";

import { deleteSnapshotAction } from "./actions";
import { PortfolioUploadPanel } from "./upload-panel";

export const dynamic = "force-dynamic";

export default async function PortfolioIndexPage() {
  const session = await requireOperator();
  const supabase = await getPortfolioClient();

  const { data: snapshotsData } = await supabase
    .from("portfolio_snapshots")
    .select(
      `
      *,
      portfolio_entities (code, display_name),
      portfolio_policy (version),
      portfolio_ingest_batches (*)
    `,
    )
    .order("snapshot_date", { ascending: false });

  const snapshots = snapshotsData || [];

  const fmtMoney = (x: number) =>
    "$" + Math.round(x || 0).toLocaleString("en-US");

  return (
    <OperatorShell session={session}>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">
            Gestión de Cartera &amp; Reportes
          </h1>
          <p className="mt-1 text-xs text-fg-muted">
            Historial de instantáneas de LoanDisk, reportes ejecutivos de Junta y
            planes de cobranza.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/portfolio/board"
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg-raised"
          >
            <BarChart3 className="h-3.5 w-3.5 text-[#620494]" />
            Reporte Junta
          </Link>
          <Link
            href="/portfolio/collections"
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg-raised"
          >
            <Layers className="h-3.5 w-3.5 text-[#620494]" />
            Plan de Cobranzas
          </Link>
        </div>
      </header>

      <div className="space-y-8">
        {/* Ingest Panel */}
        <PortfolioUploadPanel />

        {/* Snapshots Table */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg">
              Instantáneas Almacenadas ({snapshots.length})
            </h3>
            <span className="text-xs text-fg-muted">
              Persistencia estructurada en Supabase PostgreSQL
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border-subtle bg-bg-surface shadow-xs">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-raised/60 text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                  <th className="py-2.5 px-3">Fecha de corte</th>
                  <th className="py-2.5 px-3">Entidad</th>
                  <th className="py-2.5 px-3">Política</th>
                  <th className="py-2.5 px-3 text-right">Préstamos</th>
                  <th className="py-2.5 px-3 text-right">Saldo abierto</th>
                  <th className="py-2.5 px-3 text-right">CeR 30+</th>
                  <th className="py-2.5 px-3 text-right">CeR 90+</th>
                  <th className="py-2.5 px-3 text-right">Recaudado jun-25→</th>
                  <th className="py-2.5 px-3 text-center">Cash ahead</th>
                  <th className="py-2.5 px-3 text-center">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {snapshots.map((s) => (
                  <tr key={s.id} className="hover:bg-bg-raised/40">
                    <td className="py-2.5 px-3 font-mono font-medium text-fg">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5 text-fg-subtle" />
                        <span>{s.snapshot_date}</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-medium text-fg">
                      {s.portfolio_entities?.display_name || "Crediclaro"}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-fg-muted">
                      {s.portfolio_policy?.version || "v1.0"}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-fg">
                      {s.total_open_loans.toLocaleString("en-US")}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-bold text-fg">
                      {fmtMoney(Number(s.total_open_balance))}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          Number(s.cer30_percentage) <= 15
                            ? "bg-emerald-100 text-emerald-800"
                            : Number(s.cer30_percentage) <= 28
                              ? "bg-amber-100 text-amber-800"
                              : "bg-rose-100 text-rose-800"
                        }`}
                      >
                        {Number(s.cer30_percentage).toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          Number(s.cer90_percentage) <= 8
                            ? "bg-emerald-100 text-emerald-800"
                            : Number(s.cer90_percentage) <= 18
                              ? "bg-amber-100 text-amber-800"
                              : "bg-rose-100 text-rose-800"
                        }`}
                      >
                        {Number(s.cer90_percentage).toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-semibold text-emerald-600">
                      {fmtMoney(Number(s.total_collected_handover))}
                    </td>
                    <td className="py-2.5 px-3 text-center font-mono">
                      {s.cash_ahead_count > 0 ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                          {s.cash_ahead_count}
                        </span>
                      ) : (
                        <span className="text-fg-subtle">0</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <Link
                          href={`/portfolio/board?date=${s.snapshot_date}`}
                          title="Ver Reporte Junta"
                          className="rounded p-1 text-fg-muted hover:bg-bg-raised hover:text-[#620494]"
                        >
                          <BarChart3 className="h-4 w-4" />
                        </Link>
                        <Link
                          href={`/portfolio/collections?date=${s.snapshot_date}`}
                          title="Ver Plan Cobranzas"
                          className="rounded p-1 text-fg-muted hover:bg-bg-raised hover:text-[#620494]"
                        >
                          <Layers className="h-4 w-4" />
                        </Link>
                        <a
                          href={`/portfolio/collections/export?date=${s.snapshot_date}`}
                          title="Descargar Excel .xlsx"
                          className="rounded p-1 text-fg-muted hover:bg-bg-raised hover:text-emerald-600"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                        <form
                          action={async () => {
                            "use server";
                            await deleteSnapshotAction(s.id);
                          }}
                        >
                          <button
                            type="submit"
                            title="Eliminar snapshot"
                            className="rounded p-1 text-fg-muted hover:bg-rose-50 hover:text-rose-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {snapshots.length === 0 && (
              <div className="p-8 text-center text-xs text-fg-muted">
                No hay instantáneas guardadas todavía. Carga un archivo arriba
                para comenzar.
              </div>
            )}
          </div>
        </div>

        {/* Data Quality Panel per Snapshot (Fase 4.3) */}
        {snapshots.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#620494]" />
              <h3 className="text-sm font-semibold text-fg">
                Calidad de datos y conciliación por instantánea
              </h3>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {snapshots.map((s) => {
                const batches = Array.isArray(s.portfolio_ingest_batches)
                  ? s.portfolio_ingest_batches
                  : s.portfolio_ingest_batches
                    ? [s.portfolio_ingest_batches]
                    : [];
                const b = batches[0];

                const futureExcl =
                  b?.future_payments_excluded ??
                  s.future_payments_excluded_count ??
                  0;
                const cashAhead = b?.cash_ahead_count ?? s.cash_ahead_count ?? 0;
                const adminCount = b?.admin_excluded_count ?? 0;
                const adminAmount = Number(b?.admin_excluded_amount ?? 0);
                const unknownMethods: string[] = Array.isArray(
                  b?.unknown_methods,
                )
                  ? b.unknown_methods
                  : [];
                const missingFields: string[] = Array.isArray(
                  b?.missing_custom_fields,
                )
                  ? b.missing_custom_fields
                  : [];
                const missingReleased = Number(
                  b?.missing_released_date_count ?? 0,
                );

                return (
                  <div
                    key={`quality-${s.id}`}
                    className="rounded-xl border border-border-subtle bg-bg-surface p-4 text-xs shadow-xs space-y-2.5"
                  >
                    <div className="flex items-center justify-between border-b border-border-subtle pb-2">
                      <span className="font-mono font-bold text-fg">
                        {s.snapshot_date} ·{" "}
                        {s.portfolio_entities?.display_name || "Crediclaro"}
                      </span>
                      {b ? (
                        <span className="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                          Conciliado ({b.rows_loans} préstamos /{" "}
                          {b.rows_repayments} pagos)
                        </span>
                      ) : (
                        <span className="rounded bg-bg-raised px-2 py-0.5 text-[10px] text-fg-muted">
                          Snapshot base
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px] text-fg-muted">
                      <div>
                        Pagos futuros excluidos:{" "}
                        <b className="text-fg">{futureExcl}</b>
                      </div>
                      <div>
                        Ajuste de caja (cash_ahead):{" "}
                        <b className="text-fg">{cashAhead}</b>
                      </div>
                      <div>
                        Mov. administrativos excl.:{" "}
                        <b className="text-fg">
                          {adminCount} ({fmtMoney(adminAmount)})
                        </b>
                      </div>
                      <div>
                        Sin Released Date:{" "}
                        <b className="text-fg">{missingReleased}</b>
                      </div>
                    </div>

                    {unknownMethods.length > 0 && (
                      <div className="rounded bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                        <b>Métodos sin clasificar:</b>{" "}
                        {unknownMethods.join(", ")}
                      </div>
                    )}

                    {missingFields.length > 0 && (
                      <div className="rounded bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                        <b>Campos personalizados faltantes:</b>{" "}
                        {missingFields.join(", ")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
