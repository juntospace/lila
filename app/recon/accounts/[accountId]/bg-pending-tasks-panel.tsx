"use client";

import { AlertTriangle, Clock, FileWarning, CheckCircle } from "lucide-react";

import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatMinorUSD } from "@/lib/recon/format";
import type { BgPendingTaskType } from "@/lib/recon/bg";
import { toSpanishTaskType } from "@/lib/recon/bg/formatters";

interface Props {
  pendingTasks: Array<{
    task_type: BgPendingTaskType;
    missing_item: string;
    details: string | null;
    affects_uid: string;
    amount_minor: bigint | number | string | null;
  }>;
  alerts: Array<{
    message: string;
    severity: "info" | "warn" | "error";
  }>;
  quarantinedDays?: string[];
  provisionalDays?: string[];
}

export function BgPendingTasksPanel({
  pendingTasks,
  alerts,
  quarantinedDays = [],
  provisionalDays = [],
}: Props) {
  const errorAlerts = alerts.filter((a) => a.severity === "error" || a.message.includes("ANOMALIA") || a.message.includes("CONFLICTO"));
  const warnAlerts = alerts.filter((a) => a.severity !== "error" && !errorAlerts.includes(a));

  return (
    <div className="space-y-6">
      {/* Critical Alerts & Quarantine */}
      {(errorAlerts.length > 0 || quarantinedDays.length > 0 || provisionalDays.length > 0) && (
        <Card className="border-red-500/40 bg-red-500/5">
          <CardHeader>
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <AlertTriangle className="h-5 w-5" />
              <CardTitle>Alertas de Auditoría y Días en Cuarentena</CardTitle>
            </div>
            <CardDescription>
              Discrepancias críticas de saldo o conflictos de snapshot detectados.
            </CardDescription>
          </CardHeader>
          <CardBody className="space-y-3">
            {quarantinedDays.length > 0 && (
              <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
                <strong>Días en cuarentena (no conciliados por conflicto de versión):</strong>{" "}
                {quarantinedDays.join(", ")}
              </div>
            )}
            {provisionalDays.length > 0 && (
              <div className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                <strong>Días provisionales (requieren re-descarga tras cierre):</strong>{" "}
                {provisionalDays.join(", ")}
              </div>
            )}
            {errorAlerts.map((alert, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 rounded-md bg-red-500/10 p-2.5 text-xs font-mono text-red-800 dark:text-red-200"
              >
                <FileWarning className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{alert.message}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {/* Pending Tasks (What is missing) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-amber-500" />
              <CardTitle>Tareas Pendientes de Conciliación</CardTitle>
            </div>
            <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {pendingTasks.length} pendientes
            </span>
          </div>
          <CardDescription>
            Archivos o extractos faltantes necesarios para cerrar lotes o pagos pendientes.
          </CardDescription>
        </CardHeader>
        <CardBody>
          {pendingTasks.length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-4 w-4" />
              <span>No hay tareas pendientes — todos los archivos conocidos están conciliados.</span>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {pendingTasks.map((task, idx) => {
                const amt = task.amount_minor != null ? BigInt(String(task.amount_minor)) : null;
                return (
                  <div key={idx} className="flex items-start justify-between py-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-muted px-2 py-0.5 text-xs font-mono font-medium">
                          {toSpanishTaskType(task.task_type)}
                        </span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {task.affects_uid}
                        </span>
                      </div>
                      <p className="text-sm font-medium">{task.missing_item}</p>
                      {task.details && (
                        <p className="text-xs text-muted-foreground">{task.details}</p>
                      )}
                    </div>
                    {amt != null && (
                      <span className="font-mono text-sm font-semibold text-foreground">
                        {formatMinorUSD(amt)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Warning Alerts */}
      {warnAlerts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Otras Observaciones</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2">
            {warnAlerts.map((alert, idx) => (
              <p key={idx} className="text-xs text-muted-foreground font-mono">
                {alert.message}
              </p>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

