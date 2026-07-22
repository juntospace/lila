import "@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

const FEE_PER_NSF = 0.20;
const ITBMS = 0.07;
const MIN_PREFIX = 8;
const HOLIDAYS = new Set<string>(); // Keep as empty set initially, matching python script

const INCOMING_CODES = {
  "4C": "ACH entrante",
  "4E": "ACH Xpress entrante",
};

const REASON_LABELS = {
  "AM04": "Fondos insuficientes",
  "AC01": "Número de cuenta incorrecto",
  "AC04": "Cuenta cerrada",
  "AC06": "Cuenta bloqueada",
  "AG01": "Débito no permitido en la cuenta",
  "BE09": "Cuenta inexistente / inválida",
  "MD01": "Sin mandato / no autorizado",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface FileInput {
  filename: string;
  content: Uint8Array;
}

function normName(s: string): string {
  const normalized = s.normalize("NFKD");
  const ascii = normalized.replace(/[\u0300-\u036f]/g, ""); // Remove accents
  return ascii.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function namesMatch(a: string, b: string, minPrefix: number): boolean {
  if (a === b) {
    return !!a;
  }
  const L = Math.min(a.length, b.length);
  return L >= minPrefix && a.slice(0, L) === b.slice(0, L);
}

function parseDDMMYYYY(s: string): Date | null {
  const clean = s.trim();
  const m = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Date.UTC(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10)));
}

function dateToString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function stringToDate(s: string): Date {
  const [y, m, day] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function businessDaysBetween(aStr: string, bStr: string, holidays: Set<string> = new Set()): number {
  const a = stringToDate(aStr);
  const b = stringToDate(bStr);
  let n = 0;
  while (a < b) {
    a.setUTCDate(a.getUTCDate() + 1);
    const dayOfWeek = a.getUTCDay(); // 0 = Sunday, 6 = Saturday
    const currentStr = dateToString(a);
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !holidays.has(currentStr)) {
      n++;
    }
  }
  return n;
}

