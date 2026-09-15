"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpDown,
  Calendar,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  FileWarning,
  Search,
} from "lucide-react";

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

function extractTaskDate(task: {
  missing_item: string;
  details: string | null;
  affects_uid: string;
}): string | null {
  const matchUid = task.affects_uid.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (matchUid) return matchUid[0];
  const matchDetails = task.details?.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (matchDetails) return matchDetails[0];
  const matchMissing = task.missing_item.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (matchMissing) return matchMissing[0];
  return null;
}

export function BgPendingTasksPanel({
  pendingTasks,
  alerts,
  quarantinedDays = [],
  provisionalDays = [],
}: Props) {
  const [isTasksCollapsed, setIsTasksCollapsed] = useState<boolean>(false);
  const [isAlertsCollapsed, setIsAlertsCollapsed] = useState<boolean>(false);
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const errorAlerts = alerts.filter(
    (a) =>
      a.severity === "error" ||
      a.message.includes("ANOMALIA") ||
      a.message.includes("ANOMALY") ||
      a.message.includes("CONFLICTO") ||
      a.message.includes("CONFLICT"),
  );
  const warnAlerts = alerts.filter((a) => a.severity !== "error" && !errorAlerts.includes(a));

  const processedTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const withDates = pendingTasks.map((t) => ({
      ...t,
      date: extractTaskDate(t),
    }));

    const filtered = withDates.filter((t) => {
      if (!query) return true;
      const matchMissing = t.missing_item.toLowerCase().includes(query);
      const matchDetails = t.details?.toLowerCase().includes(query) ?? false;
      const matchUid = t.affects_uid.toLowerCase().includes(query);
      const matchDate = t.date?.includes(query) ?? false;
      return matchMissing || matchDetails || matchUid || matchDate;
    });

    return filtered.sort((a, b) => {
      const dateA = a.date || "";
      const dateB = b.date || "";
      if (!dateA && !dateB) return 0;
      if (!dateA) return 1;
      if (!dateB) return -1;
      return sortOrder === "desc"
        ? dateB.localeCompare(dateA)
        : dateA.localeCompare(dateB);
    });
  }, [pendingTasks, searchQuery, sortOrder]);

  return (
    <div className="space-y-6">
      {/* Critical Alerts & Quarantine */}
      {(errorAlerts.length > 0 || quarantinedDays.length > 0 || provisionalDays.length > 0) && (
        <Card className="border-red-500/40 bg-red-500/5">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                <AlertTriangle className="h-5 w-5" />
                <CardTitle>Alertas de Auditoría y Días en Cuarentena</CardTitle>
              </div>
              <button
                type="button"
                onClick={() => setIsAlertsCollapsed(!isAlertsCollapsed)}
                className="inline-flex items-center gap-1 rounded p-1 text-xs text-red-700 hover:bg-red-500/10 dark:text-red-300"
                title={isAlertsCollapsed ? "Expandir alertas" : "Contraer alertas"}
              >
                {isAlertsCollapsed ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronUp className="h-4 w-4" />
                )}
              </button>
            </div>
            <CardDescription>
              Discrepancias críticas de saldo o conflictos de snapshot detectados.
            </CardDescription>
          </CardHeader>
          {!isAlertsCollapsed && (
            <CardBody className="space-y-3">
              {quarantinedDays.length > 0 && (
                <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
                  <strong>Días en cuarentena (no conciliados por conflicto de versión):</strong>{" "}
                  {quarantinedDays.join(", ")}
                </div>
              )}
              {provisionalDays.length > 0 && (
                <div className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                  <strong>Días con cobertura provisional (requieren re-descargar tras cierre):</strong>{" "}
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
          )}
        </Card>
      )}

      {/* Pending Tasks (What is missing) */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-amber-500" />
              <CardTitle>Tareas Pendientes de Conciliación</CardTitle>
              <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                {pendingTasks.length} pendientes
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSortOrder(sortOrder === "desc" ? "asc" : "desc")}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-sm hover:bg-muted/40 transition-colors"
                title="Cambiar orden cronológico"
              >
                <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
                <span>{sortOrder === "desc" ? "Más recientes" : "Más antiguos"}</span>
              </button>
              <button
                type="button"
                onClick={() => setIsTasksCollapsed(!isTasksCollapsed)}
                className="inline-flex items-center gap-1 rounded p-1 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
                title={isTasksCollapsed ? "Expandir tareas pendientes" : "Contraer tareas pendientes"}
              >
                <span className="text-xs font-medium">{isTasksCollapsed ? "Expandir" : "Contraer"}</span>
                {isTasksCollapsed ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronUp className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
          <CardDescription>
            Archivos o extractos faltantes necesarios para liquidar lotes o pagos pendientes.
          </CardDescription>
        </CardHeader>
        {!isTasksCollapsed && (
          <CardBody>
            {pendingTasks.length === 0 ? (
              <div className="flex items-center gap-2 py-4 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle className="h-4 w-4" />
                <span>Sin tareas pendientes — todos los archivos conocidos están conciliados.</span>
              </div>
            ) : (
              <div className="space-y-3">
                {pendingTasks.length > 5 && (
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="Filtrar por cliente, fecha (YYYY-MM-DD), monto..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full rounded-md border border-border bg-background pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                )}
                {processedTasks.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    No hay tareas que coincidan con &ldquo;{searchQuery}&rdquo;.
                  </p>
                ) : (
                  <div className="max-h-[440px] overflow-y-auto divide-y divide-border pr-1">
                    {processedTasks.map((task, idx) => {
                      const amt =
                        task.amount_minor != null ? BigInt(String(task.amount_minor)) : null;
                      return (
                        <div key={idx} className="flex items-start justify-between py-2.5 gap-4">
                          <div className="space-y-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              {task.date && (
                                <span className="inline-flex items-center gap-1 rounded bg-brand-500/10 px-2 py-0.5 text-[11px] font-mono font-medium text-brand-600 dark:text-brand-400">
                                  <Calendar className="h-3 w-3" />
                                  {task.date}
                                </span>
                              )}
                              <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-mono font-medium">
                                {toSpanishTaskType(task.task_type)}
                              </span>
                              <span className="text-[11px] text-muted-foreground font-mono truncate max-w-[240px]">
                                {task.affects_uid}
                              </span>
                            </div>
                            <p className="text-sm font-medium text-foreground">{task.missing_item}</p>
                            {task.details && (
                              <p className="text-xs text-muted-foreground">{task.details}</p>
                            )}
                          </div>
                          {amt != null && (
                            <span className="font-mono text-sm font-semibold text-foreground shrink-0">
                              {formatMinorUSD(amt)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </CardBody>
        )}
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
