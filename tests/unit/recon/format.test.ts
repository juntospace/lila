import { describe, expect, it } from "vitest";

import { formatDate, formatMinorUSD, lastWorkingDays } from "@/lib/recon/format";

describe("formatMinorUSD", () => {
  it("formats positive bigint cents", () => {
    expect(formatMinorUSD(0n)).toBe("$0.00");
    expect(formatMinorUSD(5050n)).toBe("$50.50");
    expect(formatMinorUSD(123456n)).toBe("$1,234.56");
  });

  it("formats negative cents", () => {
    expect(formatMinorUSD(-5050n)).toBe("-$50.50");
  });

  it("accepts string and number inputs", () => {
    expect(formatMinorUSD("5050")).toBe("$50.50");
    expect(formatMinorUSD(5050)).toBe("$50.50");
  });
});

describe("formatDate", () => {
  it("converts ISO to DD/MM/YYYY", () => {
    expect(formatDate("2026-04-07")).toBe("07/04/2026");
  });
  it("handles null / empty", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
  });
});

describe("lastWorkingDays", () => {
  it("ref=Tuesday, n=2 → Mon–Tue", () => {
    expect(lastWorkingDays(new Date("2026-04-07T00:00:00Z"), 2)).toEqual({
      from: "2026-04-06",
      to: "2026-04-07",
    });
  });

  it("ref=Sunday skips back to Thu–Fri", () => {
    expect(lastWorkingDays(new Date("2026-04-05T00:00:00Z"), 2)).toEqual({
      from: "2026-04-02",
      to: "2026-04-03",
    });
  });

  it("ref=Monday, n=2 → previous Fri + Mon", () => {
    expect(lastWorkingDays(new Date("2026-04-06T00:00:00Z"), 2)).toEqual({
      from: "2026-04-03",
      to: "2026-04-06",
    });
  });

  it("supports n=1", () => {
    expect(lastWorkingDays(new Date("2026-04-07T00:00:00Z"), 1)).toEqual({
      from: "2026-04-07",
      to: "2026-04-07",
    });
  });
});
