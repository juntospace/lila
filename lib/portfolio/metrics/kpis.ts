// Pure KPI compute. No I/O — takes a MetricFactBundle and returns a
// KpiReport. Money is bigint cents throughout; ratios are JS numbers.
//
// Slice-1 KPIs implemented:
//   Section A — GLP, active loans, avg ticket, mix shares
//   Section B — PAR30/60/90, NPL, aging distribution, weighted DPD, stage dist
//   Section D — cohort delinquency at point-in-time (NPL by cohort month)
//   Section E — ECL, provision rate, coverage ratio, net portfolio value
//   Section F — legacy recovery (legacy book sub-metrics)
//
// The whole report can be sliced across entity / vintage / segment /
// product / IFRS stage / aging bucket / cohort month / loan officer.

import type {
  AgingBucket,
  AgingDistribution,
  AgingDistributionBucket,
  KpiReport,
  KpiValue,
  LoanFact,
  MetricFactBundle,
  SegmentBreakdown,
} from "./types";
import { AGING_BUCKETS } from "./types";

// =============================================================
// Entry point
// =============================================================

export function computeKpiReport(bundle: MetricFactBundle): KpiReport {
  const totalLoans = bundle.loans;
  const total = computeKpiValue(totalLoans, bundle);

  return {
    fact: bundle,
    total,
    agingDistribution: computeAgingDistribution(totalLoans, total.glpMinor),
    byEntity: groupedKpi(totalLoans, bundle, (l) => l.entityId),
    byManagementVintage: groupedKpi(
      totalLoans,
      bundle,
      (l) => l.managementVintage ?? "(null)",
    ),
    bySegment: groupedKpi(
      totalLoans,
      bundle,
      (l) => l.portfolioSegment ?? "(null)",
    ),
    byProductGroup: groupedKpi(
      totalLoans,
      bundle,
      (l) => l.productGroup ?? "(null)",
    ),
    byIfrsStage: groupedKpi(
      totalLoans,
      bundle,
      (l) => l.ifrsStage ?? "(null)",
    ),
    byAgingBucket: groupedAgingKpi(totalLoans, bundle),
    byCohortMonth: groupedKpi(
      totalLoans,
      bundle,
      (l) => l.cohortMonth ?? "(undated)",
    ),
    byLoanOfficer: groupedKpi(
      totalLoans,
      bundle,
      (l) => l.loanOfficerRaw ?? "(null)",
    ),
  };
}

// =============================================================
// KPI value over an arbitrary subset
// =============================================================

export function computeKpiValue(
  loans: LoanFact[],
  bundle: MetricFactBundle,
): KpiValue {
  const policy = bundle.policy;
  const stage1Coverage = policy.eclStage1Coverage ?? 0;
  const stage2Coverage = policy.eclStage2Coverage ?? 0;
  const stage3Coverage = policy.eclStage3Coverage ?? 0;
  const npl_dpd = policy.nplDpdMin;
  const par_dpd = [30, 60, 90] as const;

  let countOpen = 0;
  let glpMinor = 0n;
  let pastDueMinor = 0n;
  let par30Minor = 0n;
  let par60Minor = 0n;
  let par90Minor = 0n;
  let par30Count = 0;
  let par60Count = 0;
  let par90Count = 0;
  let nplMinor = 0n;
  let nplCount = 0;
  let dpdWeightedSum = 0n;
  let stage1Minor = 0n;
  let stage2Minor = 0n;
  let stage3Minor = 0n;
  let provisionsMinor = 0n;
  let openPrincipalLentMinor = 0n;
  let totalPrincipalLentMinor = 0n;
  let totalPaidMinor = 0n;
  let legacyCount = 0;
  let legacyOutstandingMinor = 0n;
  let legacyPrincipalLentMinor = 0n;
  let legacyCashCollectedMinor = 0n;
  let legacyWriteOffMinor = 0n;

  for (const l of loans) {
    totalPrincipalLentMinor += l.principalAmountMinor;
    totalPaidMinor += l.paidAmountMinor;

    const isOpen = l.statusNormalized !== "closed";
    const balance = l.balanceAmountMinor;
    const dpd = l.daysPastDue ?? 0;

    if (l.statusNormalized === "legacy_delinquent") {
      legacyCount += 1;
      legacyOutstandingMinor += balance;
      legacyPrincipalLentMinor += l.principalAmountMinor;
      legacyCashCollectedMinor += l.cashCollectedMinor;
      legacyWriteOffMinor += l.writeOffMinor;
    }

    if (!isOpen) continue;

    countOpen += 1;
    glpMinor += balance;
    pastDueMinor += l.pastDueMinor;
    openPrincipalLentMinor += l.principalAmountMinor;
    dpdWeightedSum += BigInt(dpd) * balance;

    if (dpd > par_dpd[0]) {
      par30Minor += balance;
      par30Count += 1;
    }
    if (dpd > par_dpd[1]) {
      par60Minor += balance;
      par60Count += 1;
    }
    if (dpd > par_dpd[2]) {
      par90Minor += balance;
      par90Count += 1;
    }
    if (dpd >= npl_dpd) {
      nplMinor += balance;
      nplCount += 1;
    }

    switch (l.ifrsStage) {
      case "stage_1":
        stage1Minor += balance;
        provisionsMinor += scaleMinor(balance, stage1Coverage);
        break;
      case "stage_2":
        stage2Minor += balance;
        provisionsMinor += scaleMinor(balance, stage2Coverage);
        break;
      case "stage_3":
        stage3Minor += balance;
        provisionsMinor += scaleMinor(balance, stage3Coverage);
        break;
      default:
        // 'closed' or null — no provision.
        break;
    }
  }

  const glpNumber = Number(glpMinor);
  const weightedDpd =
    glpMinor === 0n ? Number.NaN : Number(dpdWeightedSum) / glpNumber;
  const provisionRate =
    glpMinor === 0n ? Number.NaN : Number(provisionsMinor) / glpNumber;
  const coverageRatio =
    nplMinor === 0n ? Number.NaN : Number(provisionsMinor) / Number(nplMinor);
  const nplRatio =
    glpMinor === 0n ? Number.NaN : Number(nplMinor) / glpNumber;
  const par30Ratio =
    glpMinor === 0n ? Number.NaN : Number(par30Minor) / glpNumber;
  const par60Ratio =
    glpMinor === 0n ? Number.NaN : Number(par60Minor) / glpNumber;
  const par90Ratio =
    glpMinor === 0n ? Number.NaN : Number(par90Minor) / glpNumber;
  const avgTicketMinor =
    countOpen === 0 ? 0n : glpMinor / BigInt(countOpen);
  const legacyRecoveryRate =
    legacyPrincipalLentMinor === 0n
      ? Number.NaN
      : Number(legacyCashCollectedMinor) / Number(legacyPrincipalLentMinor);

  return {
    countLoans: loans.length,
    countOpen,
    glpMinor,
    countActiveBorrowers: 0, // set at TOTAL level only — see computeKpiReport
    avgTicketMinor,
    pastDueMinor,
    par30Minor,
    par60Minor,
    par90Minor,
    par30Count,
    par60Count,
    par90Count,
    nplMinor,
    nplCount,
    weightedDpd,
    stage1Minor,
    stage2Minor,
    stage3Minor,
    provisionsMinor,
    netPortfolioValueMinor: glpMinor - provisionsMinor,
    coverageRatio,
    provisionRate,
    nplRatio,
    par30Ratio,
    par60Ratio,
    par90Ratio,
    openPrincipalLentMinor,
    totalPrincipalLentMinor,
    totalPaidMinor,
    legacyCount,
    legacyOutstandingMinor,
    legacyPrincipalLentMinor,
    legacyCashCollectedMinor,
    legacyWriteOffMinor,
    legacyRecoveryRate,
  };
}

