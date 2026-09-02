"use client";

import { useActionState, useRef } from "react";

import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";

import { uploadStatement, type UploadActionState } from "./actions";

const INITIAL: UploadActionState = { status: "idle" };

type Account = {
  id: string;
  rail: string;
  account_number: string;
  holder_name: string;
  currency: string;
};

export function UploadForm({ accounts }: { accounts: Account[] }) {
  const [state, action, pending] = useActionState(uploadStatement, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div className="space-y-5">
      <form ref={formRef} action={action} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="account_id">Bank account</Label>
          <select
            id="account_id"
            name="account_id"
            required
            defaultValue={accounts[0]?.id}
            className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.rail.toUpperCase()} · {a.account_number} · {a.holder_name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="file">Statement files (.xls or .xlsx)</Label>
          <input
            id="file"
            type="file"
            name="file"
            multiple
            required
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg file:mr-3 file:rounded file:border-0 file:bg-bg-raised file:px-3 file:py-1.5 file:text-sm file:text-fg hover:file:bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
          <p className="text-xs text-fg-subtle">
            Up to 10 MB per file. Select 1 or more Excel exports to upload simultaneously.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Ingesting…" : "Upload & reconcile"}
          </Button>
          {state.status === "error" && (
            <p className="text-sm text-danger">{state.message}</p>
          )}
        </div>
      </form>

      {state.status === "success" && state.result && (
        <ResultPanel
          result={state.result}
          message={state.message ?? ""}
          onClear={() => formRef.current?.reset()}
        />
      )}
    </div>
  );
}

