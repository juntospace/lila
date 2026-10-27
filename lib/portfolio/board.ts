// Board Report Data Aggregator & Server-side Loader
// Assembles all data required for the 6 Board Report sections

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  BUCKET_COLORS,
  BUCKETS,
  GC_VALS,
  HANDOVER_DATE,
  MR_VALS,
  PROV_RATES,
  SEGMENTS,
  SIN_DATO,
  TC_VALS,
  TG_VALS,
} from "./enrich";
import { fetchAll } from "./fetch-all";
import { DEFAULT_POLICY, loadActivePolicy } from "./policy";
import type {
  EnrichedLoan,
  EnrichedRepayment,
  PortfolioBucket,
  PortfolioIngestBatch,
  PortfolioPolicy,
  PortfolioSegment,
} from "./types";

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
  policyVersion: string;
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
  batch?: PortfolioIngestBatch | null;
}

export interface BoardLoanInput {
  source_loan_id: string;
  loan_number: string | null;
  full_name: string | null;
  product: string | null;
  segment: PortfolioSegment | string;
  segment_idx: number;
  balance: number;
  dpd: number;
  bucket_idx: number;
  released_date: string | null;
  is_open: boolean;
  pending_due: number | null;
  total_due_amount: number | null;
  installments_count: number | null;
  cycle_type: number | null;
  tg: string | null;
  tc: string | null;
  gc: string | null;
  mr: string | null;
}

export interface BoardHistLoanInput {
  snapshot_date: string;
  source_loan_id: string;
  segment: string;
  bucket_idx: number;
  balance: number;
  dpd: number;
}

export interface BoardRepaymentInput {
  source_loan_id: string;
  collection_date: string;
  principal_amount: number;
  ingresos_amount: number;
  is_real: boolean;
}

export function formatQualityWarnings(
  batch?: PortfolioIngestBatch | null,
  fallback?: {
    futurePaymentsExcludedCount?: number;
    cashAheadCount?: number;
  },
): string[] {
  const warnings: string[] = [];
  const futureExcl =
    batch?.futurePaymentsExcluded ?? fallback?.futurePaymentsExcludedCount ?? 0;
  const cashAhead = batch?.cashAheadCount ?? fallback?.cashAheadCount ?? 0;
  const adminCount = batch?.adminExcludedCount ?? 0;
  const adminAmt = batch?.adminExcludedAmount ?? 0;
  const unknownMethods = batch?.unknownMethods ?? [];

  if (futureExcl > 0) {
    warnings.push(
      `${futureExcl} pago(s) con fecha posterior al corte (${futureExcl === 1 ? "excluido" : "excluidos"}).`,
    );
  }
  if (cashAhead > 0) {
    warnings.push(
      `${cashAhead} préstamo(s) reclasificado(s) a "Al día" por ajuste de caja (sin monto vencido en LoanDisk).`,
    );
  }
  if (adminCount > 0) {
    warnings.push(
      `${adminCount} movimiento(s) administrativo(s) excluido(s) de la recaudación real ($${Math.round(adminAmt).toLocaleString("en-US")}).`,
    );
  }
  if (unknownMethods.length > 0) {
    warnings.push(
      `Métodos sin clasificar (contados como reales): ${unknownMethods.join(", ")}. Agregarlos a la lista en Política CRO.`,
    );
  }

  return warnings;
}

/**
 * Pure builder that constructs BoardDataset from normalized snapshot records.
 * Used both by loadBoardDataset (from Supabase) and by unit/parity tests.
 */
