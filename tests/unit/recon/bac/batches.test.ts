import { describe, expect, it } from "vitest";

import {
  groupDABatches,
  groupPRBatches,
  linkAllBatches,
  tryLinkDABatch,
  type DARowForBatch,
  type LinkOptions,
  type PRRowForBatch,
} from "@/lib/recon/bac/batches";

// =============================================================
// Test helpers
// =============================================================

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const nameMatcher = (a: string, b: string) =>
  a === b || a.startsWith(b) || b.startsWith(a);

/**
 * BAC PR descriptions in the wild look like
 *   "DEBITO DIRECTO  PAGO LILA            JUAN PEREZ          ..."
 * and the operator/parser pulls the payer-name section. For tests we
 * use a deterministic prefix the fixture controls.
 */
const extractPRPayer = (description: string) => {
  const m = description.match(/^PAYER:\s*(.+?)\s*$/);
  return m ? m[1] : null;
};

/**
 * Test working-day arithmetic that handles the dates we use in fixtures.
 * Matches lib/recon/format.ts#previousWorkingDay's contract.
 */
const previousWorkingDay = (iso: string): string => {
  const t = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(t)) throw new Error(`bad iso ${iso}`);
  const cursor = new Date(t);
  do {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return cursor.toISOString().slice(0, 10);
};

const opts: LinkOptions = {
  nameMatcher,
  normalize,
  extractPRPayer,
  previousWorkingDay,
};

function pr(
  id: string,
  reference: string,
  amountMinor: bigint,
  payer: string,
  posted_at = "2026-04-06",
): PRRowForBatch {
  return {
    id,
    posted_at,
    reference,
    amountMinor,
    description: `PAYER: ${payer}`,
  };
}

function da(
  id: string,
  reference: string,
  amountMinor: bigint,
  payerNameRaw: string | null,
  posted_at = "2026-04-07",
): DARowForBatch {
  return {
    id,
    posted_at,
    reference,
    amountMinor,
    payerNameRaw,
  };
}

// =============================================================
// groupPRBatches
// =============================================================

describe("groupPRBatches", () => {
  it("groups rows by Referencia and orders by sequence ascending", () => {
    const rows = [
      pr("p1", "6227522", 10000n, "ALICE"),
      pr("p2", "6227489", 5000n, "BOB"),
      pr("p3", "6227519", 7500n, "CAROL"),
      pr("p4", "6227489", 3500n, "DAVE"), // shares ref with p2
    ];
    const batches = groupPRBatches(rows);
    expect(batches.map((b) => b.reference)).toEqual([
      "6227489",
      "6227519",
      "6227522",
    ]);
    expect(batches[0].rows.map((r) => r.id).sort()).toEqual(["p2", "p4"]);
    expect(batches[0].type).toBe(62);
    expect(batches[0].sequence).toBe(27489);
  });

  it("uses the earliest posted_at among rows in the same batch", () => {
    const rows = [
      pr("a", "6227489", 1000n, "X", "2026-04-07"),
      pr("b", "6227489", 1000n, "Y", "2026-04-06"),
    ];
    const [batch] = groupPRBatches(rows);
    expect(batch.posted_at).toBe("2026-04-06");
  });

  it("skips rows with unparseable references", () => {
    const rows = [
      pr("ok", "6227489", 1000n, "X"),
      pr("bad", "REF-X", 1000n, "Y"),
      pr("short", "12345", 1000n, "Z"),
    ];
    const batches = groupPRBatches(rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].rows.map((r) => r.id)).toEqual(["ok"]);
  });

  it("returns empty array for empty input", () => {
    expect(groupPRBatches([])).toEqual([]);
  });
});

// =============================================================
// groupDABatches
// =============================================================

