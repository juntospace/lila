import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  groupDABatches,
  groupPRBatches,
  linkAllBatches,
  type DARowForBatch,
  type PRRowForBatch,
} from "@/lib/recon/bac/batches";
import {
  extractPRPayerName,
  namesMatch,
  normalizeName,
} from "@/lib/recon/bac/classify";
import { parseBACSheet } from "@/lib/recon/bac/parser";

describe("Scalability and Volume Benchmark", () => {
  // Benchmark scenarios: N = 1,000 and N = 10,000 for standard runs,
  // 50,000+ available with high timeout.
  const volumes = [1_000, 10_000];

  for (const N of volumes) {
    it(`evaluates Recompute linking with N = ${N.toLocaleString()} transactions`, () => {
      const prCount = Math.floor(N * 0.85); // 85% PRs
      const daCount = Math.floor(N * 0.15); // 15% DAs

      const sampleNames = [
        "JUAN CARLOS PEREZ GOMEZ",
        "MARIA ELENA LOPEZ SANCHEZ",
        "DISTRIBUIDORA Y SERVICIOS PANAMA SA",
        "CORPORACION AGROPECUARIA CHIRIQUI SA",
        "ALEXANDER JOSUE RODRIGUEZ",
        "SUPERMERCADO Y ABARROTERIA EL SOL",
        "ANA SOFIA CASTILLO DE LEON",
        "TRANSPORTES UNIDOS DEL PACIFICO RL",
      ];

      // Generate synthetic PRs
      const unpairedPRs: PRRowForBatch[] = [];
      for (let i = 0; i < prCount; i++) {
        const name = sampleNames[i % sampleNames.length];
        const day = 1 + (i % 28);
        const dayStr = day < 10 ? `0${day}` : `${day}`;
        const ref = `${6000000 + Math.floor(i / 10)}`; // Batches of ~10 PRs per reference
        unpairedPRs.push({
          id: `pr-${i}`,
          posted_at: `2026-04-${dayStr}`,
          reference: ref,
          amountMinor: BigInt(5000 + ((i * 17) % 20000)), // $50 to $250
          description: `Tef DCD de ${name}`,
          normPayerName: normalizeName(name),
        });
      }

      // Generate synthetic DAs
      const unpairedDAs: DARowForBatch[] = [];
      for (let i = 0; i < daCount; i++) {
        const name = sampleNames[i % sampleNames.length];
        const day = 1 + (i % 28);
        const dayStr = day < 10 ? `0${day}` : `${day}`;
        const ref = `${7000000 + i}`;
        unpairedDAs.push({
          id: `da-${i}`,
          posted_at: `2026-04-${dayStr}`,
          reference: ref,
          amountMinor: BigInt(5000 + ((i * 17) % 20000)),
          payerNameRaw: name,
          normPayerName: normalizeName(name),
        });
      }

      // Measure memory and time
      const memBefore = process.memoryUsage().heapUsed;
      const t0 = performance.now();

      // Step A: Grouping
      const tA0 = performance.now();
      const prBatches = groupPRBatches(unpairedPRs);
      const daBatches = groupDABatches(unpairedDAs);
      const tA = performance.now() - tA0;

      // Step B: Batch linking
      const tB0 = performance.now();
      const linkResult = linkAllBatches(prBatches, daBatches, {
        nameMatcher: (pr, da) => namesMatch(pr, da),
        normalize: normalizeName,
        extractPRPayer: extractPRPayerName,
      });
      const tB = performance.now() - tB0;

      // Step C: FIFO Matching pass
      const tC0 = performance.now();
      const allPairings: { prId: string; daId: string }[] = [];
      const batchMatchedDaIds = new Set<string>();
      for (const link of linkResult.links) {
        for (const p of link.pairings) {
          allPairings.push(p);
          batchMatchedDaIds.add(p.daId);
        }
      }
      const batchPairedPrIds = new Set(allPairings.map((p) => p.prId));
      const remainingPRs = unpairedPRs.filter((p) => !batchPairedPrIds.has(p.id));

      const prsByAmount = new Map<bigint, PRRowForBatch[]>();
      for (const pr of remainingPRs) {
        const list = prsByAmount.get(pr.amountMinor) ?? [];
        list.push(pr);
        prsByAmount.set(pr.amountMinor, list);
      }
      const tC = performance.now() - tC0;

      const totalTimeMs = performance.now() - t0;
      const memAfter = process.memoryUsage().heapUsed;
      const memDeltaMB = (memAfter - memBefore) / (1024 * 1024);

      // Estimated PostgREST network round trips
      const readPages = Math.ceil(N / 1000);
      const linkInsertChunks = Math.ceil(allPairings.length / 100);
      const stateUpdateChunks = Math.ceil((unpairedPRs.length + unpairedDAs.length) / 100);
      const totalEstimatedRequests = readPages + linkInsertChunks + stateUpdateChunks;
      const estimatedNetworkLatencyMs = totalEstimatedRequests * 25; // 25ms per roundtrip

      console.log(`\n======================================================`);
      console.log(`📊 BENCHMARK N = ${N.toLocaleString()} TRANSACTIONS`);
      console.log(`======================================================`);
      console.log(`- CPU Grouping: ${tA.toFixed(2)} ms`);
      console.log(`- CPU Batch Linking: ${tB.toFixed(2)} ms`);
      console.log(`- CPU FIFO Prep: ${tC.toFixed(2)} ms`);
      console.log(`- Total CPU Time: ${totalTimeMs.toFixed(2)} ms`);
      console.log(`- Heap Delta: ${memDeltaMB.toFixed(2)} MB`);
      console.log(`- Paired count: ${allPairings.length}`);
      console.log(`- PostgREST Roundtrips Required: ${totalEstimatedRequests} requests`);
      console.log(`  (Read: ${readPages}, Link Inserts: ${linkInsertChunks}, State Updates: ${stateUpdateChunks})`);
      console.log(`- Est. Network Overhead (at 25ms/req): ${(estimatedNetworkLatencyMs / 1000).toFixed(2)} seconds`);

      expect(totalTimeMs).toBeGreaterThan(0);
      expect(prBatches.length).toBeGreaterThan(0);
    });
  }

  // 2. Excel Parsing and SheetJS memory benchmark
  it("evaluates Excel generation, reading, and parsing performance", () => {
    const rowCounts = [1_000, 5_000, 10_000];

    for (const count of rowCounts) {
      const rows: unknown[][] = [
        ["Estado de Cuenta"],
        ["Cliente", "BENCHMARK CORP SA"],
        ["Cuenta", "100412600"],
        ["Moneda", "USD"],
        ["Período", "01/04/2026 - 30/04/2026"],
        ["Saldo Inicial", "10,000.00"],
        ["Saldo Final", "50,000.00"],
        [],
        ["Fecha", "Referencia", null, "Código", "Descripción", null, "Débitos", "Créditos", "Balance"],
      ];

      for (let i = 0; i < count; i++) {
        const isCredit = i % 5 !== 0;
        rows.push([
          "15/04/2026",
          `${6000000 + i}`,
          null,
          isCredit ? "PR" : "DA",
          `Tef DCD de CLIENTE SINTETICO NUMERO ${i}`,
          null,
          isCredit ? "" : "150.00",
          isCredit ? "150.00" : "",
          "25,000.00",
        ]);
      }

      // Generate binary
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const bytes = new Uint8Array(wbout);
      const sizeKB = bytes.byteLength / 1024;

      // Measure XLSX.read (SheetJS parsing)
      const memBefore = process.memoryUsage().heapUsed;
      const tRead0 = performance.now();
      const readWb = XLSX.read(bytes, { type: "array", cellDates: true });
      const tRead = performance.now() - tRead0;

      // Measure sheet_to_json
      const tJson0 = performance.now();
      const sheet = readWb.Sheets[readWb.SheetNames[0]];
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][];
      const tJson = performance.now() - tJson0;

      // Measure parseBACSheet
      const tParse0 = performance.now();
      const parsed = parseBACSheet(matrix);
      const tParse = performance.now() - tParse0;

      const memAfter = process.memoryUsage().heapUsed;
      const memDeltaMB = (memAfter - memBefore) / (1024 * 1024);

      console.log(`\n======================================================`);
      console.log(`📄 EXCEL BENCHMARK: ${count.toLocaleString()} ROWS`);
      console.log(`======================================================`);
      console.log(`- File Size: ${(sizeKB / 1024).toFixed(2)} MB (${sizeKB.toFixed(1)} KB)`);
      console.log(`- SheetJS XLSX.read: ${tRead.toFixed(2)} ms`);
      console.log(`- sheet_to_json conversion: ${tJson.toFixed(2)} ms`);
      console.log(`- BAC Domain Matrix Parsing: ${tParse.toFixed(2)} ms`);
      console.log(`- Total Ingest Prep Time: ${(tRead + tJson + tParse).toFixed(2)} ms`);
      console.log(`- Heap Delta: ${memDeltaMB.toFixed(2)} MB`);
      console.log(`- Rows Parsed: ${parsed.rows.length}`);

      expect(parsed.rows.length).toBe(count);
    }
  });
});
