"use client";

import { Wrench } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";

import { backfillDvtoCodes, type BackfillResult } from "./actions";

export function BackfillButton({ accountId }: { accountId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<BackfillResult | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const r = await backfillDvtoCodes(accountId);
            setResult(r);
          });
        }}
      >
        <Wrench className="h-4 w-4" />
        {pending ? "Re-parsing…" : "Re-parse DVTO codes"}
      </Button>
      {result && (
        <span className="text-xs text-fg-muted">
          {result.status === "ok"
            ? `Scanned ${result.scanned}, updated ${result.updated}.`
            : `Error: ${result.message ?? "unknown"}`}
        </span>
      )}
    </div>
  );
}
