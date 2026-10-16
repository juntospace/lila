"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import type { BoardDataset } from "@/lib/portfolio/board";
import {
  fbtnLabel,
  type PeriodPreset,
  SEG_COLORS,
} from "@/lib/portfolio/board-compute";

interface ControlsProps {
  data: BoardDataset;
  selectedSegs: Set<string>;
  onChangeSegs: (next: Set<string>) => void;
  period: PeriodPreset;
  onChangePeriod: (p: PeriodPreset) => void;
  rangeStart: string;
  rangeEnd: string;
  onChangeRangeStart: (v: string) => void;
  onChangeRangeEnd: (v: string) => void;
  filterTg: Set<string>;
  onChangeTg: (next: Set<string>) => void;
  filterTc: Set<string>;
  onChangeTc: (next: Set<string>) => void;
  filterGc: Set<string>;
  onChangeGc: (next: Set<string>) => void;
  filterMr: Set<string>;
  onChangeMr: (next: Set<string>) => void;
}

interface FilterDropdownProps {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}

function FilterDropdown({
  label,
  options,
  selected,
  onChange,
}: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleOutside);
    }
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const allChecked = selected.size >= options.length;
  const btnText = fbtnLabel(selected, options);

  const toggleAll = () => {
    if (allChecked) {
      // Keep at least the first option checked
      onChange(new Set(options.length > 0 ? [options[0]] : []));
    } else {
      onChange(new Set(options));
    }
  };

  const toggleOption = (val: string) => {
    const next = new Set(selected);
    if (next.has(val)) {
      // At least 1 option must remain checked (Fase 3.2)
      if (next.size > 1) {
        next.delete(val);
        onChange(next);
      }
    } else {
      next.add(val);
      onChange(next);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition ${
          !allChecked
            ? "border-[#620494] bg-[#F1E6F8]/60 font-semibold text-[#4C0374]"
            : "border-border-subtle bg-bg-surface text-fg hover:bg-bg-raised"
        }`}
      >
        <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
          {label}:
        </span>
        <span className="max-w-[120px] truncate font-medium">{btnText}</span>
        <ChevronDown className="h-3 w-3 text-fg-subtle" />
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-1.5 w-56 rounded-xl border border-border-subtle bg-bg-surface p-2 shadow-lg">
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold text-fg hover:bg-bg-raised">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
              className="rounded border-border-subtle accent-[#620494]"
            />
            <span>Todas</span>
          </label>
          <div className="my-1 border-t border-border-subtle" />
          <div className="max-h-52 overflow-y-auto space-y-0.5">
            {options.map((opt) => {
              const isChecked = selected.has(opt);
              return (
                <label
                  key={opt}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-fg hover:bg-bg-raised"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleOption(opt)}
                    className="rounded border-border-subtle accent-[#620494]"
                  />
                  <span className="truncate">{opt}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function Controls({
  data: D,
  selectedSegs,
  onChangeSegs,
  period,
  onChangePeriod,
  rangeStart,
  rangeEnd,
  onChangeRangeStart,
  onChangeRangeEnd,
  filterTg,
  onChangeTg,
  filterTc,
  onChangeTc,
  filterGc,
  onChangeGc,
  filterMr,
  onChangeMr,
}: ControlsProps) {
  return (
    <div className="sticky top-0 z-20 rounded-xl border border-border-subtle bg-bg-surface/95 p-4 shadow-sm backdrop-blur-md space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Segment Chips */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Segmento
          </span>
          <div className="flex flex-wrap gap-1.5">
            {D.segments.map((seg, idx) => {
              const active = selectedSegs.has(seg);
              return (
                <button
                  key={seg}
                  type="button"
                  onClick={() => {
                    const next = new Set(selectedSegs);
                    if (active && next.size > 1) {
                      next.delete(seg);
                    } else {
                      next.add(seg);
                    }
                    onChangeSegs(next);
                  }}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all ${
                    active
                      ? "bg-[#620494] text-white shadow-xs"
                      : "border border-border-subtle bg-bg-surface text-fg-muted hover:border-border-strong"
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: SEG_COLORS[idx] }}
                  />
                  {seg}
                </button>
              );
            })}
          </div>
        </div>

        {/* Period Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Periodo
          </span>
          <div className="flex rounded-lg border border-border-subtle bg-bg-raised p-0.5 text-xs">
            {(["todo", "anio", "mes", "semana", "rango"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChangePeriod(p)}
                className={`rounded-md px-2.5 py-1 font-medium capitalize transition-all ${
                  period === p
                    ? "bg-bg-surface text-fg shadow-xs"
                    : "text-fg-muted hover:text-fg"
                }`}
              >
                {p === "anio" ? "Año" : p}
              </button>
            ))}
          </div>

          {period === "rango" && (
            <div className="flex items-center gap-2 text-xs">
              <input
                type="date"
                value={rangeStart}
                onChange={(e) => onChangeRangeStart(e.target.value)}
                className="rounded border border-border-subtle bg-bg-surface px-2 py-1 text-fg"
              />
              <span>a</span>
              <input
                type="date"
                value={rangeEnd}
                onChange={(e) => onChangeRangeEnd(e.target.value)}
                className="rounded border border-border-subtle bg-bg-surface px-2 py-1 text-fg"
              />
            </div>
          )}
        </div>
      </div>

      {/* Dimension Filters Row: Garantía / Cartera / Gestor / Motor (Fase 3.2) */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mr-1">
          Filtros:
        </span>
        <FilterDropdown
          label="Garantía"
          options={D.filtVals.tg}
          selected={filterTg}
          onChange={onChangeTg}
        />
        <FilterDropdown
          label="Cartera"
          options={D.filtVals.tc}
          selected={filterTc}
          onChange={onChangeTc}
        />
        <FilterDropdown
          label="Gestor"
          options={D.filtVals.gc}
          selected={filterGc}
          onChange={onChangeGc}
        />
        <FilterDropdown
          label="Motor"
          options={D.filtVals.mr}
          selected={filterMr}
          onChange={onChangeMr}
        />
      </div>
    </div>
  );
}