describe("groupDABatches", () => {
  it("opens a new batch on a sequence gap", () => {
    const rows = [
      da("d1", "7423344", 1000n, "X", "2026-04-07"),
      da("d2", "7423345", 2000n, "Y", "2026-04-07"),
      da("d3", "7423346", 3000n, "Z", "2026-04-07"),
      // gap → new batch
      da("d4", "7423350", 4000n, "A", "2026-04-07"),
      da("d5", "7423351", 5000n, "B", "2026-04-07"),
    ];
    const batches = groupDABatches(rows);
    expect(batches).toHaveLength(2);
    expect(batches[0].id).toBe("4-23344-23346");
    expect(batches[0].rows.map((r) => r.id)).toEqual(["d1", "d2", "d3"]);
    expect(batches[1].id).toBe("4-23350-23351");
  });

  it("keeps a single contiguous run together when origin-bank prefix changes", () => {
    const rows = [
      da("d1", "149423344", 1000n, "X"),
      da("d2", "149423345", 2000n, "Y"),
      da("d3", "158423346", 3000n, "Z"),
      da("d4", "7423347", 4000n, "A"),
    ];
    const batches = groupDABatches(rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].startSequence).toBe(23344);
    expect(batches[0].endSequence).toBe(23347);
    expect(batches[0].rows).toHaveLength(4);
  });

  it("closes a batch when type prefix changes even if sequence is consecutive", () => {
    const rows = [
      da("d1", "7423344", 1000n, "X"), // type=4
      da("d2", "7523345", 2000n, "Y"), // type=5 — defensive: treat as new batch
    ];
    const batches = groupDABatches(rows);
    expect(batches).toHaveLength(2);
  });

  it("sorts input by sequence before batching", () => {
    const rows = [
      da("d3", "7423346", 3000n, "Z"),
      da("d1", "7423344", 1000n, "X"),
      da("d2", "7423345", 2000n, "Y"),
    ];
    const batches = groupDABatches(rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].rows.map((r) => r.id)).toEqual(["d1", "d2", "d3"]);
  });

  it("uses the earliest posted_at among rows in the batch", () => {
    const rows = [
      da("d1", "7423344", 1000n, "X", "2026-04-07"),
      da("d2", "7423345", 2000n, "Y", "2026-04-06"), // earliest
      da("d3", "7423346", 3000n, "Z", "2026-04-07"),
    ];
    const [batch] = groupDABatches(rows);
    expect(batch.posted_at).toBe("2026-04-06");
  });

  it("skips unparseable references", () => {
    const rows = [
      da("d1", "7423344", 1000n, "X"),
      da("bad", "ABC", 1000n, "Y"),
      da("d2", "7423345", 2000n, "Z"),
    ];
    const batches = groupDABatches(rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].rows.map((r) => r.id)).toEqual(["d1", "d2"]);
  });

  it("returns empty array for empty input", () => {
    expect(groupDABatches([])).toEqual([]);
  });
});

// =============================================================
// tryLinkDABatch
// =============================================================

