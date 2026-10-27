import React from "react";

export function CollectionsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="h-7 w-64 rounded-md bg-bg-raised" />
            <div className="h-5 w-20 rounded-full bg-purple-500/15" />
          </div>
          <div className="mt-2 h-4 w-72 rounded bg-bg-raised" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-8 w-28 rounded-lg bg-bg-raised" />
          <div className="h-8 w-28 rounded-lg bg-bg-raised" />
        </div>
      </div>

      {/* Top Banner */}
      <div className="h-16 rounded-xl border border-border-subtle bg-bg-surface p-4 shadow-xs flex items-center justify-between">
        <div className="h-5 w-80 rounded bg-bg-raised" />
        <div className="h-8 w-36 rounded-lg bg-bg-raised" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-border-subtle bg-bg-surface p-4 shadow-xs space-y-2"
          >
            <div className="h-3 w-28 rounded bg-bg-raised" />
            <div className="h-6 w-24 rounded bg-bg-raised" />
            <div className="h-3 w-36 rounded bg-bg-raised" />
          </div>
        ))}
      </div>

      {/* Table skeleton */}
      <div className="rounded-xl border border-border-subtle bg-bg-surface p-6 shadow-xs space-y-4">
        <div className="h-8 w-64 rounded bg-bg-raised" />
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-12 w-full rounded bg-bg-raised" />
          ))}
        </div>
      </div>
    </div>
  );
}

