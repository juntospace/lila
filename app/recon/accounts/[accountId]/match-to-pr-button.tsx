"use client";

import { Check, Link as LinkIcon, X } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";

import { manuallyPairDA, type ManualPairResult } from "./actions";

export type CandidatePR = {
  id: string;
  posted_at: string;
  state: string;
  description: string;
};

export function MatchToPRButton({
  accountId,
  daTxnId,
  candidates,
}: {
  accountId: string;
  daTxnId: string;
  candidates: CandidatePR[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ManualPairResult | null>(null);

  if (result?.status === "ok") {
    // Server action revalidates the path; this row will disappear on the
    // next paint. Show a brief confirmation in the meantime.
    return (
      <span className="text-xs text-success">
        <Check className="inline h-3 w-3" /> Paired
      </span>
    );
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={candidates.length === 0}
        onClick={() => setOpen(true)}
      >
        <LinkIcon className="h-4 w-4" />
        {candidates.length === 0 ? "No PR available" : "Match to PR"}
      </Button>
    );
  }

  return (
    <div className="rounded border border-border-subtle bg-bg-raised/50 p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-fg-subtle">
        <span>Pick the PR to pair with this DA:</span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setSelected(null);
            setResult(null);
          }}
          className="text-fg-subtle hover:text-fg"
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="space-y-1.5 max-h-48 overflow-y-auto">
        {candidates.map((c) => (
          <li key={c.id}>
            <label className="flex cursor-pointer items-start gap-2 rounded border border-border-subtle bg-bg-surface px-2 py-1.5 text-xs hover:border-border-strong">
              <input
                type="radio"
                name="prPick"
                value={c.id}
                checked={selected === c.id}
                onChange={() => setSelected(c.id)}
                className="mt-0.5"
              />
              <span className="flex-1">
                <span className="block text-fg">
                  {c.posted_at} · <span className="text-fg-subtle">{c.state}</span>
                </span>
                <span className="block max-w-[320px] truncate text-fg-muted">
                  {c.description}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!selected || pending}
          onClick={() => {
            if (!selected) return;
            startTransition(async () => {
              const r = await manuallyPairDA({
                accountId,
                daTxnId,
                prTxnId: selected,
              });
              setResult(r);
              if (r.status === "ok") {
                // Brief in-row "Paired" confirmation; revalidatePath drops the row.
                setTimeout(() => setOpen(false), 800);
              }
            });
          }}
        >
          {pending ? "Pairing…" : "Confirm match"}
        </Button>
        {result?.status === "error" && (
          <span className="text-xs text-danger">{result.message}</span>
        )}
      </div>
    </div>
  );
}
