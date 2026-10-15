import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  detectAndParseBgFile,
  reconcileBancoGeneral,
  type BgParsedStatement,
  type BgParsedAchDetail,
  type BgParsedYappyReport,
} from "@/lib/recon/bg";

const SAMPLES_DIR = "/home/carluis/Downloads/conciliacion-crediclaro-bg_v2.0/samples";

describe("Direct verification of /samples directory", () => {
  it("processes all sample files directly and verifies confirmed metrics and alerts", () => {
    const filenames = fs.readdirSync(SAMPLES_DIR);
    console.log(`\nFound ${filenames.length} files in ${SAMPLES_DIR}`);

    const statements: BgParsedStatement[] = [];
    const achDetails: BgParsedAchDetail[] = [];
    const yappyReports: BgParsedYappyReport[] = [];

    for (const name of filenames) {
      const filePath = path.join(SAMPLES_DIR, name);
      if (fs.statSync(filePath).isDirectory()) continue;
      const bytes = new Uint8Array(fs.readFileSync(filePath));
      const parsed = detectAndParseBgFile(bytes, name);
      if (!parsed) {
        console.log(`  - [IGNORED / OTHER]: ${name}`);
        continue;
      }
      console.log(`  + [${parsed.fileType.toUpperCase()}]: ${name} (${parsed.rows.length} rows)`);
      if (parsed.fileType === "statement") statements.push(parsed);
      else if (parsed.fileType === "ach_detail") achDetails.push(parsed);
      else if (parsed.fileType === "yappy") yappyReports.push(parsed);
    }

    console.log(`\nParsed: ${statements.length} statements, ${achDetails.length} ACH details, ${yappyReports.length} Yappy reports.`);

    const snapshot = reconcileBancoGeneral(statements, achDetails, yappyReports, {
      expectedAccount: "03-43-01-106691-6",
    });

    console.log("\n=== CONTROLS ===");
    console.log("Total Batches:", snapshot.controls.totalBatchesCount);
    console.log("Settled Batches:", snapshot.controls.settledBatchesCount);
    console.log("Total Yappy Batches:", snapshot.controls.totalYappyBatchesCount);
    console.log("Settled Yappy Batches:", snapshot.controls.settledYappyBatchesCount);

    // Incoming loans for 2026-09-14 to 2026-09-15
    const sep1415Incoming = snapshot.incoming.filter(
      (i) => i.date >= "2026-09-14" && i.date <= "2026-09-15"
    );
    const confirmedIncoming = sep1415Incoming.filter((i) => i.status === "received");
    const pendingIncoming = sep1415Incoming.filter((i) => i.status !== "received");

    const sumConfirmedIncoming =
      confirmedIncoming.reduce((s, i) => s + Number(i.amountMinor), 0) / 100;

    console.log("\n=== SEPT 14-15 INCOMING LOAN TRANSFERS ===");
    console.log(`Confirmed count: ${confirmedIncoming.length}, Sum: $${sumConfirmedIncoming.toFixed(2)}`);
    console.log(
      `Pending count: ${pendingIncoming.length}, Sum: $${(
        pendingIncoming.reduce((s, i) => s + Number(i.amountMinor), 0) / 100
      ).toFixed(2)}`
    );

    // Yappy batches for Sept 14-15
    const sep1415Yappy = snapshot.yappyBatches.filter(
      (y) => y.creditDate >= "2026-09-14" && y.creditDate <= "2026-09-15"
    );
    console.log("\n=== SEPT 14-15 YAPPY BATCHES ===");
    for (const y of sep1415Yappy) {
      console.log(
        `  - Date: ${y.creditDate}, Status: ${y.status}, Count: ${y.declaredCount}, Credit: $${y.creditAmount.toFixed(
          2
        )}, MovUid: ${y.creditMovUid}`
      );
    }

    const aug2425Yappy = snapshot.yappyBatches.filter(
      (y) => y.creditDate >= "2026-08-24" && y.creditDate <= "2026-08-26"
    );
    console.log("\n=== AUG 24-26 YAPPY BATCHES ===", aug2425Yappy);

    const totalConfirmedCount = confirmedIncoming.length + sep1415Yappy.length;
    const totalConfirmedSum =
      sumConfirmedIncoming + sep1415Yappy.reduce((s, y) => s + y.creditAmount, 0);

    console.log("\n=== TOTAL CONFIRMED (TRANSFERS + YAPPY) SEPT 14-15 ===");
    console.log(`Total Count: ${totalConfirmedCount}`);
    console.log(`Total Sum $: ${totalConfirmedSum.toFixed(2)}`);

    console.log("\n=== AUDIT ALERTS (ALL) ===");
    for (const a of snapshot.alerts) {
      console.log(`  ! ${a}`);
    }

    // Assertions
    expect(totalConfirmedCount).toBe(67);
    expect(Math.abs(totalConfirmedSum - 3393.25)).toBeLessThan(0.01);
    expect(confirmedIncoming.length).toBe(66);
    expect(sep1415Yappy.length).toBe(1);
    expect(sep1415Yappy[0].creditAmount).toBe(78.82);
  });
});
