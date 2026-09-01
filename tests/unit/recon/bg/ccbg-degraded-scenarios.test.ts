// Vitest suite for Banco General (CCBG v2) degraded scenarios (T1 to T16).

import { describe, expect, it } from "vitest";

import {
  parseBgAchDetail,
  parseBgStatement,
  parseBgYappyReport,
  reconcileBancoGeneral,
  type BgAssignmentCategory,
  type BgParsedAchDetail,
  type BgParsedStatement,
  type BgParsedYappyReport,
} from "@/lib/recon/bg";

import { loadBgSamples } from "./fixtures/load-samples";

describe("Banco General CCBG v2 · Degraded Scenarios (T1 to T16)", () => {
  // -------------------------------------------------------------
  // T1: Missing Detalle for retry (3)
  // -------------------------------------------------------------
  it("T1 · missing ACH detail for retry (3) degrades batch to pending while retry (2) remains settled", () => {
    const loaded = loadBgSamples({
      excludePatterns: ["DETALLETRANSACCIONACH20260821173909"],
    });
    const r1 = reconcileBancoGeneral(
      loaded.statements,
      loaded.achDetails,
      loaded.yappyReports,
    );

    const withoutDetail = r1.batches.filter(
      (b) => b.batchDateStr === "20260814" && !b.detailFilename,
    );
    const withDetail = r1.batches.filter(
      (b) => b.batchDateStr === "20260814" && Boolean(b.detailFilename),
    );

    expect(withoutDetail.length).toBe(1);
    expect(withoutDetail[0].status).toBe("pending");
    expect(withoutDetail[0].rejectedAmount).toBe(3939.2);
    expect(withoutDetail[0].totalAmount).toBe(3939.2);
    expect(withoutDetail[0].succeededAmount).toBe(0.0);

    expect(
      r1.pendingTasks.some(
        (p) => p.taskType === "missing_ach_detail" && p.missingItem.includes("20260814"),
      ),
    ).toBe(true);

    expect(withDetail.length).toBe(1);
    expect(withDetail[0].status).toBe("settled");
  });

  // -------------------------------------------------------------
  // T2: Missing Yappy Report
  // -------------------------------------------------------------
  it("T2 · without Yappy report, all Yappy batches degrade to pending naming the exact missing day", () => {
    const loaded = loadBgSamples({
      excludePatterns: ["TRANSACCIONESYAPPY"],
    });
    const r2 = reconcileBancoGeneral(
      loaded.statements,
      loaded.achDetails,
      [],
    );

    expect(r2.yappyBatches.every((yb) => yb.status === "pending")).toBe(true);
    expect(
      r2.pendingTasks.some(
        (p) => p.taskType === "missing_yappy_report" && p.missingItem.includes("2026-08-05"),
      ),
    ).toBe(true);
    expect(r2.yappyPayments.length).toBe(0);
  });

  // -------------------------------------------------------------
  // T3: Re-downloaded response with another name
  // -------------------------------------------------------------
  it("T3 · re-downloading response with another name collapses without duplicates", () => {
    const loaded = loadBgSamples();
    const duplicatedDetail: BgParsedAchDetail = {
      ...loaded.achDetails.find((a) => a.filename.includes("173909"))!,
      filename: "DETALLETRANSACCIONACH20260821999999.xlsx",
    };
    const r3 = reconcileBancoGeneral(
      loaded.statements,
      [...loaded.achDetails, duplicatedDetail],
      loaded.yappyReports,
    );

    expect(r3.controls.totalBatchesCount).toBe(8);
    expect(r3.controls.settledBatchesCount).toBe(2);
    expect(r3.alerts.some((a) => a.includes("DUPLICADO"))).toBe(true);
    expect(r3.items.filter((i) => i.status === "rejected").length).toBe(386);
  });

  // -------------------------------------------------------------
  // T4: Altered statement -> Quarantine
  // -------------------------------------------------------------
  it("T4 · altered statement cent puts the day in quarantine and prevents false settlements", () => {
    const loaded = loadBgSamples();
    // Alter statement row in copy
    const alteredStatements: BgParsedStatement[] = loaded.statements.map((s) => {
      if (!s.filename.includes("174039")) return s;
      return {
        ...s,
        rows: s.rows.map((r) => {
          if (r.description.includes("ACH - CREDICLARO")) {
            return {
              ...r,
              creditMinor: (r.creditMinor || 0n) + 1n, // +1 cent
            };
          }
          return r;
        }),
      };
    });

    const r4 = reconcileBancoGeneral(
      alteredStatements,
      loaded.achDetails,
      loaded.yappyReports,
    );

    expect(r4.controls.quarantinedDays.includes("2026-08-17")).toBe(true);
    expect(r4.alerts.some((a) => a.includes("CONFLICTO DE SNAPSHOT"))).toBe(true);
    expect(
      r4.batches
        .filter((b) => b.batchDateStr === "20260814")
        .every((b) => b.status !== "settled"),
    ).toBe(true);
  });

  // -------------------------------------------------------------
  // T5: July statements only
  // -------------------------------------------------------------
  it("T5 · operating with July statements only leaves August batches pending due to coverage", () => {
    const loaded = loadBgSamples({
      excludePatterns: ["174026", "174039", "174054"],
    });
    const r5 = reconcileBancoGeneral(
      loaded.statements,
      loaded.achDetails,
      loaded.yappyReports,
    );

    expect(
      r5.batches
        .filter((b) => b.batchDateStr === "20260814")
        .every((b) => b.status === "pending"),
    ).toBe(true);
    expect(
      r5.pendingTasks.some(
        (p) => p.taskType === "missing_statement" && p.missingItem.includes("2026-08-17"),
      ),
    ).toBe(true);
    expect(r5.period).toEqual(["2026-07-01", "2026-07-31"]);
  });

  // -------------------------------------------------------------
  // T6: Manual Assignment resolution
  // -------------------------------------------------------------
  it("T6 · manual assignment resolves an unassigned deposit into received with category and note", () => {
    const loaded = loadBgSamples();
    const base = reconcileBancoGeneral(
      loaded.statements,
      loaded.achDetails,
      loaded.yappyReports,
    );
    const unassignedDep = base.incoming.find(
      (inc) => inc.status === "unassigned" && inc.amount === 100.0,
    )!;
    expect(unassignedDep).toBeDefined();

    const manualAssignments = new Map<string, { category: BgAssignmentCategory; notes: string | null }>();
    manualAssignments.set(unassignedDep.uid, {
      category: "loan",
      notes: "depósito de Juan Pérez cuota auto",
    });

    const r6 = reconcileBancoGeneral(
      loaded.statements,
      loaded.achDetails,
      loaded.yappyReports,
      { manualAssignments },
    );

    const updated = r6.incoming.find((inc) => inc.uid === unassignedDep.uid)!;
    expect(updated.status).toBe("received");
    expect(updated.category).toBe("loan");
    expect(updated.assignmentNotes).toContain("Juan");
    expect(r6.controls.pendingAssignmentCount).toBe(
      base.controls.pendingAssignmentCount - 1,
    );
  });

  // -------------------------------------------------------------
  // T7: UID Stability across layouts
  // -------------------------------------------------------------
  it("T7 · UIDs remain perfectly stable across re-runs and alternative statement layouts", () => {
    const loaded = loadBgSamples();
    const rA = reconcileBancoGeneral(loaded.statements, loaded.achDetails, loaded.yappyReports);
    const rB = reconcileBancoGeneral(loaded.statements, loaded.achDetails, loaded.yappyReports);

    expect(rA.batches.map((b) => b.uid)).toEqual(rB.batches.map((b) => b.uid));
    expect(rA.incoming.map((i) => i.uid)).toEqual(rB.incoming.map((i) => i.uid));
    expect(rA.yappyPayments.map((y) => y.uid)).toEqual(rB.yappyPayments.map((y) => y.uid));

    // Compare running with only layout (a) vs only layout (c)
    const samplesA = loadBgSamples({
      includePatterns: ["174026", "DETALLETRANSACCIONACH20260821", "TRANSACCIONESYAPPY"],
    });
    const samplesC = loadBgSamples({
      includePatterns: ["174054", "DETALLETRANSACCIONACH20260821", "TRANSACCIONESYAPPY"],
    });

    const r7a = reconcileBancoGeneral(samplesA.statements, samplesA.achDetails, samplesA.yappyReports);
    const r7c = reconcileBancoGeneral(samplesC.statements, samplesC.achDetails, samplesC.yappyReports);

    expect(r7a.batches.map((b) => [b.uid, b.totalAmount])).toEqual(
      r7c.batches.map((b) => [b.uid, b.totalAmount]),
    );
    expect(r7a.yappyPayments.map((y) => [y.uid, y.status])).toEqual(
      r7c.yappyPayments.map((y) => [y.uid, y.status]),
    );
  });

  // -------------------------------------------------------------
  // T8: Intraday shorter prefix download
  // -------------------------------------------------------------
  it("T8 · shorter intraday prefix download coexists cleanly with complete statement", () => {
    const loaded = loadBgSamples();
    // Simulate shorter statement from same day
    const fullStmt = loaded.statements.find((s) => s.filename.includes("174026"))!;
    const truncatedStmt: BgParsedStatement = {
      ...fullStmt,
      filename: "MOVIMIENTOSCUENTACORRIENTE20260820120000.xlsx",
      rows: fullStmt.rows.slice(0, 100),
    };

    const r8 = reconcileBancoGeneral(
      [...loaded.statements, truncatedStmt],
      loaded.achDetails,
      loaded.yappyReports,
    );

    expect(r8.controls.quarantinedDays.length).toBe(0);
    expect(r8.controls.coveredDaysCount).toBe(51);
    expect(r8.controls.settledBatchesCount).toBe(2);
  });

  // -------------------------------------------------------------
  // T9: Altered Yappy report amount -> Anomaly
  // -------------------------------------------------------------
  it("T9 · altered Yappy report amount raises anomaly explaining the difference", () => {
    const loaded = loadBgSamples();
    const alteredYappy: BgParsedYappyReport[] = loaded.yappyReports.map((y) => ({
      ...y,
      rows: y.rows.map((r) => {
        if (r.amount === 325.0) {
          return { ...r, amount: 300.0, amountMinor: 30000n };
        }
        return r;
      }),
    }));

    const r9 = reconcileBancoGeneral(
      loaded.statements,
      loaded.achDetails,
      alteredYappy,
    );

    const y9 = r9.yappyBatches.find((yb) => yb.creditDate === "2026-08-06")!;
    expect(y9.status).toBe("anomaly");
    expect(
      r9.alerts.some((a) => a.includes("ANOMALIA YAPPY") && a.includes("2026-08-05")),
    ).toBe(true);
  });

  // -------------------------------------------------------------
  // T10: Fallback unreadable PDF
  // -------------------------------------------------------------
  it("T10 · unreadable PDF does not crash the reconciliation run", () => {
    const loaded = loadBgSamples();
    const unreadablePdf: BgParsedAchDetail = {
      fileType: "ach_detail",
      filename: "TEST_UNREADABLE.pdf",
      variant: "PDF",
      batchName: "TEST_UNREADABLE.pdf",
      batchDateStr: null,
      batchDate: null,
      channel: null,
      isDelinquent: false,
      fortnight: null,
      retryCount: 1,
      effectiveDate: null,
      totalTransactions: null,
      succeededTransactions: null,
      rejectedTransactions: null,
      declaredRejectionsAmountMinor: null,
      downloadedAt: null,
      rows: [],
      rejectedSumMinor: 0n,
      rejectedSum: 0,
      rejectedRowsCount: 0,
      succeededRowsCount: 0,
      succeededSumMinor: 0n,
      succeededSum: 0,
      errors: ["PDF unreadable"],
      isUnreadable: true,
    };

    const r10 = reconcileBancoGeneral(
      loaded.statements,
      [...loaded.achDetails, unreadablePdf],
      loaded.yappyReports,
    );

    expect(r10.controls.settledBatchesCount).toBe(2);
    expect(r10.alerts.some((a) => a.includes("NO LEIDO"))).toBe(true);
  });

  // -------------------------------------------------------------
  // T11: Variant B ("Rechazos") with approvals
  // -------------------------------------------------------------
  it("T11 · Variant B batch with unknown approvals settles with total from credit", () => {
    const variantBDetail: BgParsedAchDetail = {
      fileType: "ach_detail",
      filename: "DETALLETRANSACCIONACH20260901120000.xlsx",
      variant: "B",
      batchName: "20260801 - Crediclaro - LOTE ACH TER 15.txt",
      batchDateStr: "20260801",
      batchDate: "2026-08-01",
      channel: "TER",
      isDelinquent: false,
      fortnight: 15,
      retryCount: 1,
      effectiveDate: "2026-08-03",
      totalTransactions: 2,
      succeededTransactions: null,
      rejectedTransactions: 2,
      declaredRejectionsAmountMinor: 10000n,
      downloadedAt: new Date("2026-09-01T12:00:00Z"),
      rows: [
        {
          routingCode: "0071",
          accountNumber: "111",
          amount: 60.0,
          amountMinor: 6000n,
          clientId: "8-000-000",
          clientName: "CLIENTE 1",
          addenda: "",
          errorCode: "R01",
          errorDescription: "R01 FONDOS INSUFICIENTES",
        },
        {
          routingCode: "0071",
          accountNumber: "222",
          amount: 40.0,
          amountMinor: 4000n,
          clientId: "8-000-000",
          clientName: "CLIENTE 2",
          addenda: "",
          errorCode: "R02",
          errorDescription: "R02 CUENTA CERRADA",
        },
      ],
      rejectedSumMinor: 10000n,
      rejectedSum: 100.0,
      rejectedRowsCount: 2,
      succeededRowsCount: 0,
      succeededSumMinor: 0n,
      succeededSum: 0,
      errors: [],
    };

    const syntheticStatement: BgParsedStatement = {
      fileType: "statement",
      filename: "MOVIMIENTOSCUENTACORRIENTE20260910120000.xlsx",
      layoutTitle: "BGPCheckingMovementsExcel",
      accountNumber: "03-43-01-106691-6",
      companyName: "CREDICLARO, S.A.",
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      downloadedAt: new Date("2026-09-10T12:00:00Z"),
      rows: [
        {
          postedDate: "2026-08-03",
          code: "93",
          description: "ACH - CREDICLARO, S.A.",
          debitMinor: null,
          creditMinor: 50000n,
          balanceMinor: 1050000n,
          ref1: "",
          ref2: "",
        },
        {
          postedDate: "2026-08-03",
          code: "48",
          description: "REVERSAS POR RECHAZOS ACH 20260801 - Cre",
          debitMinor: 10000n,
          creditMinor: null,
          balanceMinor: 1040000n,
          ref1: "",
          ref2: "",
        },
      ],
      errors: [],
    };

    const r11 = reconcileBancoGeneral([syntheticStatement], [variantBDetail], []);
    expect(r11.batches.length).toBe(1);
    const l11 = r11.batches[0];
    expect(l11.status).toBe("settled");
    expect(l11.totalAmount).toBe(500.0);
    expect(l11.rejectedAmount).toBe(100.0);
    expect(l11.succeededAmount).toBe(400.0);
    expect(r11.alerts.some((a) => a.includes("ANOMALIA"))).toBe(false);
  });

  // -------------------------------------------------------------
  // T12: Variants A and B for the same batch
  // -------------------------------------------------------------
  it("T12 · Variants A and B for the SAME batch unify into a single physical batch with Variant A taking precedence", () => {
    const rowsRejected = [
      {
        routingCode: "0071",
        accountNumber: "111",
        amount: 60.0,
        amountMinor: 6000n,
        clientId: "8-000-000",
        clientName: "CLIENTE 1",
        addenda: "",
        errorCode: "R01",
        errorDescription: "R01 FONDOS INSUFICIENTES",
      },
      {
        routingCode: "0071",
        accountNumber: "222",
        amount: 40.0,
        amountMinor: 4000n,
        clientId: "8-000-000",
        clientName: "CLIENTE 2",
        addenda: "",
        errorCode: "R02",
        errorDescription: "R02 CUENTA CERRADA",
      },
    ];

    const variantA: BgParsedAchDetail = {
      fileType: "ach_detail",
      filename: "DETALLETRANSACCIONACH20260901120000.xlsx",
      variant: "A",
      batchName: "20260801 - Crediclaro - LOTE ACH TER 15.txt",
      batchDateStr: "20260801",
      batchDate: "2026-08-01",
      channel: "TER",
      isDelinquent: false,
      fortnight: 15,
      retryCount: 1,
      effectiveDate: "2026-08-03",
      totalTransactions: 3,
      succeededTransactions: 1,
      rejectedTransactions: 2,
      declaredRejectionsAmountMinor: 10000n,
      downloadedAt: new Date("2026-09-01T12:00:00Z"),
      rows: [
        {
          routingCode: "0071",
          accountNumber: "333",
          amount: 400.0,
          amountMinor: 40000n,
          clientId: "8-000-000",
          clientName: "CLIENTE APROBADO",
          addenda: "",
          errorCode: "",
          errorDescription: "",
        },
        ...rowsRejected,
      ],
      rejectedSumMinor: 10000n,
      rejectedSum: 100.0,
      rejectedRowsCount: 2,
      succeededRowsCount: 1,
      succeededSumMinor: 40000n,
      succeededSum: 400.0,
      errors: [],
    };

    const variantB: BgParsedAchDetail = {
      fileType: "ach_detail",
      filename: "DETALLETRANSACCIONACH20260901130000.xlsx",
      variant: "B",
      batchName: "20260801 - Crediclaro - LOTE ACH TER 15.txt",
      batchDateStr: "20260801",
      batchDate: "2026-08-01",
      channel: "TER",
      isDelinquent: false,
      fortnight: 15,
      retryCount: 1,
      effectiveDate: "2026-08-03",
      totalTransactions: 2,
      succeededTransactions: null,
      rejectedTransactions: 2,
      declaredRejectionsAmountMinor: 10000n,
      downloadedAt: new Date("2026-09-01T13:00:00Z"),
      rows: rowsRejected,
      rejectedSumMinor: 10000n,
      rejectedSum: 100.0,
      rejectedRowsCount: 2,
      succeededRowsCount: 0,
      succeededSumMinor: 0n,
      succeededSum: 0,
      errors: [],
    };

    const statement: BgParsedStatement = {
      fileType: "statement",
      filename: "MOVIMIENTOSCUENTACORRIENTE20260910120000.xlsx",
      layoutTitle: "BGPCheckingMovementsExcel",
      accountNumber: "03-43-01-106691-6",
      companyName: "CREDICLARO, S.A.",
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      downloadedAt: new Date("2026-09-10T12:00:00Z"),
      rows: [
        {
          postedDate: "2026-08-03",
          code: "93",
          description: "ACH - CREDICLARO, S.A.",
          debitMinor: null,
          creditMinor: 50000n,
          balanceMinor: 1050000n,
          ref1: "",
          ref2: "",
        },
        {
          postedDate: "2026-08-03",
          code: "48",
          description: "REVERSAS POR RECHAZOS ACH 20260801 - Cre",
          debitMinor: 10000n,
          creditMinor: null,
          balanceMinor: 1040000n,
          ref1: "",
          ref2: "",
        },
      ],
      errors: [],
    };

    const r12 = reconcileBancoGeneral([statement], [variantA, variantB], []);
    expect(r12.batches.length).toBe(1);
    expect(r12.batches[0].variant).toBe("A");
    expect(r12.batches[0].status).toBe("settled");
    expect(r12.items.some((i) => i.status === "confirmed" && i.amount === 400.0)).toBe(true);
    expect(r12.items.filter((i) => i.status === "rejected").length).toBe(2);
    expect(r12.alerts.some((a) => a.includes("REDUNDANTE"))).toBe(true);
    expect(r12.alerts.some((a) => a.includes("REINTENTO"))).toBe(false);
  });

  // -------------------------------------------------------------
  // T13: Arrival order independence
  // -------------------------------------------------------------
  it("T13 · batch UIDs remain completely independent of file arrival order", () => {
    const samplesOnlyRetry3 = loadBgSamples({
      includePatterns: ["DETALLETRANSACCIONACH20260821173909", "174026"],
    });
    const samplesBothRetries = loadBgSamples({
      includePatterns: ["DETALLETRANSACCIONACH20260821", "174026"],
    });

    const r13a = reconcileBancoGeneral(
      samplesOnlyRetry3.statements,
      samplesOnlyRetry3.achDetails,
      samplesOnlyRetry3.yappyReports,
    );
    const r13b = reconcileBancoGeneral(
      samplesBothRetries.statements,
      samplesBothRetries.achDetails,
      samplesBothRetries.yappyReports,
    );

    const uidA = r13a.batches.find((b) => (b.batchName || "").includes("(3).txt"))?.uid;
    const uidB = r13b.batches.find((b) => (b.batchName || "").includes("(3).txt"))?.uid;
    expect(uidA).toBe("lote#20260814#TER15#r3");
    expect(uidB).toBe("lote#20260814#TER15#r3");
  });

  // -------------------------------------------------------------
  // T14: Yappy status maturation
  // -------------------------------------------------------------
  it("T14 · re-downloaded Yappy report matures 'En tránsito' to 'Procesado'", () => {
    const loaded = loadBgSamples();
    const maturedReports: BgParsedYappyReport[] = loaded.yappyReports.map((y) => ({
      ...y,
      filename: "TRANSACCIONESYAPPY20260826090000.xlsx",
      downloadedAt: new Date("2026-08-26T09:00:00Z"),
      rows: y.rows.map((r) => {
        if (r.bankStatus === "En tránsito") {
          return { ...r, bankStatus: "Procesado" };
        }
        return r;
      }),
    }));

    const r14 = reconcileBancoGeneral(
      loaded.statements,
      loaded.achDetails,
      [...loaded.yappyReports, ...maturedReports],
    );

    expect(r14.yappyPayments.some((y) => y.status === "in_transit")).toBe(false);
    expect(
      r14.yappyPayments.some((y) => y.date === "2026-08-24" && y.status === "pending"),
    ).toBe(true);
  });

  // -------------------------------------------------------------
  // T15: Invalid manual assignment UID
  // -------------------------------------------------------------
  it("T15 · manual assignment with non-existent UID raises warning alert without getting lost", () => {
    const loaded = loadBgSamples({ includePatterns: ["174026"] });
    const manualAssignments = new Map<string, { category: BgAssignmentCategory; notes: string | null }>();
    manualAssignments.set("2099-01-01#m999", { category: "loan", notes: "x" });

    const r15 = reconcileBancoGeneral(
      loaded.statements,
      loaded.achDetails,
      loaded.yappyReports,
      { manualAssignments },
    );

    expect(r15.alerts.some((a) => a.includes("ASIGNACION SIN DESTINO"))).toBe(true);
  });

  // -------------------------------------------------------------
  // T16: Two Yappy deposits on the same day
  // -------------------------------------------------------------
  it("T16 · two Yappy deposits on the same day generate distinct ypl UIDs and remain pending without false confirms", () => {
    const syntheticStatement: BgParsedStatement = {
      fileType: "statement",
      filename: "MOVIMIENTOSCUENTACORRIENTE20260910120000.xlsx",
      layoutTitle: "BGPCheckingMovementsExcel",
      accountNumber: "03-43-01-106691-6",
      companyName: "CREDICLARO, S.A.",
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      downloadedAt: new Date("2026-09-10T12:00:00Z"),
      rows: [
        {
          postedDate: "2026-08-04",
          code: "40",
          description: "DEPOSITO YAPPY - financieracrediclaro (1 TRANSACCIONES)",
          debitMinor: null,
          creditMinor: 5000n,
          balanceMinor: 105000n,
          ref1: "",
          ref2: "",
        },
        {
          postedDate: "2026-08-04",
          code: "40",
          description: "DEPOSITO YAPPY - financieracrediclaro (2 TRANSACCIONES)",
          debitMinor: null,
          creditMinor: 8000n,
          balanceMinor: 113000n,
          ref1: "",
          ref2: "",
        },
      ],
      errors: [],
    };

    const r16 = reconcileBancoGeneral([syntheticStatement], [], []);
    const uids = r16.yappyBatches.map((yb) => yb.uid);

    expect(uids.length).toBe(2);
    expect(new Set(uids).size).toBe(2);
    expect(r16.yappyBatches.every((yb) => yb.status === "pending")).toBe(true);
  });
});

