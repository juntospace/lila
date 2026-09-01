// Vitest integration suite for Banco General (CCBG v2) on 14 real sample files (T0).

import { describe, expect, it } from "vitest";

import {
  reconcileBancoGeneral,
  toCanonicalJsonContract,
} from "@/lib/recon/bg";

import { loadBgSamples } from "./fixtures/load-samples";

describe("Banco General CCBG v2 · T0 Real Samples Suite", () => {
  const loaded = loadBgSamples();
  const res = reconcileBancoGeneral(
    loaded.statements,
    loaded.achDetails,
    loaded.yappyReports,
  );
  const contract = toCanonicalJsonContract(res);
  const controls = res.controls;

  it("detects expected account and company name", () => {
    expect(res.accountNumber).toBe("03-43-01-106691-6");
    expect(res.companyName).toBe("CREDICLARO, S.A.");
  });

  it("calculates 51 days of coverage from 2026-07-01 to 2026-08-20 without quarantine", () => {
    expect(res.period).toEqual(["2026-07-01", "2026-08-20"]);
    expect(controls.coveredDaysCount).toBe(51);
    expect(controls.quarantinedDays.length).toBe(0);
    expect(controls.provisionalCoverageDays.length).toBe(0);
  });

  it("identifies 8 ACH batches with exactly 2 settled to the penny", () => {
    expect(controls.totalBatchesCount).toBe(8);
    expect(controls.settledBatchesCount).toBe(2);
  });

  it("settles batch 20260814 retry (2) with $3,939.20 total, $3,939.20 rejected, $0.00 realized", () => {
    const batch2 = res.batches.find((b) => (b.batchName || "").includes("(2).txt"));
    expect(batch2).toBeDefined();
    expect(batch2?.status).toBe("settled");
    expect(batch2?.totalAmount).toBe(3939.2);
    expect(batch2?.rejectedAmount).toBe(3939.2);
    expect(batch2?.succeededAmount).toBe(0.0);
  });

  it("settles batch 20260814 retry (3) with own credit and reversal without double consumption", () => {
    const batch2 = res.batches.find((b) => (b.batchName || "").includes("(2).txt"))!;
    const batch3 = res.batches.find((b) => (b.batchName || "").includes("(3).txt"))!;
    expect(batch3).toBeDefined();
    expect(batch3.status).toBe("settled");
    expect(batch3.creditMovUid).not.toBe(batch2.creditMovUid);
    expect(batch3.reversalsMovUids).not.toEqual(batch2.reversalsMovUids);
  });

  it("generates [REINTENTO] alert for batch 20260814", () => {
    expect(res.alerts.some((a) => a.includes("REINTENTO") && a.includes("20260814"))).toBe(true);
  });

  it("handles batch '20260229' with non-existent calendar date and effective date 2026-03-02 as pending", () => {
    const batch29 = res.batches.find((b) => (b.batchName || "").includes("20260229"));
    expect(batch29).toBeDefined();
    expect(batch29?.status).toBe("pending");
    expect(batch29?.effectiveDate).toBe("2026-03-02");

    // $332 approval item (MIGUEL) is pending
    const hasPending332 = res.items.some(
      (i) => i.amount === 332.0 && i.batchUid === batch29?.uid && i.status === "pending",
    );
    expect(hasPending332).toBe(true);
  });

  it("itemizes 386 rejected installments and zero confirmed without a settled batch", () => {
    const rejectedItems = res.items.filter((i) => i.status === "rejected");
    expect(rejectedItems.length).toBe(386);

    for (const item of res.items) {
      if (item.status === "confirmed") {
        const parent = res.batches.find((b) => b.uid === item.batchUid);
        expect(parent?.status).toBe("settled");
      }
    }
  });

  it("verifies conservation of money (total - rejected = net) across all batches", () => {
    expect(controls.batchesConservation).toBe("OK");
  });

  it("verifies uninterrupted balance chain and inter-day continuity", () => {
    expect(res.alerts.some((a) => a.includes("CORTE") || a.includes("CADENA"))).toBe(false);
  });

  it("reconciles Yappy batch on 2026-08-06: $491.00 across 3 transactions from 05-ago with 1.07% fee", () => {
    const y6 = res.yappyBatches.find((yb) => yb.creditDate === "2026-08-06");
    expect(y6).toBeDefined();
    expect(y6?.status).toBe("settled");
    expect(y6?.creditAmount).toBe(491.0);
    expect(y6?.reportCount).toBe(3);
    expect(y6?.transactionDate).toBe("2026-08-05");
    expect(y6?.feeAmount).toBe(5.25);
  });

  it("reconciles Yappy batch on Sunday 2026-08-16 (T+1 calendar including Sundays)", () => {
    const ySun = res.yappyBatches.find((yb) => yb.creditDate === "2026-08-16");
    expect(ySun).toBeDefined();
    expect(ySun?.status).toBe("settled");
  });

  it("squares 14 Yappy deposits and leaves uncovered July deposits as pending", () => {
    expect(controls.settledYappyBatchesCount).toBe(14);
    const missingYappy = res.pendingTasks.filter((pt) => pt.taskType === "missing_yappy_report");
    expect(missingYappy.length).toBeGreaterThanOrEqual(20);
  });

  it("flags Yappy payments for 20-22 Aug as pending statement coverage (21-23 Aug)", () => {
    const missingStmt = res.pendingTasks.filter(
      (pt) => pt.taskType === "missing_statement" && pt.missingItem.includes("2026-08-21"),
    );
    expect(missingStmt.length).toBeGreaterThan(0);
  });

  it("does not count 'En tránsito' payments as received", () => {
    for (const yp of res.yappyPayments) {
      if (yp.bankStatus === "En tránsito") {
        expect(yp.status).toBe("in_transit");
      }
    }
  });

  it("identifies known incoming payment: ACH XPRESS YAZIEL $1,300 on 2026-08-10 as received", () => {
    const yaziel = res.incoming.find(
      (inc) => inc.channel === "ACH Xpress" && inc.amount === 1300.0 && inc.date === "2026-08-10",
    );
    expect(yaziel).toBeDefined();
    expect(yaziel?.status).toBe("received");
  });

  it("extracts loan reference CAPASU00004006 from Yasmin $50.00 transfer on 2026-08-01", () => {
    const yasmin = res.incoming.find(
      (inc) => inc.amount === 50.0 && inc.date === "2026-08-01" && inc.detectedLoanRef === "CAPASU00004006",
    );
    expect(yasmin).toBeDefined();
  });

  it("places LA LLANADA rent in unassigned queue (received without loan suggestion)", () => {
    const llanada = res.incoming.find(
      (inc) => inc.counterpart.includes("LLANADA") && inc.status === "received",
    );
    expect(llanada).toBeDefined();
    expect(llanada?.suggestion).toBeNull();
    expect(llanada?.category).toBeNull();
  });

  it("identifies exactly 8 anonymous deposits totaling $549.37 as unassigned", () => {
    expect(controls.unassignedCount).toBe(8);
    expect(controls.unassignedTotalAmount).toBe(549.37);
  });

  it("inherits loan suggestion by recurrence for RAJM daily ACH counterpart", () => {
    const rajmList = res.incoming.filter((inc) => inc.counterpart.includes("RAJM"));
    expect(rajmList.length).toBeGreaterThan(0);
    for (const item of rajmList) {
      expect(["loan", "loan_probable"]).toContain(item.suggestion);
    }
  });

  it("formats canonical JSON contract with exact expected field names", () => {
    expect(contract.version).toBe("ccbg-2.0");
    expect(contract.cuenta).toBe("03-43-01-106691-6");
    expect(contract.empresa).toBe("CREDICLARO, S.A.");
    expect(Array.isArray(contract.batches)).toBe(true);
    expect(Array.isArray(contract.items)).toBe(true);
    expect(Array.isArray(contract.yappy_lotes)).toBe(true);
    expect(Array.isArray(contract.yappy)).toBe(true);
    expect(Array.isArray(contract.incoming)).toBe(true);
  });
});