describe("tryLinkDABatch", () => {
  it("confirms un-paired PRs inside a consumed PR batch", () => {
    // PR batch 6227489 has ALICE + BOB + EVE; the DA batch only has
    // ALICE and BOB. EVE is in the same Referencia, so once that PR
    // batch is consumed she's confirmed (nobody returned her DA).
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 10000n, "ALICE", "2026-04-06"),
      pr("pB", "6227489", 5000n, "BOB", "2026-04-06"),
      pr("pE", "6227489", 4000n, "EVE", "2026-04-06"),
      pr("pC", "6227519", 7000n, "CAROL", "2026-04-06"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "149423344", 10000n, "ALICE", "2026-04-07"),
      da("d2", "158423345", 5000n, "BOB", "2026-04-07"),
      da("d3", "7423346", 7000n, "CAROL", "2026-04-07"),
    ];
    const prBatches = groupPRBatches(prRows);
    const daBatches = groupDABatches(daRows);
    expect(daBatches).toHaveLength(1);

    const link = tryLinkDABatch(daBatches[0], prBatches, opts);
    expect(link).not.toBeNull();
    expect(link!.prBatchReferences).toEqual(["6227489", "6227519"]);
    expect(link!.pairings).toHaveLength(3);
    expect(link!.confirmedPrIds).toEqual(["pE"]);
  });

  it("stops growing the PR group as soon as every DA is paired", () => {
    // Algorithm contract: PR batches beyond what's needed are NOT
    // dragged into the link. They remain available for later DA batches
    // (or stay pending if no later DA arrives).
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 10000n, "ALICE", "2026-04-06"),
      pr("pB", "6227489", 5000n, "BOB", "2026-04-06"),
      pr("pC", "6227519", 7000n, "CAROL", "2026-04-06"),
      pr("pD", "6227522", 12000n, "DAVE", "2026-04-06"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "149423344", 10000n, "ALICE", "2026-04-07"),
      da("d2", "158423345", 5000n, "BOB", "2026-04-07"),
      da("d3", "7423346", 7000n, "CAROL", "2026-04-07"),
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link).not.toBeNull();
    expect(link!.prBatchReferences).toEqual(["6227489", "6227519"]);
    expect(link!.confirmedPrIds).toEqual([]);
  });

  it("respects the same-day window (PR.day == DA.day)", () => {
    const prRows = [pr("p1", "6227489", 1000n, "ALICE", "2026-04-07")];
    const daRows = [da("d1", "7423344", 1000n, "ALICE", "2026-04-07")];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link).not.toBeNull();
    expect(link!.pairings[0]).toEqual({ daId: "d1", prId: "p1" });
  });

  it("respects the previous-working-day window (PR.day = previousWorkingDay(DA.day))", () => {
    // DA on Mon → PR on previous Fri must still link.
    const prRows = [pr("p1", "6227489", 1000n, "ALICE", "2026-04-03")]; // Fri
    const daRows = [da("d1", "7423344", 1000n, "ALICE", "2026-04-06")]; // Mon
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link).not.toBeNull();
  });

  it("excludes PR batches outside the window even if amount/name would match", () => {
    // PR two working days before DA → ineligible.
    const prRows = [pr("p1", "6227489", 1000n, "ALICE", "2026-04-02")];
    const daRows = [da("d1", "7423344", 1000n, "ALICE", "2026-04-06")];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link).toBeNull();
  });

  it("returns null when no PR group can satisfy every DA in the batch", () => {
    const prRows = [
      pr("p1", "6227489", 1000n, "ALICE", "2026-04-06"),
      // No PR for BOB.
    ];
    const daRows = [
      da("d1", "7423344", 1000n, "ALICE", "2026-04-07"),
      da("d2", "7423345", 2000n, "BOB", "2026-04-07"),
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link).toBeNull();
  });

  it("requires exact amount match, not just name match", () => {
    const prRows = [pr("p1", "6227489", 1000n, "ALICE", "2026-04-06")];
    const daRows = [da("d1", "7423344", 9999n, "ALICE", "2026-04-07")];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link).toBeNull();
  });

  it("returns null if any DA in the batch lacks a payer name", () => {
    const prRows = [
      pr("p1", "6227489", 1000n, "ALICE", "2026-04-06"),
      pr("p2", "6227489", 2000n, "BOB", "2026-04-06"),
    ];
    const daRows = [
      da("d1", "7423344", 1000n, "ALICE", "2026-04-07"),
      da("d2", "7423345", 2000n, null, "2026-04-07"),
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link).toBeNull();
  });

  it("grows the PR group in sequence order until DA batch is satisfied", () => {
    // First PR batch alone is missing CAROL — algorithm must grab the
    // next PR batch to find her, leaving DAVE un-paired in batch 2.
    const prRows = [
      pr("pA", "6227489", 10000n, "ALICE", "2026-04-06"),
      pr("pB", "6227489", 5000n, "BOB", "2026-04-06"),
      pr("pC", "6227519", 7000n, "CAROL", "2026-04-06"),
      pr("pD", "6227519", 9999n, "DAVE", "2026-04-06"),
    ];
    const daRows = [
      da("d1", "7423344", 10000n, "ALICE", "2026-04-07"),
      da("d2", "7423345", 5000n, "BOB", "2026-04-07"),
      da("d3", "7423346", 7000n, "CAROL", "2026-04-07"),
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link).not.toBeNull();
    expect(link!.prBatchReferences).toEqual(["6227489", "6227519"]);
    expect(link!.confirmedPrIds).toEqual(["pD"]);
  });
});