function ResultPanel({
  result,
  message,
  onClear,
}: {
  result: NonNullable<UploadActionState["result"]>;
  message: string;
  onClear: () => void;
}) {
  return (
    <div className="rounded border border-success/40 bg-success-subtle p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-fg">{message}</h3>
          {result.accountLabel && (
            <p className="text-xs text-fg-muted">{result.accountLabel}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} type="button">
          Upload another
        </Button>
      </div>

      {result.rail === "bac" && <BACStats result={result} />}
      {result.rail === "bg" && result.fileKind === "statement" && (
        <BGStatementStats result={result} />
      )}
      {result.rail === "bg" && result.fileKind === "ach_detail" && (
        <BGAchDetailStats result={result} />
      )}
      {result.rail === "bg" && result.fileKind === "yappy" && (
        <BGYappyStats result={result} />
      )}

      {result.warnings.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-warning">
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BACStats({
  result,
}: {
  result: Extract<NonNullable<UploadActionState["result"]>, { rail: "bac" }>;
}) {
  return (
    <>
      {result.reversalsUnpaired > 0 && (
        <div className="mt-3 rounded border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-danger">
          <strong>{result.reversalsUnpaired}</strong> reversal
          {result.reversalsUnpaired === 1 ? "" : "s"} could not be paired
          against any PR. Open the account page and review the
          &ldquo;Unmatched reversals&rdquo; section.
        </div>
      )}
      {result.prBatchesPending > 0 && (
        <div className="mt-3 rounded border border-info/40 bg-info-subtle px-3 py-2 text-sm text-info">
          <strong>{result.prBatchesPending}</strong> PR batch
          {result.prBatchesPending === 1 ? "" : "es"} pending — no DAs
          arrived for them. Will auto-confirm if a future file&apos;s DA
          batch links to them; otherwise an operator can confirm manually.
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Stat label="Rows total" value={result.rowsTotal} />
        <Stat label="New" value={result.rowsNew} tone="success" />
        <Stat label="Duplicate" value={result.rowsDuplicate} tone="muted" />
        <Stat
          label="Reversals paired"
          value={result.reversalsPaired}
          tone="success"
        />
        <Stat
          label="Reversals unpaired"
          value={result.reversalsUnpaired}
          tone={result.reversalsUnpaired > 0 ? "danger" : "muted"}
        />
        <Stat
          label="PRs confirmed"
          value={result.prsConfirmedThisRun}
          tone="success"
        />
        <Stat
          label="PR batches pending"
          value={result.prBatchesPending}
          tone={result.prBatchesPending > 0 ? "info" : "muted"}
        />
        {result.fileWasDuplicate && (
          <Stat label="File" value="duplicate" tone="warning" />
        )}
      </dl>

      {(result.dateRangeAdded || result.dateRangeOverlap) && (
        <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-fg-muted sm:grid-cols-2">
          {result.dateRangeAdded && (
            <div>
              <span className="text-fg-subtle">Added: </span>
              {result.dateRangeAdded.start} → {result.dateRangeAdded.end}
            </div>
          )}
          {result.dateRangeOverlap && (
            <div>
              <span className="text-fg-subtle">Overlap: </span>
              {result.dateRangeOverlap.start} → {result.dateRangeOverlap.end}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function BGStatementStats({
  result,
}: {
  result: Extract<
    NonNullable<UploadActionState["result"]>,
    { rail: "bg"; fileKind: "statement" }
  >;
}) {
  return (
    <>
      {result.unknownCodeRows > 0 && (
        <div className="mt-3 rounded border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning">
          <strong>{result.unknownCodeRows}</strong> row
          {result.unknownCodeRows === 1 ? "" : "s"} had unfamiliar transaction
          codes — review them on the account page so we can extend the
          classifier.
        </div>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Stat label="Rows total" value={result.rowsTotal} />
        <Stat label="New" value={result.rowsNew} tone="success" />
        <Stat label="Duplicate" value={result.rowsDuplicate} tone="muted" />
        <Stat
          label="Loan inflows"
          value={result.loanInflowRows}
          tone="success"
        />
        <Stat label="Non-loan" value={result.nonLoanRows} tone="muted" />
        <Stat
          label="Unknown codes"
          value={result.unknownCodeRows}
          tone={result.unknownCodeRows > 0 ? "warning" : "muted"}
        />
        {result.fileWasDuplicate && (
          <Stat label="File" value="duplicate" tone="warning" />
        )}
      </dl>
    </>
  );
}

function BGAchDetailStats({
  result,
}: {
  result: Extract<
    NonNullable<UploadActionState["result"]>,
    { rail: "bg"; fileKind: "ach_detail" }
  >;
}) {
  return (
    <>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Stat label="Rows total" value={result.rowsTotal} />
        <Stat label="New" value={result.rowsNew} tone="success" />
        <Stat label="Duplicate" value={result.rowsDuplicate} tone="muted" />
        <Stat label="Approved" value={result.approvedRows} tone="success" />
        <Stat
          label="Rejected"
          value={result.rejectedRows}
          tone={result.rejectedRows > 0 ? "warning" : "muted"}
        />
        {result.fileWasDuplicate && (
          <Stat label="File" value="duplicate" tone="warning" />
        )}
      </dl>
    </>
  );
}

function BGYappyStats({
  result,
}: {
  result: Extract<
    NonNullable<UploadActionState["result"]>,
    { rail: "bg"; fileKind: "yappy" }
  >;
}) {
  return (
    <>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Stat label="Transactions total" value={result.rowsTotal} />
        <Stat label="New" value={result.rowsNew} tone="success" />
        <Stat label="Duplicate" value={result.rowsDuplicate} tone="muted" />
        {result.settledYappy != null && (
          <Stat label="Settled deposits" value={result.settledYappy} tone="success" />
        )}
        {result.fileWasDuplicate && (
          <Stat label="File" value="duplicate" tone="warning" />
        )}
      </dl>
    </>
  );
}

function Stat({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: number | string;
  tone?: "success" | "warning" | "info" | "danger" | "muted";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "info"
          ? "text-info"
          : tone === "danger"
            ? "text-danger"
            : "text-fg";
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className={`mt-0.5 font-display text-xl font-semibold ${color}`}>
        {value}
      </dd>
    </div>
  );
}
