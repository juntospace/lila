// Server component (read-only). Renders the expanded detail block under
// a loan-credits row. Picks the body shape based on the row's state +
// code, and always shows the operator audit trail when present.

import { formatDate, formatMinorUSD } from "@/lib/recon/format";
import { reasonForDvtoCode } from "@/lib/recon/bac";

export type LinkedDA = {
  id: string;
  posted_at: string;
  return_code: string | null;
  description: string | null;
  payer_name_raw: string | null;
  rail_native_ref: string | null;
  debit_minor: string;
  matched_at: string | null;
  match_strategy: string | null;
  matched_by: string | null;
};

export type ManualActionRow = {
  id: string;
  action: string;
  prior_state: string | null;
  new_state: string | null;
  justification: string;
  acted_by: string | null;
  acted_at: string;
};

export type ActorMap = Map<string, { full_name: string | null; email: string }>;

type RowForPanel = {
  id: string;
  posted_at: string;
  code: string;
  state: string;
  credit_minor: string | number;
  description: string | null;
  rail_native_ref: string | null;
  payer_name_raw: string | null;
  confirmable_after: string | null;
  currency?: string;
};

export function RowDetailPanel({
  row,
  linkedDA,
  manualActions,
  actors,
}: {
  row: RowForPanel;
  linkedDA: LinkedDA | undefined;
  manualActions: ManualActionRow[];
  actors: ActorMap;
}) {
  const isPR = row.code === "PR";
  const is4C = row.code === "4C";

  return (
    <div className="space-y-4">
      {/* Top: row metadata that didn't fit in the table cells. */}
      <DetailGrid>
        <DetailItem label="Posted">{formatDate(row.posted_at)}</DetailItem>
        <DetailItem label="Code"><code className="font-mono text-xs">{row.code}</code></DetailItem>
        <DetailItem label="Amount" mono>
          {formatMinorUSD(String(row.credit_minor))}
        </DetailItem>
        <DetailItem label="Reference" mono>
          {row.rail_native_ref || "—"}
        </DetailItem>
        <DetailItem label="State"><StateChip state={row.state} /></DetailItem>
        {row.confirmable_after && (
          <DetailItem label="Confirmable after">
            {formatDate(row.confirmable_after.slice(0, 10))}
          </DetailItem>
        )}
        <DetailItem label="Raw description" wide>
          <span className="text-fg-muted">{row.description || "—"}</span>
        </DetailItem>
      </DetailGrid>

      {/* PR + rejected: show the linked DA. */}
      {isPR && row.state === "rejected" && linkedDA && (
        <Section title="Rejected by reversal">
          <DetailGrid>
            <DetailItem label="DA posted">{formatDate(linkedDA.posted_at)}</DetailItem>
            <DetailItem label="Amount" mono>
              {formatMinorUSD(linkedDA.debit_minor)}
            </DetailItem>
            <DetailItem label="DVTO/RCZO code" mono>
              {linkedDA.return_code ?? "—"}
            </DetailItem>
            <DetailItem label="Reason">
              {linkedDA.return_code
                ? reasonForDvtoCode(linkedDA.return_code).label
                : "—"}
            </DetailItem>
            <DetailItem label="DA reference" mono>
              {linkedDA.rail_native_ref || "—"}
            </DetailItem>
            <DetailItem label="DA payer">
              {linkedDA.payer_name_raw ?? "—"}
            </DetailItem>
            <DetailItem label="Pair source">
              {linkedDA.match_strategy === "manual" ? (
                <>
                  Manual{linkedDA.matched_by ? ` · by ${actorLabel(actors, linkedDA.matched_by)}` : ""}
                  {linkedDA.matched_at
                    ? ` · ${new Date(linkedDA.matched_at).toLocaleString()}`
                    : ""}
                </>
              ) : (
                "Auto (FIFO + name + amount)"
              )}
            </DetailItem>
            <DetailItem label="DA raw description" wide>
              <span className="text-fg-muted">{linkedDA.description || "—"}</span>
            </DetailItem>
          </DetailGrid>
        </Section>
      )}

      {/* PR + pending: explain what's blocking confirmation. Confirm
          button lands in Tier 3 PR 2. */}
      {isPR && row.state === "pending" && (
        <Section title="Pending confirmation" tone="info">
          <p className="text-sm text-fg-muted">
            Will auto-confirm once a future upload&apos;s max <code>posted_at</code>{" "}
            reaches the confirmable-after date above (file-clock rule), unless a
            DA arrives first. Manual override coming in a follow-up.
          </p>
        </Section>
      )}

      {/* PR + confirmed: explain how it landed there (file-clock vs manual).
          Revert button lands in Tier 3 PR 3. */}
      {isPR && row.state === "confirmed" && (
        <Section title="Confirmed" tone="success">
          {confirmationStory(manualActions, actors)}
        </Section>
      )}

      {/* 4C: a brief note. */}
      {is4C && (
        <Section title="Inbound ACH (irrevocable)" tone="success">
          <p className="text-sm text-fg-muted">
            4C rows are inbound ACH credits from another bank; the originating
            bank cannot reverse them, so this payment is final the moment it
            posts.
          </p>
        </Section>
      )}

      {/* Audit trail — always shown when there's anything in it. */}
      {manualActions.length > 0 && (
        <Section title="Operator audit trail">
          <ul className="space-y-2 text-sm">
            {manualActions.map((a) => (
              <li
                key={a.id}
                className="rounded border border-border-subtle bg-bg-surface p-3"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-subtle">
                  <span className="font-medium text-fg">
                    {humanizeAction(a)}
                  </span>
                  <span>·</span>
                  <span>{actorLabel(actors, a.acted_by)}</span>
                  <span>·</span>
                  <span>{new Date(a.acted_at).toLocaleString()}</span>
                </div>
                <div className="mt-1 text-fg">{a.justification}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// =============================================================
// Helpers
// =============================================================

function confirmationStory(
  actions: ManualActionRow[],
  actors: ActorMap,
) {
  const manualConfirm = actions.find(
    (a) =>
      (a.action === "force_confirm" ||
        (a.action === "reclassify" && a.new_state === "confirmed")) &&
      a.new_state === "confirmed",
  );
  if (manualConfirm) {
    return (
      <div className="text-sm text-fg-muted">
        Confirmed manually on{" "}
        <span className="text-fg">
          {new Date(manualConfirm.acted_at).toLocaleString()}
        </span>{" "}
        by{" "}
        <span className="text-fg">
          {actorLabel(actors, manualConfirm.acted_by)}
        </span>
        .
        <div className="mt-1 text-fg">{manualConfirm.justification}</div>
      </div>
    );
  }
  return (
    <p className="text-sm text-fg-muted">
      Auto-confirmed by the file-clock rule — the 24h ACH rejection window
      lapsed without a corresponding DA arriving in any uploaded file.
    </p>
  );
}

function humanizeAction(a: ManualActionRow): string {
  if (a.action === "force_confirm") return "Manually confirmed";
  if (a.action === "force_reject") return "Manually rejected";
  if (a.action === "reclassify") {
    return `Reclassified ${a.prior_state ?? "?"} → ${a.new_state ?? "?"}`;
  }
  return a.action;
}

function actorLabel(actors: ActorMap, id: string | null | undefined): string {
  if (!id) return "system";
  const a = actors.get(id);
  if (!a) return id.slice(0, 8);
  return a.full_name ?? a.email.split("@")[0];
}

function DetailGrid({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {children}
    </dl>
  );
}

function DetailItem({
  label,
  children,
  mono,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "lg:col-span-4 sm:col-span-2" : ""}>
      <dt className="text-xs uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className={`mt-0.5 ${mono ? "font-mono text-xs" : ""} text-fg`}>
        {children}
      </dd>
    </div>
  );
}

function Section({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "success" | "info" | "warning";
}) {
  const border =
    tone === "success"
      ? "border-success/40"
      : tone === "info"
        ? "border-info/40"
        : tone === "warning"
          ? "border-warning/40"
          : "border-border-subtle";
  return (
    <div className={`rounded border ${border} bg-bg-surface p-4`}>
      <div className="mb-2 text-xs uppercase tracking-wide text-fg-subtle">
        {title}
      </div>
      {children}
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const tone =
    state === "confirmed"
      ? "bg-success-subtle text-success"
      : state === "rejected"
        ? "bg-warning-subtle text-warning"
        : "bg-info-subtle text-info";
  return (
    <span className={`rounded px-2 py-0.5 text-xs capitalize ${tone}`}>
      {state}
    </span>
  );
}
