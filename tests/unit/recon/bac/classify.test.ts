import { describe, expect, it } from "vitest";

import {
  ACH_PENDING_HOURS,
  classifyBACRow,
  computeFileSha256,
  computeRowHash,
  extractPRPayerName,
  fileClockCutoff,
  normalizeName,
  pickFifoMatchPR,
  type PRCandidate,
} from "@/lib/recon/bac/classify";

describe("classifyBACRow", () => {
  it("PR rows are pending with confirmable_after = posted_at + 24h", () => {
    const c = classifyBACRow({ code: "PR", postedAt: "2026-04-05" });
    expect(c.kind).toBe("loan_inflow");
    expect(c.state).toBe("pending");
    expect(c.confirmableAfter).toBe(
      new Date(Date.parse("2026-04-05T00:00:00Z") + ACH_PENDING_HOURS * 3600_000).toISOString(),
    );
  });

  it("4C rows are confirmed immediately", () => {
    expect(classifyBACRow({ code: "4C", postedAt: "2026-04-05" })).toEqual({
      kind: "loan_inflow",
      state: "confirmed",
      confirmableAfter: null,
    });
  });

  it("DA rows start as pending_pair until ingest pairs them", () => {
    expect(classifyBACRow({ code: "DA", postedAt: "2026-04-06" })).toEqual({
      kind: "reversal",
      state: "pending_pair",
      confirmableAfter: null,
    });
  });

  it.each(["AD", "TX", "FE", "4A"] as const)("%s is non_loan", (code) => {
    expect(classifyBACRow({ code, postedAt: "2026-04-05" })).toEqual({
      kind: "non_loan",
      state: "non_loan",
      confirmableAfter: null,
    });
  });

  it("unknown codes default to pending without a clock", () => {
    expect(classifyBACRow({ code: "ZZ", postedAt: "2026-04-05" })).toEqual({
      kind: "unknown",
      state: "pending",
      confirmableAfter: null,
    });
  });
});

describe("computeRowHash", () => {
  it("is deterministic and field-sensitive", () => {
    const base = {
      accountId: "acc-1",
      postedAt: "2026-04-05",
      reference: "REF001",
      code: "PR",
      description: "Tef DCD de Jorge",
      debitMinor: 0n,
      creditMinor: 5050n,
      balanceMinor: 105050n,
    };
    const h1 = computeRowHash(base);
    const h2 = computeRowHash(base);
    expect(h1).toBe(h2);

    const different = computeRowHash({ ...base, creditMinor: 5051n });
    expect(different).not.toBe(h1);
  });

  it("differs by accountId so two accounts can't collide on identical rows", () => {
    const base = {
      accountId: "acc-1",
      postedAt: "2026-04-05",
      reference: "",
      code: "4C",
      description: "ACH CRE Maria",
      debitMinor: 0n,
      creditMinor: 20000n,
      balanceMinor: 20000n,
    };
    expect(computeRowHash(base)).not.toBe(computeRowHash({ ...base, accountId: "acc-2" }));
  });
});

describe("computeFileSha256", () => {
  it("matches the well-known SHA256 of an empty buffer", () => {
    expect(computeFileSha256(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("normalizeName / extractPRPayerName", () => {
  it("strips accents, punctuation, and case", () => {
    expect(normalizeName("Jörgé Miguel Díaz P.")).toBe("JORGE MIGUEL DIAZ P");
  });

  it("extracts payer name after 'DCD de'", () => {
    expect(extractPRPayerName("Tef DCD de Jorge Miguel Diaz P")).toBe("Jorge Miguel Diaz P");
  });

  it("extracts payer name after 'ACH CRE'", () => {
    expect(extractPRPayerName("ACH CRE Maria Lopez")).toBe("Maria Lopez");
  });
});

describe("pickFifoMatchPR", () => {
  const desc = (name: string) => `Tef DCD de ${name}`;

  it("picks the earliest unmatched PR with matching amount + name", () => {
    const candidates: PRCandidate[] = [
      { id: "p2", postedAt: "2026-04-06", rowIndex: 0, creditMinor: 5050n, description: desc("Jorge Miguel Diaz P") },
      { id: "p1", postedAt: "2026-04-05", rowIndex: 0, creditMinor: 5050n, description: desc("Jorge Miguel Diaz P") },
    ];
    const match = pickFifoMatchPR(
      { amountMinor: 5050n, payerNameRaw: "JORGE MIGUEL DIAZ P", postedAt: "2026-04-06" },
      candidates,
    );
    expect(match?.id).toBe("p1"); // earlier posted_at wins
  });

  it("breaks same-day ties by rowIndex", () => {
    const candidates: PRCandidate[] = [
      { id: "p2", postedAt: "2026-04-05", rowIndex: 5, creditMinor: 5050n, description: desc("Jorge Miguel Diaz P") },
      { id: "p1", postedAt: "2026-04-05", rowIndex: 2, creditMinor: 5050n, description: desc("Jorge Miguel Diaz P") },
    ];
    const match = pickFifoMatchPR(
      { amountMinor: 5050n, payerNameRaw: "JORGE MIGUEL DIAZ P", postedAt: "2026-04-06" },
      candidates,
    );
    expect(match?.id).toBe("p1");
  });

  it("matches a PR whose posted_at is after the DA (BAC sometimes shows the DA first)", () => {
    const candidates: PRCandidate[] = [
      { id: "p1", postedAt: "2026-04-08", rowIndex: 0, creditMinor: 5050n, description: desc("Jorge Miguel Diaz P") },
    ];
    const match = pickFifoMatchPR(
      { amountMinor: 5050n, payerNameRaw: "JORGE MIGUEL DIAZ P", postedAt: "2026-04-06" },
      candidates,
    );
    expect(match?.id).toBe("p1");
  });

  it("rejects on amount mismatch", () => {
    const candidates: PRCandidate[] = [
      { id: "p1", postedAt: "2026-04-05", rowIndex: 0, creditMinor: 5051n, description: desc("Jorge Miguel Diaz P") },
    ];
    expect(
      pickFifoMatchPR(
        { amountMinor: 5050n, payerNameRaw: "JORGE MIGUEL DIAZ P", postedAt: "2026-04-06" },
        candidates,
      ),
    ).toBeNull();
  });

  it("matches across truncation (PR truncated, DA fuller, or vice versa)", () => {
    // PR is truncated to "Carlos Geovany Sanj"; DA shows "CARLOS GEOVANY SANJUR".
    const candidates: PRCandidate[] = [
      { id: "p1", postedAt: "2026-04-05", rowIndex: 0, creditMinor: 12000n, description: desc("Carlos Geovany Sanj") },
    ];
    const match = pickFifoMatchPR(
      { amountMinor: 12000n, payerNameRaw: "CARLOS GEOVANY SANJUR", postedAt: "2026-04-06" },
      candidates,
    );
    expect(match?.id).toBe("p1");
  });

  it("rejects unrelated names even with matching amount", () => {
    const candidates: PRCandidate[] = [
      { id: "p1", postedAt: "2026-04-05", rowIndex: 0, creditMinor: 5050n, description: desc("Maria Lopez") },
    ];
    expect(
      pickFifoMatchPR(
        { amountMinor: 5050n, payerNameRaw: "JORGE MIGUEL DIAZ P", postedAt: "2026-04-06" },
        candidates,
      ),
    ).toBeNull();
  });
});

describe("fileClockCutoff", () => {
  it("returns UTC midnight of the given posted_at", () => {
    expect(fileClockCutoff("2026-04-08")).toBe("2026-04-08T00:00:00.000Z");
  });
});
