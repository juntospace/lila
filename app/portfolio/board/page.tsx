import Link from "next/link";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import {
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { requirePortfolioWriter } from "@/lib/auth/guard";
import {
  computeConcentration,
  computeKpiReport,
  computeRepeatBorrowers,
  computeSnapshotDiff,
  computeVintageReport,
  layoutRollMatrix,
  loadMetricFactBundle,
  loadMetricFacts,
  loadSnapshotHistory,
  resolvePriorSnapshot,
  vintageAtMob,
} from "@/lib/portfolio/metrics";
import type {
  AgingDistributionBucket,
  KpiValue,
  MatrixLayout,
  SegmentBreakdown,
  SnapshotDiffReport,
  VintageCheckpoint,
} from "@/lib/portfolio/metrics";
import type { PortfolioEntityCode } from "@/lib/portfolio/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ entity?: string }>;
}

const SUPPORTED_ENTITIES: PortfolioEntityCode[] = [
  "crediclaro",
  "junto_soluciones",
];

export default async function PortfolioBoardPage({ searchParams }: PageProps) {
  const session = await requirePortfolioWriter();
  const supabase = await createSupabaseServerClient();
  const params = await searchParams;
  const entityCode = (
    SUPPORTED_ENTITIES.includes(params.entity as PortfolioEntityCode)
      ? (params.entity as PortfolioEntityCode)
      : "crediclaro"
  ) as PortfolioEntityCode;

  const bundle = await loadMetricFacts(supabase, { entityCode });

  if (!bundle) {
    return (
      <OperatorShell session={session}>
        <header className="mb-8">
          <p className="text-sm text-fg-muted">Portfolio · Board view</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
            No completed snapshot yet
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            Ingest a daily backup on{" "}
            <Link href="/portfolio" className="underline-offset-4 hover:underline">
              Portfolio
            </Link>{" "}
            first. KPIs populate automatically once one lands.
          </p>
          <div className="mt-6">
            <EntitySwitcher current={entityCode} />
          </div>
        </header>
      </OperatorShell>
    );
  }

  const report = computeKpiReport(bundle);

  // Split totals into Old vs New management — the founder's primary lens.
  const oldManagement = report.byManagementVintage.find((s) => s.key === "old");
  const newManagement = report.byManagementVintage.find((s) => s.key === "new");

  // Slice-2 metrics. All single-snapshot ones compute today; the
  // pair-based ones (diff + vintage) degrade gracefully when there's
  // only one snapshot.
  const concentration = computeConcentration(bundle.loans);
  const repeatBorrowers = computeRepeatBorrowers(bundle.loans);

  const prior = await resolvePriorSnapshot(supabase, {
    entityId: bundle.entityId,
    snapshotDate: bundle.snapshotDate,
  });
  let diff: SnapshotDiffReport | null = null;
  if (prior) {
    const priorBundle = await loadMetricFactBundle(supabase, prior);
    diff = computeSnapshotDiff(priorBundle, bundle);
  }

  const history = await loadSnapshotHistory(supabase, entityCode);
  const vintage = history.length >= 2 ? computeVintageReport(history) : null;

  return (
    <OperatorShell session={session}>
      <header className="mb-8">
        <p className="text-sm text-fg-muted">
          <Link
            href="/portfolio"
            className="underline-offset-4 hover:underline"
          >
            Portfolio
          </Link>{" "}
          · Board view
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
          {bundle.entityDisplayName}
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          As of{" "}
          <span className="font-medium text-fg">{bundle.snapshotDate}</span> ·{" "}
          {report.total.countLoans.toLocaleString()} loans on file ·{" "}
          {report.total.countOpen.toLocaleString()} open
        </p>
        <div className="mt-4">
          <EntitySwitcher current={entityCode} />
        </div>
        {bundle.eclPlaceholder && (
          <div className="mt-4 rounded border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-fg">
            <strong>Heads up —</strong> ECL coverage rates are placeholders
            (1% / 10% / 50% by stage). Provisioning, coverage ratio, and net
            portfolio value below are indicative only until risk supplies the
            real matrix.
          </div>
        )}
      </header>

      {/* ============ Tier 1 cover row ============ */}
      <Section title="Headline" subtitle="Where the book stands today.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Gross Loan Portfolio"
            value={fmtMoney(report.total.glpMinor)}
            sub={`${report.total.countOpen.toLocaleString()} open loans · avg ${fmtMoney(report.total.avgTicketMinor)}`}
            tone="primary"
          />
          <Kpi
            label="PAR30"
            value={fmtPct(report.total.par30Ratio)}
            sub={`${fmtMoney(report.total.par30Minor)} · ${report.total.par30Count.toLocaleString()} loans`}
            tone={severityForRatio(report.total.par30Ratio, 0.1)}
          />
          <Kpi
            label="NPL (≥ 90 DPD)"
            value={fmtPct(report.total.nplRatio)}
            sub={`${fmtMoney(report.total.nplMinor)} · ${report.total.nplCount.toLocaleString()} loans`}
            tone={severityForRatio(report.total.nplRatio, 0.05)}
          />
          <Kpi
            label="Coverage Ratio"
            value={fmtPct(report.total.coverageRatio)}
            sub={`${fmtMoney(report.total.provisionsMinor)} provisions / NPL`}
            tone={
              Number.isFinite(report.total.coverageRatio) &&
              report.total.coverageRatio >= 1
                ? "good"
                : "warn"
            }
            placeholder={bundle.eclPlaceholder}
          />

          <Kpi
            label="Net Portfolio Value"
            value={fmtMoney(report.total.netPortfolioValueMinor)}
            sub={`GLP − ECL provisions (${fmtPct(report.total.provisionRate)} provision rate)`}
            placeholder={bundle.eclPlaceholder}
          />
          <Kpi
            label="Weighted-Avg DPD"
            value={
              Number.isFinite(report.total.weightedDpd)
                ? report.total.weightedDpd.toFixed(1) + " days"
                : "—"
            }
            sub={`Σ DPD × balance / GLP`}
          />
          <Kpi
            label="Disbursed (all-time, on file)"
            value={fmtMoney(report.total.totalPrincipalLentMinor)}
            sub={`${report.total.countLoans.toLocaleString()} loans ever originated`}
          />
          <Kpi
            label="Legacy Recovery"
            value={fmtPct(report.total.legacyRecoveryRate)}
            sub={`${fmtMoney(report.total.legacyCashCollectedMinor)} recovered of ${fmtMoney(report.total.legacyPrincipalLentMinor)} legacy principal (${report.total.legacyCount} loans)`}
          />
        </div>
      </Section>

      {/* ============ Old vs New ============ */}
      <Section
        title="Old book vs. new book"
        subtitle="The founder's primary lens. Recovery on the old book is goal #1; keeping the new book healthy is goal #2."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <ManagementCard
            label="Old management (pre-2025 personal loans)"
            value={oldManagement?.value}
            tone="warn"
          />
          <ManagementCard
            label="New management (2025+ personal + cash advance)"
            value={newManagement?.value}
            tone="primary"
          />
        </div>
      </Section>

      {/* ============ Aging ============ */}
      <Section
        title="Aging distribution"
        subtitle="By balance. Legacy bucket (>365 DPD) shown alongside the active book — see Section §4 of the build spec for why."
      >
        <Card>
          <CardBody>
            <AgingTable buckets={report.agingDistribution.buckets} />
          </CardBody>
        </Card>
      </Section>

      {/* ============ Portfolio segment ============ */}
      <Section
        title="Portfolio segment"
        subtitle="Strategic split combining product × management vintage."
      >
        <Card>
          <CardBody>
            <SegmentTable
              rows={report.bySegment}
              totalGlp={report.total.glpMinor}
              orderHint={[
                "old_personal",
                "new_personal",
                "cash_advance",
                "other",
              ]}
            />
          </CardBody>
        </Card>
      </Section>

      {/* ============ IFRS stage ============ */}
      <Section
        title="IFRS-9-style stage"
        subtitle="Stage 2 = significant credit risk (30–89 DPD); Stage 3 = credit-impaired (≥ 90 DPD)."
      >
        <Card>
          <CardBody>
            <SegmentTable
              rows={report.byIfrsStage.filter((r) => r.key !== "closed")}
              totalGlp={report.total.glpMinor}
              orderHint={["stage_1", "stage_2", "stage_3"]}
              extraColumns={["provisionRate"]}
              placeholder={bundle.eclPlaceholder}
            />
          </CardBody>
        </Card>
      </Section>

      {/* ============ Cohort delinquency (point-in-time) ============ */}
      <Section
        title="Cohort delinquency — point-in-time"
        subtitle="NPL share of each origination month's still-open balance. Slice 1 only — full vintage curves over time arrive in slice 2 once we have multiple snapshots."
      >
        <Card>
          <CardBody>
            <CohortTable rows={report.byCohortMonth} />
          </CardBody>
        </Card>
      </Section>

      {/* ============ Loan officer ============ */}
      <Section
        title="Loan officer (book carried)"
        subtitle="Concentration check — the sample showed one officer carrying ~92%, with product names polluting the field."
      >
        <Card>
          <CardBody>
            <OfficerTable rows={report.byLoanOfficer.slice(0, 10)} totalGlp={report.total.glpMinor} />
          </CardBody>
        </Card>
      </Section>

      {/* ============ Borrower concentration ============ */}
      <Section
        title="Borrower concentration"
        subtitle="Largest exposures + how much of the book sits behind the top borrowers. Standard investor-diligence number."
      >
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card>
            <CardBody>
              <ConcentrationTable concentration={concentration} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Repeat-borrower rate</CardTitle>
              <CardDescription>
                Cheap, lower-risk growth comes from re-loaning to known
                borrowers. Tracks share of active borrowers with multiple
                open loans.
              </CardDescription>
            </CardHeader>
            <CardBody>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Stat
                  label="Active borrowers"
                  value={repeatBorrowers.activeBorrowers.toLocaleString()}
                />
                <Stat
                  label="Repeat (≥ 2 open)"
                  value={repeatBorrowers.repeatBorrowers.toLocaleString()}
                />
                <Stat
                  label="Repeat rate"
                  value={fmtPct(repeatBorrowers.repeatBorrowerRate)}
                />
                <Stat
                  label="Largest exposure"
                  value={fmtPct(concentration.largestExposureShare)}
                />
              </dl>
            </CardBody>
          </Card>
        </div>
      </Section>

      {/* ============ Snapshot diff ============ */}
      <Section
        title="Change vs. previous snapshot"
        subtitle="Roll-rate matrix, cure rate, early roll — the leading indicators. Compares this snapshot to the prior one for this entity."
      >
        {diff ? (
          <SnapshotDiffSection diff={diff} />
        ) : (
          <Card>
            <CardBody>
              <p className="text-sm text-fg-muted">
                Need a second snapshot for this entity to compute change.
                Drop more days under{" "}
                <code className="rounded bg-bg-raised px-1 py-0.5 text-xs">
                  tmp/samples/&lt;YYYY-MM-DD&gt;/
                </code>{" "}
                and backfill from{" "}
                <Link
                  href="/portfolio"
                  className="underline-offset-4 hover:underline"
                >
                  Portfolio
                </Link>
                .
              </p>
            </CardBody>
          </Card>
        )}
      </Section>

      {/* ============ Vintage / cohort curves ============ */}
      <Section
        title="Vintage curves"
        subtitle="Each origination cohort's PAR30 / NPL at months-on-book. Apples-to-apples comparison across cohorts: did underwriting get better or worse?"
      >
        {vintage ? (
          <VintageSection
            entity={bundle.entityDisplayName}
            historyCount={history.length}
            mob3={vintageAtMob(vintage, 3)}
            mob6={vintageAtMob(vintage, 6)}
            mob12={vintageAtMob(vintage, 12)}
          />
        ) : (
          <Card>
            <CardBody>
              <p className="text-sm text-fg-muted">
                Need at least two snapshots over time to build vintage curves.
                Current history: {history.length} snapshot
                {history.length === 1 ? "" : "s"}.
              </p>
            </CardBody>
          </Card>
        )}
      </Section>
    </OperatorShell>
  );
}

