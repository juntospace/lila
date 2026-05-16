"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Selectable = {
  id: string;
  amountMinor: bigint;
};

type SelectionContextValue = {
  /** Selected PR ids (only ones the operator can act on). */
  selectedIds: Set<string>;
  /** Total minor-units across the selection (for the action bar label). */
  selectedAmountMinor: bigint;
  toggle: (item: Selectable) => void;
  clear: () => void;
  setAll: (items: Selectable[]) => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function BulkSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Map<string, bigint>>(new Map());

  const toggle = useCallback((item: Selectable) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item.amountMinor);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Map()), []);

  const setAll = useCallback((items: Selectable[]) => {
    setSelected(new Map(items.map((i) => [i.id, i.amountMinor])));
  }, []);

  const value = useMemo<SelectionContextValue>(() => {
    let total = 0n;
    for (const v of selected.values()) total += v;
    return {
      selectedIds: new Set(selected.keys()),
      selectedAmountMinor: total,
      toggle,
      clear,
      setAll,
    };
  }, [selected, toggle, clear, setAll]);

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useBulkSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error(
      "useBulkSelection must be used inside <BulkSelectionProvider>",
    );
  }
  return ctx;
}
