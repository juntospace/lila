"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function PortfolioError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Portfolio segment error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
      <div className="mx-auto max-w-lg rounded-2xl border border-rose-500/30 bg-bg-surface p-8 shadow-e2">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/15 text-rose-400">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-semibold text-fg">
          Ocurrió un error al cargar la información
        </h2>
        <p className="mt-2 text-xs text-fg-muted">
          Se presentó un problema al procesar los datos de la cartera en el servidor.
        </p>

        <div className="mt-4 rounded-lg bg-bg-raised p-4 text-left font-mono text-xs text-rose-300 break-all overflow-x-auto">
          <p className="font-semibold text-rose-400">Detalle del error:</p>
          <p className="mt-1">{error.message || "Error desconocido"}</p>
          {error.digest && (
            <p className="mt-1 text-fg-subtle">Digest: {error.digest}</p>
          )}
        </div>

        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={() => reset()}
            className="flex items-center gap-2 rounded-lg bg-[#620494] px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-[#4C0374]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reintentar
          </button>
          <Link
            href="/portfolio"
            className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-2 text-xs font-medium text-fg hover:bg-bg-raised"
          >
            Ir a Gestión de Cartera
          </Link>
        </div>
      </div>
    </div>
  );
}

