// End-to-end integration test for BG recompute engine and duplicate protection.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { recomputeBgAccount } from "@/lib/recon/bg/recompute";

const URL = process.env.LILA_TEST_SUPABASE_URL || "http://127.0.0.1:54321";
const KEY =
  process.env.LILA_TEST_SUPABASE_SERVICE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

describe("recomputeBgAccount integration", () => {
  const supabase = createClient(URL, KEY);

  it("recomputes Crediclaro account from active storage files with zero duplicated transfers", async () => {
    // 1. Fetch BG account
    const { data: accounts } = await supabase
      .from("bank_accounts")
      .select("id, account_number")
      .eq("account_number", "03-43-01-106691-6");

    const account = accounts?.[0];
    expect(account).toBeDefined();
    if (!account) return;

    // 2. Run recomputeBgAccount
    const result = await recomputeBgAccount(supabase, account.id, {
      storageClient: supabase,
    });

    expect(result.status).toBe("ok");
    expect(result.uploadsProcessed).toBeGreaterThan(0);
    expect(result.snapshot).not.toBeNull();

    // 3. Check recon_transactions in database for Sept 14-15
    const { data: txns, error } = await supabase
      .from("recon_transactions")
      .select("posted_at, credit_minor, code, description, state, kind, row_hash")
      .eq("account_id", account.id)
      .gte("posted_at", "2026-09-14")
      .lte("posted_at", "2026-09-15");

    expect(error).toBeNull();
    expect(txns).toBeDefined();

    const confirmed = (txns || []).filter((t) => t.state === "confirmed");
    const sumConfirmed =
      confirmed.reduce((s, t) => s + Number(t.credit_minor), 0) / 100;

    // Must be exactly 67 confirmed transactions (66 transfers + 1 Yappy deposit), NOT 133
    expect(confirmed.length).toBe(67);
    expect(Math.abs(sumConfirmed - 3393.25)).toBeLessThan(0.01);

    // Verify zero legacy SHA256 row_hashes exist
    const legacyRows = (txns || []).filter((t) => !t.row_hash.includes("|bg_"));
    expect(legacyRows.length).toBe(0);

    // Verify DEPOSITO_YAPPY is present
    const yappyTxn = confirmed.find((t) => t.code === "DEPOSITO_YAPPY");
    expect(yappyTxn).toBeDefined();
    expect(Number(yappyTxn?.credit_minor)).toBe(7882);
  });
});

