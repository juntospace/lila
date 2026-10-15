import Link from "next/link";
import { BarChart3, UploadCloud } from "lucide-react";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import { requireOperator } from "@/lib/auth/guard";
import { buildCollectionsPlan } from "@/lib/portfolio/collections";
import { enrichLoan } from "@/lib/portfolio/enrich";
import { isPreviewMode } from "@/lib/preview";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

import { CollectionsView } from "./collections-view";

export const dynamic = "force-dynamic";

interface CollectionsPageProps {
  searchParams: Promise<{ entity?: string; date?: string }>;
}

export default async function PortfolioCollectionsPage({
  searchParams,
}: CollectionsPageProps) {
  const session = await requireOperator();
  const params = await searchParams;
  const entityCode = params.entity || "crediclaro";
  const targetDate = params.date;

  const supabase = isPreviewMode()
    ? createSupabaseServiceClient()
    : await createSupabaseServerClient();

  // 1. Resolve entity
  const { data: entity } = await supabase
    .from("portfolio_entities")
    .select("id")
    .eq("code", entityCode)
    .maybeSingle();

  if (!entity) {
    return (
      <OperatorShell session={session}>
        <div className="p-8 text-center text-sm text-fg-muted">
          No se encontró la entidad {entityCode}.
        </div>
      </OperatorShell>
    );
  }

  // 2. Resolve snapshot
  let snapQuery = supabase
    .from("portfolio_snapshots")
    .select("*")
    .eq("entity_id", entity.id)
    .order("snapshot_date", { ascending: false });

  if (targetDate) {
    snapQuery = snapQuery.eq("snapshot_date", targetDate);
  }

  const { data: snapshots } = await snapQuery.limit(1);
  if (!snapshots || snapshots.length === 0) {
    return (
      <OperatorShell session={session}>
        <div className="mx-auto max-w-xl rounded-2xl border border-border-subtle bg-bg-surface p-10 text-center shadow-xs">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#F1E6F8] text-[#620494]">
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
      </OperatorShell>
    );
  }

  const currentSnap = snapshots[0];
  const asOfDate = currentSnap.snapshot_date;

  // 3. Resolve previous snapshot (for "rolled a bucket" signal)
  const { data: priorSnapshots } = await supabase
    .from("portfolio_snapshots")
    .select("id, snapshot_date")
    .eq("entity_id", entity.id)
    .lt("snapshot_date", asOfDate)
    .order("snapshot_date", { ascending: false })
    .limit(1);

  const prevSnap = priorSnapshots?.[0];
  let prevBucketMap: Record<string, number> | null = null;
  if (prevSnap) {
    const { data: prevLoans } = await supabase
      .from("portfolio_loans")
      .select("source_loan_id, bucket_idx")
      .eq("snapshot_id", prevSnap.id)
      .eq("is_open", true);

    if (prevLoans) {
      prevBucketMap = {};
      for (const pl of prevLoans) {
        prevBucketMap[pl.source_loan_id] = pl.bucket_idx;
      }
    }
  }

  // 4. Load loans
  const { data: dbLoans } = await supabase
    .from("portfolio_loans")
    .select("*")
    .eq("snapshot_id", currentSnap.id);

  const enrichedLoans = (dbLoans || []).map((l) => {
    const rawObj =
      typeof l.raw === "object" && l.raw !== null
        ? (l.raw as Record<string, string>)
        : {};

    return enrichLoan({
      ...rawObj,
      "Loan Id": l.source_loan_id,
      "Loan #": l.loan_number || "",
      "Full Name": l.full_name || "",
      "Borrower Mobile": l.borrower_mobile || "",
      "Loan Product": l.product || "",
      "Balance Amount": String(l.balance),
      "Days Past Due": String(l.dpd_loandisk),
      "Past Due": String(l.past_due ?? ""),
      "Pending Due": String(l.pending_due ?? ""),
      "Loan Status Name": l.status_raw || "",
      "Prestamo Garantizado": l.pg || "",
      "Tipo de Garantia": l.tg || "",
      "Tipo de Cartera": l.tc || "",
      "Gestor de Cobro": l.gc || "",
      "Motor de Riesgo (Adelantos)": l.mr || "",
      "Last Payment Date": l.last_payment_date || "",
      "Last Payment Amount": String(l.last_payment_amount ?? ""),
    });
  });

  // 5. Load last real payment dates
  const { data: realReps } = await supabase
    .from("portfolio_loan_repayments")
    .select("source_loan_id, collection_date")
    .eq("snapshot_id", currentSnap.id)
    .eq("is_real", true);

  let lastRealPaymentMap: Record<string, string> | null = null;
  if (realReps && realReps.length > 0) {
    lastRealPaymentMap = {};
    for (const rep of realReps) {
      const cur = lastRealPaymentMap[rep.source_loan_id];
      if (!cur || rep.collection_date > cur) {
        lastRealPaymentMap[rep.source_loan_id] = rep.collection_date;
      }
    }
  }

  // 6. Compute plan
  const { plan, resumen } = buildCollectionsPlan({
    loans: enrichedLoans,
    asOfDate,
    prevBucketMap,
    lastRealPaymentMap,
    prevDate: prevSnap?.snapshot_date ?? null,
  });

  return (
    <OperatorShell session={session}>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">
            Plan Diario de Cobranzas
          </h1>
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

      <CollectionsView
        plan={plan}
        resumen={resumen}
        snapshotDate={asOfDate}
      />
    </OperatorShell>
  );
}

