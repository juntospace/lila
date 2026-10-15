import Link from "next/link";
import { UploadCloud, Layers } from "lucide-react";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import { requireOperator } from "@/lib/auth/guard";
import { loadBoardDataset } from "@/lib/portfolio/board";
import { isPreviewMode } from "@/lib/preview";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

import { BoardReportView } from "./board-view";

export const dynamic = "force-dynamic";

interface BoardPageProps {
  searchParams: Promise<{ entity?: string; date?: string }>;
}

export default async function PortfolioBoardPage({
  searchParams,
}: BoardPageProps) {
  const session = await requireOperator();
  const params = await searchParams;
  const entityCode = params.entity || "crediclaro";
  const targetDate = params.date;

  const supabase = isPreviewMode()
    ? createSupabaseServiceClient()
    : await createSupabaseServerClient();
  const dataset = await loadBoardDataset(supabase, entityCode, targetDate);

  return (
    <OperatorShell session={session}>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">
            Reporte de Junta Directiva
          </h1>
          <p className="mt-1 text-xs text-fg-muted">
            Cartera y envejecimiento de préstamos ·{" "}
            {entityCode === "crediclaro"
              ? "Crediclaro, S.A."
              : "Junto Soluciones, S.A."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/portfolio/collections"
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg-raised"
          >
            <Layers className="h-3.5 w-3.5" />
            Plan de Cobranzas
          </Link>
          <Link
            href="/portfolio"
            className="flex items-center gap-1.5 rounded-lg bg-[#620494] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4C0374]"
          >
            <UploadCloud className="h-3.5 w-3.5" />
            Cargar Backup
          </Link>
        </div>
      </header>

      {dataset ? (
        <BoardReportView data={dataset} />
      ) : (

        <div className="mx-auto max-w-xl rounded-2xl border border-border-subtle bg-bg-surface p-10 text-center shadow-xs">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#F1E6F8] text-[#620494]">
            <UploadCloud className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-fg">
            No hay datos de cartera disponibles
          </h3>
          <p className="mt-1 text-xs text-fg-muted">
            Para visualizar las métricas y la distribución de mora para la Junta,
            carga un backup de LoanDisk (CSV o ZIP) desde el panel de ingesta.
          </p>
          <div className="mt-6 flex justify-center">
            <Link
              href="/portfolio"
              className="rounded-lg bg-[#620494] px-4 py-2 text-xs font-medium text-white hover:bg-[#4C0374]"
            >
              Ir a Ingesta de Cartera
            </Link>
          </div>
        </div>
      )}
    </OperatorShell>
  );
}
