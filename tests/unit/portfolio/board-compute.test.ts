import { describe, expect, it } from "vitest";

import { buildBoardDatasetFromEnriched } from "@/lib/portfolio/board";
import {
  addMonths,
  collectSeries,
  computeMigrationMatrix,
  computeRangeAndGranularity,
  computeVisibility,
  delinqAgg,
  fbtnLabel,
} from "@/lib/portfolio/board-compute";
import { enrichLoans, enrichRepayments } from "@/lib/portfolio/enrich";
import { fetchAll } from "@/lib/portfolio/fetch-all";

describe("lib/portfolio/board-compute · Pure Board Report Computations", () => {
  it("clamps addMonths to the last day of the target month (leap & non-leap years)", () => {
    // Non-leap year 2025: Jan 31 + 1 month -> Feb 28
    expect(addMonths("2025-01-31", 1)).toBe("2025-02-28");
    // Leap year 2024: Jan 31 + 1 month -> Feb 29
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    // Jan 31 + 3 months -> Apr 30
    expect(addMonths("2025-01-31", 3)).toBe("2025-04-30");
    // Year boundary
    expect(addMonths("2025-11-15", 2)).toBe("2026-01-15");
  });

  it("computes fbtnLabel for dimension dropdowns", () => {
    const all = ["Automóvil", "Moto", "NA", "(sin dato)"];
    expect(fbtnLabel(new Set(all), all)).toBe("Todas");
    expect(fbtnLabel(new Set(["Moto"]), all)).toBe("Moto");
    expect(fbtnLabel(new Set(["Automóvil", "Moto"]), all)).toBe("2/4");
  });

  it("computes range, granularity, default asof-90, and daily fallback note", () => {
    const meta = {
      asof: "2025-06-30",
      firstMonth: "2024-01",
      dailyStart: "2024-05-26",
    };

    // Default custom range uses asof - 90 days (2025-04-01)
    const rDefault = computeRangeAndGranularity(meta, "rango", "", "");
    expect(rDefault.effStart).toBe("2025-04-01");
    expect(rDefault.effEnd).toBe("2025-06-30");
    expect(rDefault.gran).toBe("W"); // 90 days -> W

    // Custom short range before dailyStart falls back from W/D to M with note
    const rBeforeDaily = computeRangeAndGranularity(
      meta,
      "rango",
      "2024-02-01",
      "2024-02-20",
    );
    expect(rBeforeDaily.gran).toBe("M");
    expect(rBeforeDaily.granNote).toContain("Sin detalle diario antes de");
  });

  it("computes collectSeries (Cobrado vs. Programado) for monthly and daily loans", () => {
    const loans = enrichLoans([
      {
        "Loan Id": "L1",
        "Loan #": "LN-1",
        "Full Name": "Cliente Mensual",
        "Loan Product": "Personal con Garantía",
        "Balance Amount": "1000",
        "Days Past Due": "0",
        "Released Date": "31/01/2025",
        "Loan Duration": "6 Months",
        "Repayment Cycle": "Monthly",
        "Total Due Amount": "1200", // 6 installments of $200 on 2025-02-28, 03-31, 04-30, 05-31, 06-30, 07-31
        "Loan Status Name": "Current",
      },
      {
        "Loan Id": "L2",
        "Loan #": "LN-2",
        "Full Name": "Cliente Diario",
        "Loan Product": "Adelanto",
        "Balance Amount": "500",
        "Days Past Due": "0",
        "Released Date": "25/06/2025",
        "Loan Duration": "10 Days",
        "Repayment Cycle": "Daily",
        "Total Due Amount": "1000", // 10 daily installments of $100 starting 2025-06-26..2025-07-05
        "Loan Status Name": "Current",
      },
    ]);

    const { repayments } = enrichRepayments(
      [
        {
          "Loan Id": "L1",
          "Collection Date": "15/06/2025",
          "Principal Paid Amount": "160",
          "Interest Paid Amount": "40",
          "Payment Method": "ACH",
        },
        {
          "Loan Id": "L2",
          "Collection Date": "27/06/2025",
          "Principal Paid Amount": "350",
          "Interest Paid Amount": "50",
          "Payment Method": "Yappy",
        },
      ],
      "2025-06-30",
    );

    const ds = buildBoardDatasetFromEnriched({
      asof: "2025-06-30",
      snapshotsByDate: { "2025-06-30": loans },
      repayments,
    });

    const vis = computeVisibility(ds, {
      selectedSegs: new Set(ds.segments),
      filterTg: new Set(ds.filtVals.tg),
      filterTc: new Set(ds.filtVals.tc),
      filterGc: new Set(ds.filtVals.gc),
      filterMr: new Set(ds.filtVals.mr),
    });

    // Monthly granularity for June 2025:
    // L1 has 1 installment due on 2025-06-30 ($200)
    // L2 has 5 daily installments due on 2025-06-26..2025-06-30 (5 * $100 = $500; July installments > asof are excluded)
    // Total scheduled in 2025-06 = $700; Total collected in 2025-06 = $200 + $400 = $600
    const resM = collectSeries(ds, vis.loanVis, "M", "2025-06-01", "2025-06-30");
    expect(resM.totalCollected).toBe(600);
    expect(resM.totalScheduled).toBe(700);
    expect(resM.efficiencyPct).toBeCloseTo((600 / 700) * 100, 1);
    expect(resM.buckets[0].payDrillRows.length).toBe(2);
    expect(resM.buckets[0].expDrillRows.length).toBe(2);
  });

  it("computes CeR 30+ delta and transposed migration matrix (fin \\ inicio)", () => {
    const snapMay = enrichLoans([
      {
        "Loan Id": "1",
        "Loan #": "LN-1",
        "Full Name": "A",
        "Loan Product": "Personal",
        "Balance Amount": "1000",
        "Days Past Due": "15", // 1-30 (bucketIdx 1)
        "Past Due": "100",
        "Pending Due": "100",
        "Loan Status Name": "Arrears",
      },
      {
        "Loan Id": "2",
        "Loan #": "LN-2",
        "Full Name": "B",
        "Loan Product": "Personal",
        "Balance Amount": "1000",
        "Days Past Due": "45", // 31-60 (bucketIdx 2) -> CeR 30+ in May is 1000/2000 = 50%
        "Past Due": "200",
        "Pending Due": "200",
        "Loan Status Name": "Arrears",
      },
    ]);

    const snapJun = enrichLoans([
      {
        "Loan Id": "1",
        "Loan #": "LN-1",
        "Full Name": "A",
        "Loan Product": "Personal",
        "Balance Amount": "1000",
        "Days Past Due": "40", // Rolled from 1-30 (idx 1) to 31-60 (idx 2)
        "Past Due": "150",
        "Pending Due": "150",
        "Loan Status Name": "Arrears",
      },
      {
        "Loan Id": "2",
        "Loan #": "LN-2",
        "Full Name": "B",
        "Loan Product": "Personal",
        "Balance Amount": "1000",
        "Days Past Due": "70", // Rolled from 31-60 (idx 2) to 61-90 (idx 3) -> CeR 30+ in Jun is 100%
        "Past Due": "300",
        "Pending Due": "300",
        "Loan Status Name": "Arrears",
      },
    ]);

    const ds = buildBoardDatasetFromEnriched({
      asof: "2025-06-30",
      snapshotsByDate: {
        "2025-05-31": snapMay,
        "2025-06-30": snapJun,
      },
      repayments: [],
    });

    const vis = computeVisibility(ds, {
      selectedSegs: new Set(ds.segments),
      filterTg: new Set(ds.filtVals.tg),
      filterTc: new Set(ds.filtVals.tc),
      filterGc: new Set(ds.filtVals.gc),
      filterMr: new Set(ds.filtVals.mr),
    });

    const delinq = delinqAgg(
      ds,
      vis.comboVis,
      "2025-05-01",
      "2025-06-30",
      "M",
      "mes",
    );
    // May CeR 30+ = 50%, Jun CeR 30+ = 100% -> delta = +50.0 pp
    expect(delinq.deltaCer30).toBe(50.0);
    expect(delinq.deltaLabel).toBe("vs mes ant.");

    // Transposed migration matrix: rows[endIdx][startIdx]
    const mat = computeMigrationMatrix(
      ds,
      vis.loanVis,
      "2025-05-01",
      "2025-06-30",
    )!;
    expect(mat.dA).toBe("2025-05-31");
    expect(mat.dB).toBe("2025-06-30");
    // Loan "1": started at idx 1 (1-30), ended at idx 2 (31-60) -> mat.rows[2][1] = ["1"]
    expect(mat.rows[2][1]).toEqual(["1"]);
    // Loan "2": started at idx 2 (31-60), ended at idx 3 (61-90) -> mat.rows[3][2] = ["2"]
    expect(mat.rows[3][2]).toEqual(["2"]);
  });

  it("paginates past 1000 rows using fetchAll (2,500 loans and 5,000 repayments)", async () => {
    const totalLoans = 2500;
    const allLoanRows = Array.from({ length: totalLoans }, (_, i) => ({
      id: i + 1,
    }));

    const fetchedLoans = await fetchAll<{ id: number }>(async (from, to) => ({
      data: allLoanRows.slice(from, to + 1),
      error: null,
    }));
    expect(fetchedLoans.length).toBe(2500);
    expect(fetchedLoans[2499].id).toBe(2500);

    const totalReps = 5000;
    const allRepRows = Array.from({ length: totalReps }, (_, i) => ({
      id: i + 1,
    }));

    const fetchedReps = await fetchAll<{ id: number }>(async (from, to) => ({
      data: allRepRows.slice(from, to + 1),
      error: null,
    }));
    expect(fetchedReps.length).toBe(5000);
    expect(fetchedReps[4999].id).toBe(5000);
  });
});