export function assembleBoardDataset(params: {
  asof: string;
  snapshotDates: string[];
  loansData: BoardLoanInput[];
  histLoans: BoardHistLoanInput[];
  repayments: BoardRepaymentInput[];
  policy?: PortfolioPolicy;
  batch?: PortfolioIngestBatch | null;
  warnings?: string[];
}): BoardDataset {
  const {
    asof,
    snapshotDates,
    loansData,
    histLoans,
    repayments,
    policy = DEFAULT_POLICY,
    batch = null,
    warnings = [],
  } = params;

  const handover = policy.handoverDate || HANDOVER_DATE;
  const buckets = policy.bucketNames || BUCKETS;
  const provRates = policy.provRates || PROV_RATES;

  // Assemble universe of loans
  const loansMap = new Map<string, BoardLoanInput>();
  for (const l of loansData) {
    loansMap.set(l.source_loan_id, l);
  }

  // Sort historical loans by snapshot_date ascending so .pop() is deterministic
  const sortedHistLoans = [...histLoans].sort((a, b) =>
    a.snapshot_date === b.snapshot_date
      ? a.source_loan_id.localeCompare(b.source_loan_id)
      : a.snapshot_date.localeCompare(b.snapshot_date),
  );

  const histLoanIds = new Set(sortedHistLoans.map((h) => h.source_loan_id));
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

  // Build filter lists deterministically
  const extraTg = new Set<string>();
  const extraTc = new Set<string>();
  const extraGc = new Set<string>();
  const extraMr = new Set<string>();

  for (const l of loansData) {
    if (l.tg && !TG_VALS.includes(l.tg) && l.tg !== SIN_DATO) extraTg.add(l.tg);
    if (l.tc && !TC_VALS.includes(l.tc) && l.tc !== SIN_DATO) extraTc.add(l.tc);
    if (l.gc && !GC_VALS.includes(l.gc) && l.gc !== SIN_DATO) extraGc.add(l.gc);
    if (l.mr && !MR_VALS.includes(l.mr) && l.mr !== SIN_DATO) extraMr.add(l.mr);
  }

  const filtVals = {
    tg: [...TG_VALS, ...Array.from(extraTg).sort(), SIN_DATO],
    tc: [...TC_VALS, ...Array.from(extraTc).sort(), SIN_DATO],
    gc: [...GC_VALS, ...Array.from(extraGc).sort(), SIN_DATO],
    mr: [...MR_VALS, ...Array.from(extraMr).sort(), SIN_DATO],
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

  function getComboIdx(
    si: number,
    tg?: string | null,
    tc?: string | null,
    gc?: string | null,
    mr?: string | null,
  ): number {
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
      // Fase 2.7: installments = min(n, 1500), totalDue only if > 0
      const rawTd = Number(l.total_due_amount || 0);
      const td = rawTd > 0 ? Math.round(rawTd * 100) / 100 : 0;
      const rawNi = Number(l.installments_count || 0);
      const ni = rawNi > 0 ? Math.min(Math.floor(rawNi), 1500) : 0;

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
        td,
        ni,
        l.cycle_type || 0,
      ];
    } else {
      // Loan in historical snapshots but not in today's loan book
      const lastHist = sortedHistLoans
        .filter((h) => h.source_loan_id === lid)
        .pop();
      const si = lastHist?.segment
        ? SEGMENTS.indexOf(lastHist.segment as PortfolioSegment)
        : 2;
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
  const histByDate = new Map<string, BoardHistLoanInput[]>();
  for (const h of sortedHistLoans) {
    if (!histByDate.has(h.snapshot_date)) {
      histByDate.set(h.snapshot_date, []);
    }
    histByDate.get(h.snapshot_date)!.push(h);
  }

  const sortedSnapshotDates = [...snapshotDates].sort();
  for (const date of sortedSnapshotDates) {
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
  // Fase 2.2: Filter repayments so only loans present in the current snapshot (loansMap) are included
  const payM: Record<string, [number, number, number][]> = {};
  const payD: Record<string, [number, number, number][]> = {};

  const monthlyGroup = new Map<
    string,
    Map<number, { prin: number; inc: number }>
  >();
  const dailyGroup = new Map<
    string,
    Map<number, { prin: number; inc: number }>
  >();

  for (const rep of repayments) {
    if (!rep.is_real) continue;
    if (!loansMap.has(rep.source_loan_id)) continue;
    const pos = loanPos.get(rep.source_loan_id);
    if (pos === undefined) continue;

    const cdate = rep.collection_date;
    if (!cdate || cdate > asof) continue;
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

  for (const [month, lmap] of Array.from(monthlyGroup.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    payM[month] = Array.from(lmap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([pos, v]) => [
        pos,
        Math.round(v.prin * 100) / 100,
        Math.round(v.inc * 100) / 100,
      ]);
  }

  for (const [day, lmap] of Array.from(dailyGroup.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    payD[day] = Array.from(lmap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([pos, v]) => [
        pos,
        Math.round(v.prin * 100) / 100,
        Math.round(v.inc * 100) / 100,
      ]);
  }

  const allMonths = Object.keys(payM).sort();
  const firstMonth = allMonths.length > 0 ? allMonths[0] : asof.slice(0, 7);

  // Delinquency series by snapshot and combo
  const delinqMap = new Map<string, { d30: number; d90: number; tot: number }>();
  for (const h of sortedHistLoans) {
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

  const delinq: {
    date: string;
    ci: number;
    d30: number;
    d90: number;
    tot: number;
  }[] = [];
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
  delinq.sort((a, b) =>
    a.date === b.date ? a.ci - b.ci : a.date.localeCompare(b.date),
  );

  return {
    asof,
    handover,
    policyVersion: policy.version,
    dailyStart,
    firstMonth,
    segments: SEGMENTS,
    buckets,
    bucketColors: BUCKET_COLORS,
    provRates,
    combos,
    filtVals,
    payM,
    payD,
    delinq,
    loanIds,
    products,
    details,
    snapshots,
    warnings,
    batch,
  };
}

/**
 * Helper to build a BoardDataset directly from in-memory EnrichedLoan/EnrichedRepayment snapshots
 * (used for unit and Python parity testing).
 */
export function buildBoardDatasetFromEnriched(params: {
  asof: string;
  snapshotsByDate: Record<string, EnrichedLoan[]>;
  repayments: EnrichedRepayment[];
  policy?: PortfolioPolicy;
}): BoardDataset {
  const { asof, snapshotsByDate, repayments, policy = DEFAULT_POLICY } = params;
  const snapshotDates = Object.keys(snapshotsByDate).sort();
  const currentLoans = snapshotsByDate[asof] || [];

  const loansData: BoardLoanInput[] = currentLoans.map((l) => ({
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

  const histLoans: BoardHistLoanInput[] = [];
  for (const date of snapshotDates) {
    for (const l of snapshotsByDate[date]) {
      if (l.isOpen) {
        histLoans.push({
          snapshot_date: date,
          source_loan_id: l.loanId,
          segment: l.segment,
          bucket_idx: l.bucketIdx,
          balance: l.balance,
          dpd: l.dpd,
        });
      }
    }
  }

  const repaymentsInput: BoardRepaymentInput[] = repayments.map((r) => ({
    source_loan_id: r.loanId,
    collection_date: r.collectionDate,
    principal_amount: r.principalAmount,
    ingresos_amount: r.ingresosAmount,
    is_real: r.isReal,
  }));

  return assembleBoardDataset({
    asof,
    snapshotDates,
    loansData,
    histLoans,
    repayments: repaymentsInput,
    policy,
  });
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

  // 2. Fetch target snapshot (or latest completed)
  let snapQuery = supabase
    .from("portfolio_snapshots")
    .select("*")
    .eq("entity_id", entityId)
    .eq("status", "completed")
    .order("snapshot_date", { ascending: false });

  if (targetDate) {
    snapQuery = snapQuery.eq("snapshot_date", targetDate);
  }

  const { data: latestSnapshots } = await snapQuery.limit(1);
  if (!latestSnapshots || latestSnapshots.length === 0) {
    return null;
  }
  const currentSnap = latestSnapshots[0];
  const asof = currentSnap.snapshot_date as string;

  // 3-8. Fetch all required datasets concurrently to avoid request waterfalls
  const [
    policy,
    allSnapshotsRes,
    loansData,
    histLoans,
    repayments,
    batchRow,
  ] = await Promise.all([
    // Active CRO policy for asof (Fase 4.1)
    loadActivePolicy(supabase, asof),

    // All historical completed snapshots for entity
    supabase
      .from("portfolio_snapshots")
      .select("id, snapshot_date")
      .eq("entity_id", entityId)
      .eq("status", "completed")
      .lte("snapshot_date", asof)
      .order("snapshot_date", { ascending: true }),

    // All loans for current snapshot (paginated with concurrent chunks & specific columns)
    fetchAll<BoardLoanInput>(
      (from, to) =>
        supabase
          .from("portfolio_loans")
          .select(
            "source_loan_id, loan_number, full_name, product, segment, segment_idx, balance, dpd, bucket_idx, released_date, is_open, pending_due, total_due_amount, installments_count, cycle_type, tg, tc, gc, mr",
            { count: "exact" },
          )
          .eq("snapshot_id", currentSnap.id)
          .order("id", { ascending: true })
          .range(from, to),
      1000,
      6,
    ),

    // All historical snapshot open loans up to asof (paginated with concurrent chunks)
    fetchAll<BoardHistLoanInput>(
      (from, to) =>
        supabase
          .from("portfolio_loans")
          .select(
            "snapshot_date, source_loan_id, segment, bucket_idx, balance, dpd",
            { count: "exact" },
          )
          .eq("entity_id", entityId)
          .eq("is_open", true)
          .lte("snapshot_date", asof)
          .order("id", { ascending: true })
          .range(from, to),
      1000,
      6,
    ),

    // Real repayments for current snapshot (paginated with concurrent chunks)
    fetchAll<BoardRepaymentInput>(
      (from, to) =>
        supabase
          .from("portfolio_loan_repayments")
          .select(
            "source_loan_id, collection_date, principal_amount, ingresos_amount, is_real",
            { count: "exact" },
          )
          .eq("snapshot_id", currentSnap.id)
          .eq("is_real", true)
          .order("id", { ascending: true })
          .range(from, to),
      1000,
      6,
    ),

    // Latest ingest batch for quality warnings (Fase 4.3)
    supabase
      .from("portfolio_ingest_batches")
      .select("*")
      .eq("snapshot_id", currentSnap.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(
        (res) => res.data,
        () => null,
      ),
  ]);

  const snapshotDates = (allSnapshotsRes?.data || []).map(
    (s) => s.snapshot_date as string,
  );

  let batch: PortfolioIngestBatch | null = null;
  if (batchRow) {
    batch = {
      id: batchRow.id,
      snapshotId: batchRow.snapshot_id,
      sha256Loans: batchRow.sha256_loans,
      sha256Repayments: batchRow.sha256_repayments,
      rowsLoans: Number(batchRow.rows_loans || 0),
      rowsRepayments: Number(batchRow.rows_repayments || 0),
      sumBalanceSource: Number(batchRow.sum_balance_source || 0),
      sumBalanceIngested: Number(batchRow.sum_balance_ingested || 0),
      futurePaymentsExcluded: Number(batchRow.future_payments_excluded || 0),
      cashAheadCount: Number(batchRow.cash_ahead_count || 0),
      adminExcludedCount: Number(batchRow.admin_excluded_count || 0),
      adminExcludedAmount: Number(batchRow.admin_excluded_amount || 0),
      unknownMethods: Array.isArray(batchRow.unknown_methods)
        ? batchRow.unknown_methods
        : [],
      missingCustomFields: Array.isArray(batchRow.missing_custom_fields)
        ? batchRow.missing_custom_fields
        : [],
      missingReleasedDateCount: Number(
        batchRow.missing_released_date_count || 0,
      ),
      uploadedBy: batchRow.uploaded_by,
      createdAt: batchRow.created_at,
    };
  }

  const warnings = formatQualityWarnings(batch, {
    futurePaymentsExcludedCount: Number(
      currentSnap.future_payments_excluded_count || 0,
    ),
    cashAheadCount: Number(currentSnap.cash_ahead_count || 0),
  });

  return assembleBoardDataset({
    asof,
    snapshotDates,
    loansData,
    histLoans,
    repayments,
    policy,
    batch,
    warnings,
  });
}
