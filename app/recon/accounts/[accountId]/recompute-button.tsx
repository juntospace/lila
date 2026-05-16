"use client";

import { RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";

import { recomputeAccountAction, type RecomputeActionResult } from "./actions";

export function RecomputeButton({ accountId }: { accountId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RecomputeActionResult | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const r = await recomputeAccountAction(accountId);
            setResult(r);
          });
        }}
      >
        <RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />
        {pending ? "Recomputing…" : "Recompute pairings + states"}
      </Button>
      {result?.status === "ok" && result.stats && (
        <div className="text-xs text-fg-muted">
          <div>
            {result.stats.dasReparsed > 0
              ? `Re-parsed ${result.stats.dasReparsed} DVTO/RCZO row${
                  result.stats.dasReparsed === 1 ? "" : "s"
                }; `
              : ""}
            Paired {result.stats.reversalsPaired} reversal
            {result.stats.reversalsPaired === 1 ? "" : "s"}; {result.stats.prsConfirmed} confirmed,{" "}
            {result.stats.prsRejected} rejected, {result.stats.prsPending} pending.
          </div>
          <div className="mt-1 text-fg-subtle">
            <span className="font-mono">
              [debug]
              txns={result.stats.txnCount}
              · preLinks={result.stats.preexistingLinks}
              · wiped={result.stats.autoLinksWiped}
              · DAsIn={result.stats.unpairedDaInput}
              · prBatches={result.stats.prBatchesFound}/{result.stats.prBatchesConsumed}
              · prPending={result.stats.prBatchesPending}
              · daBatches={result.stats.daBatchesLinked}/{result.stats.daBatchesFound}
              · unmatchedDAs={result.stats.unmatchedDaCount}
              · autoConfirm={result.stats.prsAutoConfirmedByBatch}
              · linkConflict={result.stats.unpairedLinkConflict}
              · daRejected={result.stats.daRejected}
              · daPendingPair={result.stats.daPendingPair}
              · aliases={result.stats.aliasesLoaded}
            </span>
          </div>
        </div>
      )}
      {result?.status === "error" && (
        <span className="text-xs text-danger">Error: {result.message}</span>
      )}
    </div>
  );
}
