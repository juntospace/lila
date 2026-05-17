import { describe, expect, it } from "vitest";

import {
  BG_KNOWN_CODES,
  BGParseError,
  classifyBGCode,
  computeBGAchDetailRowHash,
  computeBGStatementRowHash,
  parseAchError,
  parseBGAchDetail,
  parseBGDescription,
  parseBGStatement,
} from "@/lib/recon/bg";

import {
  minimalBGAchDetailSheet,
  minimalBGStatementSheet,
} from "./fixtures/minimal-bg-fixtures";

describe("classifyBGCode", () => {
  it("loan_inflow for inbound codes", () => {
    for (const c of ["2627", "2626", "48", "40"]) {
      expect(classifyBGCode(c)).toBe("loan_inflow");
    }
  });
  it("non_loan for outbound codes", () => {
    for (const c of ["50", "2519", "2520", "55"]) {
      expect(classifyBGCode(c)).toBe("non_loan");
    }
  });
  it("unknown for codes we haven't seen", () => {
    expect(classifyBGCode("9999")).toBe("unknown");
    expect(classifyBGCode("")).toBe("unknown");
  });
  it("BG_KNOWN_CODES enumerates the classified codes only", () => {
    expect([...BG_KNOWN_CODES].sort()).toEqual(
      ["2519", "2520", "2626", "2627", "40", "48", "50", "55"],
    );
  });
});

describe("parseBGDescription", () => {
  it("extracts plain payer name from 'BANCA EN LINEA TRANSFERENCIA DE NAME'", () => {
    const out = parseBGDescription(
      "BANCA EN LINEA TRANSFERENCIA DE MARISELA LOPEZ PERALTA BANCA EN LINEA TRANSFERENCIA A TERC",
    );
    expect(out.payerNameRaw).toBe(
      "MARISELA LOPEZ PERALTA BANCA EN LINEA TRANSFERENCIA A TERC",
    );
    expect(out.payerDba).toBeNull();
    expect(out.comment).toBeNull();
  });

  it("extracts DBA in parentheses and trailing comment", () => {
    const out = parseBGDescription(
      "BANCA EN LINEA TRANSFERENCIA DE NUBIA SIKIU VELASQUEZ RUIZ (FASHION KIDS SALON) CAPAES0001",
    );
    expect(out.payerNameRaw).toBe("NUBIA SIKIU VELASQUEZ RUIZ");
    expect(out.payerDba).toBe("FASHION KIDS SALON");
    expect(out.comment).toBe("CAPAES0001");
  });

  it("handles BANCA MOVIL variant", () => {
    const out = parseBGDescription(
      "BANCA MOVIL TRANSFERENCIA DE DIEGO MIGUEL DE LEON SANTANA CAPADR00009001DiegoDeLeon",
    );
    expect(out.payerNameRaw).toBe(
      "DIEGO MIGUEL DE LEON SANTANA CAPADR00009001DiegoDeLeon",
    );
  });

  it("extracts payer from 'ACH - NAME'", () => {
    expect(parseBGDescription("ACH - JUAN CARLOS MONTENEGRO CEDENO")).toEqual({
      payerNameRaw: "JUAN CARLOS MONTENEGRO CEDENO",
      payerDba: null,
      comment: null,
    });
  });

  it("returns nulls for un-recognised descriptions", () => {
    expect(parseBGDescription("DEPOSITO")).toEqual({
      payerNameRaw: null,
      payerDba: null,
      comment: null,
    });
    expect(parseBGDescription("")).toEqual({
      payerNameRaw: null,
      payerDba: null,
      comment: null,
    });
  });
});

describe("parseAchError", () => {
  it("splits 'R10 NO EXISTE...' into code + description", () => {
    expect(parseAchError("R10 NO EXISTE AUTORIZACION DEL RECIBIDOR")).toEqual({
      errorCode: "R10",
      errorDescription: "NO EXISTE AUTORIZACION DEL RECIBIDOR",
    });
  });
  it("splits 'R01 FONDOS INSUFICIENTES'", () => {
    expect(parseAchError("R01 FONDOS INSUFICIENTES")).toEqual({
      errorCode: "R01",
      errorDescription: "FONDOS INSUFICIENTES",
    });
  });
  it("treats empty / blank as approved (null,null)", () => {
    expect(parseAchError("")).toEqual({
      errorCode: null,
      errorDescription: null,
    });
    expect(parseAchError("   ")).toEqual({
      errorCode: null,
      errorDescription: null,
    });
  });
  it("falls back to description-only when no R-code pattern", () => {
    expect(parseAchError("MISC FAILURE TEXT")).toEqual({
      errorCode: null,
      errorDescription: "MISC FAILURE TEXT",
    });
  });
});

