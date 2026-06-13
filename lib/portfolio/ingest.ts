// Portfolio snapshot ingest pipeline.
//
// Entry point: ingestPortfolioSnapshot(args) — given a parsed CSV bundle
// and an entity, builds one row per file fact table for the snapshot
// date. Re-running the same (entity, date) replaces the prior snapshot's
// child rows ("snapshot replace" — daily history is on the snapshot
// registry, not on duplicated child rows).
//
// Flow:
//   1. Resolve entity_id, active policy.
//   2. Upsert portfolio_snapshots row → status='in_progress'.
//   3. Delete prior child rows for this snapshot_id.
//   4. Classify loans + resolve borrower joins.
//   5. Chunked-insert borrowers / loans / repayments / dq.
//   6. Finalize snapshot row.
//
// On failure, the snapshot row is marked 'failed' with an error message
// so the registry exposes the problem rather than silently leaving
// 'in_progress' rows behind.

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAllBorrowerJoins } from "./borrower-join";
import { computeDqMetrics } from "./dq";
import { classifyLoan } from "./normalize";
import type {
  DqMetric,
  IngestArgs,
  IngestResult,
  PortfolioBorrowerJoinConfidence,
  PortfolioIfrsStage,
  PortfolioLoanStatus,
  PortfolioManagementVintage,
  PortfolioPolicy,
  PortfolioPolicyId,
  PortfolioProductGroup,
  PortfolioSegment,
  PortfolioSnapshotId,
} from "./types";

const INSERT_CHUNK = 500;
const CURRENCY = "USD";

// The Supabase client is loosely typed here because portfolio_* tables
// are added in this migration; types.generated.ts will catch up after
// `pnpm db:types` runs.
type PortfolioSupabase = SupabaseClient;

