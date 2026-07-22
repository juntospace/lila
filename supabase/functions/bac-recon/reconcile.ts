import type { BacParsedRow } from "./parser.ts";

export const FEE_PER_NSF = 0.20;
export const ITBMS = 0.07;
export const MIN_PREFIX = 8;
export const HOLIDAYS = new Set<string>();

export const INCOMING_CODES: Record<string, string> = {
  "4C": "ACH entrante",
  "4E": "ACH Xpress entrante",
};

export const REASON_LABELS: Record<string, string> = {
  "AM04": "Fondos insuficientes",
  "AC01": "Número de cuenta incorrecto",
  "AC04": "Cuenta cerrada",
  "AC06": "Cuenta bloqueada",
  "AG01": "Débito no permitido en la cuenta",
  "BE09": "Cuenta inexistente / inválida",
  "MD01": "Sin mandato / no autorizado",
};

export interface FileInput {
  filename: string;
  content: Uint8Array;
}

export function normName(s: string): string {
  const normalized = s.normalize("NFKD");
  const ascii = normalized.replace(/[\u0300-\u036f]/g, "");
  return ascii.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function namesMatch(a: string, b: string, minPrefix: number): boolean {
  if (a === b) {
    return !!a;
  }
  const L = Math.min(a.length, b.length);
  return L >= minPrefix && a.slice(0, L) === b.slice(0, L);
}

export function stringToDate(s: string): Date {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function dateToString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function businessDaysBetween(aStr: string, bStr: string, holidays: Set<string> = new Set()): number {
  const a = stringToDate(aStr);
  const b = stringToDate(bStr);
  let n = 0;
  while (a < b) {
    a.setUTCDate(a.getUTCDate() + 1);
    const dayOfWeek = a.getUTCDay();
    const currentStr = dateToString(a);
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !holidays.has(currentStr)) {
      n++;
    }
  }
  return n;
}

export function formatDayMonth(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}`;
  }
  return dateStr;
}

export function formatDayMonthYear(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

export function round2(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

export function integrityChecks(parsed: any, fileName: string): string[] {
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

  if (parsed.summary) {
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
  }
  return issues;
}

export function crossDayChainCheck(perDateMeta: [string, number | null, number | null][]): string[] {
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

export function feeChecks(stream: any[]): string[] {
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

export function buildStream(parsedFiles: { filename: string; parsed: any }[]): { stream: any[]; issues: string[]; chainOk: Record<string, boolean> } {
  const issues: string[] = [];
  const perDate: Record<string, [number, number, any[], number]> = {};

  for (const item of parsedFiles) {
    const parsed = item.parsed;
    issues.push(...integrityChecks(parsed, item.filename));
    if (!parsed.rows || parsed.rows.length === 0) {
      issues.push(`[${item.filename}] ARCHIVO SIN MOVIMIENTOS: posible descarga fallida; si el dia realmente no tuvo actividad, el empalme de balance entre los dias vecinos lo probara`);
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
    const desc = r.desc || r.description || "";
    if (r.code === "PR") {
      r.name_raw = desc.replace(/^Tef DCD de\s*/i, "").trim();
      r.name = normName(r.name_raw);
    } else if (r.code === "DA") {
      const m = desc.match(/^DVTO\s+([A-Z0-9]{2,4})-(.*)/i);
      r.reason = m ? m[1].toUpperCase() : "?";
      r.name_raw = (m ? m[2] : desc).trim();
      r.name = normName(r.name_raw);
    } else if (r.code && INCOMING_CODES[r.code as keyof typeof INCOMING_CODES]) {
      r.name_raw = desc.replace(/^ACH\s+(CRE|XPR:?)\s*/i, "").trim();
      r.name = normName(r.name_raw);
      r.channel = INCOMING_CODES[r.code as keyof typeof INCOMING_CODES];
    }
  });

  return { stream, issues, chainOk };
}

export function reconcile(stream: any[], minPrefix: number, chainOk: Record<string, boolean>) {
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

export function feeBatchTable(stream: any[], res: any): any[] {
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
