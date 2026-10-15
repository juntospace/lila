// Board Report Data Aggregator & Server-side Loader
// Assembles all data required for the 6 Board Report sections

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  BUCKET_COLORS,
  BUCKETS,
  HANDOVER_DATE,
  PROV_RATES,
  SEGMENTS,
  SIN_DATO,
  TG_VALS,
  TC_VALS,
  GC_VALS,
  MR_VALS,
} from "./enrich";
import type { PortfolioBucket, PortfolioSegment } from "./types";

export interface BoardLoanDetail {
  id: string;
  name: string;
  product: string;
  productIdx: number;
  segmentIdx: number;
  balance: number;
  dpd: number;
  bucketIdx: number;
  released: string; // YYYY-MM-DD
  isOpen: number; // 1 or 0
  loanNumber: string;
  pendingDue: number;
  comboIdx: number;
  totalDue: number;
  installments: number;
  cycle: number; // 0: monthly, 1: daily
}

export interface BoardDataset {
  asof: string;
  handover: string;
  dailyStart: string;
  firstMonth: string;
  segments: PortfolioSegment[];
  buckets: PortfolioBucket[];
  bucketColors: string[];
  provRates: number[];
  combos: number[][]; // [segIdx, tgIdx, tcIdx, gcIdx, mrIdx]
  filtVals: {
    tg: string[];
    tc: string[];
    gc: string[];
    mr: string[];
  };
  payM: Record<string, [number, number, number][]>; // month -> [[loanPos, prin, inc], ...]
  payD: Record<string, [number, number, number][]>; // day -> [[loanPos, prin, inc], ...]
  delinq: { date: string; ci: number; d30: number; d90: number; tot: number }[];
  loanIds: string[];
  products: string[];
  details: Record<string, (string | number)[]>;
  snapshots: Record<string, string>; // date -> string of bucket digits per loan pos
  warnings?: string[];
}

