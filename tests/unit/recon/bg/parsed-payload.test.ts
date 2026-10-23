import { describe, expect, it, vi } from "vitest";
import {
  deserializeBgParsedFile,
  serializeBgParsedFile,
  type BgDetectedFileResult,
} from "@/lib/recon/bg";
import { recomputeBgAccount } from "@/lib/recon/bg/recompute";

describe("BgParsedFile Serialization & Parity", () => {
  it("serializes and deserializes BgParsedStatement preserving BigInt and Date", () => {
    const original: BgDetectedFileResult = {
      fileType: "statement",
      filename: "statement_test.xlsx",
      layoutTitle: "Movimientos de Cuenta",
      accountNumber: "03-43-01-106691-6",
      companyName: "CREDICLARO, S.A.",
      startDate: "2026-10-01",
      endDate: "2026-10-15",
      downloadedAt: new Date("2026-10-16T14:30:00.000Z"),
      errors: [],
      rows: [
        {
          postedDate: "2026-10-05",
          code: "TRANSF",
          description: "PAGO CLIENTE",
          debitMinor: null,
          creditMinor: 15050n, // $150.50
          balanceMinor: 1000000n, // $10,000.00
          ref1: "REF001",
          ref2: "PRESTAMO 123",
        },
      ],
    };

    const serialized = serializeBgParsedFile(original);
    const revived = deserializeBgParsedFile(serialized);

    expect(revived).toEqual(original);
    expect(typeof (revived as any).rows[0].creditMinor).toBe("bigint");
    expect((revived as any).rows[0].creditMinor).toBe(15050n);
    expect((revived as any).downloadedAt).toBeInstanceOf(Date);
  });

  it("serializes and deserializes BgParsedAchDetail preserving BigInt totals", () => {
    const original: BgDetectedFileResult = {
      fileType: "ach_detail",
      filename: "ach_oct15.xlsx",
      variant: "A",
      batchName: "COBROS QUINCENA",
      batchDateStr: "20261015",
      batchDate: "2026-10-15",
      channel: "BG",
      isDelinquent: false,
      fortnight: 15,
      retryCount: 1,
      effectiveDate: "2026-10-15",
      totalTransactions: 10,
      succeededTransactions: 8,
      rejectedTransactions: 2,
      declaredRejectionsAmountMinor: 10000n,
      declaredTotalAmountMinor: 50000n,
      downloadedAt: new Date("2026-10-15T18:00:00.000Z"),
      rows: [
        {
          routingCode: "01",
          accountNumber: "12345",
          amountMinor: 5000n,
          amount: 50,
          clientId: "8-888-888",
          clientName: "JUAN PEREZ",
          addenda: "CUOTA 1",
          errorCode: "",
          errorDescription: "",
        },
      ],
      rejectedSumMinor: 10000n,
      rejectedSum: 100,
      rejectedRowsCount: 2,
      succeededRowsCount: 8,
      succeededSumMinor: 40000n,
      succeededSum: 400,
      errors: [],
    };

    const serialized = serializeBgParsedFile(original);
    const revived = deserializeBgParsedFile(serialized);

    expect(revived).toEqual(original);
    expect(typeof (revived as any).rejectedSumMinor).toBe("bigint");
    expect((revived as any).rejectedSumMinor).toBe(10000n);
    expect(typeof (revived as any).rows[0].amountMinor).toBe("bigint");
    expect((revived as any).rows[0].amountMinor).toBe(5000n);
  });
});

describe("recomputeBgAccount with cached parsed_payload (0 storage downloads)", () => {
  const accountId = "00000000-0000-0000-0000-000000000002";

  it("loads uploads with parsed_payload directly from DB without calling Storage", async () => {
    const statementParsed: BgDetectedFileResult = {
      fileType: "statement",
      filename: "statement.xlsx",
      layoutTitle: "Movimientos",
      accountNumber: "03-43-01-106691-6",
      companyName: "CREDICLARO, S.A.",
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      downloadedAt: new Date("2026-10-03T10:00:00Z"),
      errors: [],
      rows: [
        {
          postedDate: "2026-10-01",
          code: "DEPOSITO",
          description: "DEPOSITO EN EFECTIVO",
          debitMinor: null,
          creditMinor: 10000n,
          balanceMinor: 10000n,
          ref1: "111",
          ref2: "",
        },
      ],
    };

    const storageDownloadSpy = vi.fn();

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
            order: vi.fn().mockImplementation(() => ({
              limit: vi.fn().mockImplementation(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: "up-001" }, error: null }),
              })),
              then: (resolve: any) =>
                resolve({
                  data: [
                    {
                      id: "up-001",
                      original_filename: "statement.xlsx",
                      storage_path: "storage/path.xlsx",
                      method: "statement_bg_excel",
                      date_range_start: "2026-10-01",
                      date_range_end: "2026-10-02",
                      parsed_payload: serializeBgParsedFile(statementParsed),
                      parser_version: 1,
                    },
                  ],
                  error: null,
                }),
            })),
          };
        }
        if (table === "recon_manual_assignments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        // Purge or sync table calls
        return {
          delete: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ error: null }),
          upsert: vi.fn().mockResolvedValue({ error: null }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        };
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          download: storageDownloadSpy,
        }),
      },
    };

    const res = await recomputeBgAccount(
      mockSupabase as any,
      accountId,
      { storageClient: mockSupabase as any },
    );

    expect(res.status).toBe("ok");
    expect(res.uploadsProcessed).toBe(1);

    // CRITICAL ASSERTION: Storage download was never called because parsed_payload was cached!
    expect(storageDownloadSpy).not.toHaveBeenCalled();
  });
});
