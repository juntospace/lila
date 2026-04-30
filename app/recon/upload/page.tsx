import Link from "next/link";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { requireReconWriter } from "@/lib/auth/guard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { AddAccountForm } from "./add-account-form";
import { DeleteUploadButton } from "./delete-upload-button";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

type Account = {
  id: string;
  rail: string;
  account_number: string;
  holder_name: string;
  currency: string;
};

type RecentUpload = {
  id: string;
  uploaded_at: string;
  original_filename: string | null;
  account_id: string;
  uploaded_by: string | null;
  status: string;
  rows_total: number;
  rows_new: number;
  rows_duplicate: number;
  date_range_start: string | null;
  date_range_end: string | null;
  integrity_ok: boolean | null;
};

export default async function ReconUploadPage() {
  const session = await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  const [{ data: accounts }, { data: recents }] = await Promise.all([
    supabase
      .from("bank_accounts")
      .select("id, rail, account_number, holder_name, currency")
      .eq("status", "active")
      .order("created_at", { ascending: true }),
    supabase
      .from("recon_uploads")
      .select(
        "id, uploaded_at, original_filename, account_id, uploaded_by, status, rows_total, rows_new, rows_duplicate, date_range_start, date_range_end, integrity_ok",
      )
      .order("uploaded_at", { ascending: false })
      .limit(10),
  ]);

  const activeAccounts: Account[] = accounts ?? [];
  const recentUploads: RecentUpload[] = recents ?? [];
  const accountById = new Map(activeAccounts.map((a) => [a.id, a]));

  // Look up uploader names. recon_uploads.uploaded_by is auth.users(id), and
  // user_profiles.id mirrors that (1:1), so a single .in() against
  // user_profiles is the cheapest path.
  const uploaderIds = Array.from(
    new Set(recentUploads.map((u) => u.uploaded_by).filter((v): v is string => Boolean(v))),
  );
  const uploaderById = new Map<string, { full_name: string | null; email: string }>();
  if (uploaderIds.length > 0) {
    const { data: profiles } = await supabase
      .from("user_profiles")
      .select("id, full_name, email")
      .in("id", uploaderIds);
    for (const p of profiles ?? []) {
      uploaderById.set(p.id as string, {
        full_name: p.full_name as string | null,
        email: p.email as string,
      });
    }
  }

  return (
    <OperatorShell session={session}>
      <header className="mb-8">
        <p className="text-sm text-fg-muted">Reconciliation</p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
          BAC bank statement upload
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">
          Upload an Excel export from BAC. The system parses transactions,
          dedupes against prior uploads, pairs DVTO reversals back to their
          originating ACH pulls, and confirms aged-out pending payments.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>New upload</CardTitle>
            <CardDescription>
              Pick the destination account and an Excel file. Same-bytes
              re-uploads are silently absorbed.
            </CardDescription>
          </CardHeader>
          <CardBody>
            {activeAccounts.length === 0 ? (
              <div className="rounded border border-warning/40 bg-warning-subtle p-4 text-sm text-fg">
                No bank accounts yet. Add one on the right to get started.
              </div>
            ) : (
              <UploadForm accounts={activeAccounts} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bank accounts</CardTitle>
            <CardDescription>Add a new BAC account on this rail.</CardDescription>
          </CardHeader>
          <CardBody className="space-y-4">
            {activeAccounts.length > 0 && (
              <ul className="space-y-2 text-sm">
                {activeAccounts.map((a) => (
                  <li key={a.id}>
                    <Link
                      href={`/recon/accounts/${a.id}`}
                      className="block rounded border border-border-subtle bg-bg-raised px-3 py-2 transition-colors hover:border-border-strong hover:bg-bg-surface"
                    >
                      <div className="font-medium text-fg">{a.holder_name}</div>
                      <div className="text-xs text-fg-muted">
                        {a.rail.toUpperCase()} · {a.account_number} · {a.currency}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <AddAccountForm />
          </CardBody>
        </Card>
      </div>

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Recent uploads
        </h2>
        <Card className="mt-4">
          <CardBody>
            {recentUploads.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No uploads yet — your first ingest will appear here.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                    <tr>
                      <th className="pb-3 pr-4">Uploaded</th>
                      <th className="pb-3 pr-4">By</th>
                      <th className="pb-3 pr-4">Account</th>
                      <th className="pb-3 pr-4">File</th>
                      <th className="pb-3 pr-4">Range</th>
                      <th className="pb-3 pr-4 text-right">Rows</th>
                      <th className="pb-3 pr-4">Integrity</th>
                      <th className="pb-3 pr-4">Status</th>
                      <th className="pb-3 sr-only">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {recentUploads.map((u) => {
                      const acct = accountById.get(u.account_id);
                      return (
                        <tr key={u.id} className="text-fg">
                          <td className="py-3 pr-4 text-xs text-fg-muted">
                            {new Date(u.uploaded_at).toLocaleString()}
                          </td>
                          <td className="py-3 pr-4 text-xs text-fg-muted">
                            {(() => {
                              const up = u.uploaded_by ? uploaderById.get(u.uploaded_by) : null;
                              if (!up) return "—";
                              return up.full_name ?? up.email.split("@")[0];
                            })()}
                          </td>
                          <td className="py-3 pr-4">
                            <Link
                              href={`/recon/accounts/${u.account_id}`}
                              className="hover:underline"
                            >
                              {acct?.account_number ?? u.account_id.slice(0, 8)}
                            </Link>
                          </td>
                          <td className="py-3 pr-4 max-w-[280px] truncate">
                            {u.original_filename ?? "—"}
                          </td>
                          <td className="py-3 pr-4 text-xs text-fg-muted">
                            {u.date_range_start && u.date_range_end
                              ? `${u.date_range_start} → ${u.date_range_end}`
                              : "—"}
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums">
                            <span className="text-fg">{u.rows_new}</span>
                            <span className="text-fg-subtle"> / {u.rows_total}</span>
                          </td>
                          <td className="py-3 pr-4">
                            <IntegrityBadge ok={u.integrity_ok} />
                          </td>
                          <td className="py-3 pr-4">
                            <StatusBadge status={u.status} />
                          </td>
                          <td className="py-3">
                            <DeleteUploadButton
                              uploadId={u.id}
                              filename={u.original_filename}
                            />
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
      </section>
    </OperatorShell>
  );
}

function IntegrityBadge({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="text-fg-subtle">—</span>;
  if (ok)
    return (
      <span className="rounded bg-success-subtle px-2 py-0.5 text-xs text-success">
        ok
      </span>
    );
  return (
    <span className="rounded bg-warning-subtle px-2 py-0.5 text-xs text-warning">
      mismatch
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "committed"
      ? "bg-success-subtle text-success"
      : status === "failed"
        ? "bg-danger-subtle text-danger"
        : "bg-info-subtle text-info";
  return (
    <span className={`rounded px-2 py-0.5 text-xs capitalize ${tone}`}>
      {status}
    </span>
  );
}
