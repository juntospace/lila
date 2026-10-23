// Benchmark suite for Banco General (CCBG v2) scalability and volume.
// Simulates 1, 3, 6, 12, and 24 months of statements, ACH details, and Yappy reports.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  deserializeBgParsedFile,
  reconcileBancoGeneral,
  serializeBgParsedFile,
  type BgParsedAchDetail,
  type BgParsedStatement,
  type BgParsedYappyReport,
  type BgStatementRow,
  type BgAchDetailRow,
  type BgYappyReportRow,
} from "@/lib/recon/bg";
import { syncSnapshotToDatabase } from "@/lib/recon/bg/snapshot-sync";

function generateSyntheticBgMonth(monthIdx: number): {
  statements: BgParsedStatement[];
  achDetails: BgParsedAchDetail[];
  yappyReports: BgParsedYappyReport[];
} {
  const year = 2026 + Math.floor(monthIdx / 12);
  const m = ((monthIdx % 12) + 1).toString().padStart(2, "0");

  const statements: BgParsedStatement[] = [];
  const achDetails: BgParsedAchDetail[] = [];
  const yappyReports: BgParsedYappyReport[] = [];

  // Each month: 20 business days
  for (let d = 1; d <= 20; d++) {
    const dayStr = d.toString().padStart(2, "0");
    const dateStr = `${year}-${m}-${dayStr}`;

    // 1. Statement: ~70 rows per day (incoming loans, ACH debits, credit cards, reversals)
    const stmtRows: BgStatementRow[] = [];
    for (let r = 0; r < 70; r++) {
      const isAchDebit = r === 0;
      const isAchCreditReversal = r === 1;
      const isYappyDeposit = r === 2;

      let desc = `TRANSF BANCARIA REF 88${monthIdx}${d}${r} DE CLIENTE EJEMPLO ${r}`;
      let debit = 0;
      let credit = 10 + ((r * 13) % 150);

      if (isAchDebit) {
        desc = `PAGO ACH BATCH 2026${m}${dayStr} CCBG`;
        debit = 3500;
        credit = 0;
      } else if (isAchCreditReversal) {
        desc = `DEV ACH RECHAZO BATCH 2026${m}${dayStr}`;
        debit = 0;
        credit = 250;
      } else if (isYappyDeposit) {
        desc = `DEPOSITO YAPPY COMERCIO CREDICLARO`;
        debit = 0;
        credit = 450;
      }

      stmtRows.push({
        postedDate: dateStr,
        code: isAchDebit ? "ACH_DEBIT" : isAchCreditReversal ? "ACH_REV" : "TRANSF",
        description: desc,
        debitMinor: debit > 0 ? BigInt(debit * 100) : null,
        creditMinor: credit > 0 ? BigInt(credit * 100) : null,
        balanceMinor: BigInt((50000 + r * 10) * 100),
        ref1: `REF1-${monthIdx}-${d}-${r}`,
        ref2: `REF2-${monthIdx}-${d}-${r}`,
      });
    }

    statements.push({
      fileType: "statement",
      filename: `MOVIMIENTOS-CUENTA-CORRIENTE-${year}-${m}-${dayStr}.xlsx`,
      layoutTitle: "CUENTA CORRIENTE",
      accountNumber: "03-43-01-106691-6",
      companyName: "CREDICLARO, S.A.",
      startDate: dateStr,
      endDate: dateStr,
      downloadedAt: new Date(`${dateStr}T20:00:00Z`),
      rows: stmtRows,
      errors: [],
    });

    // 2. ACH Detail file for this day
    const achRows: BgAchDetailRow[] = [];
    for (let a = 0; a < 25; a++) {
      achRows.push({
        routingCode: "01",
        accountNumber: `04-01-01-${100000 + a}`,
        amountMinor: 14000n,
        amount: 140,
        clientId: `PE-8-${100 + a}`,
        clientName: `CLIENTE BENEFICIARIO ${a}`,
        addenda: `PAGO ACH ${a}`,
        errorCode: a === 0 ? "R01" : "",
        errorDescription: a === 0 ? "CUENTA CERRADA" : "",
      });
    }

    achDetails.push({
      fileType: "ach_detail",
      filename: `DETALLE-TRANSACCION-ACH-${year}-${m}-${dayStr}-01.xlsx`,
      variant: "A",
      batchName: `BATCH-${year}${m}${dayStr}-01`,
      batchDateStr: `${year}${m}${dayStr}`,
      batchDate: dateStr,
      channel: "TER",
      isDelinquent: false,
      fortnight: d <= 15 ? 15 : 30,
      retryCount: 1,
      effectiveDate: dateStr,
      totalTransactions: 25,
      succeededTransactions: 24,
      rejectedTransactions: 1,
      declaredRejectionsAmountMinor: 14000n,
      downloadedAt: new Date(`${dateStr}T12:00:00Z`),
      rows: achRows,
      rejectedSumMinor: 14000n,
      rejectedSum: 140,
      rejectedRowsCount: 1,
      succeededRowsCount: 24,
      succeededSumMinor: 336000n,
      succeededSum: 3360,
      errors: [],
    });

    // 3. Yappy Report for this day
    const yappyRows: BgYappyReportRow[] = [];
    for (let y = 0; y < 10; y++) {
      yappyRows.push({
        date: dateStr,
        time: "14:30",
        reference: `YAP-REF-${monthIdx}-${d}-${y}`,
        clientName: `PAGADOR YAPPY ${y}`,
        phoneNumber: "61234567",
        comment: "Pago de cuota",
        bankStatus: "Procesado",
        amountMinor: 4500n,
        amount: 45,
      });
    }

    yappyReports.push({
      fileType: "yappy",
      filename: `REPORTE-YAPPY-${year}-${m}-${dayStr}.xlsx`,
      collectionPoint: "@financieracrediclaro",
      downloadedAt: new Date(`${dateStr}T18:00:00Z`),
      rows: yappyRows,
      errors: [],
    });
  }

  return { statements, achDetails, yappyReports };
}

