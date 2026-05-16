"use client";

import { Download } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";

type Account = {
  id: string;
  rail: string;
  account_number: string;
  holder_name: string;
};

const STATES = ["rejected", "confirmed", "pending", "all"] as const;
type StateOption = (typeof STATES)[number];

function isoDaysAgo(days: number): string {
  const now = new Date();
  const d = new Date(now.getTime() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Form for the multi-account bulk export. Submits as a regular link click
 * (assembles the URL with query params) so the browser handles the file
 * download natively — no server action / progress UI needed.
 */
export function BulkExportForm({ accounts }: { accounts: Account[] }) {
  const [stateFilter, setStateFilter] = useState<StateOption>("rejected");
  const [from, setFrom] = useState<string>(() => isoDaysAgo(30));
  const [to, setTo] = useState<string>(() => todayIso());
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(
    new Set(),
  );

  const allSelected = selectedAccounts.size === 0;

  const href = useMemo(() => {
    const params = new URLSearchParams();
    params.set("state", stateFilter);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    for (const id of selectedAccounts) params.append("account", id);
    return `/recon/export?${params.toString()}`;
  }, [stateFilter, from, to, selectedAccounts]);

  function toggleAccount(id: string) {
    setSelectedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto]">
      <div className="space-y-2">
        <Label htmlFor="bulk-state">Status</Label>
        <select
          id="bulk-state"
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as StateOption)}
          className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {STATES.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All states" : s}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="bulk-from">From</Label>
          <input
            id="bulk-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bulk-to">To</Label>
          <input
            id="bulk-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>
      </div>

      <div className="flex items-end">
        <Button asChild>
          <a href={href}>
            <Download className="h-4 w-4" />
            Download .xlsx
          </a>
        </Button>
      </div>

      {accounts.length > 1 && (
        <div className="lg:col-span-3 space-y-2">
          <Label>Accounts</Label>
          <div className="flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              onClick={() => setSelectedAccounts(new Set())}
              className={`rounded border px-2 py-1 ${
                allSelected
                  ? "border-brand-500 bg-brand-500/10 text-fg"
                  : "border-border-subtle text-fg-muted hover:text-fg"
              }`}
            >
              All ({accounts.length})
            </button>
            {accounts.map((a) => {
              const on = selectedAccounts.has(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => toggleAccount(a.id)}
                  className={`rounded border px-2 py-1 ${
                    on
                      ? "border-brand-500 bg-brand-500/10 text-fg"
                      : "border-border-subtle text-fg-muted hover:text-fg"
                  }`}
                >
                  {a.account_number} · {a.holder_name.split(",")[0]}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-fg-subtle">
            Click an account to include only it (toggle off &ldquo;All&rdquo;);
            click multiple to filter to those. Leave on &ldquo;All&rdquo; for
            the whole portfolio.
          </p>
        </div>
      )}
    </div>
  );
}
