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

  // Walk the result in 1000-row pages — Supabase JS caps a single request
  // at 1000 rows by default. Without explicit pagination, exporting an
  // account with > 1000 matching rows would silently truncate to the most
  // recent 1000 (sorted posted_at desc), which is exactly the bug ops
  // reported: "April 5–30 export only contained April 20–30".
  type ExportRow = {
    id: string;
    posted_at: string;
    code: string;
    credit_minor: string | number;
    description: string | null;
    state: string;
    confirmable_after: string | null;
    rail_native_ref: string | null;
    payer_name_raw: string | null;
    currency: string;
  };

  const PAGE = 1000;
  const SAFETY_CAP = 200_000;
  const credits: ExportRow[] = [];
  let cursor = 0;
  while (cursor < SAFETY_CAP) {
    let q = supabase
      .from("recon_transactions")
      .select(
        "id, posted_at, code, credit_minor, description, state, confirmable_after, rail_native_ref, payer_name_raw, currency",
      )
      .eq("account_id", accountId)
      .eq("kind", "loan_inflow")
      .order("posted_at", { ascending: false })
      .order("id", { ascending: false })
      .range(cursor, cursor + PAGE - 1);

    if ((STATES as readonly string[]).includes(state))
      q = q.eq("state", state as (typeof STATES)[number]);
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) q = q.gte("posted_at", from);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) q = q.lte("posted_at", to);

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    credits.push(...(data as ExportRow[]));
    if (data.length < PAGE) break;
    cursor += PAGE;
  }

  // Lookup DVTO codes + raw descriptions for rejected PRs (description is
  // the legacy fallback when the parser regex didn't extract a code).
  //
  // We chunk both .in() lookups in batches of 200 ids:
  //   - Supabase JS caps a single response at 1000 rows, and an unchunked
  //     query against thousands of rejected PRs comes back truncated.
  //   - PostgREST encodes .in() values into the URL; with thousands of
  //     UUIDs the URL exceeds the gateway's length limit and the request
  //     either fails outright or silently drops trailing ids.
  // The visible bug was: large-range exports had blank DVTO/Reason
  // columns for ~all rows past the first ~1000.
  const ID_CHUNK = 200;
  const rejectedPrIds = credits
    .filter((r) => r.code === "PR" && r.state === "rejected")
    .map((r) => r.id);
  const reasonByPrId = new Map<
    string,
    { code: string | null; description: string | null }
  >();

  if (rejectedPrIds.length > 0) {
    const allLinks: { pr_txn_id: string; da_txn_id: string }[] = [];
    for (let i = 0; i < rejectedPrIds.length; i += ID_CHUNK) {
      const chunk = rejectedPrIds.slice(i, i + ID_CHUNK);
      const { data: links, error: linksErr } = await supabase
        .from("recon_links")
        .select("pr_txn_id, da_txn_id")
        .in("pr_txn_id", chunk);
      if (linksErr) {
        return NextResponse.json({ error: linksErr.message }, { status: 500 });
      }
      if (links) allLinks.push(...links);
    }

    const daById = new Map<
      string,
      { return_code: string | null; description: string | null }
    >();
    const daIds = allLinks.map((l) => l.da_txn_id);
    for (let i = 0; i < daIds.length; i += ID_CHUNK) {
      const chunk = daIds.slice(i, i + ID_CHUNK);
      const { data: das, error: dasErr } = await supabase
        .from("recon_transactions")
        .select("id, return_code, description")
        .in("id", chunk);
      if (dasErr) {
        return NextResponse.json({ error: dasErr.message }, { status: 500 });
      }
      for (const d of das ?? []) {
        daById.set(d.id, {
          return_code: d.return_code as string | null,
          description: d.description as string | null,
        });
      }
    }

    for (const link of allLinks) {
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
