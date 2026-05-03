"use client";

import { Undo2, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";

import { revertConfirmedPR, type RevertConfirmedResult } from "./actions";

const MIN_JUSTIFICATION = 10;
const MAX_JUSTIFICATION = 1000;

/**
 * Inline modal trigger + dialog for reverting a confirmed PR back to
 * `pending`. Symmetric mirror of <ConfirmPendingButton>; same modal
 * shape, server action validates + refuses if the PR has a recon_links
 * row (which would mean the next Recompute would flip it back to
 * rejected anyway).
 */
export function RevertConfirmedButton({
  accountId,
  prTxnId,
}: {
  accountId: string;
  prTxnId: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [justification, setJustification] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RevertConfirmedResult | null>(null);

  useEffect(() => {
    if (result?.status === "ok") {
      const t = setTimeout(() => {
        dialogRef.current?.close();
      }, 600);
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
      const r = await revertConfirmedPR({
        accountId,
        prTxnId,
        justification: trimmed,
      });
      setResult(r);
    });
  }

  const tooShort = justification.trim().length < MIN_JUSTIFICATION;
  const tooLong = justification.length > MAX_JUSTIFICATION;

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={open}>
        <Undo2 className="h-4 w-4" />
        Revert to pending
      </Button>

      <dialog
        ref={dialogRef}
        className="rounded-lg border border-border-subtle bg-bg-surface p-0 shadow-e3 backdrop:bg-black/60 backdrop:backdrop-blur-sm w-[min(560px,90vw)]"
        onClose={() => {
          setResult(null);
        }}
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
                Revert to pending
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                The PR is currently <code>confirmed</code> (file-clock or
                manual). Reverting puts it back to <code>pending</code> so a
                future DA can still reject it, or so a fresh confirmation
                decision can be made. The justification below joins the
                audit trail.
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
              htmlFor={`revert-justification-${prTxnId}`}
              className="block text-sm font-medium text-fg"
            >
              Justification
            </label>
            <textarea
              ref={textareaRef}
              id={`revert-justification-${prTxnId}`}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={4}
              maxLength={MAX_JUSTIFICATION + 50}
              placeholder="e.g. Borrower disputed clearance — keeping pending until BAC support clarifies"
              className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
            <div className="flex items-center justify-between text-xs text-fg-subtle">
              <span>
                {justification.trim().length} / {MAX_JUSTIFICATION} characters
              </span>
              <span>
                Minimum {MIN_JUSTIFICATION} characters required.
              </span>
            </div>
          </div>

          {result?.status === "error" && (
            <p className="rounded border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-danger">
              {result.message}
            </p>
          )}
          {result?.status === "ok" && (
            <p className="rounded border border-success/40 bg-success-subtle px-3 py-2 text-sm text-success">
              Reverted{result.message ? ` — ${result.message}` : "."}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={pending || tooShort || tooLong || result?.status === "ok"}
            >
              {pending
                ? "Reverting…"
                : result?.status === "ok"
                  ? "Reverted"
                  : "Revert"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
