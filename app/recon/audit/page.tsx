import Link from "next/link";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import {
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { requireReconWriter } from "@/lib/auth/guard";
import { formatDate, formatMinorUSD } from "@/lib/recon/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type SearchParams = {
  days?: string;
};

type ActionRow = {
  id: string;
  acted_at: string;
  action: string;
  prior_state: string | null;
  new_state: string | null;
  justification: string;
  acted_by: string | null;
  txn_id: string;
};

type TxnInfo = {
  id: string;
  account_id: string;
  code: string;
  posted_at: string;
  rail_native_ref: string | null;
  payer_name_raw: string | null;
  description: string | null;
  amountMinor: bigint;
};

type AccountInfo = {
  id: string;
  account_number: string;
  holder_name: string;
};

type ActorInfo = {
  full_name: string | null;
  email: string;
};

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export default async function ReconAuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireReconWriter();
  const supabase = await createSupabaseServerClient();
  const params = await searchParams;
  const days = Math.min(
    Math.max(Number(params.days ?? DEFAULT_DAYS) || DEFAULT_DAYS, 1),
    MAX_DAYS,
  );
  const now = new Date();
  const sinceIso = new Date(now.getTime() - days * 86_400_000).toISOString();

  // Fetch recent manual actions
  const { data: actionRows } = await supabase
    .from("recon_manual_actions")
    .select("id, acted_at, action, prior_state, new_state, justification, acted_by, txn_id")
    .gte("acted_at", sinceIso)
    .order("acted_at", { ascending: false })
    .limit(500);
  const actions: ActionRow[] = (actionRows ?? []).map((a) => ({
    id: a.id as string,
    acted_at: a.acted_at as string,
    action: a.action as string,
    prior_state: (a.prior_state as string | null) ?? null,
    new_state: (a.new_state as string | null) ?? null,
    justification: a.justification as string,
    acted_by: (a.acted_by as string | null) ?? null,
    txn_id: a.txn_id as string,
  }));

  // Pull the transactions referenced so we can show context per row.
  const txnIds = Array.from(new Set(actions.map((a) => a.txn_id)));
  const txnById = new Map<string, TxnInfo>();
  if (txnIds.length > 0) {
    const ID_CHUNK = 100;
    for (let i = 0; i < txnIds.length; i += ID_CHUNK) {
      const chunk = txnIds.slice(i, i + ID_CHUNK);
      const { data: txns } = await supabase
        .from("recon_transactions")
        .select(
          "id, account_id, code, posted_at, rail_native_ref, payer_name_raw, description, credit_minor, debit_minor",
        )
        .in("id", chunk);
      for (const t of txns ?? []) {
        const code = t.code as string;
        const amountMinor = BigInt(
          String(code === "DA" ? t.debit_minor : t.credit_minor),
        );
        txnById.set(t.id as string, {
          id: t.id as string,
          account_id: t.account_id as string,
          code,
          posted_at: t.posted_at as string,
          rail_native_ref: (t.rail_native_ref as string | null) ?? null,
          payer_name_raw: (t.payer_name_raw as string | null) ?? null,
          description: (t.description as string | null) ?? null,
          amountMinor,
        });
      }
    }
  }

  // Accounts referenced
  const accountIds = Array.from(
    new Set(Array.from(txnById.values()).map((t) => t.account_id)),
  );
  const accountById = new Map<string, AccountInfo>();
  if (accountIds.length > 0) {
    const { data: accs } = await supabase
      .from("bank_accounts")
      .select("id, account_number, holder_name")
      .in("id", accountIds);
    for (const a of accs ?? []) {
      accountById.set(a.id as string, {
        id: a.id as string,
        account_number: a.account_number as string,
        holder_name: a.holder_name as string,
      });
    }
  }

  // Actors
  const actorIds = Array.from(
    new Set(actions.map((a) => a.acted_by).filter((v): v is string => Boolean(v))),
  );
  const actorById = new Map<string, ActorInfo>();
  if (actorIds.length > 0) {
    const { data: profiles } = await supabase
      .from("user_profiles")
      .select("id, full_name, email")
      .in("id", actorIds);
    for (const p of profiles ?? []) {
      actorById.set(p.id as string, {
        full_name: p.full_name as string | null,
        email: p.email as string,
      });
    }
  }

  // ----- Aggregations ----------------------------------------------------

  // Per-operator: totals + breakdown + last activity
  type OperatorSummary = {
    id: string | null;
    label: string;
    total: number;
    forceConfirm: number;
    forceReject: number;
    reclassify: number;
    lastActedAt: string;
  };
  const operatorMap = new Map<string, OperatorSummary>();
  for (const a of actions) {
    const id = a.acted_by ?? "(system)";
    const actor = a.acted_by ? actorById.get(a.acted_by) : null;
    const label = actor
      ? actor.full_name ?? actor.email.split("@")[0]
      : a.acted_by
        ? a.acted_by.slice(0, 8)
        : "(system)";
    const existing = operatorMap.get(id) ?? {
      id: a.acted_by,
      label,
      total: 0,
      forceConfirm: 0,
      forceReject: 0,
      reclassify: 0,
      lastActedAt: a.acted_at,
    };
    existing.total++;
    if (a.action === "force_confirm") existing.forceConfirm++;
    else if (a.action === "force_reject") existing.forceReject++;
    else if (a.action === "reclassify") existing.reclassify++;
    if (a.acted_at > existing.lastActedAt) existing.lastActedAt = a.acted_at;
    operatorMap.set(id, existing);
  }
  const operatorRows = Array.from(operatorMap.values()).sort(
    (a, b) => b.total - a.total,
  );

  // Action-type breakdown
  const actionCounts: Record<string, number> = {};
  for (const a of actions) {
    actionCounts[a.action] = (actionCounts[a.action] ?? 0) + 1;
  }
  const topActionType =
    Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";

  // Last 7 days subset
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const actionsLast7 = actions.filter((a) => a.acted_at >= sevenDaysAgo).length;

  // ----- Render ----------------------------------------------------------

  return (
    <OperatorShell session={session}>
      <header className="mb-8">
        <p className="text-sm text-fg-muted">Reconciliation</p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
          Operator audit
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">
          Every operator-initiated state change on a recon transaction is
          recorded in <code>recon_manual_actions</code>. Use this view to
          spot patterns (e.g. recurring force-confirms on a specific batch)
          and verify the audit trail is healthy.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-fg-muted">Window:</span>
        {[7, 30, 90].map((d) => (
          <Link
            key={d}
            href={`/recon/audit?days=${d}`}
            className={`rounded border px-3 py-1 ${
              days === d
                ? "border-brand-500 bg-brand-500/10 text-fg"
                : "border-border-subtle text-fg-muted hover:text-fg"
            }`}
          >
            Last {d} days
          </Link>
        ))}
        <span className="ml-auto text-xs text-fg-subtle">
          Showing actions since {formatDate(sinceIso.slice(0, 10))}. Capped at 500 most recent.
        </span>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard
          label={`Actions (last ${days}d)`}
          value={actions.length}
        />
        <SummaryCard label="Actions (last 7d)" value={actionsLast7} />
        <SummaryCard label="Distinct operators" value={operatorRows.length} />
        <SummaryCard label="Top action" value={humanizeAction(topActionType)} />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Per-operator</CardTitle>
          <CardDescription>
            Counts of audit-trail rows attributed to each operator in the
            selected window.
          </CardDescription>
        </CardHeader>
        <CardBody>
          {operatorRows.length === 0 ? (
            <p className="text-sm text-fg-subtle">No actions in this window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="pb-3 pr-4">Operator</th>
                    <th className="pb-3 pr-4 text-right">Total</th>
                    <th className="pb-3 pr-4 text-right">Force-confirm</th>
                    <th className="pb-3 pr-4 text-right">Force-reject</th>
                    <th className="pb-3 pr-4 text-right">Reclassify</th>
                    <th className="pb-3 pr-4">Last activity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {operatorRows.map((row) => (
                    <tr key={row.id ?? "(system)"}>
                      <td className="py-3 pr-4 text-fg">{row.label}</td>
                      <td className="py-3 pr-4 text-right tabular-nums text-fg">
                        {row.total}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums text-success">
                        {row.forceConfirm}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums text-warning">
                        {row.forceReject}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums text-info">
                        {row.reclassify}
                      </td>
                      <td className="py-3 pr-4 text-xs text-fg-muted">
                        {new Date(row.lastActedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            Up to 500 most recent audit-trail entries in the selected window.
            Newest first.
          </CardDescription>
        </CardHeader>
        <CardBody>
          {actions.length === 0 ? (
            <p className="text-sm text-fg-subtle">No actions in this window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="pb-3 pr-4">When</th>
                    <th className="pb-3 pr-4">Operator</th>
                    <th className="pb-3 pr-4">Action</th>
                    <th className="pb-3 pr-4">Account</th>
                    <th className="pb-3 pr-4">Row</th>
                    <th className="pb-3 pr-4">Justification</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {actions.map((a) => {
                    const txn = txnById.get(a.txn_id);
                    const acc = txn ? accountById.get(txn.account_id) : null;
                    const actor = a.acted_by ? actorById.get(a.acted_by) : null;
                    const actorLabel = actor
                      ? (actor.full_name ?? actor.email.split("@")[0])
                      : a.acted_by
                        ? a.acted_by.slice(0, 8)
                        : "(system)";
                    return (
                      <tr key={a.id}>
                        <td className="py-3 pr-4 text-xs text-fg-muted whitespace-nowrap">
                          {new Date(a.acted_at).toLocaleString()}
                        </td>
                        <td className="py-3 pr-4 text-xs text-fg">
                          {actorLabel}
                        </td>
                        <td className="py-3 pr-4 text-xs">
                          <ActionBadge action={a.action} />
                          {a.prior_state && a.new_state && (
                            <span className="ml-1 text-fg-subtle">
                              {a.prior_state} → {a.new_state}
                            </span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-xs">
                          {acc ? (
                            <Link
                              href={`/recon/accounts/${acc.id}`}
                              className="text-fg hover:underline"
                            >
                              {acc.account_number}
                            </Link>
                          ) : (
                            <span className="text-fg-subtle">—</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-xs">
                          {txn ? (
                            <div className="text-fg">
                              <span className="font-mono">{txn.code}</span>
                              {" · "}
                              {formatDate(txn.posted_at)}
                              {" · "}
                              <span className="font-medium tabular-nums">
                                {formatMinorUSD(txn.amountMinor)}
                              </span>
                              {txn.payer_name_raw && (
                                <span className="text-fg-muted">
                                  {" · "}
                                  {txn.payer_name_raw}
                                </span>
                              )}
                              {txn.rail_native_ref && (
                                <span className="ml-1 font-mono text-[11px] text-fg-subtle">
                                  ref {txn.rail_native_ref}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-fg-subtle">
                              txn {a.txn_id.slice(0, 8)}
                            </span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-xs text-fg-muted max-w-[420px]">
                          <div className="line-clamp-2">{a.justification}</div>
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

function humanizeAction(action: string): string {
  switch (action) {
    case "force_confirm":
      return "Confirm";
    case "force_reject":
      return "Reject";
    case "reclassify":
      return "Reclassify";
    default:
      return action;
  }
}

function ActionBadge({ action }: { action: string }) {
  const tone =
    action === "force_confirm"
      ? "bg-success-subtle text-success"
      : action === "force_reject"
        ? "bg-warning-subtle text-warning"
        : "bg-info-subtle text-info";
  return (
    <span className={`rounded px-2 py-0.5 ${tone}`}>
      {humanizeAction(action)}
    </span>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded border border-border-subtle bg-bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-fg-subtle">
        {label}
      </div>
      <div className="mt-2 font-display text-2xl font-semibold tabular-nums text-fg">
        {value}
      </div>
    </div>
  );
}
