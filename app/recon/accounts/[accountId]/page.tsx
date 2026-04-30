import { Download, Filter } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { requireReconWriter } from "@/lib/auth/guard";
import { extractPRPayerName, reasonForDvtoCode } from "@/lib/recon/bac";
import { formatDate, formatMinorUSD } from "@/lib/recon/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type SearchParams = {
  state?: string;
  from?: string;
  to?: string;
};

const STATES = ["all", "pending", "confirmed", "rejected"] as const;
type StateFilter = (typeof STATES)[number];

function asState(v: string | undefined): StateFilter {
  return (STATES as readonly string[]).includes(v ?? "")
    ? (v as StateFilter)
    : "all";
}

function isoOrUndefined(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
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
  const from = isoOrUndefined(sp.from);
  const to = isoOrUndefined(sp.to);

  const supabase = await createSupabaseServerClient();

  const { data: account } = await supabase
    .from("bank_accounts")
    .select("id, rail, account_number, holder_name, currency, status")
    .eq("id", accountId)
    .single();

  if (!account) notFound();

  let query = supabase
    .from("recon_transactions")
    .select(
      "id, posted_at, code, credit_minor, description, state, confirmable_after, rail_native_ref, payer_name_raw",
    )
    .eq("account_id", accountId)
    .eq("kind", "loan_inflow")
    .order("posted_at", { ascending: false })
    .order("id", { ascending: false });

  if (stateFilter !== "all") query = query.eq("state", stateFilter);
  if (from) query = query.gte("posted_at", from);
  if (to) query = query.lte("posted_at", to);

  const { data: rows } = await query;
  const credits = rows ?? [];

  // For rejected PRs, fetch the linked DA so we can show the DVTO code.
  const rejectedPrIds = credits
    .filter((r) => r.code === "PR" && r.state === "rejected")
    .map((r) => r.id);
  const reasonByPrId = new Map<string, { code: string | null }>();
  if (rejectedPrIds.length > 0) {
    const { data: links } = await supabase
      .from("recon_links")
      .select("pr_txn_id, da_txn_id")
      .in("pr_txn_id", rejectedPrIds);
    const daIds = (links ?? []).map((l) => l.da_txn_id);
    let daById = new Map<string, { return_code: string | null }>();
    if (daIds.length > 0) {
      const { data: das } = await supabase
        .from("recon_transactions")
        .select("id, return_code")
        .in("id", daIds);
      daById = new Map((das ?? []).map((d) => [d.id, { return_code: d.return_code }]));
    }
    for (const link of links ?? []) {
      reasonByPrId.set(link.pr_txn_id, {
        code: daById.get(link.da_txn_id)?.return_code ?? null,
      });
    }
  }

  // Aggregates for the header strip.
  const totalsByState = credits.reduce(
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

  const exportHref = `/recon/accounts/${accountId}/export${buildQuery({ state: stateFilter, from, to })}`;

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
              Export Excel
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
              {(stateFilter !== "all" || from || to) && (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/recon/accounts/${accountId}`}>Clear</Link>
                </Button>
              )}
            </div>
          </div>
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
                    <th className="pb-3 pr-4">Date</th>
                    <th className="pb-3 pr-4">Code</th>
                    <th className="pb-3 pr-4">Payer</th>
                    <th className="pb-3 pr-4 text-right">Amount</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3 pr-4">Reason / Detail</th>
                    <th className="pb-3">Reference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {credits.map((row) => {
                    const reason = reasonByPrId.get(row.id);
                    const reasonText =
                      row.state === "rejected"
                        ? `${reason?.code ?? "—"} · ${reasonForDvtoCode(reason?.code).label}`
                        : row.state === "pending" && row.confirmable_after
                          ? `Confirmable after ${formatDate(
                              (row.confirmable_after as string).slice(0, 10),
                            )}`
                          : "—";
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
      </Card>
    </OperatorShell>
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

function buildQuery(params: { state: string; from?: string; to?: string }): string {
  const sp = new URLSearchParams();
  if (params.state && params.state !== "all") sp.set("state", params.state);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  const s = sp.toString();
  return s ? `?${s}` : "";
}
