import * as XLSX from "npm:xlsx@0.18.5";
import { formatDayMonthYear, formatDayMonth, REASON_LABELS, round2, FEE_PER_NSF } from "./reconcile.ts";

export function writeReport(res: any, stream: any[], issues: string[], feeTbl: any[]): Uint8Array {
  const wb = XLSX.utils.book_new();

  // 1. Summary Sheet
  const items = res.items;
  const rejects = res.rejects;
  const dmin = items.length > 0 ? items.reduce((min: string, i: any) => i.dateStr < min ? i.dateStr : min, items[0].dateStr) : null;
  const lastDate = res.last_date;

  const resumenData: any[][] = [];
  resumenData.push(["ACH DCD Reconciliation · BAC Credomatic · Junto Soluciones, S.A."]);
  resumenData.push([
    dmin && lastDate
      ? `Period with data: ${formatDayMonthYear(dmin)} - ${formatDayMonthYear(lastDate)} · CONFIRMED requires evidence from next business day`
      : "No data"
  ]);
  resumenData.push([]);

  const cnt = (status: string) => items.filter((i: any) => i.status === status).length;
  const amt = (status: string) => items.filter((i: any) => i.status === status).reduce((sum: number, i: any) => sum + i.credit, 0);

  const sameDayDA = rejects.filter((r: any) => r.src === "mismo-dia");
  const prevDayDA = rejects.filter((r: any) => r.src === "dia-previo");
  const noOriginDA = rejects.filter((r: any) => r.src === "sin-origen");
  const incoming = res.incoming || [];
  const adFeeSum = stream.filter(r => r.code === "AD").reduce((sum, r) => sum + r.debit, 0);
  const txFeeSum = stream.filter(r => r.code === "TX").reduce((sum, r) => sum + r.debit, 0);

  const rows = [
    ["Items sent (PR)", items.length, items.reduce((sum: number, i: any) => sum + i.credit, 0)],
    ["  CONFIRMED (collected)", cnt("CONFIRMED"), amt("CONFIRMED")],
    ["  REJECTED", cnt("REJECTED"), amt("REJECTED")],
    ["  PENDING (awaiting next day)", cnt("PENDING"), amt("PENDING")],
    ["Rejections received (DA)", rejects.length, rejects.reduce((sum: number, r: any) => sum + r.debit, 0)],
    ["  matched same day", sameDayDA.length, sameDayDA.reduce((sum: number, r: any) => sum + r.debit, 0)],
    ["  matched previous business day", prevDayDA.length, prevDayDA.reduce((sum: number, r: any) => sum + r.debit, 0)],
    ["  NO MATCHING PR (review)", noOriginDA.length, noOriginDA.reduce((sum: number, r: any) => sum + r.debit, 0)],
    ["ACH payments received from client (4C/4E) - non-rejectable", incoming.length, incoming.reduce((sum: number, r: any) => sum + r.credit, 0)],
    ["NSF return fees (AD)", "", adFeeSum],
    ["ITBMS tax on fees (TX)", "", txFeeSum]
  ];

  rows.forEach(r => resumenData.push(r));
  resumenData.push([]);
  resumenData.push(["Integrity controls"]);
  
  if (issues.length > 0) {
    issues.forEach(msg => resumenData.push(["! " + msg]));
  } else {
    resumenData.push(["OK Running balance (intra and inter-day), Summary Table, AD fees=0.20xAM04 and TX=trunc(7%) square."]);
  }
  
  resumenData.push([]);
  resumenData.push(["Methodological note: between identical items (same client and amount, twin batches) the batch tag of the rejected attempt is conventional; client, amount, and money are exact."]);

  const wsResumen = XLSX.utils.aoa_to_sheet(resumenData);
  wsResumen["!cols"] = [{ wch: 60 }, { wch: 12 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, wsResumen, "Summary");

  const formatSheet = (headers: string[], widths: number[], rowData: any[][]) => {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rowData]);
    ws["!cols"] = widths.map(w => ({ wch: w }));
    return ws;
  };

  // 2. Submissions (PR)
  const enviosRows = items.map((it: any) => {
    const rj = it.reject;
    return [
      formatDayMonthYear(it.dateStr),
      it.ref,
      it.name_raw,
      it.credit,
      it.status,
      rj ? `${rj.reason} - ${REASON_LABELS[rj.reason as keyof typeof REASON_LABELS] || ""}` : "",
      rj ? rj.ref : "",
      rj ? formatDayMonthYear(rj.dateStr) : "",
      it.reject_lag_bd ?? "",
      it.file
    ];
  });
  const wsEnvios = formatSheet(
    ["Date", "Batch", "Client", "Amount", "Status", "Rejection Reason", "DA Ref", "Rejection Date", "Lag b.d.", "File"],
    [12, 12, 35, 12, 14, 32, 12, 14, 12, 28],
    enviosRows
  );
  XLSX.utils.book_append_sheet(wb, wsEnvios, "Submissions (PR)");

  // 3. Rejections (DA)
  const rechazosRows = rejects.map((rj: any) => {
    const it = rj.matched !== null ? items[rj.matched] : null;
    const obs = rj.ambiguous
      ? "AMBIGUOUS MATCH - review"
      : it
      ? ""
      : "NO MATCHING PR - review";
    return [
      formatDayMonthYear(rj.dateStr),
      rj.ref,
      rj.name_raw,
      rj.debit,
      rj.reason,
      REASON_LABELS[rj.reason as keyof typeof REASON_LABELS] || "",
      rj.src || "",
      it ? it.ref : "",
      it ? formatDayMonthYear(it.dateStr) : "",
      obs
    ];
  });
  const wsRechazos = formatSheet(
    ["Date", "DA Ref", "Client", "Amount", "Reason Code", "Reason Description", "Source", "Origin Batch", "Submission Date", "Observation"],
    [12, 14, 35, 12, 10, 30, 12, 14, 14, 32],
    rechazosRows
  );
  XLSX.utils.book_append_sheet(wb, wsRechazos, "Rejections (DA)");

  // 4. Daily Summary
  const days = Array.from(new Set(stream.map(r => r.dateStr))).sort();
  const diasRows = days.map((d: string) => {
    const prs = items.filter((i: any) => i.dateStr === d);
    const das = rejects.filter((r: any) => r.dateStr === d);
    const ad = stream.filter(r => r.code === "AD" && r.dateStr === d).reduce((sum, r) => sum + r.debit, 0);
    const am04 = das.filter((r: any) => r.reason === "AM04").length;
    const chk = Math.abs(ad - round2(FEE_PER_NSF * am04)) < 0.005 ? "OK" : "REVIEW";
    return [
      formatDayMonthYear(d),
      prs.length,
      prs.reduce((sum: number, i: any) => sum + i.credit, 0),
      das.length,
      das.reduce((sum: number, r: any) => sum + r.debit, 0),
      das.filter((r: any) => r.src === "mismo-dia").length,
      das.filter((r: any) => r.src === "dia-previo").length,
      prs.filter((i: any) => i.status === "CONFIRMED").length,
      prs.filter((i: any) => i.status === "CONFIRMED").reduce((sum: number, i: any) => sum + i.credit, 0),
      prs.filter((i: any) => i.status === "REJECTED").length,
      prs.filter((i: any) => i.status === "PENDING").length,
      ad,
      am04,
      chk,
      incoming.filter((r: any) => r.dateStr === d).length,
      incoming.filter((r: any) => r.dateStr === d).reduce((sum: number, r: any) => sum + r.credit, 0)
    ];
  });
  const wsDias = formatSheet(
    ["Date", "PR count", "PR $", "DA count", "DA $", "DA same day", "DA prev day", "Confirmed count", "Confirmed $", "Rejected count", "Pending count", "AD $", "AM04 count", "Check AD=0.20xAM04", "Inbound ACH count", "Inbound ACH $"],
    [12, 10, 12, 10, 12, 14, 14, 16, 15, 14, 14, 10, 12, 22, 18, 16],
    diasRows
  );
  XLSX.utils.book_append_sheet(wb, wsDias, "Daily Summary");

  // 5. Batches
  const byBatch: Record<string, { d: string; ref: string; its: any[] }> = {};
  items.forEach((it: any) => {
    const key = `${it.dateStr}_${it.ref}`;
    if (!byBatch[key]) {
      byBatch[key] = { d: it.dateStr, ref: it.ref, its: [] };
    }
    byBatch[key].its.push(it);
  });
  const lotesRows = Object.values(byBatch)
    .sort((a, b) => {
      if (a.d !== b.d) return a.d.localeCompare(b.d);
      return a.ref.localeCompare(b.ref);
    })
    .map(({ d, ref, its }) => {
      const tot = its.reduce((sum, i) => sum + i.credit, 0);
      const rej = its.filter(i => i.status === "REJECTED");
      const rejamt = rej.reduce((sum, i) => sum + i.credit, 0);
      return [
        formatDayMonthYear(d),
        ref,
        its.length,
        tot,
        rej.length,
        rejamt,
        its.filter(i => i.status === "CONFIRMED").length,
        its.filter(i => i.status === "PENDING").length,
        tot ? rejamt / tot : 0
      ];
    });
  const wsLotes = formatSheet(
    ["Date", "Batch", "Items", "Amount Sent", "Rejections", "Amount Rejected", "Confirmed", "Pending", "% Rejected (Amount)"],
    [12, 12, 10, 15, 12, 16, 14, 12, 20],
    lotesRows
  );
  XLSX.utils.book_append_sheet(wb, wsLotes, "Batches");

  // 6. Inbound Payments (4C-4E)
  const incomingRows = incoming.map((r: any) => [
    formatDayMonthYear(r.dateStr),
    r.ref,
    r.channel || r.code,
    r.name_raw || "",
    r.credit,
    "RECEIVED"
  ]);
  const wsIncoming = formatSheet(
    ["Date", "Reference", "Channel", "Client (Sender)", "Amount", "Status"],
    [12, 15, 22, 35, 12, 12],
    incomingRows
  );
  XLSX.utils.book_append_sheet(wb, wsIncoming, "Inbound Payments (4C-4E)");

  // 7. Alerts
  const alerts: [string, string][] = [];
  items.forEach((it: any) => {
    if (it.reject_lag_bd && it.reject_lag_bd > 1) {
      alerts.push([
        it.reject.dateStr,
        `LATE REJECTION (${it.reject_lag_bd} b.d.): ${it.name_raw} $${it.credit.toFixed(2)} sent ${formatDayMonth(it.dateStr)} - verify if previously reported as confirmed`
      ]);
    }
  });
  rejects.forEach((rj: any) => {
    if (rj.src === "sin-origen") {
      alerts.push([
        rj.dateStr,
        `DA ${rj.ref} ${rj.name_raw} $${rj.debit.toFixed(2)} (${rj.reason}): NO MATCHING PR in loaded history`
      ]);
    } else if (rj.ambiguous) {
      alerts.push([
        rj.dateStr,
        `DA ${rj.ref} ${rj.name_raw} $${rj.debit.toFixed(2)}: different clients share prefix+amount - attributed to most recent; verify`
      ]);
    }
  });
  feeTbl.forEach((tbl: any) => {
    if (!tbl.total_ok) {
      alerts.push([
        tbl.dateStr,
        `Daily AD fees do not match assigned AM04 - possible incomplete day or uncaptured rejection`
      ]);
    }
  });
  issues.forEach(msg => {
    if (lastDate) {
      alerts.push([lastDate, "INTEGRITY: " + msg]);
    }
  });

  const alertsRows = alerts.sort((a, b) => a[0].localeCompare(b[0])).map(([d, msg]) => [formatDayMonthYear(d), msg]);
  const wsAlertas = formatSheet(
    ["Date", "Alert"],
    [12, 120],
    alertsRows.length > 0 ? alertsRows : [["-", "No alerts: all rejections paired and all controls green."]]
  );
  XLSX.utils.book_append_sheet(wb, wsAlertas, "Alerts");

  const fileData = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
  return fileData;
}
