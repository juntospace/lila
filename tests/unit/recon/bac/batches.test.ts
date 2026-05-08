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
// tryLinkDABatch (reference-ordered, no date filter)
// =============================================================

describe("tryLinkDABatch", () => {
  it("consumes PR batches in reference order until DAs are paired", () => {
    // PR batch 1 (ref 6227489) has ALICE+BOB; PR batch 2 (6227519) has CAROL.
    // The DA batch needs ALICE/BOB/CAROL → consumes both PR batches.
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 10000n, "ALICE"),
      pr("pB", "6227489", 5000n, "BOB"),
      pr("pC", "6227519", 7000n, "CAROL"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "7423344", 10000n, "ALICE"),
      da("d2", "7423345", 5000n, "BOB"),
      da("d3", "7423346", 7000n, "CAROL"),
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link.prBatchReferences).toEqual(["6227489", "6227519"]);
    expect(link.pairings).toHaveLength(3);
    expect(link.confirmedPrIds).toEqual([]);
    expect(link.unmatchedDaIds).toEqual([]);
  });

  it("confirms un-paired PRs in every consumed PR batch", () => {
    // PR batch 1 has ALICE+BOB+EVE (3 PRs); DA batch only matches ALICE+BOB.
    // EVE didn't pair → confirmed.
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 10000n, "ALICE"),
      pr("pB", "6227489", 5000n, "BOB"),
      pr("pE", "6227489", 4000n, "EVE"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "7423344", 10000n, "ALICE"),
      da("d2", "7423345", 5000n, "BOB"),
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link.prBatchReferences).toEqual(["6227489"]);
    expect(link.pairings).toHaveLength(2);
    expect(link.confirmedPrIds).toEqual(["pE"]);
    expect(link.unmatchedDaIds).toEqual([]);
  });

  it("confirms un-paired PRs across multiple consumed PR batches", () => {
    // PR batch 1 has ALICE+EVE; matches ALICE only. EVE confirmed.
    // PR batch 2 has BOB+FRANK; matches BOB only. FRANK confirmed.
    // PR batch 3 has CAROL; matches CAROL — DA batch done.
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 10000n, "ALICE"),
      pr("pE", "6227489", 4000n, "EVE"),
      pr("pB", "6227519", 5000n, "BOB"),
      pr("pF", "6227519", 9000n, "FRANK"),
      pr("pC", "6227522", 7000n, "CAROL"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "7423344", 10000n, "ALICE"),
      da("d2", "7423345", 5000n, "BOB"),
      da("d3", "7423346", 7000n, "CAROL"),
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link.prBatchReferences).toEqual(["6227489", "6227519", "6227522"]);
    expect(link.pairings).toHaveLength(3);
    expect(link.confirmedPrIds.sort()).toEqual(["pE", "pF"]);
    expect(link.unmatchedDaIds).toEqual([]);
  });

  it("does not consume PR batches beyond the last needed one", () => {
    // PR batches 1+2 are enough; PR batch 3 stays unconsumed for a
    // future DA batch.
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
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link.prBatchReferences).toEqual(["6227489", "6227519"]);
    expect(link.confirmedPrIds).toEqual([]);
  });

  it("admits any PR batch whose date is on or before the DA batch's date", () => {
    // PR Apr 1, DA Apr 7 — older window rules would have excluded it.
    // Under the reference-ordered rule with date sanity check, PR.day
    // <= DA.day is fine, so the PR batch is consumed.
    const prRows = [pr("p1", "6227489", 1000n, "ALICE", "2026-04-01")];
    const daRows = [da("d1", "7423344", 1000n, "ALICE", "2026-04-07")];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link.pairings).toEqual([{ daId: "d1", prId: "p1" }]);
  });

  it("stops at the first PR batch posted AFTER the DA batch (date sanity)", () => {
    // PR batch 1 (Apr 1) is consumable; PR batch 2 (Apr 5) is NOT — it's
    // for a future DA batch. The DA batch has 2 unmatched DAs after
    // batch 1 is exhausted; those become unmatchedDaIds (data error).
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 1000n, "ALICE", "2026-04-01"),
      pr("pB", "6227519", 2000n, "BOB", "2026-04-05"),
    ];
    const daRows: DARowForBatch[] = [
      da("d1", "7423344", 1000n, "ALICE", "2026-04-01"),
      da("d2", "7423345", 2000n, "BOB", "2026-04-01"),
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link.prBatchReferences).toEqual(["6227489"]);
    expect(link.pairings).toEqual([{ daId: "d1", prId: "pA" }]);
    expect(link.unmatchedDaIds).toEqual(["d2"]);
  });

  it("the date stop releases the un-consumed PR batch back to the next DA batch", () => {
    // Apr 1 DA batch can only consume Apr 1 PR batch. Apr 5 DA batch
    // then picks up the Apr 5 PR batch cleanly.
    const prRows: PRRowForBatch[] = [
      pr("pA", "6227489", 1000n, "ALICE", "2026-04-01"),
      pr("pB", "6227519", 2000n, "BOB", "2026-04-05"),
    ];
    const daRows: DARowForBatch[] = [
      // DA batch 1 (Apr 1) — seq 23344
      da("d1", "7423344", 1000n, "ALICE", "2026-04-01"),
      // gap → DA batch 2 (Apr 5) — seq 28982
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

  it("requires exact amount match (different amount → no pair)", () => {
    const prRows = [pr("p1", "6227489", 1000n, "ALICE")];
    const daRows = [da("d1", "7423344", 9999n, "ALICE")];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    // PR batch was consumed (we tried). DA stays un-matched.
    expect(link.prBatchReferences).toEqual(["6227489"]);
    expect(link.pairings).toEqual([]);
    expect(link.confirmedPrIds).toEqual(["p1"]);
    expect(link.unmatchedDaIds).toEqual(["d1"]);
  });

  it("reports unmatched DAs when PR batches are exhausted", () => {
    const prRows = [pr("p1", "6227489", 1000n, "ALICE")];
    const daRows = [
      da("d1", "7423344", 1000n, "ALICE"),
      da("d2", "7423345", 2000n, "BOB"), // no PR in any batch
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link.pairings).toHaveLength(1);
    expect(link.unmatchedDaIds).toEqual(["d2"]);
  });

  it("DAs without payer name fall through to unmatchedDaIds", () => {
    const prRows = [
      pr("pA", "6227489", 10000n, "ALICE"),
      pr("pB", "6227489", 2000n, "BOB"),
    ];
    const daRows = [
      da("d1", "7423344", 10000n, "ALICE"),
      da("d2", "7423345", 2000n, null), // no payer name
    ];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link.pairings.map((p) => p.daId)).toEqual(["d1"]);
    expect(link.unmatchedDaIds).toEqual(["d2"]);
    // pB is in a consumed batch and didn't pair → confirmed.
    expect(link.confirmedPrIds).toEqual(["pB"]);
  });

  it("greedy first-fit prefers earlier PRs in the batch when names tie", () => {
    // Two PRs in the same batch with the same amount + same name; first
    // declared wins.
    const prRows: PRRowForBatch[] = [
      pr("pFirst", "6227489", 5000n, "ALICE"),
      pr("pSecond", "6227489", 5000n, "ALICE"),
    ];
    const daRows: DARowForBatch[] = [da("d1", "7423344", 5000n, "ALICE")];
    const link = tryLinkDABatch(
      groupDABatches(daRows)[0],
      groupPRBatches(prRows),
      opts,
    );
    expect(link.pairings[0].prId).toBe("pFirst");
    expect(link.confirmedPrIds).toEqual(["pSecond"]);
  });
});

