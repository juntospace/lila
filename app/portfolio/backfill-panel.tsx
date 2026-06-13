"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";

import {
  ingestCrediclaroFolder,
  runFullBackfill,
  type AvailableBackfill,
  type BackfillRunState,
  type IngestSampleState,
} from "./actions";

interface Props {
  backfills: AvailableBackfill[];
  /** Map of snapshot_date → existing snapshot status for that date. */
  existingByDate: Record<string, string>;
}

export function BackfillPanel({ backfills, existingByDate }: Props) {
  const [pending, startTransition] = useTransition();
  const [perFolder, setPerFolder] = useState<Record<string, IngestSampleState>>(
    {},
  );
  const [runAllState, setRunAllState] = useState<BackfillRunState | null>(null);

  function ingestOne(folder: string) {
    startTransition(async () => {
      const result = await ingestCrediclaroFolder(folder);
      setPerFolder((s) => ({ ...s, [folder]: result }));
    });
  }

  function runAll() {
    startTransition(async () => {
      const result = await runFullBackfill();
      setRunAllState(result);
    });
  }

  if (backfills.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No <code className="rounded bg-bg-raised px-1 py-0.5 text-xs">tmp/samples/&lt;YYYY-MM-DD&gt;</code>{" "}
        folders found. Drop a day&apos;s borrowers / loans / repayments CSVs into one
        and reload.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          {backfills.length.toLocaleString()} folder
          {backfills.length === 1 ? "" : "s"} discovered.
        </p>
        <Button
          variant="primary"
          size="sm"
          disabled={pending}
          onClick={runAll}
        >
          {pending && !Object.keys(perFolder).length ? "Backfilling…" : "Backfill all"}
        </Button>
      </div>

      {runAllState?.message && (
        <p
          className={`rounded border px-3 py-2 text-sm text-fg ${
            runAllState.status === "success"
              ? "border-success/40 bg-success-subtle"
              : runAllState.status === "partial"
                ? "border-warning/40 bg-warning-subtle"
                : "border-danger/40 bg-danger-subtle"
          }`}
        >
          {runAllState.message}
        </p>
      )}

      <ul className="divide-y divide-border-subtle rounded border border-border-subtle bg-bg-raised">
        {backfills.map((b) => {
          const existing = existingByDate[b.snapshotDate];
          const state = perFolder[b.folder];
          const isLegacy = b.folder === "70136";
          return (
            <li key={b.folder} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col text-sm">
                <span className="font-mono text-xs text-fg">
                  tmp/samples/{b.folder}/
                </span>
                <span className="text-xs text-fg-muted">
                  → snapshot {b.snapshotDate}
                  {isLegacy && " (today)"}
                  {existing && ` · already ${existing}`}
                </span>
                {!b.ready && (
                  <span className="text-xs text-warning">
                    missing: {b.missing.join(", ")}
                  </span>
                )}
                {state?.message && (
                  <span
                    className={`text-xs ${state.status === "success" ? "text-success" : "text-danger"}`}
                  >
                    {state.message}
                  </span>
                )}
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending || !b.ready}
                onClick={() => ingestOne(b.folder)}
              >
                {pending && perFolder[b.folder] === undefined ? "…" : "Ingest"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
