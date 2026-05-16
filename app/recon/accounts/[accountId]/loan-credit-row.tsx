"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useBulkSelection } from "./bulk-selection-context";

/**
 * Expandable row wrapper. Server renders the cells (passed as `children`)
 * and the detail panel; this component toggles visibility client-side
 * and renders a bulk-selection checkbox when the row is selectable
 * (currently: pending PRs only).
 */
export function LoanCreditRow({
  rowKey,
  cells,
  detail,
  cellCount,
  /** When provided, the row shows a checkbox tied to the bulk-selection
   *  context. The amount is included so the action bar can show the
   *  selected total in one place. Pass undefined to render no checkbox. */
  selectable,
}: {
  rowKey: string;
  cells: ReactNode;
  detail: ReactNode;
  cellCount: number;
  selectable?: { id: string; amountMinor: bigint };
}) {
  const [open, setOpen] = useState(false);
  const { selectedIds, toggle } = useBulkSelection();
  const isSelected = selectable ? selectedIds.has(selectable.id) : false;

  // Row layout: chevron column + checkbox column + N cell columns.
  const colSpan = cellCount + 2;

  return (
    <>
      <tr
        className="cursor-pointer hover:bg-bg-raised/30"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`detail-${rowKey}`}
        onMouseDown={(e) => e.preventDefault()}
      >
        <td className="py-3 pr-2 align-top text-fg-subtle">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </td>
        <td
          className="py-3 pr-2 align-top"
          onClick={(e) => e.stopPropagation()}
        >
          {selectable && (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggle(selectable)}
              aria-label="Select this row for bulk action"
              className="h-4 w-4 cursor-pointer"
            />
          )}
        </td>
        {cells}
      </tr>
      {open && (
        <tr id={`detail-${rowKey}`} className="bg-bg-raised/30">
          <td colSpan={colSpan} className="px-4 py-4">
            {detail}
          </td>
        </tr>
      )}
    </>
  );
}
