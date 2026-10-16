"use client";

import React from "react";
import { Download, X } from "lucide-react";

import type { PortfolioBucket } from "@/lib/portfolio/types";

interface LoanModalProps {
  open: boolean;
  title: string;
  subtitle: string;
  cols: string[];
  rows: (string | number)[][];
  filename: string;
  buckets: PortfolioBucket[];
  bucketColors: string[];
  onClose: () => void;
}

const RIGHT_ALIGN_COLS = new Set([
  "Saldo",
  "DPD",
  "Por cobrar",
  "Principal",
  "Ingresos",
  "Total",
  "Cuotas",
  "Monto programado",
]);

const INT_COLS = new Set(["DPD", "Cuotas"]);

export function LoanModal({
  open,
  title,
  subtitle,
  cols,
  rows,
  filename,
  buckets,
  bucketColors,
  onClose,
}: LoanModalProps) {
  if (!open) return null;

  const fmtMoney2 = (x: number) =>
    (x || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const downloadCsv = () => {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      cols.map(q).join(";"),
      ...rows.map((r) => r.map(q).join(";")),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-2xl bg-bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle p-5">
          <div>
            <h3 className="text-base font-semibold text-fg">{title}</h3>
            <p className="text-xs text-fg-muted">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={downloadCsv}
              className="flex items-center gap-1.5 rounded-lg bg-[#620494] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#4C0374]"
            >
              <Download className="h-3.5 w-3.5" />
              Descargar CSV (Excel)
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-fg-muted hover:bg-bg-raised hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="overflow-auto p-5">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="sticky top-0 border-b border-border-subtle bg-bg-surface text-[10px] uppercase tracking-wider text-fg-subtle">
                {cols.map((col, idx) => (
                  <th
                    key={idx}
                    className={`py-2 px-3 ${
                      RIGHT_ALIGN_COLS.has(col) ? "text-right" : ""
                    }`}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((r, rIdx) => (
                <tr key={rIdx} className="hover:bg-bg-raised/50">
                  {r.map((val, cIdx) => {
                    const colName = cols[cIdx];
                    const isNum = typeof val === "number";
                    let text = String(val ?? "");
                    if (isNum) {
                      text = INT_COLS.has(colName)
                        ? String(Math.round(val))
                        : fmtMoney2(val);
                    }
                    if (colName === "Tramo") {
                      const bIdx = buckets.indexOf(
                        String(val) as PortfolioBucket,
                      );
                      const bg = bIdx >= 0 ? bucketColors[bIdx] : "#620494";
                      return (
                        <td key={cIdx} className="py-2 px-3">
                          <span
                            style={{ backgroundColor: bg }}
                            className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                          >
                            {text}
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td
                        key={cIdx}
                        className={`py-2 px-3 font-mono ${
                          RIGHT_ALIGN_COLS.has(colName) ? "text-right" : ""
                        }`}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

