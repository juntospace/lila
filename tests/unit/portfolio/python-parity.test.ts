import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { enrichLoan, enrichRepayments } from "@/lib/portfolio/enrich";
import { buildCollectionsPlan } from "@/lib/portfolio/collections";
import { generateCollectionsWorkbook } from "@/lib/portfolio/excel";
import {
  collectSeries,
  computeMigrationMatrix,
  computeVisibility,
  delinqAgg,
} from "@/lib/portfolio/board-compute";
import {
  assembleBoardDataset,
  type BoardDataset,
  type BoardHistLoanInput,
  type BoardLoanInput,
  type BoardRepaymentInput,
} from "@/lib/portfolio/board";
import type { ActionPlanItem, ActionPlanSummary } from "@/lib/portfolio/types";

function parseSimpleCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length === 0) return [];
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx] ?? "";
    });
    return row;
  });
}

describe("Python mathematical parity (end-to-end fixture suite)", () => {
  const fixturesDir = path.join(process.cwd(), "tests/fixtures/portfolio/parity");
  const expectedPath = path.join(fixturesDir, "expected/expected.json");
  const loansMayPath = path.join(fixturesDir, "loans_2025-05-31.csv");

  if (!fs.existsSync(loansMayPath) || !fs.existsSync(expectedPath)) {
    execFileSync(
      "python3",
      [path.join(process.cwd(), "scripts/portfolio/export_python_expected.py")],
      { cwd: process.cwd(), stdio: "inherit" }
    );
  }

  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as {
    futureExcludedCount: number;
    DATA: BoardDataset;
    plan: ActionPlanItem[];
    resumen: ActionPlanSummary;
  };

  const loansMayRaw = parseSimpleCsv(
    fs.readFileSync(loansMayPath, "utf8")
  );
  const loansJunRaw = parseSimpleCsv(
    fs.readFileSync(path.join(fixturesDir, "loans_2025-06-30.csv"), "utf8")
  );
  const repsJunRaw = parseSimpleCsv(
    fs.readFileSync(path.join(fixturesDir, "repayments_2025-06-30.csv"), "utf8")
  );

  const enrichedMay = loansMayRaw.map((r) => enrichLoan(r));
  const enrichedJun = loansJunRaw.map((r) => enrichLoan(r));
  const { repayments: enrichedReps, futureExcludedCount } = enrichRepayments(
    repsJunRaw,
    "2025-06-30"
  );

  const loansData: BoardLoanInput[] = enrichedJun.map((l) => ({
    source_loan_id: l.loanId,
    loan_number: l.loanNumber,
    full_name: l.fullName,
    product: l.product,
    segment: l.segment,
    segment_idx: l.segmentIdx,
    balance: l.balance,
    dpd: l.dpd,
    bucket_idx: l.bucketIdx,
    released_date: l.releasedDate,
    is_open: l.isOpen,
    pending_due: l.pendingDue,
    total_due_amount: l.totalDueAmount,
    installments_count: l.installmentsCount,
    cycle_type: l.cycleType,
    tg: l.tg,
    tc: l.tc,
    gc: l.gc,
    mr: l.mr,
  }));

  const histLoans: BoardHistLoanInput[] = [
    ...enrichedMay
      .filter((l) => l.isOpen)
      .map((l) => ({
        snapshot_date: "2025-05-31",
        source_loan_id: l.loanId,
        segment: l.segment,
        bucket_idx: l.bucketIdx,
        balance: l.balance,
        dpd: l.dpd,
      })),
    ...enrichedJun
      .filter((l) => l.isOpen)
      .map((l) => ({
        snapshot_date: "2025-06-30",
        source_loan_id: l.loanId,
        segment: l.segment,
        bucket_idx: l.bucketIdx,
        balance: l.balance,
        dpd: l.dpd,
      })),
  ];

  const repaymentsInput: BoardRepaymentInput[] = enrichedReps.map((r) => ({
    source_loan_id: r.loanId,
    collection_date: r.collectionDate,
    principal_amount: r.principalAmount,
    ingresos_amount: r.ingresosAmount,
    is_real: r.isReal,
  }));

  const tsDataset = assembleBoardDataset({
    asof: "2025-06-30",
    snapshotDates: ["2025-05-31", "2025-06-30"],
    loansData,
    histLoans,
    repayments: repaymentsInput,
  });

  const prevBucketMap: Record<string, number> = {};
  for (const l of enrichedMay) {
    if (l.isOpen) prevBucketMap[l.loanId] = l.bucketIdx;
  }
  const lastRealMap: Record<string, string> = {};
  for (const rep of enrichedReps) {
    if (rep.isReal) {
      const prev = lastRealMap[rep.loanId];
      if (!prev || rep.collectionDate > prev) {
        lastRealMap[rep.loanId] = rep.collectionDate;
      }
    }
  }

  const tsActions = buildCollectionsPlan({
    loans: enrichedJun,
    asOfDate: "2025-06-30",
    prevBucketMap,
    lastRealPaymentMap: lastRealMap,
    hasRepaymentsFile: true,
    prevDate: "2025-05-31",
  });

  it("validates fixture scale (> 1,500 loans and > 5,000 repayments)", () => {
    expect(enrichedMay.length).toBeGreaterThan(1500);
    expect(enrichedJun.length).toBeGreaterThan(1500);
    expect(enrichedReps.length).toBeGreaterThan(5000);
    expect(futureExcludedCount).toBe(expected.futureExcludedCount);
  });

  it("matches Board DATA.filtVals, combos, snapshots, loanIds, and products 100% against Python", () => {
    expect(tsDataset.filtVals).toEqual(expected.DATA.filtVals);
    expect(tsDataset.combos).toEqual(expected.DATA.combos);
    expect(tsDataset.snapshots).toEqual(expected.DATA.snapshots);
    expect(tsDataset.loanIds).toEqual(expected.DATA.loanIds);
    expect(tsDataset.products).toEqual(expected.DATA.products);
  });

  it("matches Board DATA.payM, payD, delinq, and details to the cent against Python", () => {
    expect(tsDataset.payM).toEqual(expected.DATA.payM);
    expect(tsDataset.payD).toEqual(expected.DATA.payD);
    expect(tsDataset.delinq).toEqual(expected.DATA.delinq);
    expect(tsDataset.details).toEqual(expected.DATA.details);
  });

  it("matches Collections plan and resumen 100% against Python generar_acciones.py", () => {
    expect(tsActions.resumen).toEqual(expected.resumen);
    expect(tsActions.plan.length).toBe(expected.plan.length);
    expect(tsActions.plan).toEqual(expected.plan);
  });

  it("computes Board View transposition, KPIs, and Section 04/05 aggregates consistently", () => {
    const { comboVis, loanVis, visibleOpenLoans } = computeVisibility(tsDataset, {
      selectedSegs: new Set(tsDataset.segments),
      filterTg: new Set(tsDataset.filtVals.tg),
      filterTc: new Set(tsDataset.filtVals.tc),
      filterGc: new Set(tsDataset.filtVals.gc),
      filterMr: new Set(tsDataset.filtVals.mr),
    });

    expect(visibleOpenLoans.length).toBe(expected.resumen.abiertos);
    const totalActiveBal = visibleOpenLoans.reduce(
      (sum, l) => sum + Number(l.d[3]),
      0
    );
    expect(Math.round(totalActiveBal * 100) / 100).toBe(
      Math.round(expected.resumen.saldo * 100) / 100
    );

    // Verify migration matrix rows are destination buckets (fin \ inicio)
    const mig = computeMigrationMatrix(
      tsDataset,
      loanVis,
      "2025-05-31",
      "2025-06-30"
    );
    expect(mig).not.toBeNull();
    expect(mig!.dA).toBe("2025-05-31");
    expect(mig!.dB).toBe("2025-06-30");
    expect(mig!.rows.length).toBe(7);

    // Verify Section 04 and Section 05 computations
    const col = collectSeries(tsDataset, loanVis, "M", "2025-04-01", "2025-06-30");
    expect(col.totalCollected).toBeGreaterThan(0);
    expect(col.totalScheduled).toBeGreaterThan(0);

    const del = delinqAgg(tsDataset, comboVis, "2025-05-31", "2025-06-30", "M", "todo");
    expect(del.rawPoints.length).toBe(2);
    expect(del.deltaCer30).not.toBeNull();
  });

  it("verifies generated .xlsx workbook sheets, headers, and cell values against expected plan & resumen", async () => {
    const buf = await generateCollectionsWorkbook(
      tsActions.plan,
      tsActions.resumen,
      "2025-06-30",
      "v1.0"
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);

    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Hoy",
      "Todos los accionables",
      "Resumen",
    ]);

    const wsTodos = wb.getWorksheet("Todos los accionables")!;
    // Header is on row 4, data rows start on row 5
    expect(wsTodos.rowCount).toBe(expected.plan.length + 4);

    // Check first, middle, and last row cell-by-cell against expected.plan
    const indicesToCheck = [0, Math.floor(expected.plan.length / 2), expected.plan.length - 1];
    for (const idx of indicesToCheck) {
      const exp = expected.plan[idx];
      const excelRow = wsTodos.getRow(idx + 5);
      expect(excelRow.getCell(1).value).toBe(`P${exp.prio}`);
      expect(excelRow.getCell(2).value).toBe(exp.loanno);
      expect(excelRow.getCell(3).value).toBe(exp.cliente);
      expect(excelRow.getCell(4).value).toBe(exp.cel);
      expect(excelRow.getCell(5).value).toBe(exp.seg);
      expect(Number(excelRow.getCell(6).value)).toBe(exp.dpd);
      expect(excelRow.getCell(7).value).toBe(exp.tramo);
      expect(Number(excelRow.getCell(8).value)).toBeCloseTo(exp.saldo, 2);
      expect(Number(excelRow.getCell(9).value)).toBeCloseTo(exp.cura, 2);
      expect(excelRow.getCell(10).value).toBe(exp.ultpago);
      expect(excelRow.getCell(11).value).toBe(exp.motivo);
    }

    const wsResumen = wb.getWorksheet("Resumen")!;
    expect(wsResumen.getCell("A1").value).toBe("Resumen");
    expect(wsResumen.getCell("A1").font?.color).toBeUndefined();
    expect(wsResumen.getCell("A2").value).toBe("Política v1.0");
    expect(wsResumen.getCell("B5").value).toBe(expected.resumen.abiertos);
    expect(Number(wsResumen.getCell("B6").value)).toBeCloseTo(expected.resumen.saldo, 2);
    expect(wsResumen.getCell("B7").value).toBe(expected.resumen.accionables);
  });
});
