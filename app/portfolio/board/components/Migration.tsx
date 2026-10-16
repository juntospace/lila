"use client";

import React from "react";

import type { BoardDataset } from "@/lib/portfolio/board";
import { LOAN_COLS } from "@/lib/portfolio/board-compute";

interface MigrationProps {
  data: BoardDataset;
  matrix: {
    dA: string;
    dB: string;
    /** Transposed: rows[endIdx][startIdx] */
    rows: string[][][];
  } | null;
  getLoanRow: (id: string) => (string | number)[];
  onTriggerModal: (
    title: string,
    subtitle: string,
    cols: string[],
    rows: (string | number)[][],
    fname: string,
  ) => void;
}

export function Migration({
  data: D,
  matrix,
  getLoanRow,
  onTriggerModal,
}: MigrationProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm font-bold text-fg-subtle">03</span>
        <h2 className="text-lg font-semibold text-fg">
          Migración entre tramos
        </h2>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-xs">
        {matrix ? (
          <div>
            <div className="mb-3 text-xs text-fg-muted">
              Inicio (columnas): <b className="text-fg">{matrix.dA}</b> → Fin
              (filas): <b className="text-fg">{matrix.dB}</b> (instantáneas más
              cercanas al periodo)
            </div>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="p-2 text-right text-[10px] font-semibold text-fg-subtle">
                    fin \ inicio
                  </th>
                  {D.buckets.map((startBucket) => (
                    <th
                      key={startBucket}
                      className="p-2 text-center text-[10px] font-semibold text-fg-subtle"
                    >
                      {startBucket}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {D.buckets.map((endName, endIdx) => (
                  <tr key={endName}>
                    <td className="p-2 text-right font-medium text-fg">
                      {endName}
                    </td>
                    {D.buckets.map((startName, startIdx) => {
                      const ids = matrix.rows[endIdx][startIdx];
                      const count = ids.length;
                      const isDiag = endIdx === startIdx;
                      const isImproved = endIdx < startIdx;
                      const isWorse = endIdx > startIdx;

                      let bgClass = "bg-bg-surface text-fg-subtle";
                      if (count > 0) {
                        if (isDiag) bgClass = "bg-bg-raised text-fg font-bold";
                        else if (isImproved)
                          bgClass = "bg-emerald-100 text-emerald-800 font-bold";
                        else if (isWorse)
                          bgClass = "bg-rose-100 text-rose-800 font-bold";
                      }

                      return (
                        <td
                          key={startName}
                          onClick={() => {
                            if (count > 0) {
                              onTriggerModal(
                                `Migración: ${startName} → ${endName}`,
                                `${matrix.dA} → ${matrix.dB} · ${count} préstamos`,
                                LOAN_COLS,
                                ids.map(getLoanRow),
                                `migracion_${startName}_a_${endName}`,
                              );
                            }
                          }}
                          className={`p-2 text-center rounded-sm transition-all ${bgClass} ${
                            count > 0 ? "cursor-pointer hover:opacity-80" : ""
                          }`}
                        >
                          {count > 0 ? count : "·"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border-strong p-6 text-center text-xs text-fg-muted">
            Se activa con ≥ 2 días de historial en la base de datos.
          </div>
        )}
      </div>
    </section>
  );
}

