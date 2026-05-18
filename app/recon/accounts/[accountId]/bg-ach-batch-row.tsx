"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * Expandable row for the "ACH Debit batches" table on BG accounts.
 * Server renders the summary cells (`cells`) and the detail panel
 * (`detail`); this component toggles the panel visibility client-side.
 */
export function BGAchBatchRow({
  rowKey,
  cells,
  detail,
  cellCount,
}: {
  rowKey: string;
  cells: ReactNode;
  detail: ReactNode;
  cellCount: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="cursor-pointer hover:bg-bg-raised/30"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`bg-ach-batch-${rowKey}`}
        onMouseDown={(e) => e.preventDefault()}
      >
        <td className="py-3 pr-2 align-top text-fg-subtle">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </td>
        {cells}
      </tr>
      {open && (
        <tr id={`bg-ach-batch-${rowKey}`} className="bg-bg-raised/30">
          <td colSpan={cellCount + 1} className="px-4 py-4">
            {detail}
          </td>
        </tr>
      )}
    </>
  );
}
