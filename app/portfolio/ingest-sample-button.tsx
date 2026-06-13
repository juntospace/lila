"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/Button";

import { ingestCrediclaroSample, type IngestSampleState } from "./actions";

const INITIAL: IngestSampleState = { status: "idle" };

export function IngestSampleButton() {
  const [state, formAction, pending] = useActionState<IngestSampleState, FormData>(
    async () => ingestCrediclaroSample(),
    INITIAL,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Button type="submit" disabled={pending} variant="primary">
        {pending ? "Ingesting…" : "Ingest Crediclaro sample"}
      </Button>
      {state.status === "success" && state.message && (
        <p className="rounded border border-success/40 bg-success-subtle px-3 py-2 text-sm text-fg">
          {state.message}
        </p>
      )}
      {state.status === "error" && state.message && (
        <p className="rounded border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-fg">
          {state.message}
        </p>
      )}
    </form>
  );
}
