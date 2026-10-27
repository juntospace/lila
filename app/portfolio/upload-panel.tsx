"use client";

import React, { useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileArchive,
  Loader2,
  UploadCloud,
} from "lucide-react";

import { uploadPortfolioBackupAction } from "./actions";

export function PortfolioUploadPanel() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [fileSizeStr, setFileSizeStr] = useState<string | null>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFileName(file.name);
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      setFileSizeStr(`${sizeMb} MB`);

      // Auto-populate date from filename if not already filled (e.g. 2026-10-20.zip)
      const match = file.name.match(/(\d{4}-\d{2}-\d{2})/);
      if (match && dateInputRef.current && !dateInputRef.current.value) {
        dateInputRef.current.value = match[1];
      }
    } else {
      setSelectedFileName(null);
      setFileSizeStr(null);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    const form = e.currentTarget;
    const formData = new FormData(form);

    try {
      const res = await uploadPortfolioBackupAction(formData);
      if (res?.success) {
        setSuccess(
          `✓ Instantánea cargada con éxito: ${res.result.openLoans} préstamos abiertos procesados (${res.result.snapshotDate}).`,
        );
        form.reset();
        setSelectedFileName(null);
        setFileSizeStr(null);
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
          <FileArchive className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-fg">
            Cargar Backup de LoanDisk (.zip)
          </h3>
          <p className="text-xs text-fg-muted">
            Sube el archivo ZIP de respaldo descargado de LoanDisk. Se extraerán e indexarán
            automáticamente los préstamos y pagos en Supabase con idempotencia automática.
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
              <option value="crediclaro">Crediclaro, S.A. (Predeterminada)</option>
              <option value="junto_soluciones">Junto Soluciones, S.A.</option>
            </select>
            <p className="mt-1 text-[11px] text-fg-muted">
              Por defecto Crediclaro (cartera LoanDisk Branch 1). No necesitas cambiarla.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-fg">
              Fecha de corte (opcional si está en el nombre del archivo)
            </label>
            <input
              ref={dateInputRef}
              type="date"
              name="snapshotDate"
              className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-xs text-fg focus:border-[#620494] focus:outline-hidden"
            />
            <p className="mt-1 text-[11px] text-fg-muted">
              Si el archivo se llama ej. <span className="font-mono">2026-10-20.zip</span>, se detecta sola.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-fg">
            Archivo ZIP de respaldo (*.zip) <span className="text-rose-500">*</span>
          </label>
          <input
            type="file"
            name="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            required
            onChange={handleFileChange}
            className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-xs text-fg file:mr-2 file:rounded file:border-0 file:bg-[#F1E6F8] file:px-2.5 file:py-1 file:text-xs file:font-semibold file:text-[#620494]"
          />
          {selectedFileName && (
            <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-fg-muted">
              <span>{selectedFileName}</span>
              {fileSizeStr && <span className="text-fg-subtle">({fileSizeStr})</span>}
            </p>
          )}
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={loading}
            className="flex items-center gap-2 rounded-lg bg-[#620494] px-5 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-[#4C0374] disabled:opacity-50 cursor-pointer"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Descomprimiendo y procesando backup...
              </>
            ) : (
              <>
                <UploadCloud className="h-4 w-4" />
                Procesar e Ingestar ZIP
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
