import * as XLSX from "npm:xlsx@0.18.5";
import { formatDayMonthYear, formatDayMonth, REASON_LABELS, round2, FEE_PER_NSF } from "./reconcile.ts";

export function writeReport(res: any, stream: any[], issues: string[], feeTbl: any[]): Uint8Array {
  const wb = XLSX.utils.book_new();

  // 1. Resumen Sheet
  const items = res.items;
  const rejects = res.rejects;
  const dmin = items.length > 0 ? items.reduce((min: string, i: any) => i.dateStr < min ? i.dateStr : min, items[0].dateStr) : null;
  const lastDate = res.last_date;

  const resumenData: any[][] = [];
  resumenData.push(["Conciliación ACH DCD · BAC Credomatic · Junto Soluciones, S.A."]);
  resumenData.push([
    dmin && lastDate
      ? `Período con datos: ${formatDayMonthYear(dmin)} - ${formatDayMonthYear(lastDate)} · CONFIRMADO requiere evidencia del día hábil siguiente`
      : "Sin datos"
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
    ["Ítems enviados (PR)", items.length, items.reduce((sum: number, i: any) => sum + i.credit, 0)],
    ["  CONFIRMADOS (cobrados)", cnt("CONFIRMADO"), amt("CONFIRMADO")],
    ["  RECHAZADOS", cnt("RECHAZADO"), amt("RECHAZADO")],
    ["  PENDIENTES (aún sin día siguiente)", cnt("PENDIENTE"), amt("PENDIENTE")],
    ["Rechazos recibidos (DA)", rejects.length, rejects.reduce((sum: number, r: any) => sum + r.debit, 0)],
    ["  emparejados mismo día", sameDayDA.length, sameDayDA.reduce((sum: number, r: any) => sum + r.debit, 0)],
    ["  emparejados día hábil previo", prevDayDA.length, prevDayDA.reduce((sum: number, r: any) => sum + r.debit, 0)],
    ["  SIN ORIGEN (revisar)", noOriginDA.length, noOriginDA.reduce((sum: number, r: any) => sum + r.debit, 0)],
    ["Pagos ACH recibidos del cliente (4C/4E) - no rechazables", incoming.length, incoming.reduce((sum: number, r: any) => sum + r.credit, 0)],
    ["Comisiones por devolución NSF (AD)", "", adFeeSum],
    ["ITBMS sobre comisiones (TX)", "", txFeeSum]
  ];

  rows.forEach(r => resumenData.push(r));
  resumenData.push([]);
  resumenData.push(["Controles de integridad"]);
  
  if (issues.length > 0) {
    issues.forEach(msg => resumenData.push(["! " + msg]));
  } else {
    resumenData.push(["OK Balance corrido (intra e inter-día), Cuadro de Resumen, comisiones AD=0.20xAM04 y TX=trunc(7%) cuadran."]);
  }
  
  resumenData.push([]);
  resumenData.push(["Nota metodológica: entre ítems idénticos (mismo cliente y monto, lotes gemelos) la etiqueta de lote del intento rechazado es convencional; cliente, monto y dinero son exactos."]);

  const wsResumen = XLSX.utils.aoa_to_sheet(resumenData);
  wsResumen["!cols"] = [{ wch: 60 }, { wch: 12 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen");

  const formatSheet = (headers: string[], widths: number[], rowData: any[][]) => {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rowData]);
    ws["!cols"] = widths.map(w => ({ wch: w }));
    return ws;
  };

  // 2. Envios (PR)
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
    ["Fecha", "Lote", "Cliente", "Monto", "Estado", "Motivo rechazo", "Ref DA", "Fecha rechazo", "Rezago d.h.", "Archivo"],
    [12, 12, 35, 12, 14, 32, 12, 14, 12, 28],
    enviosRows
  );
  XLSX.utils.book_append_sheet(wb, wsEnvios, "Envios (PR)");

  // 3. Rechazos (DA)
  const rechazosRows = rejects.map((rj: any) => {
    const it = rj.matched !== null ? items[rj.matched] : null;
    const obs = rj.ambiguous
      ? "COINCIDENCIA AMBIGUA - revisar"
      : it
      ? ""
      : "SIN ORIGEN - revisar";
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
    ["Fecha", "Ref DA", "Cliente", "Monto", "Motivo", "Descripción motivo", "Origen", "Lote origen", "Fecha envío", "Observación"],
    [12, 14, 35, 12, 10, 30, 12, 14, 14, 32],
    rechazosRows
  );
  XLSX.utils.book_append_sheet(wb, wsRechazos, "Rechazos (DA)");

  // 4. Dias
  const days = Array.from(new Set(stream.map(r => r.dateStr))).sort();
  const diasRows = days.map((d: string) => {
    const prs = items.filter((i: any) => i.dateStr === d);
    const das = rejects.filter((r: any) => r.dateStr === d);
    const ad = stream.filter(r => r.code === "AD" && r.dateStr === d).reduce((sum, r) => sum + r.debit, 0);
    const am04 = das.filter((r: any) => r.reason === "AM04").length;
    const chk = Math.abs(ad - round2(FEE_PER_NSF * am04)) < 0.005 ? "OK" : "REVISAR";
    return [
      formatDayMonthYear(d),
      prs.length,
      prs.reduce((sum: number, i: any) => sum + i.credit, 0),
      das.length,
      das.reduce((sum: number, r: any) => sum + r.debit, 0),
      das.filter((r: any) => r.src === "mismo-dia").length,
      das.filter((r: any) => r.src === "dia-previo").length,
      prs.filter((i: any) => i.status === "CONFIRMADO").length,
      prs.filter((i: any) => i.status === "CONFIRMADO").reduce((sum: number, i: any) => sum + i.credit, 0),
      prs.filter((i: any) => i.status === "RECHAZADO").length,
      prs.filter((i: any) => i.status === "PENDIENTE").length,
      ad,
      am04,
      chk,
      incoming.filter((r: any) => r.dateStr === d).length,
      incoming.filter((r: any) => r.dateStr === d).reduce((sum: number, r: any) => sum + r.credit, 0)
    ];
  });
  const wsDias = formatSheet(
    ["Fecha", "PR n", "PR $", "DA n", "DA $", "DA mismo dia", "DA dia previo", "Confirmados n", "Confirmados $", "Rechazados n", "Pendientes n", "AD $", "AM04 n", "Chequeo AD=0.20xAM04", "ACH recib. n", "ACH recib. $"],
    [12, 8, 12, 8, 12, 14, 14, 14, 15, 14, 14, 10, 10, 22, 12, 14],
    diasRows
  );
  XLSX.utils.book_append_sheet(wb, wsDias, "Dias");

  // 5. Lotes
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
      const rej = its.filter(i => i.status === "RECHAZADO");
      const rejamt = rej.reduce((sum, i) => sum + i.credit, 0);
      return [
        formatDayMonthYear(d),
        ref,
        its.length,
        tot,
        rej.length,
        rejamt,
        its.filter(i => i.status === "CONFIRMADO").length,
        its.filter(i => i.status === "PENDIENTE").length,
        tot ? rejamt / tot : 0
      ];
    });
  const wsLotes = formatSheet(
    ["Fecha", "Lote", "Ítems", "Monto enviado", "Rechazados", "Monto rechazado", "Confirmados", "Pendientes", "% rechazo (monto)"],
    [12, 12, 10, 15, 12, 16, 14, 12, 18],
    lotesRows
  );
  XLSX.utils.book_append_sheet(wb, wsLotes, "Lotes");

  // 6. Creditos (4C-4E)
  const incomingRows = incoming.map((r: any) => [
    formatDayMonthYear(r.dateStr),
    r.ref,
    r.channel || r.code,
    r.name_raw || "",
    r.credit,
    "RECIBIDO"
  ]);
  const wsIncoming = formatSheet(
    ["Fecha", "Referencia", "Canal", "Cliente (remitente)", "Monto", "Estado"],
    [12, 15, 22, 35, 12, 12],
    incomingRows
  );
  XLSX.utils.book_append_sheet(wb, wsIncoming, "Creditos (4C-4E)");

  // 7. Alertas
  const alerts: [string, string][] = [];
  items.forEach((it: any) => {
    if (it.reject_lag_bd && it.reject_lag_bd > 1) {
      alerts.push([
        it.reject.dateStr,
        `RECHAZO TARDÍO (${it.reject_lag_bd} d.h.): ${it.name_raw} $${it.credit.toFixed(2)} enviado ${formatDayMonth(it.dateStr)} - verificar si se reportó como confirmado antes`
      ]);
    }
  });
  rejects.forEach((rj: any) => {
    if (rj.src === "sin-origen") {
      alerts.push([
        rj.dateStr,
        `DA ${rj.ref} ${rj.name_raw} $${rj.debit.toFixed(2)} (${rj.reason}): SIN ORIGEN en el histórico cargado`
      ]);
    } else if (rj.ambiguous) {
      alerts.push([
        rj.dateStr,
        `DA ${rj.ref} ${rj.name_raw} $${rj.debit.toFixed(2)}: clientes distintos comparten prefijo+monto - atribución al más reciente; verificar`
      ]);
    }
  });
  feeTbl.forEach((tbl: any) => {
    if (!tbl.total_ok) {
      alerts.push([
        tbl.dateStr,
        `Comisiones AD del día no cuadran con AM04 asignados - posible día incompleto o rechazo sin capturar`
      ]);
    }
  });
  issues.forEach(msg => {
    if (lastDate) {
      alerts.push([lastDate, "INTEGRIDAD: " + msg]);
    }
  });

  const alertsRows = alerts.sort((a, b) => a[0].localeCompare(b[0])).map(([d, msg]) => [formatDayMonthYear(d), msg]);
  const wsAlertas = formatSheet(
    ["Fecha", "Alerta"],
    [12, 120],
    alertsRows.length > 0 ? alertsRows : [["-", "Sin alertas: todos los rechazos emparejados y controles en verde."]]
  );
  XLSX.utils.book_append_sheet(wb, wsAlertas, "Alertas");

  const fileData = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
  return fileData;
}
