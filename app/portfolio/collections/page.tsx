import Link from "next/link";
import { Suspense } from "react";
import { BarChart3, UploadCloud } from "lucide-react";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import { requireOperator } from "@/lib/auth/guard";
import { formatQualityWarnings } from "@/lib/portfolio/board";
import { getPortfolioClient } from "@/lib/portfolio/client";
import { loadCollectionsPlan } from "@/lib/portfolio/collections-loader";

import { PortfolioWarningsBanner } from "../warnings-banner";
import { CollectionsSkeleton } from "./components/CollectionsSkeleton";
import { CollectionsView } from "./collections-view";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface CollectionsPageProps {
  searchParams: Promise<{ entity?: string; date?: string }>;
}

async function CollectionsContent({
  entityCode,
  targetDate,
}: {
  entityCode: string;
  targetDate?: string;
}) {
  const supabase = await getPortfolioClient();
  const loaded = await loadCollectionsPlan(supabase, entityCode, targetDate);

  if (!loaded) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-border-subtle bg-bg-surface p-10 text-center shadow-xs">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-purple-500/30 bg-purple-500/15 text-purple-300">
          <UploadCloud className="h-6 w-6" />
        </div>
        <h3 className="text-base font-semibold text-fg">
          No hay snapshots disponibles
        </h3>
        <p className="mt-1 text-xs text-fg-muted">
          Carga un backup de LoanDisk para generar el plan de cobranzas diario
          priorizado (P1 / P2 / P3).
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
    );
  }

  const { asOfDate, plan, resumen, policy, batch } = loaded;
  const warnings = formatQualityWarnings(batch);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-display text-2xl font-bold tracking-tight text-fg">
              Plan Diario de Cobranzas
            </h1>
            <span className="rounded-full border border-purple-500/30 bg-purple-500/15 px-2.5 py-0.5 text-xs font-semibold text-purple-300">
              Política {policy.version}
            </span>
          </div>
          <p className="mt-1 text-xs text-fg-muted">
            Priorización operativa y scoring de cartera · {asOfDate}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/portfolio/board"
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg-raised"
          >
            <BarChart3 className="h-3.5 w-3.5" />
            Reporte Junta
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

      <PortfolioWarningsBanner warnings={warnings} />

      <CollectionsView
        plan={plan}
        resumen={resumen}
        snapshotDate={asOfDate}
        policyVersion={policy.version}
      />
    </>
  );
}

export default async function PortfolioCollectionsPage({
  searchParams,
}: CollectionsPageProps) {
  const session = await requireOperator();
  const params = await searchParams;
  const entityCode = params.entity || "crediclaro";
  const targetDate = params.date;

  return (
    <OperatorShell session={session}>
      <Suspense fallback={<CollectionsSkeleton />}>
        <CollectionsContent entityCode={entityCode} targetDate={targetDate} />
      </Suspense>
    </OperatorShell>
  );
}
