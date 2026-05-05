import { describe, expect, it } from "vitest";

import { parseDAReference, parsePRReference } from "@/lib/recon/bac/references";

describe("parsePRReference", () => {
  it("parses real BAC PR refs (type=62, 5-digit sequence)", () => {
    expect(parsePRReference("6227489")).toEqual({
      raw: "6227489",
      type: 62,
      sequence: 27489,
    });
    expect(parsePRReference("6227519")).toEqual({
      raw: "6227519",
      type: 62,
      sequence: 27519,
    });
    expect(parsePRReference("6227522")).toEqual({
      raw: "6227522",
      type: 62,
      sequence: 27522,
    });
  });

  it("trims whitespace before parsing", () => {
    expect(parsePRReference("  6227489 ")).toEqual({
      raw: "6227489",
      type: 62,
      sequence: 27489,
    });
  });

  it("supports a single-digit type prefix at the minimum length", () => {
    // 6 chars: 1 type digit + 5 sequence digits.
    expect(parsePRReference("612345")).toEqual({
      raw: "612345",
      type: 6,
      sequence: 12345,
    });
  });

  it("rejects empty / null / undefined", () => {
    expect(parsePRReference(null)).toBeNull();
    expect(parsePRReference(undefined)).toBeNull();
    expect(parsePRReference("")).toBeNull();
    expect(parsePRReference("   ")).toBeNull();
  });

  it("rejects non-digit input", () => {
    expect(parsePRReference("62A7489")).toBeNull();
    expect(parsePRReference("REF-6227489")).toBeNull();
  });

  it("rejects refs shorter than 6 digits", () => {
    expect(parsePRReference("12345")).toBeNull(); // exactly 5 → no type left
    expect(parsePRReference("12")).toBeNull();
  });
});

describe("parseDAReference", () => {
  it("parses BG (originBank=7) DA refs", () => {
    expect(parseDAReference("7423348")).toEqual({
      raw: "7423348",
      type: 4,
      originBank: 7,
      sequence: 23348,
    });
    expect(parseDAReference("7423401")).toEqual({
      raw: "7423401",
      type: 4,
      originBank: 7,
      sequence: 23401,
    });
  });

  it("parses St. Georges (originBank=149) DA refs", () => {
    expect(parseDAReference("149423344")).toEqual({
      raw: "149423344",
      type: 4,
      originBank: 149,
      sequence: 23344,
    });
  });

  it("parses Banesco (originBank=158) DA refs", () => {
    expect(parseDAReference("158423346")).toEqual({
      raw: "158423346",
      type: 4,
      originBank: 158,
      sequence: 23346,
    });
    expect(parseDAReference("158429039")).toEqual({
      raw: "158429039",
      type: 4,
      originBank: 158,
      sequence: 29039,
    });
  });

  it("trims whitespace before parsing", () => {
    expect(parseDAReference(" 7423348 ")).toEqual({
      raw: "7423348",
      type: 4,
      originBank: 7,
      sequence: 23348,
    });
  });

  it("rejects empty / null / undefined", () => {
    expect(parseDAReference(null)).toBeNull();
    expect(parseDAReference(undefined)).toBeNull();
    expect(parseDAReference("")).toBeNull();
    expect(parseDAReference("   ")).toBeNull();
  });

  it("rejects non-digit input", () => {
    expect(parseDAReference("7A23348")).toBeNull();
    expect(parseDAReference("DA-7423348")).toBeNull();
  });

  it("rejects refs shorter than 7 digits", () => {
    // Need at least 1 bank digit + 1 type digit + 5 sequence digits.
    expect(parseDAReference("423348")).toBeNull();
    expect(parseDAReference("12345")).toBeNull();
  });
});