describe("parseBGStatement", () => {
  it("parses header preamble + every transaction row", () => {
    const result = parseBGStatement(minimalBGStatementSheet);
    expect(result.kind).toBe("statement");
    expect(result.header.accountNumber).toBe("03-43-01-106691-6");
    expect(result.header.accountHolder).toBe("CREDICLARO, S.A.");
    expect(result.header.dateRangeStart).toBe("2026-04-13");
    expect(result.header.dateRangeEnd).toBe("2026-05-16");
    expect(result.warnings).toEqual([]);
    expect(result.rows).toHaveLength(7);
  });

  it("classifies and extracts payer for each row", () => {
    const result = parseBGStatement(minimalBGStatementSheet);
    const r0 = result.rows[0]; // 2627 plain name
    expect(r0.code).toBe("2627");
    expect(r0.creditMinor).toBe(833n);
    expect(r0.debitMinor).toBe(0n);
    expect(r0.payerNameRaw).toContain("MARISELA LOPEZ PERALTA");

    const r1 = result.rows[1]; // 2627 with DBA
    expect(r1.payerDba).toBe("FASHION KIDS SALON");
    expect(r1.comment).toBe("CAPAES0001");

    const r2 = result.rows[2]; // 48 ACH
    expect(r2.code).toBe("48");
    expect(r2.payerNameRaw).toBe("JUAN CARLOS MONTENEGRO CEDENO");

    const r3 = result.rows[3]; // 40 Yappy
    expect(r3.code).toBe("40");
    expect(r3.payerNameRaw).toBeNull();

    const r5 = result.rows[5]; // 50 Yappy commission (DR)
    expect(r5.code).toBe("50");
    expect(r5.debitMinor).toBe(27n);
    expect(r5.creditMinor).toBe(0n);
  });

  it("throws BGParseError when header row is missing", () => {
    expect(() => parseBGStatement([["foo", "bar"]])).toThrow(BGParseError);
  });

  it("rejects amount parses that aren't pure numbers", () => {
    const sheet = JSON.parse(JSON.stringify(minimalBGStatementSheet));
    // Replace credit cell with garbage — should be coerced to 0n.
    sheet[7][5] = "n/a";
    const result = parseBGStatement(sheet);
    expect(result.rows[0].creditMinor).toBe(0n);
  });
});

describe("parseBGAchDetail", () => {
  it("reads envelope (filename / effective date / summary counts)", () => {
    const result = parseBGAchDetail(minimalBGAchDetailSheet);
    expect(result.kind).toBe("ach_detail");
    expect(result.envelope.filename).toBe(
      "20260229 - Crediclaro - LOTE ACH BG 30.txt",
    );
    expect(result.envelope.effectiveDate).toBe("2026-03-02");
    expect(result.envelope.totalTransactions).toBe(3);
    expect(result.envelope.succeededTransactions).toBe(1);
    expect(result.envelope.rejectedTransactions).toBe(2);
  });

  it("parses every detail row with amount + error split", () => {
    const result = parseBGAchDetail(minimalBGAchDetailSheet);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      routingCode: "0071",
      targetAccount: "0443982533439",
      amountMinor: 10833n,
      beneficiaryId: "8-499-770",
      beneficiaryName: "ALEX ANTONIO DAVIS LOP",
      errorCode: "R10",
      errorDescription: "NO EXISTE AUTORIZACION DEL RECIBIDOR",
    });
    // Approved
    expect(result.rows[1].errorCode).toBeNull();
    expect(result.rows[1].errorDescription).toBeNull();
    expect(result.rows[1].amountMinor).toBe(33200n);
    // R01
    expect(result.rows[2].errorCode).toBe("R01");
  });

  it("throws BGParseError if effective date missing", () => {
    const sheet = minimalBGAchDetailSheet.map((row) => row.slice());
    sheet[6] = ["Fecha efectiva ", "", "", "", "", "", "", ""];
    expect(() => parseBGAchDetail(sheet)).toThrow(BGParseError);
  });
});

describe("row hashing", () => {
  it("statement hash is deterministic + field-sensitive", () => {
    const base = {
      accountId: "acc-1",
      postedAt: "2026-04-13",
      reference: "1080644554",
      code: "2627",
      description: "BANCA EN LINEA TRANSFERENCIA DE X",
      debitMinor: 0n,
      creditMinor: 833n,
      balanceMinor: 31973_07n,
    };
    const h1 = computeBGStatementRowHash(base);
    const h2 = computeBGStatementRowHash(base);
    expect(h1).toBe(h2);
    expect(
      computeBGStatementRowHash({ ...base, creditMinor: 834n }),
    ).not.toBe(h1);
    expect(
      computeBGStatementRowHash({ ...base, accountId: "acc-2" }),
    ).not.toBe(h1);
  });

  it("detail-line hash is deterministic + field-sensitive", () => {
    const base = {
      accountId: "acc-1",
      batchFilename: "20260229 - Crediclaro - LOTE ACH BG 30.txt",
      routingCode: "0071",
      targetAccount: "0443982533439",
      amountMinor: 10833n,
      beneficiaryId: "8-499-770",
      errorCode: "R10",
    };
    const h1 = computeBGAchDetailRowHash(base);
    const h2 = computeBGAchDetailRowHash(base);
    expect(h1).toBe(h2);
    expect(
      computeBGAchDetailRowHash({ ...base, errorCode: null }),
    ).not.toBe(h1);
  });
});
