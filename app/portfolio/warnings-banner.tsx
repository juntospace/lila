import React from "react";
import { AlertTriangle } from "lucide-react";

interface WarningsBannerProps {
  warnings: string[];
}

export function PortfolioWarningsBanner({ warnings }: WarningsBannerProps) {
  if (!warnings || warnings.length === 0) return null;

  return (
    <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 shadow-xs">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="space-y-1">
          <div className="font-semibold text-amber-950">
            Avisos de higiene y calidad de datos del lote
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-amber-800">
            {warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

