"use client";

import { useState, useTransition } from "react";
import { Check, HelpCircle, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatMinorUSD } from "@/lib/recon/format";
import type { BgAssignmentCategory } from "@/lib/recon/bg";
import { toSpanishSuggestion } from "@/lib/recon/bg/formatters";

import { saveBgManualAssignment } from "./actions";

export interface UnassignedIncomingRow {
  uid: string;
  movUid: string;
  date: string;
  channel: string;
  counterpart: string;
  transferReference: string;
  paymentReference: string;
  detectedLoanRef: string;
  description: string;
  amountMinor: bigint;
  status: string;
  category: BgAssignmentCategory | null;
  suggestion: "loan" | "loan_probable" | null;
  notes: string | null;
}

interface Props {
  accountId: string;
  items: UnassignedIncomingRow[];
}

export function BgUnassignedQueue({ accountId, items }: Props) {
  const [pendingItems, setPendingItems] = useState(items);
  const [selectedCategories, setSelectedCategories] = useState<Record<string, BgAssignmentCategory>>({});
  const [notes] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  const handleCategoryChange = (uid: string, cat: BgAssignmentCategory) => {
    setSelectedCategories((prev) => ({ ...prev, [uid]: cat }));
  };

  const handleSave = (uid: string) => {
    const category = selectedCategories[uid] || (items.find((i) => i.uid === uid)?.suggestion === "loan" ? "loan" : "loan");
    const itemNote = notes[uid] || "";

    startTransition(async () => {
      const res = await saveBgManualAssignment({
        accountId,
        targetUid: uid,
        category,
        notes: itemNote,
      });

      if (res.status === "ok") {
        setPendingItems((prev) => prev.filter((i) => i.uid !== uid));
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5 text-amber-500" />
            <CardTitle>Cola de Asignación Manual (Depósitos y Transferencias Directas)</CardTitle>
          </div>
          <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            {pendingItems.length} por clasificar
          </span>
        </div>
        <CardDescription>
          Depósitos directos y transferencias entrantes que requieren confirmación sobre si corresponden al pago de un préstamo.
        </CardDescription>
      </CardHeader>
      <CardBody>
        {pendingItems.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Check className="h-4 w-4 text-emerald-500" />
            <span>No hay abonos voluntarios pendientes de asignar.</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="py-2.5 px-3 font-medium">Fecha</th>
                  <th className="py-2.5 px-3 font-medium">Canal</th>
                  <th className="py-2.5 px-3 font-medium">Contraparte / Detalle</th>
                  <th className="py-2.5 px-3 font-medium text-right">Monto</th>
                  <th className="py-2.5 px-3 font-medium">Sugerencia</th>
                  <th className="py-2.5 px-3 font-medium">Asignar Categoría</th>
                  <th className="py-2.5 px-3 font-medium text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pendingItems.map((item) => {
                  const currentCategory = selectedCategories[item.uid] || (item.suggestion === "loan" ? "loan" : "loan");
                  return (
                    <tr key={item.uid} className="hover:bg-muted/20">
                      <td className="py-3 px-3 font-mono text-xs whitespace-nowrap">{item.date}</td>
                      <td className="py-3 px-3 text-xs whitespace-nowrap">
                        <span className="rounded bg-muted px-2 py-0.5 font-medium">{item.channel}</span>
                      </td>
                      <td className="py-3 px-3 max-w-xs">
                        <div className="font-medium truncate">{item.counterpart || item.description}</div>
                        {item.detectedLoanRef && (
                          <div className="text-xs font-mono text-emerald-600 dark:text-emerald-400">
                            Ref: {item.detectedLoanRef}
                          </div>
                        )}
                        {item.paymentReference && !item.detectedLoanRef && (
                          <div className="text-xs text-muted-foreground font-mono truncate">
                            {item.paymentReference}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-semibold whitespace-nowrap">
                        {formatMinorUSD(item.amountMinor)}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        {item.suggestion ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
                            <Sparkles className="h-3 w-3" />
                            {toSpanishSuggestion(item.suggestion)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        <select
                          className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                          value={currentCategory}
                          onChange={(e) => handleCategoryChange(item.uid, e.target.value as BgAssignmentCategory)}
                          disabled={isPending}
                        >
                          <option value="loan">PRÉSTAMO</option>
                          <option value="non_loan">NO PRÉSTAMO</option>
                          <option value="other">OTRO</option>
                        </select>
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleSave(item.uid)}
                          disabled={isPending}
                        >
                          Guardar
                        </Button>
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
