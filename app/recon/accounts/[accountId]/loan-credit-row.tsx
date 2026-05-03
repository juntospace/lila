"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * Expandable row wrapper. Server renders the cells (passed as `children`)
 * and the detail panel; this component just toggles visibility client-side.
 *
 * Tier 3 PR 1 keeps the panel read-only — confirm/revert buttons land in
 * PRs 2/3 inside the same panel.
 */
export function LoanCreditRow({
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
        aria-controls={`detail-${rowKey}`}
        // Stop selection on shift-click / drag from leaking into the
        // page; toggle is the only intent here.
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
        <tr id={`detail-${rowKey}`} className="bg-bg-raised/30">
          <td colSpan={cellCount + 1} className="px-4 py-4">
            {detail}
          </td>
        </tr>
      )}
    </>
  );
}
