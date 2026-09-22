"use client";

import { useState, useTransition } from "react";
import { Check, Edit3, Loader2, UserCheck } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { assignBgDepositPayerAction } from "./actions";

interface Props {
  accountId: string;
  txnId: string;
  targetUid?: string;
  currentPayer?: string | null;
  currentLoanRef?: string | null;
}

export function BgAssignPayerForm({
  accountId,
  txnId,
  targetUid,
  currentPayer,
  currentLoanRef,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [payerName, setPayerName] = useState(currentPayer || "");
  const [loanRef, setLoanRef] = useState(currentLoanRef || "");
  const [notes, setNotes] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!payerName.trim()) {
      setErrorMsg("Por favor ingresa el nombre del ordenante.");
      return;
    }

    setErrorMsg(null);
    setSuccessMsg(null);

    startTransition(async () => {
      const res = await assignBgDepositPayerAction({
        accountId,
        txnId,
        targetUid,
        payerName,
        loanRef: loanRef || undefined,
        notes: notes || undefined,
      });

      if (res.status === "ok") {
        setSuccessMsg("Ordenante asignado exitosamente.");
        setTimeout(() => {
          setIsOpen(false);
          setSuccessMsg(null);
        }, 1200);
      } else {
        setErrorMsg(res.message || "Error al asignar ordenante.");
      }
    });
  };

  if (!isOpen) {
    return (
      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant={currentPayer ? "ghost" : "primary"}
          onClick={() => setIsOpen(true)}
          className="inline-flex items-center gap-1.5 text-xs font-medium"
        >
          {currentPayer ? (
            <>
              <Edit3 className="h-3.5 w-3.5" />
              <span>Editar ordenante</span>
            </>
          ) : (
            <>
              <UserCheck className="h-3.5 w-3.5" />
              <span>Asignar ordenante</span>
            </>
          )}
        </Button>
        {!currentPayer && (
          <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
            (Fondos confirmados · Falta identificar cliente)
          </span>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSave}
      className="mt-3 rounded-lg border border-border bg-bg-surface p-4 shadow-sm space-y-3 max-w-lg"
    >
      <div className="flex items-center justify-between border-b border-border-subtle pb-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-fg">
          <UserCheck className="h-4 w-4 text-brand-500" />
          <span>{currentPayer ? "Editar ordenante del depósito" : "Designar ordenante del depósito"}</span>
        </div>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="text-xs text-fg-muted hover:text-fg"
        >
          Cancelar
        </button>
      </div>

      <div className="space-y-1">
        <Label htmlFor="payerName" className="text-xs font-medium">
          Nombre del cliente / Ordenante <span className="text-destructive">*</span>
        </Label>
        <Input
          id="payerName"
          value={payerName}
          onChange={(e) => setPayerName(e.target.value)}
          placeholder="Ej: MARÍA GONZÁLEZ"
          disabled={isPending}
          className="h-8 text-xs font-medium"
          autoFocus
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="loanRef" className="text-xs font-medium">
            Préstamo / Referencia (opcional)
          </Label>
          <Input
            id="loanRef"
            value={loanRef}
            onChange={(e) => setLoanRef(e.target.value)}
            placeholder="Ej: CAPAPR00012001"
            disabled={isPending}
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="notes" className="text-xs font-medium">
            Notas / Boleta (opcional)
          </Label>
          <Input
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Ej: Boleta #48291 vía WhatsApp"
            disabled={isPending}
            className="h-8 text-xs"
          />
        </div>
      </div>

      {errorMsg && (
        <p className="text-xs text-destructive font-medium">{errorMsg}</p>
      )}

      {successMsg && (
        <div className="flex items-center gap-1.5 text-xs text-success font-medium">
          <Check className="h-3.5 w-3.5" />
          <span>{successMsg}</span>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setIsOpen(false)}
          disabled={isPending}
          className="text-xs"
        >
          Cancelar
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={isPending || !payerName.trim()}
          className="text-xs inline-flex items-center gap-1.5"
        >
          {isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Guardando...</span>
            </>
          ) : (
            <>
              <Check className="h-3.5 w-3.5" />
              <span>Guardar asignación</span>
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

