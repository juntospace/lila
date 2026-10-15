"use client";

import React, { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, UploadCloud } from "lucide-react";

import { uploadPortfolioBackupAction } from "./actions";

export function PortfolioUploadPanel() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    const formData = new FormData(e.currentTarget);

    try {
      const res = await uploadPortfolioBackupAction(formData);
      if (res?.success) {
        setSuccess(
          `✓ Instantánea cargada con éxito: ${res.result.openLoans} préstamos abiertos procesados.`,
        );
        (e.target as HTMLFormElement).reset();
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Ocurrió un error al procesar el backup.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border-subtle bg-bg-surface p-6 shadow-xs">
      <div className="flex items-center gap-3 border-b border-border-subtle pb-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#F1E6F8] text-[#620494]">
          <UploadCloud className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-fg">
            Cargar Backup de LoanDisk
          </h3>
          <p className="text-xs text-fg-muted">
            Procesa e indexa archivos CSV de préstamos y pagos en Supabase con
            idempotencia automática.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-rose-50 p-3 text-xs text-rose-800">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-fg">
              Entidad legal
            </label>
            <select
              name="entityCode"
              defaultValue="crediclaro"
              className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-xs text-fg focus:border-[#620494] focus:outline-hidden"
            >
              <option value="crediclaro">Crediclaro, S.A.</option>
              <option value="junto_soluciones">Junto Soluciones, S.A.</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-fg">
              Fecha de corte (opcional si está en el nombre del archivo)
            </label>
            <input
              type="date"
              name="snapshotDate"
              className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-xs text-fg focus:border-[#620494] focus:outline-hidden"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-fg">
              Archivo de préstamos (*loans*.csv) <span className="text-rose-500">*</span>
            </label>
            <input
              type="file"
              name="loansFile"
              accept=".csv"
              required
              className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-xs text-fg file:mr-2 file:rounded file:border-0 file:bg-[#F1E6F8] file:px-2.5 file:py-1 file:text-xs file:font-semibold file:text-[#620494]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-fg">
              Archivo de pagos (*repayments*.csv) (opcional pero recomendado)
            </label>
            <input
              type="file"
              name="repaymentsFile"
              accept=".csv"
              className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-xs text-fg file:mr-2 file:rounded file:border-0 file:file:bg-[#F1E6F8] file:px-2.5 file:py-1 file:text-xs file:font-semibold file:text-[#620494]"
            />
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={loading}
            className="flex items-center gap-2 rounded-lg bg-[#620494] px-5 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-[#4C0374] disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Procesando backup...
              </>
            ) : (
              <>
                <UploadCloud className="h-4 w-4" />
                Procesar e Ingestar
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

