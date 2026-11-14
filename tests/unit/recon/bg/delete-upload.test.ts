import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireReconWriterMock,
  createSupabaseServerClientMock,
  createSupabaseServiceClientMock,
  recomputeBgAccountMock,
  revalidatePathMock,
} = vi.hoisted(() => ({
  requireReconWriterMock: vi.fn(),
  createSupabaseServerClientMock: vi.fn(),
  createSupabaseServiceClientMock: vi.fn(),
  recomputeBgAccountMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("@/lib/auth/guard", () => ({
  requireReconWriter: requireReconWriterMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: createSupabaseServerClientMock,
  createSupabaseServiceClient: createSupabaseServiceClientMock,
}));

vi.mock("@/lib/recon/bg/recompute", () => ({
  recomputeBgAccount: recomputeBgAccountMock,
}));

import { deleteUpload } from "@/app/recon/upload/actions";

describe("deleteUpload · Banco General", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireReconWriterMock.mockResolvedValue({ userId: "user-1" });
  });

  it("cleans up recon_links, recon_transactions, and recon_ach_batch_lines before deleting recon_uploads", async () => {
    const operations: string[] = [];
    const removeStorageMock = vi.fn().mockResolvedValue({ error: null });

    createSupabaseServiceClientMock.mockReturnValue({
      storage: {
        from: vi.fn(() => ({
          remove: removeStorageMock,
        })),
      },
    });

    const invokeMock = vi.fn().mockResolvedValue({
      data: null,
      error: new Error("edge function unavailable"),
    });
    recomputeBgAccountMock.mockResolvedValue({
      status: "ok",
      uploadsProcessed: 1,
      snapshot: null,
    });

    const mockSupabase = {
      functions: {
        invoke: invokeMock,
      },
      from: vi.fn((table: string) => {
        if (table === "recon_uploads") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((col: string, val: string) => {
              if (operations.includes("delete_upload_pending")) {
                operations.push(`delete:recon_uploads:${col}=${val}`);
                return Promise.resolve({ error: null });
              }
              return {
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: "upload-yappy-1",
                    account_id: "acct-bg-1",
                    original_filename: "BG - TRANSACCIONES-YAPPY-20oct-2nov-26.xlsx",
                    storage_path: "acct-bg-1/yappy.xlsx",
                  },
                  error: null,
                }),
              };
            }),
            delete: vi.fn(() => {
              operations.push("delete_upload_pending");
              return {
                eq: vi.fn((col: string, val: string) => {
                  operations.push(`delete:recon_uploads:${col}=${val}`);
                  return Promise.resolve({ error: null });
                }),
              };
            }),
          };
        }

        if (table === "bank_accounts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { id: "acct-bg-1", rail: "bg" },
              error: null,
            }),
          };
        }

        if (table === "recon_transactions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({
              data: [{ id: "txn-1" }, { id: "txn-2" }],
              error: null,
            }),
            delete: vi.fn(() => ({
              eq: vi.fn((col: string, val: string) => {
                operations.push(`delete:recon_transactions:${col}=${val}`);
                return Promise.resolve({ error: null });
              }),
            })),
          };
        }

        if (table === "recon_links") {
          return {
            delete: vi.fn(() => ({
              in: vi.fn((side: string) => ({
                select: vi.fn(() => {
                  operations.push(`delete:recon_links:${side}`);
                  return Promise.resolve({ data: [], error: null });
                }),
              })),
            })),
          };
        }

        if (table === "recon_ach_batch_lines") {
          return {
            delete: vi.fn(() => ({
              eq: vi.fn((col: string, val: string) => {
                operations.push(`delete:recon_ach_batch_lines:${col}=${val}`);
                return Promise.resolve({ error: null });
              }),
            })),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    createSupabaseServerClientMock.mockResolvedValue(mockSupabase);

    const res = await deleteUpload("upload-yappy-1");

    expect(res).toEqual({
      status: "ok",
      rowsDeleted: 2,
      linksDeleted: 0,
    });

    const idxLinks = operations.indexOf("delete:recon_links:pr_txn_id");
    const idxTxns = operations.indexOf("delete:recon_transactions:upload_id=upload-yappy-1");
    const idxAchLines = operations.indexOf("delete:recon_ach_batch_lines:upload_id=upload-yappy-1");
    const idxUpload = operations.indexOf("delete:recon_uploads:id=upload-yappy-1");

    expect(idxLinks).toBeGreaterThanOrEqual(0);
    expect(idxTxns).toBeGreaterThan(idxLinks);
    expect(idxAchLines).toBeGreaterThan(idxTxns);
    expect(idxUpload).toBeGreaterThan(idxAchLines);

    expect(removeStorageMock).toHaveBeenCalledWith(["acct-bg-1/yappy.xlsx"]);
    expect(invokeMock).toHaveBeenCalledWith("bg-recon-recompute", {
      body: { account_id: "acct-bg-1" },
    });
    expect(recomputeBgAccountMock).toHaveBeenCalledTimes(1);
    expect(recomputeBgAccountMock).toHaveBeenCalledWith(mockSupabase, "acct-bg-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/recon/upload");
    expect(revalidatePathMock).toHaveBeenCalledWith("/recon/accounts/acct-bg-1");
  });
});