export async function loadBoardDataset(
  supabase: SupabaseClient,
  entityCode = "crediclaro",
  targetDate?: string,
): Promise<BoardDataset | null> {
  // 1. Resolve entity
  const { data: entity } = await supabase
    .from("portfolio_entities")
    .select("id")
    .eq("code", entityCode)
    .maybeSingle();

  if (!entity) return null;
  const entityId = entity.id;

  // 2. Fetch target snapshot (or latest)
  let snapQuery = supabase
    .from("portfolio_snapshots")
    .select("*")
    .eq("entity_id", entityId)
    .order("snapshot_date", { ascending: false });

  if (targetDate) {
    snapQuery = snapQuery.eq("snapshot_date", targetDate);
  }

  const { data: latestSnapshots } = await snapQuery.limit(1);
  if (!latestSnapshots || latestSnapshots.length === 0) {
    return null;
  }
  const currentSnap = latestSnapshots[0];
  const asof = currentSnap.snapshot_date;

  // 3. Fetch all historical snapshots for entity (for migration & delinq series)
  const { data: allSnapshots } = await supabase
    .from("portfolio_snapshots")
    .select("id, snapshot_date")
    .eq("entity_id", entityId)
    .order("snapshot_date", { ascending: true });

  const snapshotList = allSnapshots || [];

  // 4. Fetch all loans for current snapshot
  const { data: loansData, error: loansErr } = await supabase
    .from("portfolio_loans")
    .select("*")
    .eq("snapshot_id", currentSnap.id);

  if (loansErr || !loansData) {
    throw new Error(`Failed loading loans: ${loansErr?.message}`);
  }

  // 5. Fetch all historical snapshot loan buckets (for transition matrix & delinq)
  const { data: histLoansData } = await supabase
    .from("portfolio_loans")
    .select("snapshot_date, source_loan_id, segment, bucket_idx, balance, dpd")
    .eq("entity_id", entityId)
    .eq("is_open", true);

  const histLoans = histLoansData || [];

  // 6. Fetch repayments for current snapshot
  const { data: repaymentsData } = await supabase
    .from("portfolio_loan_repayments")
    .select("*")
    .eq("snapshot_id", currentSnap.id)
    .eq("is_real", true);

  const repayments = repaymentsData || [];

  // Assemble universe of loans
  const loansMap = new Map<string, (typeof loansData)[number]>();
  for (const l of loansData) {
    loansMap.set(l.source_loan_id, l);
  }

  const histLoanIds = new Set(histLoans.map((h) => h.source_loan_id));
  const universeSet = new Set<string>([...loansMap.keys(), ...histLoanIds]);
  const loanIds = Array.from(universeSet).sort((a, b) =>
    a.length === b.length ? a.localeCompare(b) : a.length - b.length,
  );
  const loanPos = new Map<string, number>();
  loanIds.forEach((id, idx) => loanPos.set(id, idx));

  // Products
  const productsSet = new Set<string>();
  for (const l of loansData) {
    if (l.product) productsSet.add(l.product);
  }
  const products = Array.from(productsSet).sort();
  const productIdxMap = new Map<string, number>();
  products.forEach((p, idx) => productIdxMap.set(p, idx));

  // Build filter lists
  const seenTg = new Set(TG_VALS);
  const seenTc = new Set(TC_VALS);
  const seenGc = new Set(GC_VALS);
  const seenMr = new Set(MR_VALS);

  for (const l of loansData) {
    if (l.tg) seenTg.add(l.tg);
    if (l.tc) seenTc.add(l.tc);
    if (l.gc) seenGc.add(l.gc);
    if (l.mr) seenMr.add(l.mr);
  }

  const filtVals = {
    tg: [...Array.from(seenTg), SIN_DATO],
    tc: [...Array.from(seenTc), SIN_DATO],
    gc: [...Array.from(seenGc), SIN_DATO],
    mr: [...Array.from(seenMr), SIN_DATO],
  };

  const fidx = {
    tg: new Map(filtVals.tg.map((v, i) => [v, i])),
    tc: new Map(filtVals.tc.map((v, i) => [v, i])),
    gc: new Map(filtVals.gc.map((v, i) => [v, i])),
    mr: new Map(filtVals.mr.map((v, i) => [v, i])),
  };

  // Combos
  const combos: number[][] = [];
  const comboKeyMap = new Map<string, number>();

  function getComboIdx(si: number, tg?: string, tc?: string, gc?: string, mr?: string): number {
    const key = `${si}|${tg || SIN_DATO}|${tc || SIN_DATO}|${gc || SIN_DATO}|${mr || SIN_DATO}`;
    if (!comboKeyMap.has(key)) {
      const idx = combos.length;
      comboKeyMap.set(key, idx);
      combos.push([
        si,
        fidx.tg.get(tg || SIN_DATO) ?? filtVals.tg.length - 1,
        fidx.tc.get(tc || SIN_DATO) ?? filtVals.tc.length - 1,
        fidx.gc.get(gc || SIN_DATO) ?? filtVals.gc.length - 1,
        fidx.mr.get(mr || SIN_DATO) ?? filtVals.mr.length - 1,
      ]);
    }
    return comboKeyMap.get(key)!;
  }

  // Details
  const details: Record<string, (string | number)[]> = {};

  for (const lid of loanIds) {
    const l = loansMap.get(lid);
    if (l) {
      const pIdx = l.product ? productIdxMap.get(l.product) ?? -1 : -1;
      const ci = getComboIdx(l.segment_idx, l.tg, l.tc, l.gc, l.mr);
      details[lid] = [
        l.full_name || "",
        pIdx,
        l.segment_idx,
        Number(l.balance),
        l.dpd,
        l.bucket_idx,
        l.released_date || "",
        l.is_open ? 1 : 0,
        l.loan_number || lid,
        Number(l.pending_due || 0),
        ci,
        Number(l.total_due_amount || 0),
        l.installments_count || 0,
        l.cycle_type || 0,
      ];
    } else {
      // Loan in historical snapshots but not in today's loan book
      const lastHist = histLoans.filter((h) => h.source_loan_id === lid).pop();
      const si = lastHist?.segment ? SEGMENTS.indexOf(lastHist.segment) : 2;
      const ci = getComboIdx(si >= 0 ? si : 2);
      details[lid] = [
        "(histórico)",
        -1,
        si >= 0 ? si : 2,
        Number(lastHist?.balance || 0),
        lastHist?.dpd || 0,
        lastHist?.bucket_idx || 0,
        "",
        0,
        lid,
        0,
        ci,
        0,
        0,
        0,
      ];
    }
  }

  // Snapshots string matrix
  const snapshots: Record<string, string> = {};
  const histByDate = new Map<string, typeof histLoans>();
  for (const h of histLoans) {
    if (!histByDate.has(h.snapshot_date)) {
      histByDate.set(h.snapshot_date, []);
    }
    histByDate.get(h.snapshot_date)!.push(h);
  }

  for (const s of snapshotList) {
    const date = s.snapshot_date;
    const chars = new Array(loanIds.length).fill(".");
    const rows = histByDate.get(date) || [];
    for (const r of rows) {
      const pos = loanPos.get(r.source_loan_id);
      if (pos !== undefined) {
        chars[pos] = String(r.bucket_idx);
      }
    }
    snapshots[date] = chars.join("");
  }

  // Daily Window
  const asofDateObj = new Date(asof + "T00:00:00Z");
  const dailyStartDateObj = new Date(asofDateObj);
  dailyStartDateObj.setUTCDate(dailyStartDateObj.getUTCDate() - 400);
  const dailyStart = dailyStartDateObj.toISOString().slice(0, 10);

  // Payments payM and payD
  const payM: Record<string, [number, number, number][]> = {};
  const payD: Record<string, [number, number, number][]> = {};

  const monthlyGroup = new Map<string, Map<number, { prin: number; inc: number }>>();
  const dailyGroup = new Map<string, Map<number, { prin: number; inc: number }>>();

  for (const rep of repayments) {
    const pos = loanPos.get(rep.source_loan_id);
    if (pos === undefined) continue;

    const cdate = rep.collection_date;
    const month = cdate.slice(0, 7);
    const prin = Number(rep.principal_amount);
    const inc = Number(rep.ingresos_amount);

    // Monthly
    if (!monthlyGroup.has(month)) monthlyGroup.set(month, new Map());
    const mLoans = monthlyGroup.get(month)!;
    const mCur = mLoans.get(pos) || { prin: 0, inc: 0 };
    mLoans.set(pos, { prin: mCur.prin + prin, inc: mCur.inc + inc });

    // Daily (last 400 days)
    if (cdate >= dailyStart) {
      if (!dailyGroup.has(cdate)) dailyGroup.set(cdate, new Map());
      const dLoans = dailyGroup.get(cdate)!;
      const dCur = dLoans.get(pos) || { prin: 0, inc: 0 };
      dLoans.set(pos, { prin: dCur.prin + prin, inc: dCur.inc + inc });
    }
  }

  for (const [month, lmap] of monthlyGroup.entries()) {
    payM[month] = Array.from(lmap.entries()).map(([pos, v]) => [
      pos,
      Math.round(v.prin * 100) / 100,
      Math.round(v.inc * 100) / 100,
    ]);
  }

  for (const [day, lmap] of dailyGroup.entries()) {
    payD[day] = Array.from(lmap.entries()).map(([pos, v]) => [
      pos,
      Math.round(v.prin * 100) / 100,
      Math.round(v.inc * 100) / 100,
    ]);
  }

  const allMonths = Object.keys(payM).sort();
  const firstMonth = allMonths.length > 0 ? allMonths[0] : asof.slice(0, 7);

  // Delinquency series by snapshot and combo
  const delinqMap = new Map<string, { d30: number; d90: number; tot: number }>();
  for (const h of histLoans) {
    const d = details[h.source_loan_id];
    if (!d) continue;
    const ci = d[10] as number;
    const key = `${h.snapshot_date}|${ci}`;
    const cur = delinqMap.get(key) || { d30: 0, d90: 0, tot: 0 };
    const bal = Number(h.balance);
    cur.tot += bal;
    if (h.bucket_idx >= 2) cur.d30 += bal;
    if (h.bucket_idx >= 4) cur.d90 += bal;
    delinqMap.set(key, cur);
  }

  const delinq: { date: string; ci: number; d30: number; d90: number; tot: number }[] = [];
  for (const [key, val] of delinqMap.entries()) {
    const [date, ciStr] = key.split("|");
    delinq.push({
      date,
      ci: parseInt(ciStr, 10),
      d30: Math.round(val.d30 * 100) / 100,
      d90: Math.round(val.d90 * 100) / 100,
      tot: Math.round(val.tot * 100) / 100,
    });
  }

  return {
    asof,
    handover: HANDOVER_DATE,
    dailyStart,
    firstMonth,
    segments: SEGMENTS,
    buckets: BUCKETS,
    bucketColors: BUCKET_COLORS,
    provRates: PROV_RATES,
    combos,
    filtVals,
    payM,
    payD,
    delinq,
    loanIds,
    products,
    details,
    snapshots,
  };
}

