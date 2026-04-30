import { ChevronDown, ChevronsUpDown, ChevronUp, Download, Filter } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { requireReconWriter } from "@/lib/auth/guard";
import { extractPRPayerName, reasonForDvtoCode } from "@/lib/recon/bac";
import { formatDate, formatMinorUSD, lastWorkingDays } from "@/lib/recon/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { BackfillButton } from "./backfill-button";

export const dynamic = "force-dynamic";

type SearchParams = {
  state?: string;
  from?: string;
  to?: string;
  page?: string;
  perPage?: string;
  sort?: string;
  dir?: string;
  range?: string; // "all" overrides the last-2-working-days default
};

const STATES = ["all", "pending", "confirmed", "rejected"] as const;
type StateFilter = (typeof STATES)[number];

const SORTABLE = {
  posted_at: "Date",
  code: "Code",
  description: "Payer",
  credit_minor: "Amount",
  state: "Status",
  rail_native_ref: "Reference",
} as const;
type SortKey = keyof typeof SORTABLE;
const SORT_KEYS = Object.keys(SORTABLE) as SortKey[];

const PER_PAGE_DEFAULT = 20;
const PER_PAGE_OPTIONS = [20, 50, 100, 250];

function asState(v: string | undefined): StateFilter {
  return (STATES as readonly string[]).includes(v ?? "")
    ? (v as StateFilter)
    : "all";
}