describe("Banco General CCBG v2 · Scalability & Volume Benchmark (Phase B)", () => {
  const scenarios = [
    { months: 1, label: "1 month (~2,000 txns, ~60 files)" },
    { months: 3, label: "3 months (~6,000 txns, ~180 files)" },
    { months: 6, label: "6 months (~12,000 txns, ~360 files)" },
    { months: 12, label: "12 months (~24,000 txns, ~720 files)" },
    { months: 24, label: "24 months (~48,000 txns, ~1,440 files)" },
  ];

  for (const { months, label } of scenarios) {
    it(`evaluates CCBG v2 pipeline for ${label}`, async () => {
      // 1. Generate dataset
      const allStatements: BgParsedStatement[] = [];
      const allAchDetails: BgParsedAchDetail[] = [];
      const allYappyReports: BgParsedYappyReport[] = [];

      for (let m = 0; m < months; m++) {
        const gen = generateSyntheticBgMonth(m);
        allStatements.push(...gen.statements);
        allAchDetails.push(...gen.achDetails);
        allYappyReports.push(...gen.yappyReports);
      }

      const totalFiles = allStatements.length + allAchDetails.length + allYappyReports.length;
      const totalTxns =
        allStatements.reduce((s, st) => s + st.rows.length, 0) +
        allAchDetails.reduce((s, a) => s + a.rows.length, 0) +
        allYappyReports.reduce((s, y) => s + y.rows.length, 0);

      // 2. Benchmark JSON Serialization & Deserialization (parsed_payload Postgres caching)
      const tSer0 = performance.now();
      const serializedFiles: unknown[] = [];
      for (const st of allStatements) serializedFiles.push(serializeBgParsedFile(st));
      for (const ach of allAchDetails) serializedFiles.push(serializeBgParsedFile(ach));
      for (const yap of allYappyReports) serializedFiles.push(serializeBgParsedFile(yap));
      const serTime = performance.now() - tSer0;

      const tDes0 = performance.now();
      const deserializedStatements: BgParsedStatement[] = [];
      const deserializedAchDetails: BgParsedAchDetail[] = [];
      const deserializedYappy: BgParsedYappyReport[] = [];

      for (const payload of serializedFiles) {
        const parsed = deserializeBgParsedFile(payload);
        if (parsed.fileType === "statement") deserializedStatements.push(parsed);
        else if (parsed.fileType === "ach_detail") deserializedAchDetails.push(parsed);
        else if (parsed.fileType === "yappy") deserializedYappy.push(parsed);
      }
      const desTime = performance.now() - tDes0;

      // 3. Benchmark In-Memory CCBG v2 Reconciliation Engine
      const memBefore = process.memoryUsage().heapUsed;
      const tRecon0 = performance.now();
      const snapshot = reconcileBancoGeneral(
        deserializedStatements,
        deserializedAchDetails,
        deserializedYappy,
        { expectedAccount: "03-43-01-106691-6" },
      );
      const reconTime = performance.now() - tRecon0;
      const memAfter = process.memoryUsage().heapUsed;
      const heapDeltaMb = ((memAfter - memBefore) / 1024 / 1024).toFixed(2);

      // 4. Benchmark Database Sync Mock (PostgREST Roundtrip & Row count evaluation)
      let postgrestRoundtrips = 0;
      let totalRowsUpserted = 0;

      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          upsert: vi.fn((rows: unknown[]) => {
            postgrestRoundtrips++;
            totalRowsUpserted += Array.isArray(rows) ? rows.length : 1;
            return Promise.resolve({ error: null });
          }),
          delete: vi.fn().mockReturnValue({
            eq: vi.fn(() => {
              postgrestRoundtrips++;
              return Promise.resolve({ error: null });
            }),
          }),
          insert: vi.fn((rows: unknown[]) => {
            postgrestRoundtrips++;
            totalRowsUpserted += Array.isArray(rows) ? rows.length : 1;
            return Promise.resolve({ error: null });
          }),
        })),
      } as unknown as SupabaseClient;

      const tSync0 = performance.now();
      await syncSnapshotToDatabase(
        mockSupabase,
        "00000000-0000-0000-0000-000000000001",
        snapshot,
      );
      const syncPrepTime = performance.now() - tSync0;

      console.log(`\n======================================================`);
      console.log(`📊 BANCO GENERAL BENCHMARK: ${label.toUpperCase()}`);
      console.log(`======================================================`);
      console.log(`- Total Files: ${totalFiles} | Total Rows/Txns: ${totalTxns.toLocaleString()}`);
      console.log(`- JSON Serialization Time: ${serTime.toFixed(2)} ms`);
      console.log(`- JSON Deserialization Time (Postgres read): ${desTime.toFixed(2)} ms`);
      console.log(`- CCBG v2 Engine CPU Time: ${reconTime.toFixed(2)} ms`);
      console.log(`- Heap Delta: ${heapDeltaMb} MB`);
      console.log(`- Incoming Transferred Detected: ${snapshot.incoming.length}`);
      console.log(`- Settled Batches: ${snapshot.controls.settledBatchesCount}`);
      console.log(`- DB Rows Upserted / Inserted: ${totalRowsUpserted.toLocaleString()}`);
      console.log(`- DB Roundtrips (CHUNK_SIZE=500): ${postgrestRoundtrips} HTTP calls`);
      console.log(`- Sync In-Memory Prep Time: ${syncPrepTime.toFixed(2)} ms`);
      console.log(
        `- Est. Network Latency (at 20ms/roundtrip): ${(
          (postgrestRoundtrips * 20) /
          1000
        ).toFixed(2)} seconds`,
      );

      // Assertions
      expect(snapshot.batches.length).toBeGreaterThan(0);
      expect(snapshot.incoming.length).toBeGreaterThan(0);
      // Performance threshold assertions: ensure in-memory execution stays sub-linear
      const maxAllowedReconMs = months <= 1 ? 600 : months <= 3 ? 1200 : months <= 6 ? 2500 : months <= 12 ? 4000 : 6000;
      expect(reconTime).toBeLessThan(maxAllowedReconMs);
    });
  }
});
