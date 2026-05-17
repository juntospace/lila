"use client";

import { useActionState, useEffect, useRef } from "react";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";

import { createBankAccount, type AccountActionState } from "./actions";

const INITIAL: AccountActionState = { status: "idle" };

export function AddAccountForm() {
  const [state, action, pending] = useActionState(createBankAccount, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state.status, state.message]);

  return (
    <form ref={formRef} action={action} className="space-y-3 border-t border-border-subtle pt-4">
      <p className="text-xs uppercase tracking-wide text-fg-subtle">Add account</p>

      <div className="space-y-1.5">
        <Label htmlFor="acct_rail">Rail</Label>
        <select
          id="acct_rail"
          name="rail"
          defaultValue="bac"
          className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <option value="bac">BAC</option>
          <option value="bg">Banco General</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="acct_number">Account number</Label>
        <Input
          id="acct_number"
          name="account_number"
          required
          placeholder="100412600 or 03-43-01-106691-6"
          aria-invalid={!!state.fieldErrors?.account_number || undefined}
        />
        {state.fieldErrors?.account_number && (
          <p className="text-xs text-danger">{state.fieldErrors.account_number}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="acct_holder">Holder name</Label>
        <Input
          id="acct_holder"
          name="holder_name"
          required
          placeholder="JUNTO SOLUCIONES, S.A."
          aria-invalid={!!state.fieldErrors?.holder_name || undefined}
        />
        {state.fieldErrors?.holder_name && (
          <p className="text-xs text-danger">{state.fieldErrors.holder_name}</p>
        )}
      </div>

      <input type="hidden" name="currency" value="USD" />

      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? "Adding…" : "Add account"}
        </Button>
        {state.status === "success" && (
          <p className="text-xs text-success">{state.message}</p>
        )}
        {state.status === "error" && !state.fieldErrors && (
          <p className="text-xs text-danger">{state.message}</p>
        )}
      </div>
    </form>
  );
}
