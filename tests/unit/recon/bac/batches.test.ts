import { describe, expect, it } from "vitest";

import {
  groupDABatches,
  groupPRBatches,
  linkAllBatches,
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
 * Tests use a deterministic prefix the fixture controls so we don't
 * couple the test data to the production parser regex.
 */
const extractPRPayer = (description: string) => {
  const m = description.match(/^PAYER:\s*(.+?)\s*$/);
  return m ? m[1] : null;
};

const opts: LinkOptions = {
  nameMatcher,
  normalize,
  extractPRPayer,
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
      da("d1", "7423344", 1000n, "X"),
      da("d2", "7423345", 2000n, "Y"),
      da("d3", "7423346", 3000n, "Z"),
      // gap → new batch
      da("d4", "7423350", 4000n, "A"),
      da("d5", "7423351", 5000n, "B"),
    ];
    const batches = groupDABatches(rows);
    expect(batches).toHaveLength(2);
    expect(batches[0].id).toBe("4-23344-23346");
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

  it("orders cross-day batches chronologically even when later-date sequences are lower", () => {
    // BAC's DA sequence counter is NOT monotonic across days. Apr 1
    // has high sequences (23344-23345) while Apr 7 has lower ones
    // (9791-9792). The earlier-DATE batch must come first, otherwise
    // the linker walks PR batches in the wrong order and consumes
    // earlier-day PR batches against later-day DA batches.
    const rows = [
      // Apr 7 DA batch — lower sequence
      da("d_apr7_a", "7409791", 1000n, "ALICE", "2026-04-07"),
      da("d_apr7_b", "7409792", 2000n, "BOB", "2026-04-07"),
      // Apr 1 DA batch — higher sequence (despite earlier date)
      da("d_apr1_a", "7423344", 3000n, "CAROL", "2026-04-01"),
      da("d_apr1_b", "7423345", 4000n, "DAVE", "2026-04-01"),
    ];
    const batches = groupDABatches(rows);
    expect(batches).toHaveLength(2);
    // Earlier date first, regardless of sequence magnitude.
    expect(batches[0].posted_at).toBe("2026-04-01");
    expect(batches[0].startSequence).toBe(23344);
    expect(batches[1].posted_at).toBe("2026-04-07");
    expect(batches[1].startSequence).toBe(9791);
  });

  it("returns empty array for empty input", () => {
    expect(groupDABatches([])).toEqual([]);
  });
});

// =============================================================
// linkAllBatches (partial-claim model)
// =============================================================