function formatDayMonth(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}`;
  }
  return dateStr;
}

function formatDayMonthYear(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

function round2(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function parseBacXls(content: Uint8Array, fileName: string) {
  const workbook = XLSX.read(content, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true }) as any[][];

  let downloadTs: number | null = null;
  let account: string | null = null;
  let initialBalance: number | null = null;
  let headerRow: number | null = null;

  for (let i = 0; i < grid.length; i++) {
    const row = grid[i] || [];
    const cells = row.map(c => (c !== undefined && c !== null ? String(c).trim() : ""));
    if (cells[0] === "Fecha" && typeof row[1] === "number") {
      downloadTs = row[1];
    }
    if (cells[0] === "Producto") {
      account = row[1] !== undefined && row[1] !== null ? String(row[1]).trim() : "";
    }
    if (cells[0] === "Fecha" && cells.includes("Referencia")) {
      headerRow = i;
    }
  }

  if (headerRow === null) {
    throw new Error(`${fileName}: no se encontro el encabezado de movimientos`);
  }

  const headerCells = grid[headerRow] || [];
  const cols: Record<string, number> = {};
  headerCells.forEach((c, j) => {
    const key = c !== undefined && c !== null ? String(c).trim() : "";
    if (key) {
      cols[key] = j;
    }
  });

  const requiredCols = ["Fecha", "Referencia", "Código", "Descripción", "Débitos", "Créditos", "Balance*"];
  for (const k of requiredCols) {
    if (cols[k] === undefined) {
      throw new Error(`${fileName}: falta columna ${k}`);
    }
  }

  const rows: any[] = [];
  const summary: Record<string, any> = {};
  let inSummary = false;
  let sumCols: number[] | null = null;

  const getVal = (row: any[], colIdx: number): any => {
    if (colIdx === undefined || colIdx >= row.length) return null;
    return row[colIdx];
  };
  const getStr = (row: any[], colIdx: number): string => {
    const val = getVal(row, colIdx);
    return val !== undefined && val !== null ? String(val).trim() : "";
  };
  const getFloat = (row: any[], colIdx: number): number => {
    const val = getVal(row, colIdx);
    if (val === undefined || val === null || val === "") return 0;
    const num = Number(val);
    return isNaN(num) ? 0 : num;
  };

  for (let i = headerRow + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    const c0 = getStr(row, cols["Fecha"]);
    const desc = getStr(row, cols["Descripción"]);

    if (c0 === "Cuadro de Resumen") {
      inSummary = true;
      continue;
    }

    if (inSummary) {
      const labels = row.map(c => (c !== undefined && c !== null ? String(c).trim() : ""));
      const cantCount = labels.filter(l => l === "Cantidad").length;
      const montCount = labels.filter(l => l === "Montos").length;
      if (cantCount === 2 && montCount === 2) {
        sumCols = [];
        labels.forEach((v, j) => {
          if (v === "Cantidad" || v === "Montos") {
            sumCols!.push(j);
          }
        });
        continue;
      }
      if (sumCols && /^[A-Z0-9]{2}$/.test(c0)) {
        try {
          summary[c0] = {
            deb_n: Math.floor(getFloat(row, sumCols[0])),
            deb_amt: getFloat(row, sumCols[1]),
            cred_n: Math.floor(getFloat(row, sumCols[2])),
            cred_amt: getFloat(row, sumCols[3]),
          };
        } catch {
          // ignore
        }
      }
      continue;
    }

    if (desc === "Saldo Inicial") {
      initialBalance = getFloat(row, cols["Balance*"]);
      continue;
    }

    const d = parseDDMMYYYY(c0);
    if (!d) {
      continue;
    }

    const rawRef = getVal(row, cols["Referencia"]);
    let ref = "";
    if (typeof rawRef === "number") {
      ref = String(Math.floor(rawRef));
    } else if (rawRef !== undefined && rawRef !== null) {
      ref = String(rawRef).trim();
    }

    rows.push({
      dateStr: dateToString(d),
      ref,
      code: getStr(row, cols["Código"]),
      desc,
      debit: getFloat(row, cols["Débitos"]),
      credit: getFloat(row, cols["Créditos"]),
      balance: getFloat(row, cols["Balance*"]),
      file: fileName,
    });
  }

  return {
    download_ts: downloadTs || 0.0,
    rows,
    summary,
    initial_balance: initialBalance,
    account,
  };
}

function integrityChecks(parsed: any, fileName: string): string[] {
  const issues: string[] = [];
  const rows = parsed.rows;
  const base = parsed.initial_balance;
  if (base !== null && base !== undefined) {
    let bal = base;
    for (const r of rows) {
      const expected = round2(bal - r.debit + r.credit);
      if (Math.abs(expected - r.balance) > 0.005) {
        issues.push(`[${fileName}] CORTE de balance en ref ${r.ref} (${r.desc.slice(0, 30)}): esperado ${expected.toFixed(2)}, extracto ${r.balance.toFixed(2)}`);
      }
      bal = r.balance;
    }
  }

  const agg: Record<string, [number, number, number, number]> = {};
  for (const r of rows) {
    if (!agg[r.code]) {
      agg[r.code] = [0, 0.0, 0, 0.0];
    }
    const a = agg[r.code];
    if (r.debit) {
      a[0] += 1;
      a[1] += r.debit;
    }
    if (r.credit) {
      a[2] += 1;
      a[3] += r.credit;
    }
  }

  for (const [code, s] of Object.entries(parsed.summary as Record<string, any>)) {
    const a = agg[code] || [0, 0.0, 0, 0.0];
    if (
      s.deb_n !== a[0] ||
      s.cred_n !== a[2] ||
      Math.abs(s.deb_amt - a[1]) > 0.01 ||
      Math.abs(s.cred_amt - a[3]) > 0.01
    ) {
      issues.push(`[${fileName}] Cuadro de Resumen no cuadra para ${code}`);
    }
  }
  return issues;
}

function crossDayChainCheck(perDateMeta: [string, number | null, number | null][]): string[] {
  const issues: string[] = [];
  let prev: [string, number | null] | null = null;
  for (const [d, opening, closing] of perDateMeta) {
    if (prev !== null && opening !== null && prev[1] !== null && Math.abs(opening - prev[1]) > 0.005) {
      issues.push(`Cadena entre dias: cierre ${formatDayMonth(prev[0])} = ${prev[1].toFixed(2)} pero apertura ${formatDayMonth(d)} = ${opening.toFixed(2)} -> puede faltar un dia o movimientos`);
    }
    prev = [d, closing];
  }
  return issues;
}

function feeChecks(stream: any[]): string[] {
  const issues: string[] = [];
  const byDay: Record<string, { ad_lines: number[]; tx_lines: number[]; am04: number }> = {};
  
  for (const r of stream) {
    const dStr = r.dateStr;
    if (!byDay[dStr]) {
      byDay[dStr] = { ad_lines: [], tx_lines: [], am04: 0 };
    }
    const dayData = byDay[dStr];
    if (r.code === "AD") {
      dayData.ad_lines.push(r.debit);
    } else if (r.code === "TX") {
      dayData.tx_lines.push(r.debit);
    } else if (r.code === "DA" && r.reason === "AM04") {
      dayData.am04 += 1;
    }
  }

  const sortedDays = Object.keys(byDay).sort();
  for (const day of sortedDays) {
    const v = byDay[day];
    const tot_ad = round2(v.ad_lines.reduce((sum, a) => sum + a, 0));
    const exp = round2(FEE_PER_NSF * v.am04);
    if (Math.abs(tot_ad - exp) > 0.005) {
      issues.push(`${formatDayMonthYear(day)}: comisiones AD $${tot_ad.toFixed(2)} != ${v.am04} x $${FEE_PER_NSF.toFixed(2)} = $${exp.toFixed(2)} -> dia posiblemente incompleto o rechazo AM04 sin capturar`);
    }
    const exp_tx = round2(v.ad_lines.reduce((sum, a) => sum + Math.floor(round2(a * ITBMS * 100)) / 100, 0));
    const tot_tx = round2(v.tx_lines.reduce((sum, a) => sum + a, 0));
    if (v.ad_lines.length > 0 && Math.abs(tot_tx - exp_tx) > 0.01 * Math.max(1, v.ad_lines.length)) {
      issues.push(`${formatDayMonthYear(day)}: ITBMS TX $${tot_tx.toFixed(2)} != Suma trunc(7%xAD) = $${exp_tx.toFixed(2)}`);
    }
  }
  return issues;
}

function buildStream(files: FileInput[]): { stream: any[]; issues: string[]; chainOk: Record<string, boolean> } {
  const issues: string[] = [];
  const perDate: Record<string, [number, number, any[], number]> = {};

  for (const file of files) {
    const parsed = parseBacXls(file.content, file.filename);
    issues.push(...integrityChecks(parsed, file.filename));
    if (!parsed.rows || parsed.rows.length === 0) {
      issues.push(`[${file.filename}] ARCHIVO SIN MOVIMIENTOS: posible descarga fallida; si el dia realmente no tuvo actividad, el empalme de balance entre los dias vecinos lo probara`);
      continue;
    }
    const byD: Record<string, any[]> = {};
    for (const r of parsed.rows) {
      if (!byD[r.dateStr]) {
        byD[r.dateStr] = [];
      }
      byD[r.dateStr].push(r);
    }
    for (const [dStr, rows] of Object.entries(byD)) {
      const f = rows[0];
      const opening = round2(f.balance + f.debit - f.credit);
      const cand: [number, number, any[], number] = [parsed.download_ts, rows.length, rows, opening];
      if (!perDate[dStr] || cand[0] > perDate[dStr][0] || (cand[0] === perDate[dStr][0] && cand[1] > perDate[dStr][1])) {
        perDate[dStr] = cand;
      }
    }
  }

  const stream: any[] = [];
  const chainMeta: [string, number | null, number | null][] = [];
  const sortedDays = Object.keys(perDate).sort();
  for (const dStr of sortedDays) {
    const rows = perDate[dStr][2];
    stream.push(...rows);
    chainMeta.push([dStr, perDate[dStr][3], rows.length > 0 ? rows[rows.length - 1].balance : null]);
  }

  issues.push(...crossDayChainCheck(chainMeta));

  const chainOk: Record<string, boolean> = {};
  let prev: [string, number | null] | null = null;
  for (const [dStr, opening, closing] of chainMeta) {
    if (prev !== null) {
      const key = `${prev[0]}_${dStr}`;
      chainOk[key] = (opening !== null && prev[1] !== null && Math.abs(opening - prev[1]) <= 0.005);
    }
    prev = [dStr, closing];
  }

  stream.forEach((r, i) => {
    r.seq = i;
    if (r.code === "PR") {
      r.name_raw = r.desc.replace(/^Tef DCD de\s*/i, "").trim();
      r.name = normName(r.name_raw);
    } else if (r.code === "DA") {
      const m = r.desc.match(/^DVTO\s+([A-Z0-9]{2,4})-(.*)/i);
      r.reason = m ? m[1].toUpperCase() : "?";
      r.name_raw = (m ? m[2] : r.desc).trim();
      r.name = normName(r.name_raw);
    } else if (INCOMING_CODES[r.code as keyof typeof INCOMING_CODES]) {
      r.name_raw = r.desc.replace(/^ACH\s+(CRE|XPR:?)\s*/i, "").trim();
      r.name = normName(r.name_raw);
      r.channel = INCOMING_CODES[r.code as keyof typeof INCOMING_CODES];
    }
  });

  return { stream, issues, chainOk };
}

function reconcile(stream: any[], minPrefix: number, chainOk: Record<string, boolean>) {
  const items: any[] = [];
  const rejects: any[] = [];

  for (const r of stream) {
    if (r.code === "PR") {
      items.push({ ...r, status: "PENDIENTE", reject: null });
    } else if (r.code === "DA") {
      rejects.push({ ...r, matched: null, ambiguous: false, src: null });
    }
  }

  const byDayItems: Record<string, number[]> = {};
  items.forEach((it, ix) => {
    if (!byDayItems[it.dateStr]) {
      byDayItems[it.dateStr] = [];
    }
    byDayItems[it.dateStr].push(ix);
  });

  const outstanding = new Set<number>(items.keys());

  for (const rj of rejects) {
    let cands = (byDayItems[rj.dateStr] || []).filter(ix => 
      outstanding.has(ix) &&
      Math.abs(items[ix].credit - rj.debit) < 0.005 &&
      namesMatch(items[ix].name, rj.name, minPrefix)
    );
    let src = "mismo-dia";

    if (cands.length === 0) {
      const prevCands = Array.from(outstanding).filter(ix => 
        items[ix].dateStr < rj.dateStr &&
        Math.abs(items[ix].credit - rj.debit) < 0.005 &&
        namesMatch(items[ix].name, rj.name, minPrefix)
      );
      prevCands.sort((a, b) => {
        if (items[a].dateStr !== items[b].dateStr) {
          return items[b].dateStr.localeCompare(items[a].dateStr);
        }
        return items[b].seq - items[a].seq;
      });
      cands = prevCands;
      src = "dia-previo";
    }

    if (cands.length > 0) {
      const names = Array.from(new Set(cands.map(ix => items[ix].name)));
      let realAmb = false;
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          if (!namesMatch(names[i], names[j], minPrefix)) {
            realAmb = true;
            break;
          }
        }
        if (realAmb) break;
      }

      const ix = cands[0];
      outstanding.delete(ix);
      rj.matched = ix;
      rj.src = src;
      rj.ambiguous = realAmb;

      const it = items[ix];
      it.status = "RECHAZADO";
      it.reject = rj;
      it.reject_lag_bd = businessDaysBetween(it.dateStr, rj.dateStr, HOLIDAYS);
    } else {
      rj.src = "sin-origen";
    }
  }

  const daysPresent = Array.from(new Set(stream.map(r => r.dateStr))).sort();
  const daysWithPr = Array.from(new Set(items.map(it => it.dateStr))).sort();
  const lastDate = stream.length > 0 ? stream.reduce((max, r) => r.dateStr > max ? r.dateStr : max, stream[0].dateStr) : null;

  function confirmable(d: string): boolean {
    for (const e of daysWithPr) {
      if (e <= d) continue;
      const seg = daysPresent.filter(x => x >= d && x <= e);
      let intact = true;
      for (let i = 0; i < seg.length - 1; i++) {
        const key = `${seg[i]}_${seg[i+1]}`;
        if (!chainOk[key]) {
          intact = false;
          break;
        }
      }
      if (intact) return true;
    }
    return false;
  }

  const confCache: Record<string, boolean> = {};
  for (const it of items) {
    if (it.status === "PENDIENTE") {
      const d = it.dateStr;
      if (confCache[d] === undefined) {
        confCache[d] = confirmable(d);
      }
      if (confCache[d]) {
        it.status = "CONFIRMADO";
      }
    }
  }

  const incoming = stream
    .filter(r => !!INCOMING_CODES[r.code as keyof typeof INCOMING_CODES])
    .map(r => ({ ...r, status: "RECIBIDO" }));

  return { items, rejects, incoming, last_date: lastDate };
}

function feeBatchTable(stream: any[], res: any): any[] {
  const items = res.items;
  const feeByDay: Record<string, number[]> = {};
  for (const r of stream) {
    if (r.code === "AD") {
      if (!feeByDay[r.dateStr]) {
        feeByDay[r.dateStr] = [];
      }
      feeByDay[r.dateStr].push(Math.round(r.debit / FEE_PER_NSF));
    }
  }

  const out: any[] = [];
  const sortedDays = Object.keys(feeByDay).sort();
  for (const d of sortedDays) {
    const perBatch: Record<string, number> = {};
    for (const rj of res.rejects) {
      if (rj.dateStr === d && rj.reason === "AM04" && rj.matched !== null) {
        const it = items[rj.matched];
        const key = `${it.ref} (${formatDayMonth(it.dateStr)})`;
        perBatch[key] = (perBatch[key] || 0) + 1;
      }
    }
    const fees = [...feeByDay[d]].sort((a, b) => a - b);
    const got = Object.values(perBatch).sort((a, b) => a - b);
    const sumFees = fees.reduce((sum, x) => sum + x, 0);
    const sumGot = got.reduce((sum, x) => sum + x, 0);

    const splitExact = fees.length === got.length && fees.every((val, index) => val === got[index]);

    out.push({
      dateStr: d,
      fee_counts: fees,
      assigned: perBatch,
      total_ok: sumFees === sumGot,
      split_exact: splitExact,
    });
  }
  return out;
}

function writeReport(res: any, stream: any[], issues: string[], feeTbl: any[]): Uint8Array {
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

export default {
  fetch: async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    try {
      const url = new URL(req.url);
      const formatParam = url.searchParams.get("format") || "xlsx";
      const minPrefixParam = parseInt(url.searchParams.get("min_prefix") || String(MIN_PREFIX), 10);

      const formData = await req.formData();
      const files: FileInput[] = [];

      for (const [key, value] of formData.entries()) {
        if (value instanceof File) {
          const content = new Uint8Array(await value.arrayBuffer());
          files.push({
            filename: value.name,
            content,
          });
        }
      }

      if (files.length === 0) {
        return new Response(
          JSON.stringify({ error: "No se subieron archivos .xls en el multipart/form-data" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { stream, issues: streamIssues, chainOk } = buildStream(files);

      if (stream.length === 0) {
        return new Response(
          JSON.stringify({ error: "Los archivos provistos no contienen movimientos validos" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const res = reconcile(stream, minPrefixParam, chainOk);
      const issues = [...streamIssues, ...feeChecks(stream)];
      const feeTbl = feeBatchTable(stream, res);

      const alerts: [string, string][] = [];
      res.items.forEach((it: any) => {
        if (it.reject_lag_bd && it.reject_lag_bd > 1) {
          alerts.push([
            it.reject.dateStr,
            `RECHAZO TARDÍO (${it.reject_lag_bd} d.h.): ${it.name_raw} $${it.credit.toFixed(2)} enviado ${formatDayMonth(it.dateStr)} - verificar si se reportó como confirmado antes`
          ]);
        }
      });
      res.rejects.forEach((rj: any) => {
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
        if (res.last_date) {
          alerts.push([res.last_date, "INTEGRIDAD: " + msg]);
        }
      });

      if (formatParam.toLowerCase() === "json") {
        const dmin = res.items.length > 0 ? res.items.reduce((min: string, i: any) => i.dateStr < min ? i.dateStr : min, res.items[0].dateStr) : null;
        
        const payload = {
          generated_from: files.map(f => f.filename),
          period: dmin && res.last_date ? [dmin, res.last_date] : [],
          items: res.items.map((i: any) => ({
            date: i.dateStr,
            ref: i.ref,
            name_raw: i.name_raw,
            credit: i.credit,
            status: i.status,
            reject_ref: i.reject ? i.reject.ref : null,
            reject_reason: i.reject ? i.reject.reason : null,
            reject_date: i.reject ? i.reject.dateStr : null,
            reject_lag_bd: i.reject_lag_bd ?? null,
            file: i.file,
          })),
          rejects: res.rejects.map((r: any) => ({
            date: r.dateStr,
            ref: r.ref,
            name_raw: r.name_raw,
            debit: r.debit,
            reason: r.reason,
            src: r.src,
            matched_ref: r.matched !== null && res.items[r.matched] ? res.items[r.matched].ref : null,
            matched_date: r.matched !== null && res.items[r.matched] ? res.items[r.matched].dateStr : null,
            ambiguous: r.ambiguous,
          })),
          incoming: res.incoming.map((r: any) => ({
            date: r.dateStr,
            ref: r.ref,
            channel: r.channel || r.code,
            name_raw: r.name_raw,
            credit: r.credit,
            status: r.status,
          })),
          issues,
          alerts: alerts.sort((a, b) => a[0].localeCompare(b[0])).map(([d, msg]) => [d, msg]),
        };

        return new Response(JSON.stringify(payload), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const reportBytes = writeReport(res, stream, issues, feeTbl);
      return new Response(reportBytes, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="conciliacion_ach.xlsx"',
        },
      });

    } catch (err: any) {
      console.error(err);
      return new Response(
        JSON.stringify({ error: err.message || "Internal Server Error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  },
};
