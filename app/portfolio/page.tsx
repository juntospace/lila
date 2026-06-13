import Link from "next/link";

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

import { discoverAvailableBackfills } from "./actions";
import { BackfillPanel } from "./backfill-panel";

export const dynamic = "force-dynamic";

interface SnapshotRow {
  id: string;
  snapshot_date: string;
  status: string;
  borrower_row_count: number;
  loan_row_count: number;
  repayment_row_count: number;
  loans_with_borrower_match: number;
  loans_without_borrower_match: number;
  imported_at: string;
  finalized_at: string | null;
  error_message: string | null;
  entity_id: string;
}

interface EntityRow {
  id: string;
  code: string;
  display_name: string;
  legal_name: string;
  is_active: boolean;
}

export default async function PortfolioPage() {
  const session = await requirePortfolioWriter();
  const supabase = await createSupabaseServerClient();

  const [{ data: entities }, { data: snapshots }] = await Promise.all([
    supabase
      .from("portfolio_entities")
      .select("id, code, display_name, legal_name, is_active")
      .eq("is_active", true)
      .order("display_name", { ascending: true }),
    supabase
      .from("portfolio_snapshots")
      .select(
        "id, snapshot_date, status, borrower_row_count, loan_row_count, repayment_row_count, loans_with_borrower_match, loans_without_borrower_match, imported_at, finalized_at, error_message, entity_id",
      )
      .order("snapshot_date", { ascending: false })
      .limit(50),
  ]);

  const entityList: EntityRow[] = entities ?? [];
  const snapshotList: SnapshotRow[] = snapshots ?? [];

  // DQ severity rollup per snapshot.
  const snapshotIds = snapshotList.map((s) => s.id);
  const dqBySnapshot = new Map<string, { warn: number; critical: number }>();
  if (snapshotIds.length > 0) {
    const { data: dq } = await supabase
      .from("portfolio_snapshot_dq")
      .select("snapshot_id, severity")
      .in("snapshot_id", snapshotIds);
    for (const row of dq ?? []) {
      const entry = dqBySnapshot.get(row.snapshot_id as string) ?? {
        warn: 0,
        critical: 0,
      };
      if (row.severity === "warn") entry.warn += 1;
      if (row.severity === "critical") entry.critical += 1;
      dqBySnapshot.set(row.snapshot_id as string, entry);
    }
  }

  const snapshotsByEntity = new Map<string, SnapshotRow[]>();
  for (const s of snapshotList) {
    const list = snapshotsByEntity.get(s.entity_id) ?? [];
    list.push(s);
    snapshotsByEntity.set(s.entity_id, list);
  }

  // Discover backfill folders and map existing snapshot status per date.
  const backfills = await discoverAvailableBackfills();
  const existingByDate: Record<string, string> = {};
  for (const s of snapshotList) {
    existingByDate[s.snapshot_date] = s.status;
  }

  return (
    <OperatorShell session={session}>
      <header className="mb-8">
        <p className="text-sm text-fg-muted">Portfolio</p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
          Daily backup snapshots
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">
          Each snapshot is one LoanDisk daily backup per entity (borrowers,
          loans, repayments) classified against the active portfolio policy.
          Re-running the same day replaces the previous snapshot in place.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="space-y-6">
          {entityList.length === 0 ? (
            <Card>
              <CardBody>
                <p className="text-sm text-fg-muted">
                  No entities configured. Re-run the seed migration.
                </p>
              </CardBody>
            </Card>
          ) : (
            entityList.map((entity) => {
              const rows = snapshotsByEntity.get(entity.id) ?? [];
              return (
                <Card key={entity.id}>
                  <CardHeader>
                    <CardTitle>{entity.display_name}</CardTitle>
                    <CardDescription>{entity.legal_name}</CardDescription>
                  </CardHeader>
                  <CardBody>
                    {rows.length === 0 ? (
                      <p className="text-sm text-fg-muted">
                        No snapshots ingested yet.
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                            <tr>
                              <th className="pb-3 pr-4">Date</th>
                              <th className="pb-3 pr-4">Status</th>
                              <th className="pb-3 pr-4 text-right">Borrowers</th>
                              <th className="pb-3 pr-4 text-right">Loans</th>
                              <th className="pb-3 pr-4 text-right">Repayments</th>
                              <th className="pb-3 pr-4 text-right">DQ flags</th>
                              <th className="pb-3 pr-4">Imported</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((row) => {
                              const dq = dqBySnapshot.get(row.id) ?? {
                                warn: 0,
                                critical: 0,
                              };
                              return (
                                <tr
                                  key={row.id}
                                  className="border-t border-border-subtle"
                                >
                                  <td className="py-3 pr-4">
                                    <Link
                                      href={`/portfolio/snapshots/${row.id}`}
                                      className="text-fg underline-offset-4 hover:underline"
                                    >
                                      {row.snapshot_date}
                                    </Link>
                                  </td>
                                  <td className="py-3 pr-4">
                                    <StatusBadge status={row.status} />
                                  </td>
                                  <td className="py-3 pr-4 text-right tabular-nums">
                                    {row.borrower_row_count.toLocaleString()}
                                  </td>
                                  <td className="py-3 pr-4 text-right tabular-nums">
                                    {row.loan_row_count.toLocaleString()}
                                  </td>
                                  <td className="py-3 pr-4 text-right tabular-nums">
                                    {row.repayment_row_count.toLocaleString()}
                                  </td>
                                  <td className="py-3 pr-4 text-right text-xs">
                                    {dq.critical > 0 && (
                                      <span className="mr-2 inline-flex items-center rounded bg-danger-subtle px-2 py-0.5 text-danger">
                                        {dq.critical} crit
                                      </span>
                                    )}
                                    {dq.warn > 0 && (
                                      <span className="inline-flex items-center rounded bg-warning-subtle px-2 py-0.5 text-warning">
                                        {dq.warn} warn
                                      </span>
                                    )}
                                    {dq.critical === 0 && dq.warn === 0 && (
                                      <span className="text-fg-muted">ok</span>
                                    )}
                                  </td>
                                  <td className="py-3 pr-4 text-xs text-fg-muted">
                                    {formatDateTime(row.imported_at)}
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
              );
            })
          )}
        </section>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Backfill from samples</CardTitle>
              <CardDescription>
                Each{" "}
                <code className="rounded bg-bg-raised px-1 py-0.5 text-xs">
                  tmp/samples/&lt;YYYY-MM-DD&gt;/
                </code>{" "}
                folder becomes a Crediclaro snapshot for that date. Re-running
                replaces the day. Backfill multiple days to unlock slice 2 KPIs
                (roll rate, cure rate, vintage curves).
              </CardDescription>
            </CardHeader>
            <CardBody>
              <BackfillPanel
                backfills={backfills}
                existingByDate={existingByDate}
              />
            </CardBody>
          </Card>
        </aside>
      </div>
    </OperatorShell>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-success-subtle text-success",
    in_progress: "bg-info-subtle text-info",
    failed: "bg-danger-subtle text-danger",
  };
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${styles[status] ?? "bg-bg-raised text-fg-muted"}`}
    >
      {status}
    </span>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
