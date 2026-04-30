// Excel export of an account's loan-related credits, with the same filters
// the list page exposes. Returns a freshly generated .xlsx workbook so ops
// can pull a snapshot for offline review without touching the DB directly.

import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import { requireReconWriter } from "@/lib/auth/guard";
import { extractPRPayerName, reasonForDvtoCode } from "@/lib/recon/bac";
import { formatDate, formatMinorUSD } from "@/lib/recon/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const STATES = ["pending", "confirmed", "rejected"] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  await requireReconWriter();
  const { accountId } = await params;
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "all";
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const supabase = await createSupabaseServerClient();

  const { data: account, error: acctErr } = await supabase
    .from("bank_accounts")
    .select("id, rail, account_number, holder_name, currency")
    .eq("id", accountId)
    .single();

  if (acctErr || !account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  let query = supabase
    .from("recon_transactions")
    .select(
      "id, posted_at, code, credit_minor, description, state, confirmable_after, rail_native_ref, payer_name_raw, currency",
    )
    .eq("account_id", accountId)
    .eq("kind", "loan_inflow")
    .order("posted_at", { ascending: false })
    .order("id", { ascending: false });

  if ((STATES as readonly string[]).includes(state))
    query = query.eq("state", state as (typeof STATES)[number]);
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) query = query.gte("posted_at", from);
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) query = query.lte("posted_at", to);

  const { data: rows, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const credits = rows ?? [];

  // Lookup DVTO codes + raw descriptions for rejected PRs (description is
  // the legacy fallback when the parser regex didn't extract a code).
  const rejectedPrIds = credits
    .filter((r) => r.code === "PR" && r.state === "rejected")
    .map((r) => r.id);
  const reasonByPrId = new Map<
    string,
    { code: string | null; description: string | null }
  >();
  if (rejectedPrIds.length > 0) {
    const { data: links } = await supabase
      .from("recon_links")
      .select("pr_txn_id, da_txn_id")
      .in("pr_txn_id", rejectedPrIds);
    const daIds = (links ?? []).map((l) => l.da_txn_id);
    let daById = new Map<string, { return_code: string | null; description: string | null }>();
    if (daIds.length > 0) {
      const { data: das } = await supabase
        .from("recon_transactions")
        .select("id, return_code, description")
        .in("id", daIds);
      daById = new Map(
        (das ?? []).map((d) => [
          d.id,
          {
            return_code: d.return_code as string | null,
            description: d.description as string | null,
          },
        ]),
      );
    }
    for (const link of links ?? []) {
      const da = daById.get(link.da_txn_id);
      reasonByPrId.set(link.pr_txn_id, {
        code: da?.return_code ?? null,
        description: da?.description ?? null,
      });
    }
  }

  const sheetData = credits.map((r) => {
    const reason = r.state === "rejected" ? reasonByPrId.get(r.id) : undefined;
    const reasonCode = reason?.code ?? null;
    let reasonDetail = "";
    if (r.state === "rejected") {
      if (reasonCode) {
        reasonDetail = reasonForDvtoCode(reasonCode).label;
      } else if (reason?.description) {
        reasonDetail = reason.description;
      }
    } else if (r.state === "pending" && r.confirmable_after) {
      reasonDetail = `Confirmable after ${formatDate(
        (r.confirmable_after as string).slice(0, 10),
      )}`;
    }
    return {
      Date: formatDate(r.posted_at as string),
      Code: r.code,
      Payer:
        (r.payer_name_raw as string | null) ??
        extractPRPayerName(r.description as string) ??
        "",
      Amount: formatMinorUSD(String(r.credit_minor)),
      Currency: r.currency,
      Status: r.state,
      "DVTO code": reasonCode ?? "",
      "Reason / detail": reasonDetail,
      Reference: (r.rail_native_ref as string) ?? "",
      Description: (r.description as string) ?? "",
    };
  });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(sheetData, {
    header: [
      "Date",
      "Code",
      "Payer",
      "Amount",
      "Currency",
      "Status",
      "DVTO code",
      "Reason / detail",
      "Reference",
      "Description",
    ],
  });
  // Reasonable column widths so the sheet is readable on first open.
  worksheet["!cols"] = [
    { wch: 12 }, // Date
    { wch: 6 }, // Code
    { wch: 28 }, // Payer
    { wch: 12 }, // Amount
    { wch: 8 }, // Currency
    { wch: 12 }, // Status
    { wch: 10 }, // DVTO code
    { wch: 36 }, // Reason / detail
    { wch: 14 }, // Reference
    { wch: 48 }, // Description
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, "Loan credits");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `loan-credits-${account.rail}-${account.account_number}-${stamp}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
