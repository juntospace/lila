import Link from "next/link";
import { notFound } from "next/navigation";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import {
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { requirePortfolioWriter } from "@/lib/auth/guard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ snapshotId: string }>;
}

interface LoanAggregateRow {
  status_normalized: string | null;
  portfolio_segment: string | null;
  ifrs_stage: string | null;
  management_vintage: string | null;
  is_npl: boolean | null;
  balance_amount_minor: number | string | null;
  principal_amount_minor: number | string | null;
  paid_amount_minor: number | string | null;
  days_past_due: number | null;
}

interface DqRow {
  metric: string;
  value_numeric: number | string | null;
  value_text: string | null;
  severity: string;
  detail: Record<string, unknown> | null;
}

export default async function PortfolioSnapshotPage({ params }: PageProps) {
  const session = await requirePortfolioWriter();
  const { snapshotId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: snapshot, error: snapshotError } = await supabase
    .from("portfolio_snapshots")
    .select(
      "id, entity_id, snapshot_date, status, borrower_row_count, loan_row_count, repayment_row_count, loans_with_borrower_match, loans_without_borrower_match, imported_at, finalized_at, error_message, source_files",
    )
    .eq("id", snapshotId)
    .maybeSingle();

  if (snapshotError || !snapshot) {
    notFound();
  }

  const { data: entity } = await supabase
    .from("portfolio_entities")
    .select("display_name, legal_name, code")
    .eq("id", snapshot.entity_id as string)
    .single();

  const [{ data: loans }, { data: dq }] = await Promise.all([
    supabase
      .from("portfolio_loans")
      .select(
        "status_normalized, portfolio_segment, ifrs_stage, management_vintage, is_npl, balance_amount_minor, principal_amount_minor, paid_amount_minor, days_past_due",
      )
      .eq("snapshot_id", snapshotId),
    supabase
      .from("portfolio_snapshot_dq")
      .select("metric, value_numeric, value_text, severity, detail")
      .eq("snapshot_id", snapshotId)
      .order("severity", { ascending: false })
      .order("metric", { ascending: true }),
  ]);

  const loanRows: LoanAggregateRow[] = (loans ?? []) as LoanAggregateRow[];
  const dqRows: DqRow[] = (dq ?? []) as DqRow[];

  // -------- Aggregates --------
  const segCounts = new Map<string, number>();
  const segBalance = new Map<string, bigint>();
  const statusCounts = new Map<string, number>();
  const stageCounts = new Map<string, number>();
  const vintageCounts = new Map<string, number>();
  let totalPrincipalLent = 0n;
  let totalPaid = 0n;
  let openBalance = 0n;
  let nplBalance = 0n;
  let nplCount = 0;

  for (const l of loanRows) {
    const seg = l.portfolio_segment ?? "(null)";
    const status = l.status_normalized ?? "(null)";
    const stage = l.ifrs_stage ?? "(null)";
    const vintage = l.management_vintage ?? "(null)";
    const balance = toBigInt(l.balance_amount_minor);
    const principalLent = toBigInt(l.principal_amount_minor);
    const paid = toBigInt(l.paid_amount_minor);
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
    vintageCounts.set(vintage, (vintageCounts.get(vintage) ?? 0) + 1);
    totalPrincipalLent += principalLent;
    totalPaid += paid;
    if (status !== "closed") {
      segCounts.set(seg, (segCounts.get(seg) ?? 0) + 1);
      segBalance.set(seg, (segBalance.get(seg) ?? 0n) + balance);
      openBalance += balance;
      if (l.is_npl) {
        nplBalance += balance;
        nplCount += 1;
      }
    }
  }

  // Find borrower-join rate from DQ for the header.
  const joinMatchRate = numericMetric(dqRows, "borrower_join_match_rate");
  const unresolvedJoins = numericMetric(dqRows, "borrower_join_unresolved_count");

  const totalEntries = (m: Map<string, number>) =>
    Array.from(m.values()).reduce((acc, n) => acc + n, 0);

  return (
    <OperatorShell session={session}>
      <header className="mb-8">
        <p className="text-sm text-fg-muted">
          <Link
            href="/portfolio"
            className="underline-offset-4 hover:underline"
          >
            Portfolio
          </Link>{" "}
          · {entity?.display_name ?? "—"}
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
          Snapshot {snapshot.snapshot_date as string}
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          Status <Badge>{snapshot.status as string}</Badge> · Imported{" "}
          {formatDateTime(snapshot.imported_at as string)}
          {snapshot.finalized_at && (
            <> · Finalized {formatDateTime(snapshot.finalized_at as string)}</>
          )}
        </p>
        {snapshot.error_message ? (
          <div className="mt-4 rounded border border-danger/40 bg-danger-subtle p-3 text-sm text-fg">
            <strong>Ingest error:</strong> {snapshot.error_message as string}
          </div>
        ) : null}
      </header>

      {/* -------- KPI row -------- */}
      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Active book balance"
          value={fmtMoney(openBalance)}
          sub={`${(loanRows.length - (statusCounts.get("closed") ?? 0)).toLocaleString()} open loans`}
        />
        <Kpi
          label="Total principal lent"
          value={fmtMoney(totalPrincipalLent)}
          sub={`${loanRows.length.toLocaleString()} loans all-time`}
        />
        <Kpi
          label="Total collected"
          value={fmtMoney(totalPaid)}
          sub={`${(snapshot.repayment_row_count as number).toLocaleString()} repayment rows`}
        />
        <Kpi
          label="NPL balance (≥ 90 DPD)"
          value={fmtMoney(nplBalance)}
          sub={`${nplCount.toLocaleString()} loans · ${
            openBalance === 0n
              ? "—"
              : fmtPct(Number(nplBalance) / Number(openBalance))
          } of open`}
        />
      </section>

      {/* -------- Borrower-join health -------- */}
      <section className="mb-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Borrower↔loan join</CardTitle>
            <CardDescription>
              How loans link back to borrowers in this snapshot.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-fg-subtle">
                  Match rate
                </div>
                <div className="mt-1 text-2xl font-semibold text-fg">
                  {joinMatchRate === null ? "—" : fmtPct(joinMatchRate)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-fg-subtle">
                  Unresolved
                </div>
                <div className="mt-1 text-2xl font-semibold text-fg">
                  {unresolvedJoins === null
                    ? "—"
                    : unresolvedJoins.toLocaleString()}
                </div>
              </div>
              <div className="col-span-2 grid grid-cols-2 gap-2 border-t border-border-subtle pt-3">
                <Stat
                  label="With match"
                  value={(snapshot.loans_with_borrower_match as number).toLocaleString()}
                />
                <Stat
                  label="Without"
                  value={(snapshot.loans_without_borrower_match as number).toLocaleString()}
                />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Snapshot rows</CardTitle>
            <CardDescription>
              Counts written to the snapshot&apos;s child tables.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <Stat
                label="Borrowers"
                value={(snapshot.borrower_row_count as number).toLocaleString()}
              />
              <Stat
                label="Loans"
                value={(snapshot.loan_row_count as number).toLocaleString()}
              />
              <Stat
                label="Repayments"
                value={(snapshot.repayment_row_count as number).toLocaleString()}
              />
            </div>
          </CardBody>
        </Card>
      </section>

      {/* -------- Segment + Status + Stage breakdowns -------- */}
      <section className="mb-8 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Portfolio segment (open book)</CardTitle>
            <CardDescription>Strategic split by management × product.</CardDescription>
          </CardHeader>
          <CardBody>
            <SegmentTable
              countMap={segCounts}
              balanceMap={segBalance}
              order={["old_personal", "new_personal", "cash_advance", "other"]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Status distribution</CardTitle>
            <CardDescription>
              Normalized vs the active policy&apos;s charge-off threshold.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <CountTable
              counts={statusCounts}
              total={totalEntries(statusCounts)}
              order={[
                "performing",
                "delinquent",
                "legacy_delinquent",
                "closed",
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>IFRS stage</CardTitle>
            <CardDescription>By DPD against policy thresholds.</CardDescription>
          </CardHeader>
          <CardBody>
            <CountTable
              counts={stageCounts}
              total={totalEntries(stageCounts)}
              order={["stage_1", "stage_2", "stage_3", "closed"]}
            />
          </CardBody>
        </Card>
      </section>

      {/* -------- DQ metrics -------- */}
      <section className="mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Data quality</CardTitle>
            <CardDescription>
              Per-snapshot DQ metrics. Critical = blocker. Warn = look.
            </CardDescription>
          </CardHeader>
          <CardBody>
            {dqRows.length === 0 ? (
              <p className="text-sm text-fg-muted">No DQ metrics recorded.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                    <tr>
                      <th className="pb-3 pr-4">Metric</th>
                      <th className="pb-3 pr-4">Severity</th>
                      <th className="pb-3 pr-4 text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dqRows.map((m) => (
                      <tr
                        key={m.metric}
                        className="border-t border-border-subtle align-top"
                      >
                        <td className="py-3 pr-4 font-mono text-xs text-fg">
                          {m.metric}
                        </td>
                        <td className="py-3 pr-4">
                          <SeverityBadge severity={m.severity} />
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {formatDqValue(m)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </section>

      {/* -------- Source files -------- */}
      <section className="mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Source files</CardTitle>
            <CardDescription>
              SHA-256 of each ingested CSV. Re-uploading the same bytes is a
              no-op replace.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <SourceFilesTable source={snapshot.source_files} />
          </CardBody>
        </Card>
      </section>
    </OperatorShell>
  );
}

// =============================================================
// Helpers
// =============================================================

function toBigInt(v: number | string | null): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.length > 0) {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function fmtMoney(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${cents}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function numericMetric(rows: DqRow[], name: string): number | null {
  const m = rows.find((r) => r.metric === name);
  if (!m || m.value_numeric === null) return null;
  return typeof m.value_numeric === "string"
    ? Number(m.value_numeric)
    : m.value_numeric;
}

function formatDqValue(m: DqRow): React.ReactNode {
  if (m.value_numeric === null && !m.value_text) return "(see detail)";
  if (m.value_numeric !== null) {
    const n =
      typeof m.value_numeric === "string"
        ? Number(m.value_numeric)
        : m.value_numeric;
    if (
      m.metric.startsWith("field_completeness_") ||
      m.metric === "borrower_join_match_rate" ||
      m.metric.startsWith("control_total_")
    ) {
      return fmtPct(n);
    }
    return n.toLocaleString();
  }
  return m.value_text;
}

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardBody>
        <div className="text-xs uppercase tracking-wide text-fg-subtle">
          {label}
        </div>
        <div className="mt-2 font-display text-2xl font-semibold tabular-nums text-fg">
          {value}
        </div>
        {sub && <div className="mt-1 text-xs text-fg-muted">{sub}</div>}
      </CardBody>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border-subtle bg-bg-raised px-3 py-2">
      <div className="text-xs text-fg-subtle">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-fg">{value}</div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded bg-bg-raised px-2 py-0.5 text-xs text-fg-muted">
      {children}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    ok: "bg-success-subtle text-success",
    warn: "bg-warning-subtle text-warning",
    critical: "bg-danger-subtle text-danger",
  };
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${
        styles[severity] ?? "bg-bg-raised text-fg-muted"
      }`}
    >
      {severity}
    </span>
  );
}

function CountTable({
  counts,
  total,
  order,
}: {
  counts: Map<string, number>;
  total: number;
  order: string[];
}) {
  const keys = Array.from(
    new Set([...order, ...Array.from(counts.keys())]),
  ).filter((k) => counts.has(k));
  return (
    <table className="w-full text-sm">
      <tbody>
        {keys.map((k) => {
          const n = counts.get(k) ?? 0;
          return (
            <tr key={k} className="border-t border-border-subtle first:border-t-0">
              <td className="py-2 pr-4 font-mono text-xs text-fg">{k}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-fg">
                {n.toLocaleString()}
              </td>
              <td className="py-2 text-right text-xs tabular-nums text-fg-muted">
                {total === 0 ? "—" : fmtPct(n / total)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SegmentTable({
  countMap,
  balanceMap,
  order,
}: {
  countMap: Map<string, number>;
  balanceMap: Map<string, bigint>;
  order: string[];
}) {
  const keys = Array.from(
    new Set([...order, ...Array.from(countMap.keys())]),
  ).filter((k) => countMap.has(k));
  const totalBalance = Array.from(balanceMap.values()).reduce(
    (acc, v) => acc + v,
    0n,
  );
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
        <tr>
          <th className="pb-2 pr-4">Segment</th>
          <th className="pb-2 pr-4 text-right">Loans</th>
          <th className="pb-2 pr-4 text-right">Open balance</th>
          <th className="pb-2 pr-4 text-right">% of book</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => {
          const count = countMap.get(k) ?? 0;
          const balance = balanceMap.get(k) ?? 0n;
          const pct =
            totalBalance === 0n
              ? 0
              : Number((balance * 10000n) / totalBalance) / 10000;
          return (
            <tr key={k} className="border-t border-border-subtle">
              <td className="py-2 pr-4 font-mono text-xs text-fg">{k}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-fg">
                {count.toLocaleString()}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-fg">
                {fmtMoney(balance)}
              </td>
              <td className="py-2 text-right text-xs tabular-nums text-fg-muted">
                {totalBalance === 0n ? "—" : fmtPct(pct)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface SourceFileInfo {
  filename?: string;
  sha256?: string;
  byteSize?: number;
  rowCount?: number;
}

function SourceFilesTable({ source }: { source: unknown }) {
  const obj = (source ?? {}) as Record<string, SourceFileInfo>;
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return <p className="text-sm text-fg-muted">No source files recorded.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
        <tr>
          <th className="pb-2 pr-4">Slot</th>
          <th className="pb-2 pr-4">Filename</th>
          <th className="pb-2 pr-4 text-right">Rows</th>
          <th className="pb-2 pr-4 text-right">Bytes</th>
          <th className="pb-2">SHA-256</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([slot, info]) => (
          <tr key={slot} className="border-t border-border-subtle">
            <td className="py-2 pr-4 font-mono text-xs text-fg">{slot}</td>
            <td className="py-2 pr-4 text-fg">{info.filename ?? "—"}</td>
            <td className="py-2 pr-4 text-right tabular-nums text-fg">
              {info.rowCount?.toLocaleString() ?? "—"}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums text-fg">
              {info.byteSize?.toLocaleString() ?? "—"}
            </td>
            <td className="py-2 font-mono text-xs text-fg-muted">
              {info.sha256 ? `${info.sha256.slice(0, 16)}…` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