// =============================================================
// Sections
// =============================================================

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10 first:mt-0">
      <div className="mb-4">
        <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
          {title}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-fg-muted">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function EntitySwitcher({ current }: { current: PortfolioEntityCode }) {
  return (
    <nav className="inline-flex rounded border border-border-subtle bg-bg-raised p-1 text-sm">
      {SUPPORTED_ENTITIES.map((code) => {
        const active = code === current;
        return (
          <Link
            key={code}
            href={`/portfolio/board?entity=${code}`}
            className={
              active
                ? "rounded bg-bg-surface px-3 py-1 font-medium text-fg shadow-e1"
                : "rounded px-3 py-1 text-fg-muted hover:text-fg"
            }
          >
            {code === "crediclaro" ? "Crediclaro" : "Junto Soluciones"}
          </Link>
        );
      })}
    </nav>
  );
}

// =============================================================
// KPI card
// =============================================================

type KpiTone = "default" | "primary" | "good" | "warn" | "danger";

function Kpi({
  label,
  value,
  sub,
  tone = "default",
  placeholder = false,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: KpiTone;
  placeholder?: boolean;
}) {
  const ring: Record<KpiTone, string> = {
    default: "",
    primary: "border-brand-500/40",
    good: "border-success/40",
    warn: "border-warning/40",
    danger: "border-danger/40",
  };
  const accent: Record<KpiTone, string> = {
    default: "text-fg",
    primary: "text-fg",
    good: "text-success",
    warn: "text-warning",
    danger: "text-danger",
  };
  return (
    <Card className={ring[tone]}>
      <CardBody>
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-fg-subtle">
            {label}
          </div>
          {placeholder && (
            <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning">
              placeholder
            </span>
          )}
        </div>
        <div
          className={`mt-2 font-display text-2xl font-semibold tabular-nums ${accent[tone]}`}
        >
          {value}
        </div>
        {sub && <div className="mt-1 text-xs text-fg-muted">{sub}</div>}
      </CardBody>
    </Card>
  );
}

function ManagementCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: KpiValue | undefined;
  tone: KpiTone;
}) {
  if (!value || value.countOpen === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{label}</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-fg-muted">
            No open loans in this slice yet.
          </p>
        </CardBody>
      </Card>
    );
  }
  const ring: Record<KpiTone, string> = {
    default: "",
    primary: "border-brand-500/40",
    good: "border-success/40",
    warn: "border-warning/40",
    danger: "border-danger/40",
  };
  return (
    <Card className={ring[tone]}>
      <CardHeader>
        <CardTitle className="text-base">{label}</CardTitle>
        <CardDescription>
          {value.countOpen.toLocaleString()} open loans ·{" "}
          {fmtMoney(value.glpMinor)} GLP
        </CardDescription>
      </CardHeader>
      <CardBody>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="PAR30" value={fmtPct(value.par30Ratio)} />
          <Stat label="PAR90 / NPL" value={fmtPct(value.nplRatio)} />
          <Stat label="Wt. Avg DPD" value={Number.isFinite(value.weightedDpd) ? value.weightedDpd.toFixed(1) + " d" : "—"} />
          <Stat label="Provisions" value={fmtMoney(value.provisionsMinor)} />
          <Stat label="Coverage" value={fmtPct(value.coverageRatio)} />
          <Stat label="Net portfolio" value={fmtMoney(value.netPortfolioValueMinor)} />
        </dl>
      </CardBody>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border-subtle bg-bg-raised px-3 py-2">
      <div className="text-xs text-fg-subtle">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-fg">{value}</div>
    </div>
  );
}

