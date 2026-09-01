"use client";

import { CheckCircle2, Clock, Smartphone, AlertTriangle } from "lucide-react";

import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatMinorUSD } from "@/lib/recon/format";
import type { BgYappyStatus } from "@/lib/recon/bg";
import { toSpanishBatchStatus, toSpanishYappyStatus } from "@/lib/recon/bg/formatters";

export interface BgYappyBatchView {
  uid: string;
  creditDate: string;
  transactionDate: string | null;
  declaredCount: number;
  reportCount: number | null;
  creditAmountMinor: bigint;
  reportAmountMinor: bigint | null;
  feeAmountMinor: bigint | null;
  feeRate: number | null;
  status: "settled" | "pending" | "anomaly";
  pendingReason: string | null;
}

interface Props {
  batches: BgYappyBatchView[];
}

export function BgYappyPanel({ batches }: Props) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-indigo-500" />
            <CardTitle>Liquidaciones Yappy T+1</CardTitle>
          </div>
          <span className="text-xs text-muted-foreground">
            {batches.filter((b) => b.status === "settled").length} de {batches.length} liquidadas
          </span>
        </div>
        <CardDescription>
          Depósitos consolidados de Yappy conciliados contra el reporte diario de transacciones (T+1 incluyendo fines de semana).
        </CardDescription>
      </CardHeader>
      <CardBody>
        {batches.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No hay depósitos Yappy registrados.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="py-2.5 px-3 font-medium">Fecha Crédito</th>
                  <th className="py-2.5 px-3 font-medium">Fecha Pagos (T-1)</th>
                  <th className="py-2.5 px-3 font-medium text-center">Transacciones</th>
                  <th className="py-2.5 px-3 font-medium text-right">Depósito Neto</th>
                  <th className="py-2.5 px-3 font-medium text-right">Comisión Banco</th>
                  <th className="py-2.5 px-3 font-medium text-center">Estado</th>
                  <th className="py-2.5 px-3 font-medium">Observación</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {batches.map((batch) => {
                  const isSettled = batch.status === "settled";
                  const isPending = batch.status === "pending";
                  const isAnomaly = batch.status === "anomaly";

                  return (
                    <tr key={batch.uid} className="hover:bg-muted/20">
                      <td className="py-3 px-3 font-mono text-xs font-medium whitespace-nowrap">
                        {batch.creditDate}
                      </td>
                      <td className="py-3 px-3 font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {batch.transactionDate || "—"}
                      </td>
                      <td className="py-3 px-3 text-center text-xs whitespace-nowrap">
                        {batch.reportCount != null ? (
                          <span>
                            {batch.reportCount} <span className="text-muted-foreground">/ {batch.declaredCount}</span>
                          </span>
                        ) : (
                          <span>{batch.declaredCount}</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-semibold whitespace-nowrap">
                        {formatMinorUSD(batch.creditAmountMinor)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {batch.feeAmountMinor != null ? formatMinorUSD(batch.feeAmountMinor) : "—"}
                      </td>
                      <td className="py-3 px-3 text-center whitespace-nowrap">
                        {isSettled && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" />
                            {toSpanishBatchStatus(batch.status)}
                          </span>
                        )}
                        {isPending && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                            <Clock className="h-3 w-3" />
                            {toSpanishBatchStatus(batch.status)}
                          </span>
                        )}
                        {isAnomaly && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
                            <AlertTriangle className="h-3 w-3" />
                            {toSpanishBatchStatus(batch.status)}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-xs text-muted-foreground max-w-xs truncate">
                        {batch.pendingReason || "Liquidada al centavo con reporte Yappy"}
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

