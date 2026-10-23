import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  recomputeAccount,
  subtractWorkingDays,
} from "@/lib/recon/bac/recompute";

describe("subtractWorkingDays", () => {
  it("subtracts 1 day across normal weekdays", () => {
    expect(subtractWorkingDays("2026-10-22", 1)).toBe("2026-10-21"); // Thu -> Wed
    expect(subtractWorkingDays("2026-10-21", 1)).toBe("2026-10-20"); // Wed -> Tue
    expect(subtractWorkingDays("2026-10-20", 1)).toBe("2026-10-19"); // Tue -> Mon
  });

  it("skips weekends when subtracting across Sunday/Monday", () => {
    expect(subtractWorkingDays("2026-10-19", 1)).toBe("2026-10-16"); // Mon -> Fri
    expect(subtractWorkingDays("2026-10-18", 1)).toBe("2026-10-16"); // Sun -> Fri
    expect(subtractWorkingDays("2026-10-17", 1)).toBe("2026-10-16"); // Sat -> Fri
  });

  it("correctly subtracts 15 working days (3 full business weeks)", () => {
    // 2026-10-22 is Thursday
    // Week 1: 10-21(W), 10-20(Tu), 10-19(M), 10-16(F), 10-15(Th) -> 5 days
    // Week 2: 10-14(W), 10-13(Tu), 10-12(M), 10-09(F), 10-08(Th) -> 10 days
    // Week 3: 10-07(W), 10-06(Tu), 10-05(M), 10-02(F), 10-01(Th) -> 15 days
    expect(subtractWorkingDays("2026-10-22", 15)).toBe("2026-10-01");
  });
});

