// Multi-account Excel export of loan-related credits across the operator's
// portfolio. Collections team uses this to chase up borrowers without
// clicking through each account's individual export.
//
// Query params:
//   state   "rejected" | "confirmed" | "pending" | "all"  (default "rejected")
//   from    YYYY-MM-DD                                     (optional)
//   to      YYYY-MM-DD                                     (optional)
//   account UUID, repeatable                               (optional; default all active accounts)
//
// The returned workbook has one sheet ("Loan credits") with account info
// prepended to every row so the team can filter / pivot in Excel.

import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import { requireReconWriter } from "@/lib/auth/guard";
import { extractPRPayerName, reasonForDvtoCode } from "@/lib/recon/bac";
import { formatDate, formatMinorUSD } from "@/lib/recon/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const STATES = ["pending", "confirmed", "rejected"] as const;
type State = (typeof STATES)[number];
const PAGE = 1000;
const SAFETY_CAP = 200_000;
const ID_CHUNK = 100;

export async function GET(request: Request) {
  await requireReconWriter();
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state") ?? "rejected";
  const stateFilter: State | "all" = (STATES as readonly string[]).includes(
    stateParam,
  )
    ? (stateParam as State)
    : "all";
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const accountFilter = url.searchParams.getAll("account");

  const supabase = await createSupabaseServerClient();

  // Account list (filtered if accountFilter is provided)
  let accountQuery = supabase
    .from("bank_accounts")
    .select("id, rail, account_number, holder_name, currency")
    .eq("status", "active");
  if (accountFilter.length > 0) {
    accountQuery = accountQuery.in("id", accountFilter);
  }
  const { data: accounts, error: acctErr } = await accountQuery;
  if (acctErr) {
    return NextResponse.json({ error: acctErr.message }, { status: 500 });
  }
  if (!accounts || accounts.length === 0) {
    return NextResponse.json({ error: "No accounts." }, { status: 404 });
  }
  const accountById = new Map(accounts.map((a) => [a.id as string, a]));
  const accountIds = accounts.map((a) => a.id as string);

  // Pull loan-related credits across all accounts, paginated.
  type CreditRow = {
    id: string;
    account_id: string;
    posted_at: string;
    code: string;
    credit_minor: string | number;
    description: string | null;
    state: string;
    rail_native_ref: string | null;
    payer_name_raw: string | null;
    currency: string;
  };
  const credits: CreditRow[] = [];
  let cursor = 0;
  while (cursor < SAFETY_CAP) {
    let q = supabase
      .from("recon_transactions")
      .select(
        "id, account_id, posted_at, code, credit_minor, description, state, rail_native_ref, payer_name_raw, currency",
      )
      .in("account_id", accountIds)
      .eq("kind", "loan_inflow")
      .order("posted_at", { ascending: false })
      .order("id", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (stateFilter !== "all") q = q.eq("state", stateFilter);
    if (from) q = q.gte("posted_at", from);
    if (to) q = q.lte("posted_at", to);
    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    for (const r of data) {
      credits.push({
        id: r.id as string,
        account_id: r.account_id as string,
        posted_at: r.posted_at as string,
        code: r.code as string,
        credit_minor: r.credit_minor as string | number,
        description: r.description as string | null,
        state: r.state as string,
        rail_native_ref: r.rail_native_ref as string | null,
        payer_name_raw: r.payer_name_raw as string | null,
        currency: r.currency as string,
      });
    }
    if (data.length < PAGE) break;
    cursor += PAGE;
  }

  // For rejected PRs, fetch the linked DA's return_code + description so the
  // "Reason" column carries useful detail per row.
  const rejectedPrIds = credits
    .filter((r) => r.state === "rejected" && r.code === "PR")
    .map((r) => r.id);
  const reasonByPrId = new Map<
    string,
    { code: string | null; description: string | null }
  >();
  if (rejectedPrIds.length > 0) {
    const links: { pr_txn_id: string; da_txn_id: string }[] = [];
    for (let i = 0; i < rejectedPrIds.length; i += ID_CHUNK) {
      const chunk = rejectedPrIds.slice(i, i + ID_CHUNK);
      const { data: linkRows, error: linksErr } = await supabase
        .from("recon_links")
        .select("pr_txn_id, da_txn_id")
        .in("pr_txn_id", chunk);
      if (linksErr) {
        return NextResponse.json({ error: linksErr.message }, { status: 500 });
      }
      if (linkRows) links.push(...linkRows);
    }
    const daIds = links.map((l) => l.da_txn_id);
    const daById = new Map<
      string,
      { return_code: string | null; description: string | null }
    >();
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
        daById.set(d.id as string, {
          return_code: d.return_code as string | null,
          description: d.description as string | null,
        });
      }
    }
    for (const link of links) {
      const da = daById.get(link.da_txn_id);
      reasonByPrId.set(link.pr_txn_id, {
        code: da?.return_code ?? null,
        description: da?.description ?? null,
      });
    }
  }

  const sheetData = credits.map((r) => {
    const acc = accountById.get(r.account_id);
    const reason = r.state === "rejected" ? reasonByPrId.get(r.id) : undefined;
    const reasonCode = reason?.code ?? null;
    let reasonDetail = "";
    if (r.state === "rejected") {
      if (reasonCode) reasonDetail = reasonForDvtoCode(reasonCode).label;
      else if (reason?.description) reasonDetail = reason.description;
    } else if (r.state === "pending") {
      reasonDetail = "Awaiting batch link";
    }
    return {
      Account: acc?.account_number ?? "",
      Holder: acc?.holder_name ?? "",
      Date: formatDate(r.posted_at),
      Code: r.code,
      Payer:
        (r.payer_name_raw as string | null) ??
        extractPRPayerName(r.description ?? "") ??
        "",
      Amount: formatMinorUSD(String(r.credit_minor)),
      Currency: r.currency,
      Status: r.state,
      "DVTO code": reasonCode ?? "",
      "Reason / detail": reasonDetail,
      Reference: r.rail_native_ref ?? "",
      Description: r.description ?? "",
    };
  });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(sheetData, {
    header: [
      "Account",
      "Holder",
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
  worksheet["!cols"] = [
    { wch: 14 }, // Account
    { wch: 32 }, // Holder
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

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  }) as Buffer;

  const stamp = new Date().toISOString().slice(0, 10);
  const stateLabel = stateFilter === "all" ? "all" : stateFilter;
  const accountLabel =
    accountFilter.length > 0 ? `-${accountFilter.length}accts` : "-allaccts";
  const filename = `loan-credits-${stateLabel}${accountLabel}-${stamp}.xlsx`;

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