describe("linkAllBatches", () => {
  it("clean case: each DA batch pairs cleanly with its own day's PR batches", () => {
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 1000n, "ALICE"),
      pr("pB", "6227519", 2000n, "BOB"),
      pr("pC", "6227522", 3000n, "CAROL"),
      pr("pD", "6227878", 4000n, "DAVE"),
    ];
    const daRows: DARowForBatch[] = [
      // DA batch 1 — seqs 23344, 23345
      da("d1", "7423344", 1000n, "ALICE"),
      da("d2", "7423345", 2000n, "BOB"),
      // gap → DA batch 2 — seqs 28982, 28983
      da("d3", "7428982", 3000n, "CAROL"),
      da("d4", "7428983", 4000n, "DAVE"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(2);
    expect(result.links[0].prBatchReferences.sort()).toEqual([
      "6227489",
      "6227519",
    ]);
    expect(result.links[1].prBatchReferences.sort()).toEqual([
      "6227522",
      "6227878",
    ]);
    expect(result.unconsumedPRBatchReferences).toEqual([]);
    for (const link of result.links) {
      expect(link.unmatchedDaIds).toEqual([]);
    }
  });

  it("auto-confirms un-paired PRs in claimed batches", () => {
    // PR batch has ALICE + BOB + EVE (3 PRs); DA batch returns ALICE+BOB
    // only. EVE didn't pair → auto-confirmed since her batch was claimed.
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 10000n, "ALICE"),
      pr("pB", "6227489", 5000n, "BOB"),
      pr("pE", "6227489", 4000n, "EVE"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "7423344", 10000n, "ALICE"),
      da("d2", "7423345", 5000n, "BOB"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(1);
    expect(result.links[0].prBatchReferences).toEqual(["6227489"]);
    expect(result.links[0].pairings).toHaveLength(2);
    expect(result.links[0].confirmedPrIds).toEqual(["pE"]);
    expect(result.links[0].unmatchedDaIds).toEqual([]);
  });

  it("leaves PR batches with zero pairings unconsumed (stay pending)", () => {
    // 6227522 (DAVE) is never matched by any DA → unconsumed. Under the
    // partial-claim model, it stays available for future DA batches or
    // operator action.
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 10000n, "ALICE"),
      pr("pB", "6227489", 5000n, "BOB"),
      pr("pC", "6227519", 7000n, "CAROL"),
      pr("pD", "6227522", 12000n, "DAVE"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "7423344", 10000n, "ALICE"),
      da("d2", "7423345", 5000n, "BOB"),
      da("d3", "7423346", 7000n, "CAROL"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(1);
    expect(result.links[0].prBatchReferences.sort()).toEqual([
      "6227489",
      "6227519",
    ]);
    expect(result.unconsumedPRBatchReferences).toEqual(["6227522"]);
  });

  it("admits any PR batch whose date is on or before the DA batch's date", () => {
    // PR Apr 1, DA Apr 7 — fine, PR.day <= DA.day.
    const prRows = [pr("p1", "6227489", 1000n, "ALICE", "2026-04-01")];
    const daRows = [da("d1", "7423344", 1000n, "ALICE", "2026-04-07")];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links[0].pairings).toEqual([{ daId: "d1", prId: "p1" }]);
  });

  it("excludes PR batches posted AFTER the DA batch (date sanity)", () => {
    // The Apr 5 PR batch can't be a source for an Apr 1 DA batch.
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 1000n, "ALICE", "2026-04-01"),
      pr("pB", "6227519", 2000n, "BOB", "2026-04-05"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "7423344", 1000n, "ALICE", "2026-04-01"),
      // BOB DA on Apr 1 — but its only candidate PR is Apr 5 → unmatched.
      da("d2", "7423345", 2000n, "BOB", "2026-04-01"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(1);
    expect(result.links[0].pairings).toEqual([{ daId: "d1", prId: "pA" }]);
    expect(result.links[0].unmatchedDaIds).toEqual(["d2"]);
    expect(result.unconsumedPRBatchReferences).toEqual(["6227519"]);
  });

  it("a future-dated PR batch can pair with a later-day DA batch", () => {
    // Apr 1 DA batch only consumes Apr 1 PR batch. Apr 5 DA batch picks
    // up the Apr 5 PR batch cleanly.
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 1000n, "ALICE", "2026-04-01"),
      pr("pB", "6227519", 2000n, "BOB", "2026-04-05"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "7423344", 1000n, "ALICE", "2026-04-01"),
      da("d2", "7428982", 2000n, "BOB", "2026-04-05"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(2);
    expect(result.links[0].prBatchReferences).toEqual(["6227489"]);
    expect(result.links[0].unmatchedDaIds).toEqual([]);
    expect(result.links[1].prBatchReferences).toEqual(["6227519"]);
    expect(result.links[1].unmatchedDaIds).toEqual([]);
    expect(result.unconsumedPRBatchReferences).toEqual([]);
  });

  it("requires exact amount match", () => {
    const prRows = [pr("p1", "6227489", 1000n, "ALICE")];
    const daRows = [da("d1", "7423344", 9999n, "ALICE")];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    // No pairing → 6227489 stays unconsumed (no batch has any pairing).
    expect(result.links).toHaveLength(1);
    expect(result.links[0].pairings).toEqual([]);
    expect(result.links[0].unmatchedDaIds).toEqual(["d1"]);
    expect(result.unconsumedPRBatchReferences).toEqual(["6227489"]);
  });

  it("DAs without a payer name are unmatched", () => {
    const prRows = [
      pr("pA", "6227489", 10000n, "ALICE"),
      pr("pB", "6227489", 2000n, "BOB"),
    ];
    const daRows = [
      da("d1", "7423344", 10000n, "ALICE"),
      da("d2", "7423345", 2000n, null),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links[0].pairings.map((p) => p.daId)).toEqual(["d1"]);
    expect(result.links[0].unmatchedDaIds).toEqual(["d2"]);
    // pB stays in the claimed batch (it auto-confirms).
    expect(result.links[0].confirmedPrIds).toEqual(["pB"]);
  });

  it("greedy first-fit prefers earlier PRs in the same batch", () => {
    const prRows: PRRowForBatch[] = [
      pr("pFirst", "6227489", 5000n, "ALICE"),
      pr("pSecond", "6227489", 5000n, "ALICE"),
    ];
    const daRows: DARowForBatch[] = [da("d1", "7423344", 5000n, "ALICE")];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links[0].pairings[0].prId).toBe("pFirst");
    expect(result.links[0].confirmedPrIds).toEqual(["pSecond"]);
  });

  it("two example links: each batch resolves cleanly", () => {
    const prRows: PRRowForBatch[] = [
      pr("p1", "6227489", 1000n, "ALICE"),
      pr("p2", "6227519", 2000n, "BOB"),
      pr("p3", "6227522", 3000n, "CAROL"),
      pr("p4", "6227878", 4000n, "DAVE"),
      pr("p5", "6227915", 5000n, "EVE"),
      pr("p6", "6227916", 6000n, "FRANK"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "149423344", 1000n, "ALICE"),
      da("d2", "158423345", 2000n, "BOB"),
      da("d3", "7423346", 3000n, "CAROL"),
      da("d4", "7428982", 4000n, "DAVE"),
      da("d5", "158428983", 5000n, "EVE"),
      da("d6", "7428984", 6000n, "FRANK"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(2);
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
    expect(result.unconsumedPRBatchReferences).toEqual([]);
    for (const link of result.links) {
      expect(link.unmatchedDaIds).toEqual([]);
    }
  });

  it("multi-day data with chronological DA-batch ordering", () => {
    // Apr 7 DA batch has LOWER sequence (9791) than Apr 1 DA batch
    // (23344). Sorted chronologically, Apr 1 is processed first.
    const prRows: PRRowForBatch[] = [
      pr("p_apr1_a", "6227489", 1000n, "ALICE", "2026-04-01"),
      pr("p_apr1_b", "6227519", 2000n, "BOB", "2026-04-01"),
      pr("p_apr7_a", "6231061", 3000n, "CAROL", "2026-04-07"),
      pr("p_apr7_b", "6231088", 4000n, "DAVE", "2026-04-07"),
    ];
    const daRows: DARowForBatch[] = [
      da("d_apr7_a", "7409791", 3000n, "CAROL", "2026-04-07"),
      da("d_apr7_b", "7409792", 4000n, "DAVE", "2026-04-07"),
      da("d_apr1_a", "7423344", 1000n, "ALICE", "2026-04-01"),
      da("d_apr1_b", "7423345", 2000n, "BOB", "2026-04-01"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(2);
    // Apr 1 batch processed first.
    expect(result.links[0].prBatchReferences.sort()).toEqual([
      "6227489",
      "6227519",
    ]);
    expect(result.links[1].prBatchReferences.sort()).toEqual([
      "6231061",
      "6231088",
    ]);
    for (const link of result.links) {
      expect(link.unmatchedDaIds).toEqual([]);
    }
  });

  it("symmetric two-batch case: bipartite assignment splits one PR batch per DA batch", () => {
    // Two PR batches with identical (name, amount) PRs. Two DA batches
    // also with identical (name, amount) DAs. The bipartite assignment
    // chooses one PR batch per DA batch (no over-claim). Exactly which
    // PR batch goes to which DA batch is symmetric — either choice is
    // valid — so we just assert both DA batches pair all 3 DAs each
    // and exactly one PR batch is assigned to each.
    const prRows: PRRowForBatch[] = [
      pr("pA1", "6227489", 1000n, "ALICE"),
      pr("pA2", "6227489", 2000n, "BOB"),
      pr("pA3", "6227489", 3000n, "CAROL"),
      pr("pB1", "6227878", 1000n, "ALICE"),
      pr("pB2", "6227878", 2000n, "BOB"),
      pr("pB3", "6227878", 3000n, "CAROL"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1a", "7423344", 1000n, "ALICE"),
      da("d1b", "7423345", 2000n, "BOB"),
      da("d1c", "7423346", 3000n, "CAROL"),
      da("d2a", "7428982", 1000n, "ALICE"),
      da("d2b", "7428983", 2000n, "BOB"),
      da("d2c", "7428984", 3000n, "CAROL"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(2);
    for (const link of result.links) {
      expect(link.prBatchReferences).toHaveLength(1);
      expect(link.pairings).toHaveLength(3);
      expect(link.unmatchedDaIds).toEqual([]);
    }
    // Exactly one PR batch per DA batch, no over-claim.
    const allClaimed = result.links.flatMap((l) => l.prBatchReferences);
    expect(allClaimed.sort()).toEqual(["6227489", "6227878"]);
    expect(result.unconsumedPRBatchReferences).toEqual([]);
  });

  it("inverted ref/seq pattern (production Apr 20): DA1 ↔ higher-ref PR group", () => {
    // The actual Apr 20 production scenario the user's manual
    // reconciliation revealed: DA batch 1 (lower seq) corresponds to
    // PR4 (higher ref). The bipartite assignment finds this by
    // maximizing total pairings — DA1's DAs match PR4's PRs uniquely,
    // and DA2's DAs match PR1's PRs uniquely (different amounts /
    // people unique to each PR batch).
    const prRows: PRRowForBatch[] = [
      // PR1 (lower ref) — has GROUP_A_PERSON only
      pr("pr1_a", "6246565", 1000n, "GROUP_A_PERSON_1"),
      pr("pr1_b", "6246565", 2000n, "GROUP_A_PERSON_2"),
      // PR4 (higher ref) — has GROUP_B_PERSON only
      pr("pr4_a", "6246583", 3000n, "GROUP_B_PERSON_1"),
      pr("pr4_b", "6246583", 4000n, "GROUP_B_PERSON_2"),
    ];
    const daRows: DARowForBatch[] = [
      // DA1 (lower seq) — returns GROUP_B_PERSON
      da("d1a", "7482219", 3000n, "GROUP_B_PERSON_1"),
      da("d1b", "7482220", 4000n, "GROUP_B_PERSON_2"),
      // DA2 (higher seq) — returns GROUP_A_PERSON
      da("d2a", "7485671", 1000n, "GROUP_A_PERSON_1"),
      da("d2b", "7485672", 2000n, "GROUP_A_PERSON_2"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(2);
    // DA1 (lower seq) processed first; assigned to 6246583 (higher ref)
    // because that's where its DAs find matches.
    const da1Link = result.links.find((l) => l.daBatchId.endsWith("82219-82220"));
    const da2Link = result.links.find((l) => l.daBatchId.endsWith("85671-85672"));
    expect(da1Link?.prBatchReferences).toEqual(["6246583"]);
    expect(da2Link?.prBatchReferences).toEqual(["6246565"]);
    expect(da1Link?.unmatchedDaIds).toEqual([]);
    expect(da2Link?.unmatchedDaIds).toEqual([]);
  });
});
