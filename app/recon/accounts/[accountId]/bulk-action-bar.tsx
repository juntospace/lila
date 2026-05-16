"use client";

import { CheckCircle2, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";
import { formatMinorUSD } from "@/lib/recon/format";

import { bulkConfirmPRs, type BulkConfirmPRsResult } from "./actions";
import { useBulkSelection } from "./bulk-selection-context";

const MIN_JUSTIFICATION = 10;
const MAX_JUSTIFICATION = 1000;

/**
 * Floating action bar at the bottom of the account page. Visible only
 * when ≥1 pending PR is selected. Offers "Confirm selected" (opens a
 * modal with a shared justification) and "Clear" (deselect all).
 */
export function BulkActionBar({ accountId }: { accountId: string }) {
  const { selectedIds, selectedAmountMinor, clear } = useBulkSelection();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [justification, setJustification] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<BulkConfirmPRsResult | null>(null);

  const count = selectedIds.size;

  useEffect(() => {
    if (result?.status === "ok") {
      const t = setTimeout(() => {
        dialogRef.current?.close();
        clear();
      }, 800);
      return () => clearTimeout(t);
    }
  }, [result?.status, clear]);

  if (count === 0) return null;

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
    const ids = Array.from(selectedIds);
    startTransition(async () => {
      const r = await bulkConfirmPRs({
        accountId,
        prTxnIds: ids,
        justification: trimmed,
      });
      setResult(r);
    });
  }

  const tooShort = justification.trim().length < MIN_JUSTIFICATION;
  const tooLong = justification.length > MAX_JUSTIFICATION;

  return (
    <>
      <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2">
        <div className="flex items-center gap-3 rounded-full border border-border bg-bg-raised px-4 py-2 shadow-e3">
          <span className="text-sm text-fg">
            <strong>{count}</strong> selected ·{" "}
            <span className="font-medium tabular-nums">
              {formatMinorUSD(selectedAmountMinor)}
            </span>
          </span>
          <Button type="button" size="sm" onClick={open}>
            <CheckCircle2 className="h-4 w-4" />
            Confirm selected
          </Button>
          <button
            type="button"
            onClick={clear}
            className="text-xs text-fg-subtle hover:text-fg"
            aria-label="Clear selection"
          >
            Clear
          </button>
        </div>
      </div>

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
                Confirm selected PRs
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                Confirms <strong>{count}</strong> pending PR
                {count === 1 ? "" : "s"} (
                {formatMinorUSD(selectedAmountMinor)}). One justification is
                written to the audit trail for every PR.
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
              htmlFor="bulk-confirm-justification"
              className="block text-sm font-medium text-fg"
            >
              Justification
            </label>
            <textarea
              ref={textareaRef}
              id="bulk-confirm-justification"
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={4}
              maxLength={MAX_JUSTIFICATION + 50}
              placeholder="e.g. Spot-checked these payments individually with BAC support — none will return."
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
              {result.skippedCount && result.skippedCount > 0
                ? ` (${result.skippedCount} skipped — no longer pending)`
                : ""}
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
                  : `Confirm ${count}`}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