describe("recomputeAccount Active Sliding Window", () => {
  const accountId = "00000000-0000-0000-0000-000000000001";

  function createMockSupabase(options?: {
    maxPostedAt?: string;
    links?: any[];
    prs?: any[];
    das?: any[];
    priorConfirmedPrs?: number;
    priorRejectedPrs?: number;
    priorRejectedDas?: number;
  }) {
    const rpcCalls: { fn: string; params: any }[] = [];
    const queries: { table: string; filters: Record<string, any> }[] = [];

    const mockClient = {
      rpc: vi.fn(async (fn: string, params: any) => {
        rpcCalls.push({ fn, params });
        if (fn === "recon_wipe_auto_links") return { data: 5, error: null };
        if (fn === "recon_bulk_update_states") return { data: 1, error: null };
        return { data: null, error: null };
      }),
      from: vi.fn((table: string) => {
        const filterState: Record<string, any> = {};

        const chain: any = {
          select: vi.fn((_cols: string, opts?: any) => {
            if (opts?.head && opts?.count === "exact") {
              filterState.headCount = true;
            }
            return chain;
          }),
          eq: vi.fn((col: string, val: any) => {
            filterState[col] = val;
            return chain;
          }),
          gte: vi.fn((col: string, val: any) => {
            filterState[`gte_${col}`] = val;
            return chain;
          }),
          lt: vi.fn((col: string, val: any) => {
            filterState[`lt_${col}`] = val;
            return chain;
          }),
          or: vi.fn((expr: string) => {
            filterState.or = expr;
            return chain;
          }),
          order: vi.fn((col: string, _opts?: any) => {
            filterState.orderBy = col;
            return chain;
          }),
          limit: vi.fn((lim: number) => {
            filterState.limit = lim;
            return chain;
          }),
          range: vi.fn((start: number, end: number) => {
            filterState.range = [start, end];
            queries.push({ table, filters: { ...filterState } });

            if (table === "name_aliases") {
              return Promise.resolve({ data: [], error: null });
            }
            if (table === "recon_links") {
              const defaultLinks = [
                {
                  pr_txn_id: "pr-001",
                  da_txn_id: "da-001",
                  match_strategy: "auto_batch_link",
                },
              ];
              return Promise.resolve({ data: options?.links ?? defaultLinks, error: null });
            }
            if (table === "recon_transactions") {
              if (filterState.code === "PR") {
                return Promise.resolve({ data: options?.prs ?? [], error: null });
              }
              if (filterState.code === "DA") {
                return Promise.resolve({ data: options?.das ?? [], error: null });
              }
            }
            if (table === "recon_manual_actions") {
              return Promise.resolve({ data: [], error: null });
            }
            return Promise.resolve({ data: [], error: null });
          }),
          maybeSingle: vi.fn(async () => {
            queries.push({ table, filters: { ...filterState } });
            if (table === "recon_transactions" && filterState.orderBy === "posted_at") {
              return { data: { posted_at: options?.maxPostedAt ?? "2026-10-22" }, error: null };
            }
            if (table === "recon_uploads") {
              return {
                data: {
                  statement_downloaded_at: "2026-10-22T21:00:00Z",
                  saldo_diferido_minor: 0,
                  date_range_end: options?.maxPostedAt ?? "2026-10-22",
                },
                error: null,
              };
            }
            return { data: null, error: null };
          }),
          insert: vi.fn(() => ({
            select: vi.fn().mockResolvedValue({ data: [], error: null }),
          })),
          delete: vi.fn(() => chain),
          update: vi.fn(() => chain),
          in: vi.fn(() => Promise.resolve({ data: [], error: null })),
          then: (resolve: any) => {
            queries.push({ table, filters: { ...filterState } });
            if (filterState.headCount) {
              if (table === "recon_transactions") {
                if (filterState.code === "PR" && filterState.state === "confirmed") {
                  return resolve({ count: options?.priorConfirmedPrs ?? 1200, error: null });
                }
                if (filterState.code === "PR" && filterState.state === "rejected") {
                  return resolve({ count: options?.priorRejectedPrs ?? 50, error: null });
                }
                if (filterState.code === "DA" && filterState.state === "rejected") {
                  return resolve({ count: options?.priorRejectedDas ?? 50, error: null });
                }
                return resolve({ count: 1300, error: null });
              }
            }
            return resolve({ data: [], error: null });
          },
        };

        return chain;
      }),
    };

    return { mockClient: mockClient as unknown as SupabaseClient, rpcCalls, queries };
  }

  it("defaults to 15 working days sliding window and scopes wipes and queries", async () => {
    const { mockClient, rpcCalls, queries } = createMockSupabase({
      maxPostedAt: "2026-10-22",
      priorConfirmedPrs: 1500,
      priorRejectedPrs: 60,
      priorRejectedDas: 60,
    });

    const stats = await recomputeAccount(mockClient, accountId, null);

    // 1. Verify RPC wipeAutoLinks called with 15 working days ago (2026-10-01)
    const wipeRpc = rpcCalls.find((c) => c.fn === "recon_wipe_auto_links");
    expect(wipeRpc).toBeDefined();
    expect(wipeRpc?.params.p_since_date).toBe("2026-10-01");
    expect(wipeRpc?.params.p_account_id).toBe(accountId);

    // 2. Verify recon_transactions queries applied .or() window filter
    const prQueries = queries.filter(
      (q) => q.table === "recon_transactions" && q.filters.code === "PR" && q.filters.or,
    );
    expect(prQueries.length).toBeGreaterThan(0);
    expect(prQueries[0].filters.or).toBe(
      "posted_at.gte.2026-10-01,state.in.(pending,pending_pair)",
    );

    // 3. Verify total stats include historical counts
    expect(stats.prsConfirmed).toBe(1500);
    expect(stats.prsRejected).toBe(60);
    expect(stats.daRejected).toBe(60);
  });

  it("respects fullLifetime: true by wiping all auto links without date boundary", async () => {
    const { mockClient, rpcCalls, queries } = createMockSupabase({
      maxPostedAt: "2026-10-22",
    });

    await recomputeAccount(mockClient, accountId, null, { fullLifetime: true });

    // 1. Verify RPC wipeAutoLinks called with p_since_date = null
    const wipeRpc = rpcCalls.find((c) => c.fn === "recon_wipe_auto_links");
    expect(wipeRpc).toBeDefined();
    expect(wipeRpc?.params.p_since_date).toBeNull();

    // 2. Verify queries did NOT apply .or() date window
    const windowedQueries = queries.filter(
      (q) => q.table === "recon_transactions" && q.filters.or,
    );
    expect(windowedQueries.length).toBe(0);
  });

  it("respects custom fromDate option", async () => {
    const { mockClient, rpcCalls, queries } = createMockSupabase({
      maxPostedAt: "2026-10-22",
    });

    await recomputeAccount(mockClient, accountId, null, { fromDate: "2026-10-10" });

    // 1. Verify wipeAutoLinks called with fromDate
    const wipeRpc = rpcCalls.find((c) => c.fn === "recon_wipe_auto_links");
    expect(wipeRpc?.params.p_since_date).toBe("2026-10-10");

    // 2. Verify transactions query bounded by 2026-10-10
    const prQueries = queries.filter(
      (q) => q.table === "recon_transactions" && q.filters.code === "PR" && q.filters.or,
    );
    expect(prQueries[0].filters.or).toBe(
      "posted_at.gte.2026-10-10,state.in.(pending,pending_pair)",
    );
  });
});
