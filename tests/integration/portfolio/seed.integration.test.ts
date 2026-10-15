import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { ingestSnapshot } from "@/lib/portfolio/ingest";
import { parseCsv } from "@/lib/portfolio/parser";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

describe("Seed & Integration test · Portfolio Ingest", () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  it("ingests May 2025 snapshot into local Supabase", async () => {
    const samplesDir = path.resolve(process.cwd(), "samples/portfolio");
    const loansCsv = fs.readFileSync(
      path.join(samplesDir, "crediclaro_loans_2025-05-31.csv"),
      "utf-8",
    );
    const repaymentsCsv = fs.readFileSync(
      path.join(samplesDir, "crediclaro_repayments_2025-05-31.csv"),
      "utf-8",
    );

    const loansRaw = parseCsv(loansCsv);
    const repaymentsRaw = parseCsv(repaymentsCsv);

    const result = await ingestSnapshot(supabase, {
      entityCode: "crediclaro",
      snapshotDate: "2025-05-31",
      loansRaw,
      repaymentsRaw,
      sourceFiles: {
        loans: "crediclaro_loans_2025-05-31.csv",
        repayments: "crediclaro_repayments_2025-05-31.csv",
      },
    });

    expect(result.snapshotDate).toBe("2025-05-31");
    expect(result.totalLoans).toBe(8);
    expect(result.openLoans).toBe(6); // 1006 restructured & 1007 small balance excluded
    expect(result.openBalance).toBeGreaterThan(0);
  });

  it("ingests June 2025 snapshot into local Supabase and verifies rollups", async () => {
    const samplesDir = path.resolve(process.cwd(), "samples/portfolio");
    const loansCsv = fs.readFileSync(
      path.join(samplesDir, "crediclaro_loans_2025-06-30.csv"),
      "utf-8",
    );
    const repaymentsCsv = fs.readFileSync(
      path.join(samplesDir, "crediclaro_repayments_2025-06-30.csv"),
      "utf-8",
    );

    const loansRaw = parseCsv(loansCsv);
    const repaymentsRaw = parseCsv(repaymentsCsv);

    const result = await ingestSnapshot(supabase, {
      entityCode: "crediclaro",
      snapshotDate: "2025-06-30",
      loansRaw,
      repaymentsRaw,
      sourceFiles: {
        loans: "crediclaro_loans_2025-06-30.csv",
        repayments: "crediclaro_repayments_2025-06-30.csv",
      },
    });

    expect(result.snapshotDate).toBe("2025-06-30");
    expect(result.totalLoans).toBe(9);
    expect(result.openLoans).toBe(7); // 1001, 1002, 1003, 1004, 1005, 1008, 1009
    expect(result.cashAheadCount).toBe(1); // 1002 Ana Morales
    expect(result.futurePaymentsExcludedCount).toBe(1); // 1001 payment on 15/07/2025 > 30/06/2025
  });
});

