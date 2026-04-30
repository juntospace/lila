import { describe, expect, it } from "vitest";

import { rangeIntersection, rangeMinus, rangeOrNull } from "@/lib/recon/bac/ingest";

describe("rangeOrNull", () => {
  it("returns the range when both ends are non-empty", () => {
    expect(rangeOrNull("2026-04-05", "2026-04-07")).toEqual({
      start: "2026-04-05",
      end: "2026-04-07",
    });
  });
  it("returns null when either end is empty", () => {
    expect(rangeOrNull("", "2026-04-07")).toBeNull();
    expect(rangeOrNull("2026-04-05", "")).toBeNull();
  });
});

describe("rangeIntersection", () => {
  it("returns null when the prior range is missing", () => {
    expect(rangeIntersection("2026-04-05", "2026-04-07", null, null)).toBeNull();
  });

  it("returns null on disjoint ranges", () => {
    expect(rangeIntersection("2026-04-08", "2026-04-09", "2026-04-05", "2026-04-07")).toBeNull();
  });

  it("returns the overlapping window when ranges intersect", () => {
    expect(
      rangeIntersection("2026-04-06", "2026-04-08", "2026-04-05", "2026-04-07"),
    ).toEqual({ start: "2026-04-06", end: "2026-04-07" });
  });

  it("treats touching ranges as a 1-day overlap", () => {
    expect(
      rangeIntersection("2026-04-07", "2026-04-09", "2026-04-05", "2026-04-07"),
    ).toEqual({ start: "2026-04-07", end: "2026-04-07" });
  });
});

describe("rangeMinus", () => {
  it("returns the full range when no carve is present", () => {
    expect(rangeMinus("2026-04-05", "2026-04-07", null)).toEqual({
      start: "2026-04-05",
      end: "2026-04-07",
    });
  });

  it("returns null when the carve fully covers the range", () => {
    expect(
      rangeMinus("2026-04-05", "2026-04-07", { start: "2026-04-05", end: "2026-04-07" }),
    ).toBeNull();
  });

  it("trims a prefix carve, leaving the tail", () => {
    expect(
      rangeMinus("2026-04-05", "2026-04-09", { start: "2026-04-05", end: "2026-04-07" }),
    ).toEqual({ start: "2026-04-08", end: "2026-04-09" });
  });

  it("trims a suffix carve, leaving the head", () => {
    expect(
      rangeMinus("2026-04-05", "2026-04-09", { start: "2026-04-07", end: "2026-04-09" }),
    ).toEqual({ start: "2026-04-05", end: "2026-04-06" });
  });
});
