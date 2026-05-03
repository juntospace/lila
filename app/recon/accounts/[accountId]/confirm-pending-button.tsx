"use client";

import { CheckCircle2, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";

import { confirmPendingPR, type ConfirmPendingResult } from "./actions";

const MIN_JUSTIFICATION = 10;
const MAX_JUSTIFICATION = 1000;

/**
 * Inline modal trigger + dialog for manually confirming a pending PR.
 *
 * Lives inside the row's expandable detail panel so it stays anchored to
 * the row it acts on. Native <dialog> for the modal behaviour — cheaper
 * than wiring a portal and the focus-trap is handled by the platform.
 */
export function ConfirmPendingButton({
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
  const [result, setResult] = useState<ConfirmPendingResult | null>(null);

  useEffect(() => {
    if (result?.status === "ok") {
      // Server action revalidatePath flips the row's state to confirmed
      // — the drawer will rerender from the server and this button
      // unmounts on next paint. Brief in-place success state in the
      // meantime.
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
    // Focus the textarea after the dialog has opened.
    queueMicrotask(() => textareaRef.current?.focus());
  }

  function close() {
    dialogRef.current?.close();
  }

  function submit() {
    const trimmed = justification.trim();
    if (trimmed.length < MIN_JUSTIFICATION) return;
    startTransition(async () => {
      const r = await confirmPendingPR({
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
      <Button type="button" size="sm" onClick={open}>
        <CheckCircle2 className="h-4 w-4" />
        Confirm manually
      </Button>

      <dialog
        ref={dialogRef}
        className="rounded-lg border border-border-subtle bg-bg-surface p-0 shadow-e3 backdrop:bg-black/60 backdrop:backdrop-blur-sm w-[min(560px,90vw)]"
        onClose={() => {
          // Dialog dismissed (Esc or programmatic). Reset transient state.
          setResult(null);
        }}
      >
        <form
          method="dialog"
          className="space-y-4 p-6"
          onSubmit={(e) => {
            // We handle submit manually so the action fires before the
            // dialog closes (and so we can show errors inline).
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-fg">
                Confirm payment manually
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                The PR&apos;s 24h ACH window hasn&apos;t closed yet, but
                you have independent evidence the payment cleared. The
                justification below is appended to the audit trail.
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
              htmlFor={`justification-${prTxnId}`}
              className="block text-sm font-medium text-fg"
            >
              Justification
            </label>
            <textarea
              ref={textareaRef}
              id={`justification-${prTxnId}`}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={4}
              maxLength={MAX_JUSTIFICATION + 50}
              placeholder="e.g. Borrower provided proof of clearance via BAC support ticket #12345"
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
              Confirmed{result.message ? ` — ${result.message}` : "."}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || tooShort || tooLong || result?.status === "ok"}
            >
              {pending
                ? "Confirming…"
                : result?.status === "ok"
                  ? "Confirmed"
                  : "Confirm"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
