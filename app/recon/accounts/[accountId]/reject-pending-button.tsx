"use client";

import { Link as LinkIcon, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";

import { manuallyRejectPR, type ManuallyRejectResult } from "./actions";

const MIN_JUSTIFICATION = 10;
const MAX_JUSTIFICATION = 1000;

export type CandidateDA = {
  id: string;
  posted_at: string;
  debit_minor: string;
  return_code: string | null;
  payer_name_raw: string | null;
  description: string | null;
};

/**
 * Inline modal trigger + dialog for manually rejecting a pending PR by
 * picking from unpaired DAs in the account within ±7 days of the PR.
 *
 * Mirror of the unmatched-reversals "Match to PR" picker (which is
 * driven from the DA side); this one is driven from the PR side. Same
 * audit-first server-action pattern, same name-alias capture so future
 * ingests pair the same client automatically.
 */
export function RejectPendingButton({
  accountId,
  prTxnId,
  prAmountMinor,
  candidates,
}: {
  accountId: string;
  prTxnId: string;
  prAmountMinor: string;
  candidates: CandidateDA[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [selectedDaId, setSelectedDaId] = useState<string | null>(null);
  const [justification, setJustification] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ManuallyRejectResult | null>(null);

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
    setSelectedDaId(null);
    setJustification("");
    dialogRef.current?.showModal();
    queueMicrotask(() => textareaRef.current?.focus());
  }

  function close() {
    dialogRef.current?.close();
  }

  function submit() {
    if (!selectedDaId) return;
    const trimmed = justification.trim();
    if (trimmed.length < MIN_JUSTIFICATION) return;
    startTransition(async () => {
      const r = await manuallyRejectPR({
        accountId,
        prTxnId,
        daTxnId: selectedDaId,
        justification: trimmed,
      });
      setResult(r);
    });
  }

  const tooShort = justification.trim().length < MIN_JUSTIFICATION;
  const tooLong = justification.length > MAX_JUSTIFICATION;
  const noCandidates = candidates.length === 0;

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={noCandidates}
        onClick={open}
      >
        <LinkIcon className="h-4 w-4" />
        {noCandidates ? "No DA candidates" : "Reject manually (link to DA)"}
      </Button>

      <dialog
        ref={dialogRef}
        className="rounded-lg border border-border-subtle bg-bg-surface p-0 shadow-e3 backdrop:bg-black/60 backdrop:backdrop-blur-sm w-[min(640px,90vw)]"
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
                Reject manually
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                Pick one of the unpaired DAs in this account from within
                ±7 days of the PR&apos;s posted date. The pairing creates
                a manual <code>recon_links</code> row, captures a
                name-alias for future automatic pairing, and writes the
                justification to the audit trail.
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
            <div className="text-sm font-medium text-fg">Pick the DA to link</div>
            <ul className="max-h-64 space-y-1.5 overflow-y-auto rounded border border-border-subtle bg-bg-raised/40 p-2">
              {candidates.map((da) => {
                const sameAmount = da.debit_minor === prAmountMinor;
                return (
                  <li key={da.id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded border border-border-subtle bg-bg-surface px-2 py-1.5 text-xs hover:border-border-strong">
                      <input
                        type="radio"
                        name="daPick"
                        value={da.id}
                        checked={selectedDaId === da.id}
                        onChange={() => setSelectedDaId(da.id)}
                        className="mt-0.5"
                      />
                      <span className="flex-1">
                        <span className="block text-fg">
                          {da.posted_at} ·{" "}
                          <span className={sameAmount ? "text-fg-muted" : "text-warning"}>
                            ${(Number(da.debit_minor) / 100).toFixed(2)}
                          </span>
                          {!sameAmount && <span className="text-warning"> (different amount)</span>}
                          {da.return_code && (
                            <span className="ml-2 font-mono text-fg-subtle">{da.return_code}</span>
                          )}
                        </span>
                        <span className="block text-fg-muted">
                          {da.payer_name_raw ?? "—"}
                        </span>
                        <span className="block max-w-[440px] truncate text-fg-subtle">
                          {da.description ?? "—"}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-fg-subtle">
              Highlighted in yellow when the DA&apos;s amount differs from the PR — pair anyway if you have a reason (fee adjustment, etc).
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={`reject-justification-${prTxnId}`}
              className="block text-sm font-medium text-fg"
            >
              Justification
            </label>
            <textarea
              ref={textareaRef}
              id={`reject-justification-${prTxnId}`}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={3}
              maxLength={MAX_JUSTIFICATION + 50}
              placeholder="e.g. Bank statement showed late-arriving DA for this payment — confirmed via support ticket #12345"
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
              Rejected and linked{result.message ? ` — ${result.message}` : "."}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={
                pending || !selectedDaId || tooShort || tooLong || result?.status === "ok"
              }
            >
              {pending
                ? "Linking…"
                : result?.status === "ok"
                  ? "Linked"
                  : "Confirm rejection"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
