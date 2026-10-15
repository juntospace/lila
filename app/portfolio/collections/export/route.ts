import { NextRequest, NextResponse } from "next/server";

import { requireOperator } from "@/lib/auth/guard";
import { buildCollectionsPlan } from "@/lib/portfolio/collections";
import { enrichLoan } from "@/lib/portfolio/enrich";
import { generateCollectionsWorkbook } from "@/lib/portfolio/excel";
import { isPreviewMode } from "@/lib/preview";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  await requireOperator();
  const searchParams = request.nextUrl.searchParams;
  const targetDate = searchParams.get("date");
  const entityCode = searchParams.get("entity") || "crediclaro";

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
    return new NextResponse("Entity not found", { status: 404 });
  }

  // 2. Resolve target snapshot
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
    return new NextResponse("Snapshot not found", { status: 404 });
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

  // 4. Load loans for current snapshot
  const { data: dbLoans } = await supabase
    .from("portfolio_loans")
    .select("*")
    .eq("snapshot_id", currentSnap.id);

  if (!dbLoans) {
    return new NextResponse("No loans in snapshot", { status: 404 });
  }

  // Re-map db rows to EnrichedLoan shape
  const enrichedLoans = dbLoans.map((l) => {
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

  // 5. Load last real payments from repayments
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

  // 6. Build collections plan & summary
  const { plan, resumen } = buildCollectionsPlan({
    loans: enrichedLoans,
    asOfDate,
    prevBucketMap,
    lastRealPaymentMap,
    prevDate: prevSnap?.snapshot_date ?? null,
  });

  // 7. Generate Excel workbook
  const buffer = await generateCollectionsWorkbook(plan, resumen, asOfDate);

  const filename = `acciones_${asOfDate}.xlsx`;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

