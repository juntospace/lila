import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { detectAndParseBgFile } from "@/lib/recon/bg/parsers/sniffer";
import { reconcileBancoGeneral } from "@/lib/recon/bg/reconcile";
import type {
  BgParsedAchDetail,
  BgParsedStatement,
} from "@/lib/recon/bg/types";

const dir = "/home/carluis/.gemini/antigravity/brain/aa36e7cd-c2b0-4ee8-9908-2b2b41f7c7a0/scratch/cg_files";

describe.runIf(fs.existsSync(dir))("Banco General - Saturday 2026-09-26 ACH Manual Reconcile", () => {
  const stmtPath = path.join(dir, "MOVIMIENTOS-CUENTA-CORRIENTE-2026-09-28-084853.xlsx");

  it("parses and settles all 6 Saturday ACH manual batches with zero anomalies", () => {
    const achFiles = fs.readdirSync(dir).filter((f) => f.startsWith("DETALLE-TRANSACCION-ACH-2026-09-26")).sort();
    // 1. Parse statement
    const stmtBuf = fs.readFileSync(stmtPath);
    const parsedStmt = detectAndParseBgFile(stmtBuf, "MOVIMIENTOS-CUENTA-CORRIENTE-2026-09-28-084853.xlsx") as BgParsedStatement;
    expect(parsedStmt.fileType).toBe("statement");

    // 2. Parse 6 ACH files
    const parsedAchs: BgParsedAchDetail[] = [];
    for (const file of achFiles) {
      const buf = fs.readFileSync(path.join(dir, file));
      const res = detectAndParseBgFile(buf, file) as BgParsedAchDetail;
      expect(res.fileType).toBe("ach_detail");
      expect(res.errors.length).toBe(0);
      parsedAchs.push(res);
    }

    expect(parsedAchs.length).toBe(6);

    // 3. Reconcile
    const snapshot = reconcileBancoGeneral([parsedStmt], parsedAchs, []);

    // 4. Verify Saturday batches
    const satBatches = snapshot.batches.filter((b) => b.batchDateStr === "20260926");
    expect(satBatches.length).toBe(6);

    // None should be in anomaly
    const anomalies = satBatches.filter((b) => b.status === "anomaly");
    expect(anomalies.length).toBe(0);

    // All 6 should be settled
    const settled = satBatches.filter((b) => b.status === "settled");
    expect(settled.length).toBe(6);

    // Succeeded sum across the 6 batches must be exactly $495.00
    const totalSucceeded = satBatches.reduce((sum, b) => sum + (b.succeededAmount || 0), 0);
    expect(Math.abs(totalSucceeded - 495.00)).toBeLessThan(0.01);

    // Check items (debtor cuotas) itemized for Geovanna Rios
    const geovannaItems = snapshot.items.filter((it) => it.clientName.toLowerCase().includes("geovanna"));
    expect(geovannaItems.length).toBeGreaterThanOrEqual(4);
    const geovannaConfirmed = geovannaItems.filter((it) => it.status === "confirmed");
    expect(geovannaConfirmed.length).toBe(4);
    const sumConfirmed = geovannaConfirmed.reduce((s, it) => s + it.amount, 0);
    expect(Math.abs(sumConfirmed - 495.00)).toBeLessThan(0.01);

    // Verify no [RESPONSE CONFLICT] alerts for 2026-09-26
    const conflictAlerts = snapshot.alerts.filter((a) => a.includes("RESPONSE CONFLICT") && a.includes("20260926"));
    expect(conflictAlerts.length).toBe(0);
  });
});