// =============================================================
// linkAllBatches
// =============================================================

describe("linkAllBatches", () => {
  it("threads the PR cursor across DA batches in reference order", () => {
    // DA batch 1 consumes PR batches 6227489+6227519.
    // DA batch 2 consumes PR batches 6227522+6227878.
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
    expect(result.links[0].prBatchReferences).toEqual(["6227489", "6227519"]);
    expect(result.links[1].prBatchReferences).toEqual(["6227522", "6227878"]);
    expect(result.unconsumedPRBatchReferences).toEqual([]);
    for (const link of result.links) {
      expect(link.unmatchedDaIds).toEqual([]);
    }
  });

  it("does not reuse PR batches across DA batches", () => {
    // First DA batch consumes the only PR batch. Second DA batch has
    // no PR batches available; its DAs are reported as unmatched.
    const prRows = [pr("pA", "6227489", 1000n, "ALICE")];
    const daRows = [
      da("d1", "7423344", 1000n, "ALICE"),
      // gap → second batch
      da("d2", "7428982", 1000n, "ALICE"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(2);
    expect(result.links[0].pairings).toHaveLength(1);
    expect(result.links[1].pairings).toEqual([]);
    expect(result.links[1].unmatchedDaIds).toEqual(["d2"]);
  });

  it("leaves PR batches unconsumed if no DA batch needs them", () => {
    const prRows = [
      pr("pA", "6227489", 1000n, "ALICE"),
      pr("pB", "6227519", 2000n, "BOB"),
      pr("pC", "6227522", 3000n, "CAROL"),
    ];
    const daRows = [da("d1", "7423344", 1000n, "ALICE")];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(1);
    expect(result.unconsumedPRBatchReferences).toEqual(["6227519", "6227522"]);
  });

  it("reproduces the user's two real example links", () => {
    // Mirrors the shape of the real account: two DA batches, each consuming
    // three PR batches in reference order.
    const prRows: PRRowForBatch[] = [
      pr("p1", "6227489", 1000n, "ALICE"),
      pr("p2", "6227519", 2000n, "BOB"),
      pr("p3", "6227522", 3000n, "CAROL"),
      pr("p4", "6227878", 4000n, "DAVE"),
      pr("p5", "6227915", 5000n, "EVE"),
      pr("p6", "6227916", 6000n, "FRANK"),
    ];
    const daRows: DARowForBatch[] = [
      // DA batch 1 — seqs 23344..23346
      da("d1", "149423344", 1000n, "ALICE"),
      da("d2", "158423345", 2000n, "BOB"),
      da("d3", "7423346", 3000n, "CAROL"),
      // DA batch 2 — seqs 28982..28984
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
    expect(result.links[0].prBatchReferences).toEqual([
      "6227489",
      "6227519",
      "6227522",
    ]);
    expect(result.links[1].prBatchReferences).toEqual([
      "6227878",
      "6227915",
      "6227916",
    ]);
    expect(result.unconsumedPRBatchReferences).toEqual([]);
    for (const link of result.links) {
      expect(link.unmatchedDaIds).toEqual([]);
    }
  });

  it("multi-day data with a later-date DA batch having a LOWER sequence", () => {
    // Reproduction of the production bug: Apr 1 has DA sequences in the
    // 23000s (high), Apr 7 has DA sequences starting at 9791 (low). If
    // we sort DA batches by raw sequence, Apr 7 comes first, walks into
    // the Apr 1 PR batches, wrongly consumes them, and leaves every
    // earlier-day DA un-matched. With chronological sort, each DA batch
    // consumes the PR batches from its own day cleanly.
    const prRows: PRRowForBatch[] = [
      // Apr 1 PR batches (lower refs because they were submitted earlier)
      pr("p_apr1_a", "6227489", 1000n, "ALICE", "2026-04-01"),
      pr("p_apr1_b", "6227519", 2000n, "BOB", "2026-04-01"),
      // Apr 7 PR batches (higher refs, later date)
      pr("p_apr7_a", "6231061", 3000n, "CAROL", "2026-04-07"),
      pr("p_apr7_b", "6231088", 4000n, "DAVE", "2026-04-07"),
    ];
    const daRows: DARowForBatch[] = [
      // Apr 7 DA batch — sequences 9791-9792 (LOW sequence on a LATE date)
      da("d_apr7_a", "7409791", 3000n, "CAROL", "2026-04-07"),
      da("d_apr7_b", "7409792", 4000n, "DAVE", "2026-04-07"),
      // Apr 1 DA batch — sequences 23344-23345 (HIGH sequence on an EARLY date)
      da("d_apr1_a", "7423344", 1000n, "ALICE", "2026-04-01"),
      da("d_apr1_b", "7423345", 2000n, "BOB", "2026-04-01"),
    ];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    // Both DA batches should pair cleanly against their own day's PR batches.
    expect(result.links).toHaveLength(2);
    // First DA batch processed = earliest date = Apr 1 (despite higher seq).
    expect(result.links[0].prBatchReferences).toEqual(["6227489", "6227519"]);
    expect(result.links[0].pairings).toHaveLength(2);
    expect(result.links[0].unmatchedDaIds).toEqual([]);
    // Second DA batch = Apr 7.
    expect(result.links[1].prBatchReferences).toEqual(["6231061", "6231088"]);
    expect(result.links[1].pairings).toHaveLength(2);
    expect(result.links[1].unmatchedDaIds).toEqual([]);
    expect(result.unconsumedPRBatchReferences).toEqual([]);
  });

  it("the cross-batch case: a DA batch reaches into a PR batch where no DA matched", () => {
    // PR batch 6227489 has nobody whose name appears in DA batch 1.
    // Under the reference-ordered rule, the linker still consumes
    // 6227489 (advancing the cursor) and confirms its un-paired PRs.
    const prRows: PRRowForBatch[] = [
      pr("pX", "6227489", 999n, "XAVIER"),
      pr("pY", "6227519", 1000n, "ALICE"),
    ];
    const daRows = [da("d1", "7423344", 1000n, "ALICE")];
    const result = linkAllBatches(
      groupPRBatches(prRows),
      groupDABatches(daRows),
      opts,
    );
    expect(result.links).toHaveLength(1);
    expect(result.links[0].prBatchReferences).toEqual(["6227489", "6227519"]);
    expect(result.links[0].pairings).toEqual([{ daId: "d1", prId: "pY" }]);
    // pX in 6227489 didn't pair, but its batch was consumed → confirmed.
    expect(result.links[0].confirmedPrIds).toEqual(["pX"]);
  });
});
