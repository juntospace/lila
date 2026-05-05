// End-to-end integration test for the BAC ingest pipeline.
//
// Hits a real Supabase project via service-role key, wipes recon tables for
// a dedicated test account, ingests a synthetic statement, then asserts the
// resulting rows + reconciliation state.
//
// Skipped unless the following env vars are set — keep CI green when no test
// project is provisioned:
//   LILA_TEST_SUPABASE_URL
//   LILA_TEST_SUPABASE_SERVICE_KEY
//
// To run locally:
//   LILA_TEST_SUPABASE_URL=http://localhost:54321 \
//   LILA_TEST_SUPABASE_SERVICE_KEY=$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2) \
//   pnpm vitest run tests/integration

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ingestBACFile, parseBACSheet, type BACParseResult } from "@/lib/recon/bac";

const URL = process.env.LILA_TEST_SUPABASE_URL;
const KEY = process.env.LILA_TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && KEY);

const TEST_ACCOUNT_NUMBER = `INTG-${Date.now()}`;
const TEST_HOLDER = "Integration Test Account";

// Minimal three-row fixture: one PR (will pair with the DA via batch
// linking), one 4C (irrevocable), one DA (DVTO that pairs back to the PR).
//
// Saldo arithmetic (so integrity check passes):
//   1000.00 + 50.50 (PR) + 200.00 (4C) - 50.50 (DA) = 1200.00
//
// References use BAC's actual digit-only shape so groupPRBatches and
// groupDABatches can parse them. Dates are picked so PR and DA fall in
// the batch window: PR on Mon 06/04, DA on Tue 07/04 (DA.day's previous
// working day == PR.day).
const fixtureSheet = (): unknown[][] => [
  ["Estado de Cuenta"],
  ["Cliente", TEST_HOLDER],
  ["Cuenta", TEST_ACCOUNT_NUMBER],
  ["Moneda", "USD"],
  ["Período", "06/04/2026 - 07/04/2026"],
  ["Saldo Inicial", "1,000.00"],
  ["Saldo Final", "1,200.00"],
  [],
  ["Fecha", "Referencia", null, "Código", "Descripción", null, "Débitos", "Créditos", "Balance"],
  ["06/04/2026", "6227489", null, "PR", "Tef DCD de Jorge Miguel Diaz P", null, "", "50.50", "1,050.50"],
  ["06/04/2026", "6227490", null, "4C", "ACH CRE Maria Lopez", null, "", "200.00", "1,250.50"],
  ["07/04/2026", "7423344", null, "DA", "DVTO AM04-JORGE MIGUEL DIAZ P", null, "50.50", "", "1,200.00"],
];

describe.skipIf(!enabled)("BAC ingest integration", () => {
  let supabase: SupabaseClient;
  let accountId: string;
  const fileBytes = new TextEncoder().encode("synthetic-bac-fixture-v1");

  beforeAll(async () => {
    supabase = createClient(URL!, KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Provision a fresh bank account for this run; account_number includes
    // a timestamp so concurrent runs don't collide.
    const { data, error } = await supabase
      .from("bank_accounts")
      .insert({
        rail: "bac",
        account_number: TEST_ACCOUNT_NUMBER,
        holder_name: TEST_HOLDER,
        currency: "USD",
      })
      .select("id")
      .single();
    if (error) throw error;
    accountId = data.id;
  });

  afterAll(async () => {
    if (!accountId) return;
    // Tear down everything we created. Order matters because of FK
    // constraints (links → transactions → uploads → account).
    await supabase.from("recon_links").delete().in(
      "pr_txn_id",
      (
        await supabase
          .from("recon_transactions")
          .select("id")
          .eq("account_id", accountId)
      ).data?.map((r) => r.id) ?? [],
    );
    await supabase.from("recon_transactions").delete().eq("account_id", accountId);
    await supabase.from("recon_uploads").delete().eq("account_id", accountId);
    await supabase.from("bank_accounts").delete().eq("id", accountId);
  });

  it("ingests a fresh file: rows landed, reversal paired, PR rejected", async () => {
    const parseResult: BACParseResult = parseBACSheet(fixtureSheet());
    expect(parseResult.integrity.ok).toBe(true);

    const result = await ingestBACFile({
      supabase,
      accountId,
      fileBytes,
      originalFilename: "intg-day1.xlsx",
      parseResult,
    });

    expect(result.fileWasDuplicate).toBe(false);
    expect(result.rowsTotal).toBe(3);
    expect(result.rowsNew).toBe(3);
    expect(result.rowsDuplicate).toBe(0);
    expect(result.reversalsPaired).toBe(1);
    expect(result.reversalsUnpaired).toBe(0);

    // The only PR was paired-and-rejected, not aged-out-confirmed.
    expect(result.prsConfirmedThisRun).toBe(0);

    const { data: txns } = await supabase
      .from("recon_transactions")
      .select("code, state")
      .eq("account_id", accountId);
    const byCode = Object.fromEntries(
      ["PR", "4C", "DA"].map((c) => [c, txns?.find((t) => t.code === c)?.state]),
    );
    expect(byCode).toEqual({ PR: "rejected", "4C": "confirmed", DA: "rejected" });

    const { data: links } = await supabase
      .from("recon_links")
      .select("match_strategy")
      .order("matched_at", { ascending: false })
      .limit(1);
    expect(links?.[0]?.match_strategy).toBe("auto_batch_link");
  });

  it("re-ingesting the same bytes is a no-op (file dedup)", async () => {
    const parseResult = parseBACSheet(fixtureSheet());
    const result = await ingestBACFile({
      supabase,
      accountId,
      fileBytes,
      originalFilename: "intg-day1-resent.xlsx",
      parseResult,
    });
    expect(result.fileWasDuplicate).toBe(true);
    expect(result.rowsNew).toBe(0);
  });

  it("a different file with overlapping rows dedups at the row level", async () => {
    // Same data, but flip the saldo final to make integrity warn — the file
    // bytes differ, so file-level dedup doesn't trigger and we exercise the
    // row-level (account_id, row_hash) UNIQUE.
    const variant = fixtureSheet();
    variant[6] = ["Saldo Final", "1,200.01"]; // off by one cent
    const parseResult = parseBACSheet(variant);

    const result = await ingestBACFile({
      supabase,
      accountId,
      fileBytes: new TextEncoder().encode("synthetic-bac-fixture-v2"),
      originalFilename: "intg-day1-tweaked.xlsx",
      parseResult,
    });

    expect(result.fileWasDuplicate).toBe(false);
    expect(result.rowsTotal).toBe(3);
    expect(result.rowsNew).toBe(0);
    expect(result.rowsDuplicate).toBe(3);
  });
});