// =============================================================
// Aging distribution
// =============================================================

export function classifyAgingBucket(daysPastDue: number | null): AgingBucket {
  const dpd = daysPastDue ?? 0;
  if (dpd <= 0) return "current";
  if (dpd <= 30) return "1-30";
  if (dpd <= 60) return "31-60";
  if (dpd <= 90) return "61-90";
  if (dpd <= 180) return "91-180";
  if (dpd <= 365) return "181-365";
  return "365+";
}

function computeAgingDistribution(
  loans: LoanFact[],
  glpMinor: bigint,
): AgingDistribution {
  const counts = new Map<AgingBucket, { count: number; balance: bigint }>();
  for (const b of AGING_BUCKETS) {
    counts.set(b, { count: 0, balance: 0n });
  }
  for (const l of loans) {
    if (l.statusNormalized === "closed") continue;
    const bucket = classifyAgingBucket(l.daysPastDue);
    const entry = counts.get(bucket);
    if (!entry) continue;
    entry.count += 1;
    entry.balance += l.balanceAmountMinor;
  }
  const buckets: AgingDistributionBucket[] = AGING_BUCKETS.map((bucket) => {
    const entry = counts.get(bucket) ?? { count: 0, balance: 0n };
    return {
      bucket,
      countLoans: entry.count,
      balanceMinor: entry.balance,
      shareOfGlp:
        glpMinor === 0n ? Number.NaN : Number(entry.balance) / Number(glpMinor),
    };
  });
  return { glpMinor, buckets };
}

// =============================================================
// Slicing helpers
// =============================================================

function groupedKpi(
  loans: LoanFact[],
  bundle: MetricFactBundle,
  keyFn: (l: LoanFact) => string,
): SegmentBreakdown[] {
  const groups = new Map<string, LoanFact[]>();
  for (const l of loans) {
    const key = keyFn(l);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(l);
  }
  return Array.from(groups.entries())
    .map(([key, members]) => ({
      key,
      value: computeKpiValue(members, bundle),
    }))
    .sort((a, b) => Number(b.value.glpMinor - a.value.glpMinor));
}

function groupedAgingKpi(
  loans: LoanFact[],
  bundle: MetricFactBundle,
): SegmentBreakdown<AgingBucket>[] {
  const groups = new Map<AgingBucket, LoanFact[]>();
  for (const b of AGING_BUCKETS) groups.set(b, []);
  for (const l of loans) {
    if (l.statusNormalized === "closed") continue;
    groups.get(classifyAgingBucket(l.daysPastDue))?.push(l);
  }
  return AGING_BUCKETS.map((bucket) => ({
    key: bucket,
    value: computeKpiValue(groups.get(bucket) ?? [], bundle),
  }));
}

// =============================================================
// Money helpers
// =============================================================

/** Multiply minor units by a rate in [0,1] keeping bigint precision. */
function scaleMinor(amount: bigint, rate: number): bigint {
  if (rate <= 0) return 0n;
  // Scale rate to 10,000 to keep ~4 decimal digits of precision.
  const scaled = Math.round(rate * 10_000);
  return (amount * BigInt(scaled)) / 10_000n;
}