function asInt(v: string | undefined, fallback: number, min = 1, max = Infinity): number {
  const n = Number.parseInt(v ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function isoOrUndefined(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

function asSortKey(v: string | undefined): SortKey {
  return SORT_KEYS.includes(v as SortKey) ? (v as SortKey) : "posted_at";
}

function asDir(v: string | undefined): "asc" | "desc" {
  return v === "asc" ? "asc" : "desc";
}

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireReconWriter();
  const { accountId } = await params;
  const sp = await searchParams;

  const stateFilter = asState(sp.state);
  const explicitFrom = isoOrUndefined(sp.from);
  const explicitTo = isoOrUndefined(sp.to);
  const sort = asSortKey(sp.sort);
  const dir = asDir(sp.dir);
  const perPage = asInt(sp.perPage, PER_PAGE_DEFAULT, 1, 500);
  const page = asInt(sp.page, 1, 1);
  const showAll = sp.range === "all";

  const supabase = await createSupabaseServerClient();

  const { data: account } = await supabase
    .from("bank_accounts")
    .select("id, rail, account_number, holder_name, currency, status")
    .eq("id", accountId)
    .single();

  if (!account) notFound();

  // Resolve the date range in effect:
  //   1. URL has explicit from/to → honor those.
  //   2. URL has range=all → no date filter.
  //   3. Otherwise default to the last 2 working days anchored to this
  //      account's most-recent posted_at (or today if no data yet).
  let defaultRange: { from: string; to: string } | null = null;
  if (!explicitFrom && !explicitTo && !showAll) {
    const { data: maxRow } = await supabase
      .from("recon_transactions")
      .select("posted_at")
      .eq("account_id", accountId)
      .order("posted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ref = maxRow?.posted_at
      ? new Date(`${maxRow.posted_at}T00:00:00Z`)
      : new Date();
    defaultRange = lastWorkingDays(ref, 2);
  }
  const from = explicitFrom ?? defaultRange?.from;
  const to = explicitTo ?? defaultRange?.to;
  const usingDefault = !explicitFrom && !explicitTo && !showAll;

  // Aggregate totals don't depend on pagination — query them with their
  // own narrow projection so the page row count is independent.
  const totalsQuery = supabase
    .from("recon_transactions")
    .select("state, credit_minor")
    .eq("account_id", accountId)
    .eq("kind", "loan_inflow");
  if (stateFilter !== "all") totalsQuery.eq("state", stateFilter);
  if (from) totalsQuery.gte("posted_at", from);
  if (to) totalsQuery.lte("posted_at", to);
  const { data: totalsRows } = await totalsQuery;

  // Page query. We use { count: "exact" } so the footer can render the
  // total page count without a second roundtrip.
  let pageQuery = supabase
    .from("recon_transactions")
    .select(
      "id, posted_at, code, credit_minor, description, state, confirmable_after, rail_native_ref, payer_name_raw",
      { count: "exact" },
    )
    .eq("account_id", accountId)
    .eq("kind", "loan_inflow");
  if (stateFilter !== "all") pageQuery = pageQuery.eq("state", stateFilter);
  if (from) pageQuery = pageQuery.gte("posted_at", from);
  if (to) pageQuery = pageQuery.lte("posted_at", to);

  // Stable secondary sort on id avoids row-shuffling when many rows share
  // the same primary key (e.g., 200 PRs all posted on the same day).
  pageQuery = pageQuery
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: false });

  const start = (page - 1) * perPage;
  pageQuery = pageQuery.range(start, start + perPage - 1);

  const { data: rows, count } = await pageQuery;
  const credits = rows ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, totalPages);

  // Reasons for rejected PRs on this page. We fetch BOTH the parsed
  // return_code and the raw description so the UI can fall back to the
  // description when the regex didn't extract a code (some legacy DA rows
  // landed before the parser was broadened).
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
          { return_code: d.return_code, description: d.description },
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

  // Surface a one-time hint if any rejected DAs in the system still have a
  // null return_code — the operator can backfill them via the button.
  const { count: nullDaCount } = await supabase
    .from("recon_transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("code", "DA")
    .is("return_code", null);
  const showBackfillHint = (nullDaCount ?? 0) > 0;

  const totalsByState = (totalsRows ?? []).reduce(
    (acc, r) => {
      const s = r.state as keyof typeof acc;
      if (s in acc) {
        acc[s].count++;
        acc[s].minor += BigInt(String(r.credit_minor));
      }
      return acc;
    },
    {
      pending: { count: 0, minor: 0n },
      confirmed: { count: 0, minor: 0n },
      rejected: { count: 0, minor: 0n },
    } as Record<"pending" | "confirmed" | "rejected", { count: number; minor: bigint }>,
  );

  const baseQS = (overrides: Partial<SearchParams>): string => {
    const merged: SearchParams = {
      state: stateFilter,
      from,
      to,
      sort,
      dir,
      page: String(safePage),
      perPage: String(perPage),
      ...overrides,
    };
    const usp = new URLSearchParams();
    if (merged.state && merged.state !== "all") usp.set("state", merged.state);
    if (merged.from) usp.set("from", merged.from);
    if (merged.to) usp.set("to", merged.to);
    if (merged.sort && merged.sort !== "posted_at") usp.set("sort", merged.sort);
    if (merged.dir && merged.dir !== "desc") usp.set("dir", merged.dir);
    if (merged.page && merged.page !== "1") usp.set("page", merged.page);
    if (merged.perPage && merged.perPage !== String(PER_PAGE_DEFAULT))
      usp.set("perPage", merged.perPage);
    const s = usp.toString();
    return s ? `?${s}` : "";
  };

  const exportHref = `/recon/accounts/${accountId}/export${exportQS({ state: stateFilter, from, to })}`;

  const showingFrom = total === 0 ? 0 : start + 1;
  const showingTo = Math.min(start + perPage, total);

  return (
    <OperatorShell session={session}>
      <header className="mb-8">
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Link href="/recon/upload" className="hover:text-fg">
            Reconciliation
          </Link>
          <span>·</span>
          <span>Accounts</span>
        </div>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
          {account.holder_name}
        </h1>
        <p className="mt-1 text-sm text-fg-muted">
          {account.rail.toUpperCase()} · {account.account_number} · {account.currency}
        </p>
      </header>

      <section
        aria-label="Loan-credit totals"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        <Stat label="Pending" tone="info" {...totalsByState.pending} />
        <Stat label="Confirmed" tone="success" {...totalsByState.confirmed} />
        <Stat label="Rejected" tone="warning" {...totalsByState.rejected} />
      </section>

      {showBackfillHint && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-fg">
          <div>
            <strong className="text-warning">DVTO codes not yet extracted</strong>{" "}
            for {nullDaCount} reversal row{nullDaCount === 1 ? "" : "s"} on this
            account. Re-parse to populate them.
          </div>
          <BackfillButton accountId={accountId} />
        </div>
      )}

      <Card className="mt-8">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Loan-related credits</CardTitle>
            <CardDescription>
              PR (Junto-initiated ACH inbound) and 4C (irrevocable inbound ACH) only.
            </CardDescription>
          </div>
          <Button asChild variant="secondary" size="sm">
            <a href={exportHref}>
              <Download className="h-4 w-4" />
              Export Excel ({total})
            </a>
          </Button>
        </CardHeader>

        <form className="border-b border-border-subtle bg-bg-raised/40 px-6 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="state">Status</Label>
              <select
                id="state"
                name="state"
                defaultValue={stateFilter}
                className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="from">From</Label>
              <Input id="from" type="date" name="from" defaultValue={from ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">To</Label>
              <Input id="to" type="date" name="to" defaultValue={to ?? ""} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm">
                <Filter className="h-4 w-4" />
                Apply
              </Button>
              {(stateFilter !== "all" || explicitFrom || explicitTo || showAll) && (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/recon/accounts/${accountId}`}>Reset</Link>
                </Button>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-subtle">
            <span>
              {usingDefault
                ? `Showing the last 2 working days (${from} → ${to}). `
                : showAll
                  ? "Showing all history. "
                  : "Custom range. "}
            </span>
            {!showAll && (
              <Link
                href={`/recon/accounts/${accountId}?range=all${stateFilter !== "all" ? `&state=${stateFilter}` : ""}`}
                className="text-brand-300 hover:text-brand-200"
              >
                Show all history
              </Link>
            )}
            {showAll && (
              <Link
                href={`/recon/accounts/${accountId}${stateFilter !== "all" ? `?state=${stateFilter}` : ""}`}
                className="text-brand-300 hover:text-brand-200"
              >
                Back to last 2 working days
              </Link>
            )}
          </div>
          {/* Preserve sort + perPage when re-applying filters */}
          {sort !== "posted_at" && <input type="hidden" name="sort" value={sort} />}
          {dir !== "desc" && <input type="hidden" name="dir" value={dir} />}
          {perPage !== PER_PAGE_DEFAULT && (
            <input type="hidden" name="perPage" value={String(perPage)} />
          )}
        </form>

        <CardBody>
          {credits.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No loan credits match the current filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <SortHeader col="posted_at" label="Date" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                    <SortHeader col="code" label="Code" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                    <SortHeader col="description" label="Payer" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                    <SortHeader col="credit_minor" label="Amount" sort={sort} dir={dir} accountId={accountId} qs={baseQS} align="right" />
                    <SortHeader col="state" label="Status" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                    <th className="pb-3 pr-4">Reason / Detail</th>
                    <SortHeader col="rail_native_ref" label="Reference" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {credits.map((row) => {
                    const reason = reasonByPrId.get(row.id);
                    let reasonText: string;
                    if (row.state === "rejected") {
                      if (reason?.code) {
                        reasonText = `${reason.code} · ${reasonForDvtoCode(reason.code).label}`;
                      } else if (reason?.description) {
                        // Legacy fallback: the parser regex missed this DA's
                        // code, so surface the raw description so the operator
                        // still has actionable context.
                        reasonText = reason.description;
                      } else {
                        reasonText = "—";
                      }
                    } else if (row.state === "pending" && row.confirmable_after) {
                      reasonText = `Confirmable after ${formatDate(
                        (row.confirmable_after as string).slice(0, 10),
                      )}`;
                    } else {
                      reasonText = "—";
                    }
                    const payer =
                      (row.payer_name_raw as string | null) ??
                      extractPRPayerName(row.description as string) ??
                      "—";
                    return (
                      <tr key={row.id}>
                        <td className="py-3 pr-4 text-fg-muted">
                          {formatDate(row.posted_at as string)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-fg">
                          {row.code}
                        </td>
                        <td className="py-3 pr-4 text-fg">{payer}</td>
                        <td className="py-3 pr-4 text-right font-medium tabular-nums text-fg">
                          {formatMinorUSD(String(row.credit_minor))}
                        </td>
                        <td className="py-3 pr-4">
                          <StateBadge state={row.state as string} />
                        </td>
                        <td className="py-3 pr-4 text-xs text-fg-muted">
                          {reasonText}
                        </td>
                        <td className="py-3 font-mono text-xs text-fg-muted">
                          {(row.rail_native_ref as string) || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>

        {total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-6 py-3 text-sm text-fg-muted">
            <div>
              Showing <span className="text-fg tabular-nums">{showingFrom}</span>–
              <span className="text-fg tabular-nums">{showingTo}</span> of{" "}
              <span className="text-fg tabular-nums">{total}</span>
            </div>
            <div className="flex items-center gap-3">
              <PerPageSelect accountId={accountId} qs={baseQS} current={perPage} />
              <div className="flex items-center gap-1">
                <PageLink
                  accountId={accountId}
                  qs={baseQS}
                  page={Math.max(1, safePage - 1)}
                  disabled={safePage <= 1}
                  label="Prev"
                />
                <span className="px-2 text-xs">
                  Page <span className="text-fg tabular-nums">{safePage}</span> of{" "}
                  <span className="text-fg tabular-nums">{totalPages}</span>
                </span>
                <PageLink
                  accountId={accountId}
                  qs={baseQS}
                  page={Math.min(totalPages, safePage + 1)}
                  disabled={safePage >= totalPages}
                  label="Next"
                />
              </div>
            </div>
          </div>
        )}
      </Card>
    </OperatorShell>
  );
}

function SortHeader({
  col,
  label,
  sort,
  dir,
  accountId,
  qs,
  align = "left",
}: {
  col: SortKey;
  label: string;
  sort: SortKey;
  dir: "asc" | "desc";
  accountId: string;
  qs: (overrides: Partial<SearchParams>) => string;
  align?: "left" | "right";
}) {
  const active = sort === col;
  // Toggle direction on the active column; new column defaults to desc
  // (matching the page's overall recency-first orientation).
  const nextDir = active && dir === "desc" ? "asc" : "desc";
  const Icon = !active ? ChevronsUpDown : dir === "desc" ? ChevronDown : ChevronUp;
  return (
    <th className={`pb-3 pr-4 ${align === "right" ? "text-right" : ""}`}>
      <Link
        href={`/recon/accounts/${accountId}${qs({ sort: col, dir: nextDir, page: "1" })}`}
        className={`inline-flex items-center gap-1 hover:text-fg ${active ? "text-fg" : ""} ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        <span>{label}</span>
        <Icon className="h-3 w-3" />
      </Link>
    </th>
  );
}

function PageLink({
  accountId,
  qs,
  page,
  disabled,
  label,
}: {
  accountId: string;
  qs: (overrides: Partial<SearchParams>) => string;
  page: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="rounded border border-border-subtle px-3 py-1 text-xs text-fg-subtle opacity-50">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={`/recon/accounts/${accountId}${qs({ page: String(page) })}`}
      className="rounded border border-border-subtle px-3 py-1 text-xs text-fg hover:bg-bg-raised"
    >
      {label}
    </Link>
  );
}

function PerPageSelect({
  accountId,
  qs,
  current,
}: {
  accountId: string;
  qs: (overrides: Partial<SearchParams>) => string;
  current: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs">Per page</span>
      <div className="flex gap-1">
        {PER_PAGE_OPTIONS.map((n) => (
          <Link
            key={n}
            href={`/recon/accounts/${accountId}${qs({ perPage: String(n), page: "1" })}`}
            className={`rounded px-2 py-0.5 text-xs ${
              n === current
                ? "bg-bg-raised text-fg"
                : "text-fg-subtle hover:bg-bg-raised hover:text-fg"
            }`}
          >
            {n}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  count,
  minor,
  tone,
}: {
  label: string;
  count: number;
  minor: bigint;
  tone: "info" | "success" | "warning";
}) {
  const colors = {
    info: "bg-info-subtle text-info",
    success: "bg-success-subtle text-success",
    warning: "bg-warning-subtle text-warning",
  } as const;
  return (
    <div className="rounded border border-border-subtle bg-bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-fg-subtle">{label}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${colors[tone]}`}>{count}</span>
      </div>
      <div className="mt-2 font-display text-2xl font-semibold text-fg tabular-nums">
        {formatMinorUSD(minor)}
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const tone =
    state === "confirmed"
      ? "bg-success-subtle text-success"
      : state === "rejected"
        ? "bg-warning-subtle text-warning"
        : "bg-info-subtle text-info";
  return (
    <span className={`rounded px-2 py-0.5 text-xs capitalize ${tone}`}>{state}</span>
  );
}

// Export route only takes filters, never sort/pagination — admins always
// get the full filtered set in the .xlsx.
function exportQS(params: { state: string; from?: string; to?: string }): string {
  const sp = new URLSearchParams();
  if (params.state && params.state !== "all") sp.set("state", params.state);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  const s = sp.toString();
  return s ? `?${s}` : "";
}
