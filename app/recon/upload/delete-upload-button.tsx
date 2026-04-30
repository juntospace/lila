"use client";

import { Trash2 } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";

import { deleteUpload, type DeleteUploadResult } from "./actions";

export function DeleteUploadButton({
  uploadId,
  filename,
}: {
  uploadId: string;
  filename: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<DeleteUploadResult | null>(null);

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending || result?.status === "ok"}
        onClick={() => {
          // Native confirm is good enough here — operators are deliberate
          // about wiping a file, and a richer modal can come later if the
          // delete becomes a frequent action.
          const label = filename || "this upload";
          if (
            !window.confirm(
              `Delete "${label}"? This wipes its transactions, removes any reversal pairings made by this file, and recomputes the account state. Cannot be undone (you'd re-upload to redo it).`,
            )
          ) {
            return;
          }
          startTransition(async () => {
            const r = await deleteUpload(uploadId);
            setResult(r);
          });
        }}
        aria-label={`Delete upload ${filename ?? ""}`}
      >
        <Trash2 className="h-4 w-4" />
        {pending ? "Deleting…" : result?.status === "ok" ? "Deleted" : "Delete"}
      </Button>
      {result?.status === "error" && (
        <span className="text-xs text-danger" title={result.message}>
          Error
        </span>
      )}
    </div>
  );
}
