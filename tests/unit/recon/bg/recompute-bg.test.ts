// Unit test for recomputeBgAccount in lib/recon/bg/recompute.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { recomputeBgAccount } from "@/lib/recon/bg/recompute";
import { loadBgSamples } from "./fixtures/load-samples";

describe("recomputeBgAccount", () => {
  const loaded = loadBgSamples();
  const accountId = "00000000-0000-0000-0000-000000000001";

  it("throws if account is not found", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: "Not found" } }),
      }),
    };

    await expect(
      recomputeBgAccount(mockSupabase as unknown as SupabaseClient, accountId),
    ).rejects.toThrow("Bank account 00000000-0000-0000-0000-000000000001 not found");
  });

  it("throws if account is not on bg rail", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: accountId, rail: "bac", account_number: "12345" },
          error: null,
        }),
      }),
    };

    await expect(
      recomputeBgAccount(mockSupabase as unknown as SupabaseClient, accountId),
    ).rejects.toThrow('Bank account 00000000-0000-0000-0000-000000000001 is on rail "bac", expected "bg"');
  });

  it("cleans all BG tables if no uploads remain", async () => {
    const deletedTables: string[] = [];

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "bank_accounts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { id: accountId, rail: "bg", account_number: "03-43-01-106691-6" },
              error: null,
            }),
          };
        }
        if (table === "recon_uploads") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {
          delete: vi.fn(() => {
            deletedTables.push(table);
            return {
              eq: vi.fn().mockResolvedValue({ error: null }),
            };
          }),
        };
      }),
    };

    const result = await recomputeBgAccount(mockSupabase as unknown as SupabaseClient, accountId);

    expect(result.status).toBe("empty");
    expect(result.uploadsProcessed).toBe(0);
    expect(result.snapshot).toBeNull();
    expect(deletedTables).toContain("recon_bg_coverage");
    expect(deletedTables).toContain("recon_bg_batches");
    expect(deletedTables).toContain("recon_bg_ach_items");
    expect(deletedTables).toContain("recon_bg_yappy_batches");
    expect(deletedTables).toContain("recon_transactions");
  });

  it("executes cross-file reconciliation with cached parsed files", async () => {
    const deletedTables: string[] = [];
    const upsertedTransactions: Record<string, unknown>[] = [];

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "bank_accounts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { id: accountId, rail: "bg", account_number: "03-43-01-106691-6" },
              error: null,
            }),
          };
        }
        if (table === "recon_uploads") {
          const uploadsList = [
            {
              id: "up-1",
              original_filename: "statement.xlsx",
              storage_path: `${accountId}/stmt.xlsx`,
              method: "statement_bg_excel",
            },
            {
              id: "up-2",
              original_filename: "ach.xlsx",
              storage_path: `${accountId}/ach.xlsx`,
              method: "ach_detail_bg_excel",
            },
            {
              id: "up-3",
              original_filename: "yappy.xlsx",
              storage_path: `${accountId}/yappy.xlsx`,
              method: "yappy_bg_excel",
            },
          ];

          const builder: Record<string, unknown> = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "up-1" },
              error: null,
            }),
            then: (resolve: (value: { data: typeof uploadsList; error: null }) => void) =>
              resolve({ data: uploadsList, error: null }),
          };
          return builder;
        }
        if (table === "recon_bg_manual_assignments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === "recon_transactions") {
          return {
            delete: vi.fn(() => {
              deletedTables.push(table);
              return { eq: vi.fn().mockResolvedValue({ error: null }) };
            }),
            upsert: vi.fn((rows: Record<string, unknown>[]) => {
              upsertedTransactions.push(...rows);
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {
          delete: vi.fn(() => {
            deletedTables.push(table);
            return { eq: vi.fn().mockResolvedValue({ error: null }) };
          }),
          upsert: vi.fn().mockResolvedValue({ error: null }),
          insert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnThis(),
        };
      }),
    };

    const cachedFiles = [
      {
        filename: "statement.xlsx",
        bytes: new Uint8Array(),
        parsed: loaded.statements[0],
      },
      {
        filename: "ach.xlsx",
        bytes: new Uint8Array(),
        parsed: loaded.achDetails[0],
      },
      {
        filename: "yappy.xlsx",
        bytes: new Uint8Array(),
        parsed: loaded.yappyReports[0],
      },
    ];

    const result = await recomputeBgAccount(
      mockSupabase as unknown as SupabaseClient,
      accountId,
      { cachedFiles, storageClient: mockSupabase as unknown as SupabaseClient },
    );

    expect(result.status).toBe("ok");
    expect(result.uploadsProcessed).toBe(3);
    expect(result.snapshot).not.toBeNull();
    expect(deletedTables).toContain("recon_transactions");
    expect(upsertedTransactions.length).toBeGreaterThan(0);

    // Verify all upserted transactions have canonical |bg_ row_hash
    for (const txn of upsertedTransactions) {
      expect(String(txn.row_hash)).toContain("|bg_");
    }
  });
});
