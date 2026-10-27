import React from "react";

export function BoardReportSkeleton({
  entityCode = "crediclaro",
}: {
  entityCode?: string;
}) {
  return (
    <div className="space-y-8 animate-pulse">
      {/* Header skeleton */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="h-7 w-64 rounded-md bg-bg-raised" />
            <div className="h-5 w-20 rounded-full bg-[#F1E6F8]/50" />
          </div>
          <p className="mt-2 text-xs text-fg-muted">
            Cartera y envejecimiento de préstamos ·{" "}
            {entityCode === "crediclaro"
              ? "Crediclaro, S.A."
              : "Junto Soluciones, S.A."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-8 w-28 rounded-lg bg-bg-raised" />
          <div className="h-8 w-28 rounded-lg bg-bg-raised" />
        </div>
      </div>

      {/* KPI Cards skeleton */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-fg-subtle">01</span>
          <div className="h-5 w-40 rounded bg-bg-raised" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="relative overflow-hidden rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs"
            >
              <div className="h-3 w-24 rounded bg-bg-raised" />
              <div className="mt-3 h-7 w-32 rounded bg-bg-raised" />
              <div className="mt-2 h-3 w-28 rounded bg-bg-raised" />
            </div>
          ))}
        </div>
      </section>

      {/* Controls filter bar skeleton */}
      <div className="rounded-xl border border-border-subtle bg-bg-surface p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="h-6 w-20 rounded-full bg-bg-raised" />
            <div className="h-6 w-24 rounded-full bg-bg-raised" />
            <div className="h-6 w-24 rounded-full bg-bg-raised" />
          </div>
          <div className="h-8 w-48 rounded-lg bg-bg-raised" />
        </div>
      </div>

      {/* Main distribution table / chart card skeleton */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-fg-subtle">02</span>
          <div className="h-5 w-48 rounded bg-bg-raised" />
        </div>
        <div className="h-72 rounded-xl border border-border-subtle bg-bg-surface p-6 shadow-xs flex flex-col justify-between">
          <div className="space-y-3">
            <div className="h-4 w-1/3 rounded bg-bg-raised" />
            <div className="h-4 w-1/2 rounded bg-bg-raised" />
          </div>
          <div className="grid grid-cols-7 gap-2">
            {[...Array(7)].map((_, i) => (
              <div
                key={i}
                className="rounded bg-bg-raised"
                style={{ height: `${40 + (i % 3) * 30}px` }}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

