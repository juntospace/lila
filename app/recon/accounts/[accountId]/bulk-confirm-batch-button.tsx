"use client";

import { CheckCircle2, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";

import {
  bulkConfirmPendingBatch,
  type BulkConfirmBatchResult,
} from "./actions";

const MIN_JUSTIFICATION = 10;
const MAX_JUSTIFICATION = 1000;

/**
 * Modal trigger + dialog for confirming every pending PR in a single
 * Referencia batch at once. One justification covers the whole batch.
 */
export function BulkConfirmBatchButton({
  accountId,
  railNativeRef,
  pendingCount,
  pendingAmountLabel,
}: {
  accountId: string;
  railNativeRef: string;
  pendingCount: number;
  pendingAmountLabel: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [justification, setJustification] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<BulkConfirmBatchResult | null>(null);

  useEffect(() => {
    if (result?.status === "ok") {
      const t = setTimeout(() => dialogRef.current?.close(), 800);
      return () => clearTimeout(t);
    }
  }, [result?.status]);

  function open() {
    setResult(null);
    setJustification("");
    dialogRef.current?.showModal();
    queueMicrotask(() => textareaRef.current?.focus());
  }

  function close() {
    dialogRef.current?.close();
  }

  function submit() {
    const trimmed = justification.trim();
    if (trimmed.length < MIN_JUSTIFICATION) return;
    startTransition(async () => {
      const r = await bulkConfirmPendingBatch({
        accountId,
        railNativeRef,
        justification: trimmed,
      });
      setResult(r);
    });
  }

  const tooShort = justification.trim().length < MIN_JUSTIFICATION;
  const tooLong = justification.length > MAX_JUSTIFICATION;

  return (
    <>
      <Button type="button" size="sm" onClick={open}>
        <CheckCircle2 className="h-4 w-4" />
        Confirm batch ({pendingCount})
      </Button>

      <dialog
        ref={dialogRef}
        className="rounded-lg border border-border-subtle bg-bg-surface p-0 shadow-e3 backdrop:bg-black/60 backdrop:backdrop-blur-sm w-[min(600px,90vw)]"
        onClose={() => setResult(null)}
      >
        <form
          method="dialog"
          className="space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-fg">
                Confirm pending batch
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                Confirms all <strong>{pendingCount}</strong> pending PR
                {pendingCount === 1 ? "" : "s"} ({pendingAmountLabel}) in
                Referencia <code className="font-mono">{railNativeRef}</code>.
                One justification is written to the audit trail for every PR.
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              className="text-fg-subtle hover:text-fg"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={`bulk-justification-${railNativeRef}`}
              className="block text-sm font-medium text-fg"
            >
              Justification
            </label>
            <textarea
              ref={textareaRef}
              id={`bulk-justification-${railNativeRef}`}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={4}
              maxLength={MAX_JUSTIFICATION + 50}
              placeholder="e.g. Bank confirmed no DAs will be issued for this submission; end-of-day cutoff passed."
              className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
            <div className="flex items-center justify-between text-xs text-fg-subtle">
              <span>
                {justification.trim().length} / {MAX_JUSTIFICATION} characters
              </span>
              <span>Minimum {MIN_JUSTIFICATION} characters required.</span>
            </div>
          </div>

          {result?.status === "error" && (
            <p className="rounded border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-danger">
              {result.message}
            </p>
          )}
          {result?.status === "ok" && (
            <p className="rounded border border-success/40 bg-success-subtle px-3 py-2 text-sm text-success">
              Confirmed {result.confirmedCount ?? 0} PR
              {(result.confirmedCount ?? 0) === 1 ? "" : "s"}
              {result.message ? ` — ${result.message}` : "."}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={close}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending || tooShort || tooLong || result?.status === "ok"
              }
            >
              {pending
                ? "Confirming…"
                : result?.status === "ok"
                  ? "Confirmed"
                  : "Confirm batch"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