// =============================================================
// linkAllBatches
// =============================================================

describe("linkAllBatches", () => {
  it("walks DA batches in order and consumes PR batches once", () => {
    // Two independent DA batches matching two distinct PR batches.
    const prRows = [
      pr("pA", "6227489", 10000n, "ALICE", "2026-04-06"),
      pr("pB", "6227519", 5000n, "BOB", "2026-04-06"),
    ];
    const daRows = [
      // DA batch 1
      da("d1", "7423344", 10000n, "ALICE", "2026-04-07"),
      // gap
      da("d2", "7423350", 5000n, "BOB", "2026-04-07"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(2);
    expect(result.unlinkedDABatches).toEqual([]);
    expect(result.unconsumedPRBatchReferences).toEqual([]);
  });

  it("reports DA batches that cannot link and PR batches that go unconsumed", () => {
    const prRows = [
      pr("pA", "6227489", 10000n, "ALICE", "2026-04-06"),
      // EVE has no DA at all → unconsumed.
      pr("pE", "6227519", 4000n, "EVE", "2026-04-06"),
    ];
    const daRows = [
      // DA batch 1: matches ALICE in pA, plus a missing BOB → cannot link.
      da("d1", "7423344", 10000n, "ALICE", "2026-04-07"),
      da("d2", "7423345", 9999n, "BOB", "2026-04-07"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toEqual([]);
    expect(result.unlinkedDABatches).toHaveLength(1);
    expect(result.unconsumedPRBatchReferences.sort()).toEqual([
      "6227489",
      "6227519",
    ]);
  });

  it("does not reuse a PR batch across multiple DA-batch links", () => {
    // Both DA batches happen to need the same single PR (impossible in
    // reality, but the contract is that consumption is exclusive).
    const prRows = [pr("pA", "6227489", 10000n, "ALICE", "2026-04-06")];
    const daRows = [
      da("d1", "7423344", 10000n, "ALICE", "2026-04-07"),
      // gap → second batch
      da("d2", "7423350", 10000n, "ALICE", "2026-04-07"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(1);
    expect(result.unlinkedDABatches).toHaveLength(1);
  });

  it("works on the structure of the user's two real example links", () => {
    // Mirrors the shape (not the exact data) the user described:
    //   Link 1: PR refs 6227489/6227519/6227522 ↔ DA batch ending 7423401
    //   Link 2: PR refs 6227878/6227916/6227915 ↔ DA batch starting 7428982
    const prRows: PRRowForBatch[] = [
      pr("p1", "6227489", 1000n, "ALICE", "2026-04-06"),
      pr("p2", "6227519", 2000n, "BOB", "2026-04-06"),
      pr("p3", "6227522", 3000n, "CAROL", "2026-04-06"),
      pr("p4", "6227878", 4000n, "DAVE", "2026-04-07"),
      pr("p5", "6227915", 5000n, "EVE", "2026-04-07"),
      pr("p6", "6227916", 6000n, "FRANK", "2026-04-07"),
    ];
    const daRows: DARowForBatch[] = [
      // DA batch 1 — sequences 23344..23346, posted Apr 7
      da("d1", "149423344", 1000n, "ALICE", "2026-04-07"),
      da("d2", "158423345", 2000n, "BOB", "2026-04-07"),
      da("d3", "7423346", 3000n, "CAROL", "2026-04-07"),
      // DA batch 2 — gap, sequences 28982..28984, posted Apr 8
      da("d4", "7428982", 4000n, "DAVE", "2026-04-08"),
      da("d5", "158428983", 5000n, "EVE", "2026-04-08"),
      da("d6", "7428984", 6000n, "FRANK", "2026-04-08"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(2);
    expect(result.unlinkedDABatches).toEqual([]);
    expect(result.unconsumedPRBatchReferences).toEqual([]);
    expect(result.links[0].prBatchReferences.sort()).toEqual([
      "6227489",
      "6227519",
      "6227522",
    ]);
    expect(result.links[1].prBatchReferences.sort()).toEqual([
      "6227878",
      "6227915",
      "6227916",
    ]);
  });
});
