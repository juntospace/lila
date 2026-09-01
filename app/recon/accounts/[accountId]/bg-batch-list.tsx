"use client";

import { CheckCircle2, Clock, AlertTriangle, Layers } from "lucide-react";

import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatMinorUSD } from "@/lib/recon/format";
import type { BgBatchStatus } from "@/lib/recon/bg";
import { toSpanishBatchStatus } from "@/lib/recon/bg/formatters";

export interface BgBatchView {
  uid: string;
  batchDateStr: string | null;
  batchName: string | null;
  channel: string | null;
  fortnight: number | null;
  isDelinquent: boolean;
  retryCount: number;
  variant: string | null;
  effectiveDate: string | null;
  creditDate: string | null;
  totalTransactions: number | null;
  succeededTransactions: number | null;
  declaredRejectedTransactions: number | null;
  rejectedRowsCount: number;
  succeededRowsCount: number;
  totalAmountMinor: bigint | null;
  rejectedAmountMinor: bigint | null;
  succeededAmountMinor: bigint | null;
  status: BgBatchStatus;
  pendingReason: string | null;
  creditMovUid: string | null;
  reversalsMovUids: string[];
}

interface Props {
  batches: BgBatchView[];
}

export function BgBatchList({ batches }: Props) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-blue-500" />
            <CardTitle>Lotes de Cobro ACH (Banco General)</CardTitle>
          </div>
          <span className="text-xs text-muted-foreground">
            {batches.filter((b) => b.status === "settled" || b.status === "settled_no_reversals").length} de {batches.length} liquidados
          </span>
        </div>
        <CardDescription>
          Conciliación integral de lotes ACH contra créditos totales y combinaciones de reversas de rechazos.
        </CardDescription>
      </CardHeader>
      <CardBody>
        {batches.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No hay lotes ACH registrados para esta cuenta.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="py-2.5 px-3 font-medium">Lote / UID</th>
                  <th className="py-2.5 px-3 font-medium">Fecha Efectiva</th>
                  <th className="py-2.5 px-3 font-medium text-center">Canal / Reintento</th>
                  <th className="py-2.5 px-3 font-medium text-right">Total Débito</th>
                  <th className="py-2.5 px-3 font-medium text-right">Rechazos</th>
                  <th className="py-2.5 px-3 font-medium text-right">Neto Realizado</th>
                  <th className="py-2.5 px-3 font-medium text-center">Estado</th>
                  <th className="py-2.5 px-3 font-medium">Referencias Movimiento</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {batches.map((b) => {
                  const isSettled = b.status === "settled" || b.status === "settled_no_reversals";
                  const isPending = b.status === "pending";
                  const isAnomaly = b.status === "anomaly";

                  return (
                    <tr key={b.uid} className="hover:bg-muted/20">
                      <td className="py-3 px-3 max-w-xs">
                        <div className="font-medium font-mono text-xs truncate">
                          {b.batchName || b.uid}
                        </div>
                        {b.batchName && (
                          <div className="text-[11px] text-muted-foreground font-mono truncate">
                            {b.uid}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 font-mono text-xs whitespace-nowrap">
                        {b.effectiveDate || b.batchDateStr || "—"}
                      </td>
                      <td className="py-3 px-3 text-center text-xs whitespace-nowrap">
                        <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
                          {b.channel || "ACH"}{b.fortnight ? ` ${b.fortnight}` : ""}{b.isDelinquent ? " (M)" : ""}
                        </span>
                        {b.retryCount > 1 && (
                          <span className="ml-1 text-xs text-amber-600 dark:text-amber-400 font-semibold">
                            r({b.retryCount})
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-semibold whitespace-nowrap">
                        {b.totalAmountMinor != null ? formatMinorUSD(b.totalAmountMinor) : "—"}
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs text-red-600 dark:text-red-400 whitespace-nowrap">
                        {b.rejectedAmountMinor != null ? formatMinorUSD(b.rejectedAmountMinor) : "—"}
                        {b.rejectedRowsCount > 0 && (
                          <span className="text-muted-foreground ml-1">({b.rejectedRowsCount})</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-semibold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                        {b.succeededAmountMinor != null ? formatMinorUSD(b.succeededAmountMinor) : "—"}
                      </td>
                      <td className="py-3 px-3 text-center whitespace-nowrap">
                        {isSettled && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" />
                            {toSpanishBatchStatus(b.status)}
                          </span>
                        )}
                        {isPending && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                            <Clock className="h-3 w-3" />
                            {toSpanishBatchStatus(b.status)}
                          </span>
                        )}
                        {isAnomaly && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
                            <AlertTriangle className="h-3 w-3" />
                            {toSpanishBatchStatus(b.status)}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-xs text-muted-foreground max-w-xs">
                        {b.creditMovUid && (
                          <div className="font-mono text-[11px] truncate text-foreground">
                            Crédito: {b.creditMovUid}
                          </div>
                        )}
                        {b.reversalsMovUids.length > 0 && (
                          <div className="font-mono text-[11px] truncate text-red-600 dark:text-red-400">
                            Reversas: {b.reversalsMovUids.join(", ")}
                          </div>
                        )}
                        {b.pendingReason && (
                          <div className="text-[11px] text-amber-600 dark:text-amber-400 truncate">
                            {b.pendingReason}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