export async function ingestPortfolioSnapshot(
  supabase: PortfolioSupabase,
  args: IngestArgs,
): Promise<IngestResult> {
  const { entityCode, snapshotDate, bundle, uploadedBy } = args;

  const entityId = await resolveEntityId(supabase, entityCode);
  const policy = await resolveActivePolicy(supabase, snapshotDate);

  // ----- 1. Snapshot row (upsert in_progress) -----
  const snapshotId = await upsertSnapshotRow(supabase, {
    entityId,
    snapshotDate,
    policyId: policy.id,
    bundle,
    uploadedBy: uploadedBy ?? null,
  });

  try {
    // ----- 2. Replace child rows -----
    await deleteSnapshotChildren(supabase, snapshotId);

    // ----- 3. In-memory classify + join -----
    const classifications = bundle.loans.map((l) => classifyLoan(l, policy));
    const joinResults = resolveAllBorrowerJoins(bundle.loans, bundle.borrowers);

    // ----- 4. Insert -----
    await insertBorrowers(supabase, {
      snapshotId,
      entityId,
      snapshotDate,
      rows: bundle.borrowers,
    });
    await insertLoans(supabase, {
      snapshotId,
      entityId,
      snapshotDate,
      rows: bundle.loans,
      classifications,
      joinResults,
    });
    await insertRepayments(supabase, {
      snapshotId,
      entityId,
      snapshotDate,
      rows: bundle.repayments,
    });

    // ----- 5. DQ metrics -----
    const dqMetrics = computeDqMetrics({
      bundle,
      joinResults,
      loanClassifications: classifications,
    });
    await insertDqMetrics(supabase, snapshotId, dqMetrics);

    // ----- 6. Finalize -----
    const loansWithMatch = joinResults.filter(
      (r) => r.confidence !== "unresolved",
    ).length;
    const loansWithoutMatch = joinResults.length - loansWithMatch;

    await supabase
      .from("portfolio_snapshots")
      .update({
        status: "completed",
        finalized_at: new Date().toISOString(),
        borrower_row_count: bundle.borrowers.length,
        loan_row_count: bundle.loans.length,
        repayment_row_count: bundle.repayments.length,
        loans_with_borrower_match: loansWithMatch,
        loans_without_borrower_match: loansWithoutMatch,
        error_message: null,
      })
      .eq("id", snapshotId);

    return {
      snapshotId,
      status: "completed",
      borrowerRowCount: bundle.borrowers.length,
      loanRowCount: bundle.loans.length,
      repaymentRowCount: bundle.repayments.length,
      loansWithBorrowerMatch: loansWithMatch,
      loansWithoutBorrowerMatch: loansWithoutMatch,
      dqMetrics,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("portfolio_snapshots")
      .update({ status: "failed", error_message: message })
      .eq("id", snapshotId);
    throw err;
  }
}

// =============================================================
// Resolvers
// =============================================================

async function resolveEntityId(
  supabase: PortfolioSupabase,
  entityCode: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("portfolio_entities")
    .select("id")
    .eq("code", entityCode)
    .single();
  if (error || !data) {
    throw new Error(
      `portfolio_entities lookup failed for code=${entityCode}: ${error?.message ?? "no row"}`,
    );
  }
  return data.id as string;
}

async function resolveActivePolicy(
  supabase: PortfolioSupabase,
  snapshotDate: string,
): Promise<PortfolioPolicy> {
  const { data, error } = await supabase
    .from("portfolio_policy")
    .select("*")
    .lte("effective_from", snapshotDate)
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();
  if (error || !data) {
    throw new Error(
      `portfolio_policy lookup failed for snapshot_date=${snapshotDate}: ${error?.message ?? "no row"}`,
    );
  }
  return mapPolicyRow(data);
}

function mapPolicyRow(row: Record<string, unknown>): PortfolioPolicy {
  return {
    id: row.id as PortfolioPolicyId,
    effectiveFrom: row.effective_from as string,
    chargeOffDpdThreshold: row.charge_off_dpd_threshold as number,
    managementCutoffDate: row.management_cutoff_date as string,
    cashAdvanceAlwaysNew: row.cash_advance_always_new as boolean,
    stage2DpdMin: row.stage_2_dpd_min as number,
    stage3DpdMin: row.stage_3_dpd_min as number,
    nplDpdMin: row.npl_dpd_min as number,
    eclStage1Coverage:
      row.ecl_stage_1_coverage === null
        ? null
        : Number(row.ecl_stage_1_coverage),
    eclStage2Coverage:
      row.ecl_stage_2_coverage === null
        ? null
        : Number(row.ecl_stage_2_coverage),
    eclStage3Coverage:
      row.ecl_stage_3_coverage === null
        ? null
        : Number(row.ecl_stage_3_coverage),
  };
}

// =============================================================
// Snapshot row + child cleanup
// =============================================================

interface UpsertSnapshotArgs {
  entityId: string;
  snapshotDate: string;
  policyId: string;
  bundle: IngestArgs["bundle"];
  uploadedBy: string | null;
}

async function upsertSnapshotRow(
  supabase: PortfolioSupabase,
  args: UpsertSnapshotArgs,
): Promise<PortfolioSnapshotId> {
  const sourceFiles = {
    borrowers: args.bundle.meta.borrowers,
    loans: args.bundle.meta.loans,
    repayments: args.bundle.meta.repayments,
  };
  const insert = {
    entity_id: args.entityId,
    snapshot_date: args.snapshotDate,
    policy_id: args.policyId,
    source_files: sourceFiles,
    borrower_row_count: 0,
    loan_row_count: 0,
    repayment_row_count: 0,
    loans_with_borrower_match: 0,
    loans_without_borrower_match: 0,
    imported_by: args.uploadedBy,
    imported_at: new Date().toISOString(),
    status: "in_progress",
    error_message: null,
  };
  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .upsert(insert, { onConflict: "entity_id,snapshot_date" })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `portfolio_snapshots upsert failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id as PortfolioSnapshotId;
}

async function deleteSnapshotChildren(
  supabase: PortfolioSupabase,
  snapshotId: PortfolioSnapshotId,
): Promise<void> {
  const tables = [
    "portfolio_borrowers",
    "portfolio_loans",
    "portfolio_loan_repayments",
    "portfolio_snapshot_dq",
  ];
  for (const t of tables) {
    const { error } = await supabase.from(t).delete().eq("snapshot_id", snapshotId);
    if (error) {
      throw new Error(`Failed to clear ${t} for snapshot=${snapshotId}: ${error.message}`);
    }
  }
}

// =============================================================
// Inserters
// =============================================================

async function insertBorrowers(
  supabase: PortfolioSupabase,
  args: {
    snapshotId: PortfolioSnapshotId;
    entityId: string;
    snapshotDate: string;
    rows: IngestArgs["bundle"]["borrowers"];
  },
): Promise<void> {
  const inserts = args.rows.map((b) => ({
    snapshot_id: args.snapshotId,
    entity_id: args.entityId,
    snapshot_date: args.snapshotDate,
    source_borrower_id: b.sourceBorrowerId,
    unique_number: b.uniqueNumber,
    cedula_normalized: b.cedulaNormalized,
    full_name: b.fullName,
    last_name: b.lastName,
    first_name: b.firstName,
    gender: b.gender,
    age: b.age,
    date_of_birth: b.dateOfBirth,
    email: b.email,
    mobile: b.mobile,
    landline: b.landline,
    address: b.address,
    city: b.city,
    province: b.province,
    zipcode: b.zipcode,
    country: b.country,
    working_status: b.workingStatus,
    business: b.business,
    credit_score: b.creditScore,
    loan_officer_raw: b.loanOfficerRaw,
    borrower_status_raw: b.borrowerStatusRaw,
    created_date: b.createdDate,
    number_of_loans: b.numberOfLoans,
    number_of_open_loans: b.numberOfOpenLoans,
    number_of_fully_paid_loans: b.numberOfFullyPaidLoans,
    number_of_defaulted_loans: b.numberOfDefaultedLoans,
    number_of_processing_loans: b.numberOfProcessingLoans,
    number_of_restructured_loans: b.numberOfRestructuredLoans,
    number_of_denied_loans: b.numberOfDeniedLoans,
    number_of_not_taken_up_loans: b.numberOfNotTakenUpLoans,
    total_paid_amount_minor: bigintToString(b.totalPaidAmountMinor),
    open_loans_balance_minor: bigintToString(b.openLoansBalanceMinor),
    currency: CURRENCY,
    normalized_name: b.normalizedName,
    raw: b.raw,
  }));
  await chunkedInsert(supabase, "portfolio_borrowers", inserts);
}

async function insertLoans(
  supabase: PortfolioSupabase,
  args: {
    snapshotId: PortfolioSnapshotId;
    entityId: string;
    snapshotDate: string;
    rows: IngestArgs["bundle"]["loans"];
    classifications: ReturnType<typeof classifyLoan>[];
    joinResults: ReturnType<typeof resolveAllBorrowerJoins>;
  },
): Promise<void> {
  const inserts = args.rows.map((l, i) => {
    const c = args.classifications[i];
    const j = args.joinResults[i];
    return {
      snapshot_id: args.snapshotId,
      entity_id: args.entityId,
      snapshot_date: args.snapshotDate,
      source_loan_id: l.sourceLoanId,
      source_loan_number: l.sourceLoanNumber,
      source_borrower_ref: l.sourceBorrowerRef,
      resolved_source_borrower_id: j.resolvedSourceBorrowerId,
      borrower_join_confidence: j.confidence as PortfolioBorrowerJoinConfidence,
      product_raw: l.productRaw,
      product_group: c.productGroup as PortfolioProductGroup,
      loan_officer_raw: l.loanOfficerRaw,
      released_date: l.releasedDate,
      maturity_date: l.maturityDate,
      duration_months: l.durationMonths,
      repayment_cycle: l.repaymentCycle,
      interest_rate_raw: l.interestRateRaw,
      principal_amount_minor: bigintToString(l.principalAmountMinor),
      balance_amount_minor: bigintToString(l.balanceAmountMinor),
      total_principal_balance_minor: bigintToString(l.totalPrincipalBalanceMinor),
      pending_principal_due_minor: bigintToString(l.pendingPrincipalDueMinor),
      past_due_minor: bigintToString(l.pastDueMinor),
      pending_due_minor: bigintToString(l.pendingDueMinor),
      paid_amount_minor: bigintToString(l.paidAmountMinor),
      total_principal_paid_minor: bigintToString(l.totalPrincipalPaidMinor),
      total_interest_paid_minor: bigintToString(l.totalInterestPaidMinor),
      total_penalty_paid_minor: bigintToString(l.totalPenaltyPaidMinor),
      total_fees_paid_minor: bigintToString(l.totalFeesPaidMinor),
      total_penalty_balance_minor: bigintToString(l.totalPenaltyBalanceMinor),
      total_fees_balance_minor: bigintToString(l.totalFeesBalanceMinor),
      total_interest_balance_minor: bigintToString(l.totalInterestBalanceMinor),
      next_installment_amount_minor: bigintToString(l.nextInstallmentAmountMinor),
      next_installment_date: l.nextInstallmentDate,
      last_payment_amount_minor: bigintToString(l.lastPaymentAmountMinor),
      last_payment_date: l.lastPaymentDate,
      currency: CURRENCY,
      days_past_due: l.daysPastDue,
      days_past_maturity: l.daysPastMaturity,
      days_to_maturity: l.daysToMaturity,
      bank_account_loan_released: l.bankAccountLoanReleased,
      status_raw: l.statusRaw,
      status_normalized: c.statusNormalized as PortfolioLoanStatus,
      management_vintage: c.managementVintage as PortfolioManagementVintage,
      portfolio_segment: c.portfolioSegment as PortfolioSegment,
      ifrs_stage: c.ifrsStage as PortfolioIfrsStage,
      is_npl: c.isNpl,
      raw: l.raw,
    };
  });
  await chunkedInsert(supabase, "portfolio_loans", inserts);
}

async function insertRepayments(
  supabase: PortfolioSupabase,
  args: {
    snapshotId: PortfolioSnapshotId;
    entityId: string;
    snapshotDate: string;
    rows: IngestArgs["bundle"]["repayments"];
  },
): Promise<void> {
  const inserts = args.rows.map((r) => ({
    snapshot_id: args.snapshotId,
    entity_id: args.entityId,
    snapshot_date: args.snapshotDate,
    source_repayment_id: r.sourceRepaymentId,
    source_loan_id: r.sourceLoanId,
    source_borrower_ref: r.sourceBorrowerRef,
    collection_date: r.collectionDate,
    edit_date: r.editDate,
    method: r.method,
    is_cash_collection: r.isCashCollection,
    principal_paid_minor: r.principalPaidMinor.toString(),
    interest_paid_minor: r.interestPaidMinor.toString(),
    penalty_paid_minor: r.penaltyPaidMinor.toString(),
    fees_paid_minor: r.feesPaidMinor.toString(),
    total_paid_minor: r.totalPaidMinor.toString(),
    currency: CURRENCY,
    collected_by: r.collectedBy,
    approved_by: r.approvedBy,
    loan_officer_raw: r.loanOfficerRaw,
    description: r.description,
    bank_account_payment_raw: r.bankAccountPaymentRaw,
    raw: r.raw,
  }));
  await chunkedInsert(supabase, "portfolio_loan_repayments", inserts);
}

async function insertDqMetrics(
  supabase: PortfolioSupabase,
  snapshotId: PortfolioSnapshotId,
  metrics: DqMetric[],
): Promise<void> {
  const inserts = metrics.map((m) => ({
    snapshot_id: snapshotId,
    metric: m.metric,
    value_numeric: m.valueNumeric,
    value_text: m.valueText,
    severity: m.severity,
    detail: m.detail,
  }));
  await chunkedInsert(supabase, "portfolio_snapshot_dq", inserts);
}

// =============================================================
// Helpers
// =============================================================

function bigintToString(v: bigint | null): string | null {
  return v === null ? null : v.toString();
}

async function chunkedInsert(
  supabase: PortfolioSupabase,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) {
      throw new Error(`insert into ${table} failed at chunk ${i}: ${error.message}`);
    }
  }
}
