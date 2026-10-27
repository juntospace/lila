import { describe, expect, it, vi } from "vitest";

import { fetchAll } from "@/lib/portfolio/fetch-all";

describe("fetchAll pagination helper", () => {
  it("returns immediately when results are less than pageSize", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      data: [{ id: 1 }, { id: 2 }],
      error: null,
    });

    const results = await fetchAll<{ id: number }>(mockQuery, 10);

    expect(results).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(0, 9);
  });

  it("fetches remaining pages concurrently when count is present", async () => {
    const totalItems = 35;
    const pageSize = 10;
    const allData = Array.from({ length: totalItems }, (_, i) => ({ id: i }));

    const mockQuery = vi.fn().mockImplementation((from: number, to: number) => {
      const slice = allData.slice(from, to + 1);
      return Promise.resolve({
        data: slice,
        count: totalItems,
        error: null,
      });
    });

    const results = await fetchAll<{ id: number }>(mockQuery, pageSize, 4);

    expect(results).toHaveLength(totalItems);
    expect(results[0].id).toBe(0);
    expect(results[34].id).toBe(34);
    // Page 0: (0, 9), Page 1: (10, 19), Page 2: (20, 29), Page 3: (30, 34)
    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(mockQuery).toHaveBeenNthCalledWith(1, 0, 9);
  });

  it("falls back to sequential loop when count is not provided", async () => {
    const totalItems = 25;
    const pageSize = 10;
    const allData = Array.from({ length: totalItems }, (_, i) => ({ id: i }));

    const mockQuery = vi.fn().mockImplementation((from: number, to: number) => {
      const slice = allData.slice(from, to + 1);
      return Promise.resolve({
        data: slice,
        count: undefined,
        error: null,
      });
    });

    const results = await fetchAll<{ id: number }>(mockQuery, pageSize);

    expect(results).toHaveLength(totalItems);
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery).toHaveBeenNthCalledWith(1, 0, 9);
    expect(mockQuery).toHaveBeenNthCalledWith(2, 10, 19);
    expect(mockQuery).toHaveBeenNthCalledWith(3, 20, 29);
  });

  it("throws when query returns error", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Database timeout" },
    });

    await expect(fetchAll(mockQuery, 10)).rejects.toThrow(
      "Supabase paginated query failed: Database timeout",
    );
  });
});

