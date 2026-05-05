import { describe, expect, it } from "vitest";

import {
  formatDate,
  formatMinorUSD,
  lastWorkingDays,
  previousWorkingDay,
} from "@/lib/recon/format";

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

describe("previousWorkingDay", () => {
  it("Tue → Mon", () => {
    expect(previousWorkingDay("2026-04-07")).toBe("2026-04-06");
  });

  it("Mon → previous Fri (skips weekend)", () => {
    expect(previousWorkingDay("2026-04-06")).toBe("2026-04-03");
  });

  it("Sun → previous Fri", () => {
    expect(previousWorkingDay("2026-04-05")).toBe("2026-04-03");
  });

  it("Sat → previous Fri", () => {
    expect(previousWorkingDay("2026-04-04")).toBe("2026-04-03");
  });

  it("crosses month boundary", () => {
    // 2026-05-01 is a Friday → previous working day is Thu Apr 30.
    expect(previousWorkingDay("2026-05-01")).toBe("2026-04-30");
  });

  it("crosses month boundary over a weekend", () => {
    // 2026-06-01 is a Monday → previous working day is Fri May 29.
    expect(previousWorkingDay("2026-06-01")).toBe("2026-05-29");
  });

  it("throws on invalid ISO", () => {
    expect(() => previousWorkingDay("not-a-date")).toThrow();
  });
});