// =============================================================
// Tables
// =============================================================

function AgingTable({ buckets }: { buckets: AgingDistributionBucket[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
        <tr>
          <th className="pb-2 pr-4">Bucket</th>
          <th className="pb-2 pr-4 text-right">Loans</th>
          <th className="pb-2 pr-4 text-right">Balance</th>
          <th className="pb-2 pr-4 text-right">% of GLP</th>
          <th className="pb-2 pr-4"></th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b) => (
          <tr key={b.bucket} className="border-t border-border-subtle">
            <td className="py-2 pr-4 font-mono text-xs text-fg">{b.bucket}</td>
            <td className="py-2 pr-4 text-right tabular-nums text-fg">
              {b.countLoans.toLocaleString()}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums text-fg">
              {fmtMoney(b.balanceMinor)}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums text-fg-muted">
              {fmtPct(b.shareOfGlp)}
            </td>
            <td className="py-2 pr-4">
              <ShareBar value={b.shareOfGlp} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ShareBar({ value }: { value: number }) {
  if (!Number.isFinite(value)) return null;
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-2 w-32 overflow-hidden rounded bg-bg-raised">
      <div
        className="h-full bg-brand-500"
        style={{ width: `${pct.toFixed(2)}%` }}
      />
    </div>
  );
}

function SegmentTable({
  rows,
  totalGlp,
  orderHint,
  extraColumns,
  placeholder,
}: {
  rows: SegmentBreakdown[];
  totalGlp: bigint;
  orderHint?: string[];
  extraColumns?: ("provisionRate")[];
  placeholder?: boolean;
}) {
  const ordered = orderHint
    ? [
        ...orderHint
          .map((k) => rows.find((r) => r.key === k))
          .filter((r): r is SegmentBreakdown => Boolean(r)),
        ...rows.filter((r) => !orderHint.includes(r.key)),
      ]
    : rows;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
        <tr>
          <th className="pb-2 pr-4">Slice</th>
          <th className="pb-2 pr-4 text-right">Open loans</th>
          <th className="pb-2 pr-4 text-right">GLP</th>
          <th className="pb-2 pr-4 text-right">% of book</th>
          <th className="pb-2 pr-4 text-right">PAR30</th>
          <th className="pb-2 pr-4 text-right">NPL</th>
          {extraColumns?.includes("provisionRate") && (
            <th className="pb-2 pr-4 text-right">
              Prov rate{placeholder ? " *" : ""}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {ordered.map((r) => {
          const v = r.value;
          const shareOfBook =
            totalGlp === 0n ? Number.NaN : Number(v.glpMinor) / Number(totalGlp);
          return (
            <tr key={r.key} className="border-t border-border-subtle">
              <td className="py-2 pr-4 font-mono text-xs text-fg">{r.key}</td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {v.countOpen.toLocaleString()}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {fmtMoney(v.glpMinor)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-fg-muted">
                {fmtPct(shareOfBook)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {fmtPct(v.par30Ratio)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {fmtPct(v.nplRatio)}
              </td>
              {extraColumns?.includes("provisionRate") && (
                <td className="py-2 pr-4 text-right tabular-nums">
                  {fmtPct(v.provisionRate)}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CohortTable({ rows }: { rows: SegmentBreakdown[] }) {
  // Show recent cohorts first; cap at 18 months for legibility.
  const dated = rows
    .filter((r) => r.key !== "(undated)" && r.value.countOpen > 0)
    .sort((a, b) => b.key.localeCompare(a.key))
    .slice(0, 18);
  if (dated.length === 0) {
    return <p className="text-sm text-fg-muted">No dated cohorts with open balance.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
        <tr>
          <th className="pb-2 pr-4">Cohort (origination month)</th>
          <th className="pb-2 pr-4 text-right">Open loans</th>
          <th className="pb-2 pr-4 text-right">GLP</th>
          <th className="pb-2 pr-4 text-right">PAR30</th>
          <th className="pb-2 pr-4 text-right">NPL</th>
          <th className="pb-2 pr-4 text-right">Wt. Avg DPD</th>
        </tr>
      </thead>
      <tbody>
        {dated.map((r) => (
          <tr key={r.key} className="border-t border-border-subtle">
            <td className="py-2 pr-4 font-mono text-xs text-fg">
              {r.key.slice(0, 7)}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums">
              {r.value.countOpen.toLocaleString()}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums">
              {fmtMoney(r.value.glpMinor)}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums">
              {fmtPct(r.value.par30Ratio)}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums">
              {fmtPct(r.value.nplRatio)}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums">
              {Number.isFinite(r.value.weightedDpd)
                ? r.value.weightedDpd.toFixed(0) + " d"
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OfficerTable({
  rows,
  totalGlp,
}: {
  rows: SegmentBreakdown[];
  totalGlp: bigint;
}) {
  const real = rows.filter((r) => r.key !== "(null)" && r.value.countOpen > 0);
  if (real.length === 0) {
    return <p className="text-sm text-fg-muted">No officer assignments on open loans.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
        <tr>
          <th className="pb-2 pr-4">Officer (raw)</th>
          <th className="pb-2 pr-4 text-right">Open loans</th>
          <th className="pb-2 pr-4 text-right">GLP</th>
          <th className="pb-2 pr-4 text-right">% of book</th>
          <th className="pb-2 pr-4 text-right">PAR30</th>
          <th className="pb-2 pr-4 text-right">NPL</th>
        </tr>
      </thead>
      <tbody>
        {real.map((r) => {
          const share =
            totalGlp === 0n
              ? Number.NaN
              : Number(r.value.glpMinor) / Number(totalGlp);
          return (
            <tr key={r.key} className="border-t border-border-subtle">
              <td className="py-2 pr-4 max-w-xs truncate text-fg">{r.key}</td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {r.value.countOpen.toLocaleString()}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {fmtMoney(r.value.glpMinor)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-fg-muted">
                {fmtPct(share)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {fmtPct(r.value.par30Ratio)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {fmtPct(r.value.nplRatio)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// =============================================================
// Helpers
// =============================================================

function fmtMoney(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${cents}`;
}

function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function severityForRatio(ratio: number, alarmAt: number): KpiTone {
  if (!Number.isFinite(ratio)) return "default";
  if (ratio >= alarmAt) return "warn";
  return "default";
}

// =============================================================
// Slice-2 sections
// =============================================================

function ConcentrationTable({
  concentration,
}: {
  concentration: import("@/lib/portfolio/metrics").ConcentrationReport;
}) {
  const rows = concentration.top.slice(0, 15);
  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-3 text-sm">
        <Stat label="Active borrowers" value={concentration.activeBorrowers.toLocaleString()} />
        <Stat label="Top-10 share" value={fmtPct(concentration.top10Share)} />
        <Stat label="Top-25 share" value={fmtPct(concentration.top25Share)} />
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No active borrowers.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
            <tr>
              <th className="pb-2 pr-4">#</th>
              <th className="pb-2 pr-4">Borrower</th>
              <th className="pb-2 pr-4 text-right">Open loans</th>
              <th className="pb-2 pr-4 text-right">GLP</th>
              <th className="pb-2 pr-4 text-right">% of book</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={e.borrowerId + i} className="border-t border-border-subtle">
                <td className="py-2 pr-4 text-fg-muted">{i + 1}</td>
                <td className="py-2 pr-4 font-mono text-xs text-fg">
                  {e.unresolved ? "(unresolved) " : ""}
                  {e.borrowerId}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {e.openLoanCount.toLocaleString()}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmtMoney(e.glpMinor)}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-fg-muted">
                  {concentration.glpMinor === 0n
                    ? "—"
                    : fmtPct(Number(e.glpMinor) / Number(concentration.glpMinor))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SnapshotDiffSection({ diff }: { diff: SnapshotDiffReport }) {
  const layout = layoutRollMatrix(diff.rollMatrix);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {diff.from.snapshotDate} → {diff.to.snapshotDate}
          </CardTitle>
          <CardDescription>
            {diff.daysBetween} day{diff.daysBetween === 1 ? "" : "s"} apart.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              label="Cure rate"
              value={fmtPct(diff.cureRate)}
              sub={`${fmtMoney(diff.cureBalanceMinor)} of ${fmtMoney(diff.delinquentT0Minor)} delinquent at t-1`}
              tone={
                Number.isFinite(diff.cureRate) && diff.cureRate >= 0.35
                  ? "good"
                  : "warn"
              }
            />
            <Kpi
              label="Early roll (Current → 1-30)"
              value={fmtPct(diff.earlyRollRate)}
              sub={`${fmtMoney(diff.earlyRollBalanceMinor)} of ${fmtMoney(diff.currentT0Minor)} current at t-1`}
              tone={
                Number.isFinite(diff.earlyRollRate) && diff.earlyRollRate > 0.05
                  ? "warn"
                  : "good"
              }
            />
            <Kpi
              label="Flow to default (61-90 → 91+)"
              value={fmtPct(diff.flowToDefaultRate)}
              sub={`${fmtMoney(diff.flowToDefaultBalanceMinor)} of ${fmtMoney(diff.band6190T0Minor)} in 61-90 at t-1`}
              tone={
                Number.isFinite(diff.flowToDefaultRate) &&
                diff.flowToDefaultRate > 0.5
                  ? "warn"
                  : "default"
              }
            />
            <Kpi
              label="New originations"
              value={diff.newLoanCount.toLocaleString()}
              sub={`${fmtMoney(diff.newLoanPrincipalMinor)} disbursed`}
            />
            <Kpi
              label="Cash collected (Δ)"
              value={fmtMoney(diff.cashCollectedMinor)}
              sub={`Δ paid_amount across all loans`}
            />
            <Kpi
              label="GLP change"
              value={
                diff.glpDeltaMinor >= 0n
                  ? `+${fmtMoney(diff.glpDeltaMinor)}`
                  : `${fmtMoney(diff.glpDeltaMinor)}`
              }
              sub={`${diff.countOpenDelta >= 0 ? "+" : ""}${diff.countOpenDelta} open loans`}
            />
            <Kpi
              label="PAR30 ratio Δ"
              value={
                Number.isFinite(diff.par30RatioDelta)
                  ? `${diff.par30RatioDelta >= 0 ? "+" : ""}${(diff.par30RatioDelta * 100).toFixed(2)} pp`
                  : "—"
              }
              tone={
                Number.isFinite(diff.par30RatioDelta) && diff.par30RatioDelta > 0
                  ? "warn"
                  : "default"
              }
            />
            <Kpi
              label="Old → New share Δ"
              value={
                Number.isFinite(diff.newGlpShareDelta)
                  ? `${diff.newGlpShareDelta >= 0 ? "+" : ""}${(diff.newGlpShareDelta * 100).toFixed(2)} pp`
                  : "—"
              }
              sub={`${fmtPct(diff.newGlpShareFrom)} → ${fmtPct(diff.newGlpShareTo)}`}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Roll-rate matrix (by balance)</CardTitle>
          <CardDescription>
            Where each bucket&apos;s balance at t-1 ended up at t. Diagonal = no
            movement; above-diagonal = curing; below-diagonal = worsening.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <RollMatrixView layout={layout} />
        </CardBody>
      </Card>
    </div>
  );
}

function RollMatrixView({ layout }: { layout: MatrixLayout }) {
  // Suppress rows whose entire balance is zero to keep the table small.
  const usefulFrom = layout.fromBuckets.filter((fb) =>
    layout.toBuckets.some((tb) => layout.balance[fb][tb] !== 0n),
  );
  if (usefulFrom.length === 0) {
    return <p className="text-sm text-fg-muted">No transitions to show.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-fg-subtle">
            <th className="border-b border-border-subtle pb-2 pr-3 text-left">
              t-1 \ t
            </th>
            {layout.toBuckets.map((tb) => (
              <th
                key={tb}
                className="border-b border-border-subtle pb-2 pr-3 text-right font-mono"
              >
                {tb}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {usefulFrom.map((fb) => {
            const rowTotal = layout.toBuckets.reduce(
              (acc, tb) => acc + layout.balance[fb][tb],
              0n,
            );
            return (
              <tr key={fb} className="border-t border-border-subtle">
                <td className="py-1.5 pr-3 font-mono text-fg">{fb}</td>
                {layout.toBuckets.map((tb) => {
                  const bal = layout.balance[fb][tb];
                  const count = layout.count[fb][tb];
                  if (bal === 0n) {
                    return (
                      <td key={tb} className="py-1.5 pr-3 text-right text-fg-subtle">
                        —
                      </td>
                    );
                  }
                  const share = rowTotal === 0n ? 0 : Number(bal) / Number(rowTotal);
                  return (
                    <td
                      key={tb}
                      className="py-1.5 pr-3 text-right tabular-nums text-fg"
                      title={`${count} loan${count === 1 ? "" : "s"}`}
                    >
                      <div>{fmtMoney(bal)}</div>
                      <div className="text-[10px] text-fg-muted">
                        {(share * 100).toFixed(0)}%
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VintageSection({
  entity,
  historyCount,
  mob3,
  mob6,
  mob12,
}: {
  entity: string;
  historyCount: number;
  mob3: VintageCheckpoint[];
  mob6: VintageCheckpoint[];
  mob12: VintageCheckpoint[];
}) {
  const cohorts = Array.from(
    new Set([...mob3, ...mob6, ...mob12].map((c) => c.cohortMonth)),
  ).sort((a, b) => b.localeCompare(a));
  const findRate = (
    list: VintageCheckpoint[],
    cohort: string,
    field: "par30Rate" | "nplRate",
  ): number | null => {
    const c = list.find((x) => x.cohortMonth === cohort);
    if (!c || !c.observation) return null;
    return c.observation[field];
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {entity} · {historyCount} snapshots in history
        </CardTitle>
        <CardDescription>
          NPL share by months-on-book. Recent cohorts top. &quot;@N&quot; columns
          fall back to the latest snapshot at or before that MoB.
        </CardDescription>
      </CardHeader>
      <CardBody>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
            <tr>
              <th className="pb-2 pr-4">Cohort</th>
              <th className="pb-2 pr-4 text-right">NPL @3</th>
              <th className="pb-2 pr-4 text-right">NPL @6</th>
              <th className="pb-2 pr-4 text-right">NPL @12</th>
              <th className="pb-2 pr-4 text-right">PAR30 @6</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.slice(0, 18).map((c) => (
              <tr key={c} className="border-t border-border-subtle">
                <td className="py-2 pr-4 font-mono text-xs text-fg">
                  {c.slice(0, 7)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {fmtPctOrDash(findRate(mob3, c, "nplRate"))}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {fmtPctOrDash(findRate(mob6, c, "nplRate"))}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {fmtPctOrDash(findRate(mob12, c, "nplRate"))}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {fmtPctOrDash(findRate(mob6, c, "par30Rate"))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}

function fmtPctOrDash(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
