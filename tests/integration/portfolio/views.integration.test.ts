import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { loadBoardDataset } from "@/lib/portfolio/board";
import { buildCollectionsPlan } from "@/lib/portfolio/collections";
import { enrichLoan } from "@/lib/portfolio/enrich";
import { generateCollectionsWorkbook } from "@/lib/portfolio/excel";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

describe("Integration View Verification · Board & Collections", () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  it("loads board dataset including transition matrix and cohorts", async () => {
    const dataset = await loadBoardDataset(supabase, "crediclaro", "2025-06-30");

    expect(dataset).not.toBeNull();
    expect(dataset?.asof).toBe("2025-06-30");
    expect(dataset?.loanIds.length).toBeGreaterThan(0);
    expect(dataset?.segments.length).toBe(3);
    expect(dataset?.buckets.length).toBe(7);
    expect(Object.keys(dataset?.snapshots || {}).length).toBe(2);
  });

  it("builds collections plan and generates valid Excel workbook", async () => {
    // 1. Fetch loans from 2025-06-30
    const { data: snap } = await supabase
      .from("portfolio_snapshots")
      .select("id")
      .eq("snapshot_date", "2025-06-30")
      .single();

    const { data: dbLoans } = await supabase
      .from("portfolio_loans")
      .select("*")
      .eq("snapshot_id", snap!.id);

    const enriched = (dbLoans || []).map((l) =>
      enrichLoan({
        ...((l.raw as Record<string, string>) || {}),
        "Loan Id": l.source_loan_id,
        "Loan #": l.loan_number || "",
        "Full Name": l.full_name || "",
        "Borrower Mobile": l.borrower_mobile || "",
        "Loan Product": l.product || "",
        "Balance Amount": String(l.balance),
        "Days Past Due": String(l.dpd_loandisk),
        "Past Due": String(l.past_due ?? ""),
        "Pending Due": String(l.pending_due ?? ""),
        "Last Payment Date": l.last_payment_date || "",
        "Préstamo Garantizado": l.pg || "No",
      }),
    );

    const { plan, resumen } = buildCollectionsPlan({
      loans: enriched,
      asOfDate: "2025-06-30",
    });

    expect(resumen.abiertos).toBe(7);
    expect(plan.length).toBeGreaterThan(0);
    expect(resumen.castigo_excl).toBe(1); // 1005 Roberto Gomez

    // 2. Generate Excel workbook
    const buffer = await generateCollectionsWorkbook(plan, resumen, "2025-06-30");
    expect(buffer).toBeDefined();
    expect(buffer.length).toBeGreaterThan(5000);
  });
});
