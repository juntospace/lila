-- Portfolio Analytics & Daily Backup — initial schema (Phase 1).
--
-- Scope: ingest a daily snapshot of the LoanDisk export (one CSV per
-- borrower/loan/repayment) per legal entity. Every fact row carries an
-- entity_id and a snapshot_date so the same day's import can be replayed
-- idempotently while prior days are preserved (daily evolution is the
-- core analytic — aging trends, roll rates, vintage curves all need it).
--
-- Tables (all RLS-on):
--   portfolio_entities       — Crediclaro, Junto Soluciones (and future).
--   portfolio_policy         — configurable thresholds (charge-off, staging,
--                              management cutoff). Seeded with defaults
--                              that the user can change without a deploy.
--   portfolio_snapshots      — one row per (entity, date); ingest registry.
--   portfolio_borrowers      — one row per borrower per snapshot.
--   portfolio_loans          — one row per loan per snapshot.
--   portfolio_loan_repayments — one row per repayment per snapshot.
--   portfolio_snapshot_dq    — per-snapshot data-quality metrics.
--
-- Money convention: *_minor bigint + currency char(3) (CLAUDE.md §8.3).
-- set_updated_at() is defined in 20260427120000_user_profiles.sql.
-- is_active_operator() is defined in 20260429180000_recon_collection_initial_schema.sql.

-- =============================================================
-- Enums
-- =============================================================

do $$ begin
  create type portfolio_entities_code_enum as enum (
    'crediclaro',
    'junto_soluciones'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type portfolio_snapshots_status_enum as enum (
    'in_progress',
    'completed',
    'failed'
  );
exception when duplicate_object then null; end $$;

-- Normalized loan status. Mapped from LoanDisk's "Loan Status Name" by
-- the ingest layer using the active portfolio_policy thresholds.
do $$ begin
  create type portfolio_loans_status_enum as enum (
    'closed',
    'performing',
    'delinquent',
    'legacy_delinquent'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type portfolio_loans_management_vintage_enum as enum (
    'old',
    'new'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type portfolio_loans_product_group_enum as enum (
    'personal_collateralized',
    'personal_uncollateralized',
    'cash_advance',
    'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type portfolio_loans_portfolio_segment_enum as enum (
    'old_personal',
    'new_personal',
    'cash_advance',
    'other'
  );
exception when duplicate_object then null; end $$;

-- IFRS-9-style staging. Thresholds live in portfolio_policy.
do $$ begin
  create type portfolio_loans_ifrs_stage_enum as enum (
    'stage_1',
    'stage_2',
    'stage_3',
    'closed'
  );
exception when duplicate_object then null; end $$;

-- How a loan's "Borrower #" was resolved back to a portfolio_borrowers row.
-- Recorded per loan so DQ + drill-down can show low-confidence joins.
do $$ begin
  create type portfolio_loans_borrower_join_enum as enum (
    'exact_unique_number',
    'normalized_name',
    'unresolved'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type portfolio_snapshot_dq_severity_enum as enum (
    'ok',
    'warn',
    'critical'
  );
exception when duplicate_object then null; end $$;

-- =============================================================
-- Tables
-- =============================================================

-- portfolio_entities ------------------------------------------------------
create table if not exists public.portfolio_entities (
  id uuid primary key default gen_random_uuid(),
  code portfolio_entities_code_enum not null,
  display_name text not null,
  legal_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portfolio_entities_code_unique unique (code)
);

drop trigger if exists portfolio_entities_set_updated_at on public.portfolio_entities;
create trigger portfolio_entities_set_updated_at
before update on public.portfolio_entities
for each row execute function public.set_updated_at();

-- portfolio_policy --------------------------------------------------------
-- Single active row at any time. Inserting a new row with a later
-- effective_from supersedes it. We never UPDATE a past row — policy
-- changes are a new version, so historical snapshots can re-derive
-- under the policy that was active at the time.
create table if not exists public.portfolio_policy (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null,

  -- O1 — charge-off / legacy threshold. Loans with dpd > this are
  -- bucketed as 'legacy_delinquent' so they don't pollute active-book
  -- aging displayed to the board.
  charge_off_dpd_threshold int not null default 365,

  -- O3 — management vintage cutoff. Loans with released_date >= this
  -- are "new management", otherwise "old". Cash Advance is always "new"
  -- (it's a current-management product) — see cash_advance_always_new.
  management_cutoff_date date not null default '2025-01-01',
  cash_advance_always_new boolean not null default true,

  -- O4 — IFRS staging thresholds.
  stage_2_dpd_min int not null default 30,
  stage_3_dpd_min int not null default 90,

  -- NPL / PAR-90 threshold (frequently reported).
  npl_dpd_min int not null default 90,

  -- ECL coverage rates per stage (decimal 0..1). Empty until risk
  -- supplies the matrix — Phase 1 stores them, Phase 2 applies them.
  ecl_stage_1_coverage numeric(6,4),
  ecl_stage_2_coverage numeric(6,4),
  ecl_stage_3_coverage numeric(6,4),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint portfolio_policy_stage_thresholds_check
    check (stage_2_dpd_min < stage_3_dpd_min),
  constraint portfolio_policy_npl_check
    check (npl_dpd_min >= stage_3_dpd_min),
  constraint portfolio_policy_effective_from_unique
    unique (effective_from)
);

drop trigger if exists portfolio_policy_set_updated_at on public.portfolio_policy;
create trigger portfolio_policy_set_updated_at
before update on public.portfolio_policy
for each row execute function public.set_updated_at();

-- portfolio_snapshots -----------------------------------------------------
create table if not exists public.portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.portfolio_entities(id) on delete restrict,
  snapshot_date date not null,
  policy_id uuid not null references public.portfolio_policy(id) on delete restrict,

  -- Source files used to build this snapshot. Each entry:
  --   { filename: text, sha256: text, byte_size: int, row_count: int }
  source_files jsonb not null default '{}'::jsonb,

  -- Roll-ups, set by ingest at finalization.
  borrower_row_count int not null default 0,
  loan_row_count int not null default 0,
  repayment_row_count int not null default 0,

  -- Borrower-join health, set by ingest. Surfaces DQ issue O2.
  loans_with_borrower_match int not null default 0,
  loans_without_borrower_match int not null default 0,

  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  finalized_at timestamptz,

  status portfolio_snapshots_status_enum not null default 'in_progress',
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint portfolio_snapshots_entity_date_unique
    unique (entity_id, snapshot_date)
);

create index if not exists portfolio_snapshots_entity_date_idx
  on public.portfolio_snapshots (entity_id, snapshot_date desc);

drop trigger if exists portfolio_snapshots_set_updated_at on public.portfolio_snapshots;
create trigger portfolio_snapshots_set_updated_at
before update on public.portfolio_snapshots
for each row execute function public.set_updated_at();

-- portfolio_borrowers -----------------------------------------------------
create table if not exists public.portfolio_borrowers (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,
  entity_id uuid not null references public.portfolio_entities(id) on delete restrict,
  snapshot_date date not null,

  -- LoanDisk identifiers.
  source_borrower_id text not null,         -- LoanDisk "Borrower Id" (numeric)
  unique_number text,                       -- LoanDisk "Unique Number" — join key candidate
  -- Normalized cédula for joins/dedup; not authoritative — DQ-derived.
  cedula_normalized text,

  -- Identity.
  full_name text,
  last_name text,
  first_name text,
  gender text,
  age int,
  date_of_birth date,

  -- Contact.
  email text,
  mobile text,
  landline text,
  address text,
  city text,
  province text,
  zipcode text,
  country text,

  -- Profile.
  working_status text,
  business text,
  credit_score int,
  loan_officer_raw text,
  borrower_status_raw text,                 -- LoanDisk "Borrower Status Name"
  created_date date,                        -- LoanDisk "Created Date"

  -- Denormalized per-borrower aggregates from LoanDisk (used as control
  -- totals in DQ — we re-derive these from portfolio_loans and compare).
  number_of_loans int,
  number_of_open_loans int,
  number_of_fully_paid_loans int,
  number_of_defaulted_loans int,
  number_of_processing_loans int,
  number_of_restructured_loans int,
  number_of_denied_loans int,
  number_of_not_taken_up_loans int,
  total_paid_amount_minor bigint,
  open_loans_balance_minor bigint,
  currency char(3) not null default 'USD',

  -- Normalized name + tokens for fuzzy borrower↔loan join when
  -- exact unique_number doesn't match. Computed by ingest, not stored
  -- raw from the file.
  normalized_name text,

  -- Full original row for fields we haven't structured (forward-compat).
  raw jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint portfolio_borrowers_snapshot_source_unique
    unique (snapshot_id, source_borrower_id)
);

create index if not exists portfolio_borrowers_entity_date_idx
  on public.portfolio_borrowers (entity_id, snapshot_date desc);

-- Hot lookup paths for the borrower↔loan join resolver.
create index if not exists portfolio_borrowers_snapshot_unique_number_idx
  on public.portfolio_borrowers (snapshot_id, unique_number)
  where unique_number is not null;
create index if not exists portfolio_borrowers_snapshot_cedula_idx
  on public.portfolio_borrowers (snapshot_id, cedula_normalized)
  where cedula_normalized is not null;
create index if not exists portfolio_borrowers_snapshot_normalized_name_idx
  on public.portfolio_borrowers (snapshot_id, normalized_name)
  where normalized_name is not null;

drop trigger if exists portfolio_borrowers_set_updated_at on public.portfolio_borrowers;
create trigger portfolio_borrowers_set_updated_at
before update on public.portfolio_borrowers
for each row execute function public.set_updated_at();

-- portfolio_loans ---------------------------------------------------------
create table if not exists public.portfolio_loans (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,
  entity_id uuid not null references public.portfolio_entities(id) on delete restrict,
  snapshot_date date not null,

  -- LoanDisk identifiers.
  source_loan_id text not null,              -- LoanDisk "Loan Id"
  source_loan_number text,                   -- LoanDisk "Loan #" (display label)
  source_borrower_ref text,                  -- LoanDisk "Borrower #" — join key

  -- Resolved borrower (Phase 1 stores source_borrower_id only; the FK
  -- to portfolio_borrowers.id is intentionally not enforced because
  -- borrower resolution is best-effort and may fail).
  resolved_source_borrower_id text,
  borrower_join_confidence portfolio_loans_borrower_join_enum
    not null default 'unresolved',

  -- Terms.
  product_raw text,
  product_group portfolio_loans_product_group_enum not null default 'other',
  loan_officer_raw text,
  released_date date,
  maturity_date date,
  duration_months int,
  repayment_cycle text,
  -- Interest rate is unreliable in source (>800% spikes on recent rows);
  -- we keep it raw and DO NOT use it for risk metrics in Phase 1.
  interest_rate_raw text,

  -- Balances.
  principal_amount_minor bigint,
  balance_amount_minor bigint,
  total_principal_balance_minor bigint,
  pending_principal_due_minor bigint,
  past_due_minor bigint,
  pending_due_minor bigint,
  paid_amount_minor bigint,
  total_principal_paid_minor bigint,
  total_interest_paid_minor bigint,
  total_penalty_paid_minor bigint,
  total_fees_paid_minor bigint,
  total_penalty_balance_minor bigint,
  total_fees_balance_minor bigint,
  total_interest_balance_minor bigint,
  next_installment_amount_minor bigint,
  next_installment_date date,
  last_payment_amount_minor bigint,
  last_payment_date date,
  currency char(3) not null default 'USD',

  -- Delinquency.
  days_past_due int,
  days_past_maturity int,
  days_to_maturity int,

  -- Disbursement.
  bank_account_loan_released text,

  -- Classification (computed by ingest at this snapshot's policy).
  status_raw text,                           -- LoanDisk "Loan Status Name"
  status_normalized portfolio_loans_status_enum,
  management_vintage portfolio_loans_management_vintage_enum,
  portfolio_segment portfolio_loans_portfolio_segment_enum,
  ifrs_stage portfolio_loans_ifrs_stage_enum,
  is_npl boolean,

  -- Full original row for forward-compat (94 columns in source).
  raw jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint portfolio_loans_snapshot_source_unique
    unique (snapshot_id, source_loan_id)
);

create index if not exists portfolio_loans_entity_date_idx
  on public.portfolio_loans (entity_id, snapshot_date desc);
create index if not exists portfolio_loans_snapshot_segment_idx
  on public.portfolio_loans (snapshot_id, portfolio_segment);
create index if not exists portfolio_loans_snapshot_status_idx
  on public.portfolio_loans (snapshot_id, status_normalized);
create index if not exists portfolio_loans_snapshot_borrower_idx
  on public.portfolio_loans (snapshot_id, resolved_source_borrower_id)
  where resolved_source_borrower_id is not null;
create index if not exists portfolio_loans_released_date_idx
  on public.portfolio_loans (entity_id, released_date)
  where released_date is not null;

drop trigger if exists portfolio_loans_set_updated_at on public.portfolio_loans;
create trigger portfolio_loans_set_updated_at
before update on public.portfolio_loans
for each row execute function public.set_updated_at();

-- portfolio_loan_repayments ----------------------------------------------
create table if not exists public.portfolio_loan_repayments (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,
  entity_id uuid not null references public.portfolio_entities(id) on delete restrict,
  snapshot_date date not null,

  -- LoanDisk identifiers.
  source_repayment_id text not null,
  source_loan_id text not null,
  source_borrower_ref text,

  collection_date date,
  edit_date date,
  method text,
  -- LoanDisk methods 'Traspaso a Provision' / 'Finiquito otorgado' are
  -- accounting moves, not real cash inflow. Pre-computed for downstream
  -- collection metrics so they aren't accidentally counted as cash.
  is_cash_collection boolean not null default true,

  principal_paid_minor bigint not null default 0,
  interest_paid_minor bigint not null default 0,
  penalty_paid_minor bigint not null default 0,
  fees_paid_minor bigint not null default 0,
  total_paid_minor bigint not null default 0,
  currency char(3) not null default 'USD',

  collected_by text,
  approved_by text,
  loan_officer_raw text,
  description text,

  -- The recon-bridge: e.g. "Banco General ****6916" or "BAC ****2600
  -- Junto". Preserve verbatim — this is the column that will eventually
  -- match a recon_transactions credit (cross-entity flows show up here).
  bank_account_payment_raw text,

  raw jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint portfolio_loan_repayments_snapshot_source_unique
    unique (snapshot_id, source_repayment_id)
);

create index if not exists portfolio_loan_repayments_entity_date_idx
  on public.portfolio_loan_repayments (entity_id, snapshot_date desc);
create index if not exists portfolio_loan_repayments_snapshot_loan_idx
  on public.portfolio_loan_repayments (snapshot_id, source_loan_id);
create index if not exists portfolio_loan_repayments_collection_date_idx
  on public.portfolio_loan_repayments (entity_id, collection_date)
  where collection_date is not null;
create index if not exists portfolio_loan_repayments_bank_account_idx
  on public.portfolio_loan_repayments (entity_id, bank_account_payment_raw)
  where bank_account_payment_raw is not null;

drop trigger if exists portfolio_loan_repayments_set_updated_at on public.portfolio_loan_repayments;
create trigger portfolio_loan_repayments_set_updated_at
before update on public.portfolio_loan_repayments
for each row execute function public.set_updated_at();

-- portfolio_snapshot_dq ---------------------------------------------------
create table if not exists public.portfolio_snapshot_dq (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,

  -- A short stable key for the metric, e.g.
  --   'borrower_join_match_rate', 'borrower_field_completeness_gender',
  --   'control_total_open_balance_diff', 'interest_rate_out_of_range_count',
  --   'product_in_officer_field_count', 'legacy_delinquent_loan_count'.
  metric text not null,
  value_numeric numeric,
  value_text text,
  severity portfolio_snapshot_dq_severity_enum not null default 'ok',
  detail jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  constraint portfolio_snapshot_dq_snapshot_metric_unique
    unique (snapshot_id, metric)
);

create index if not exists portfolio_snapshot_dq_severity_idx
  on public.portfolio_snapshot_dq (snapshot_id, severity);

-- =============================================================
-- RBAC helper for write access
-- =============================================================

-- Reuse is_active_operator() (defined in 20260429180000) for reads.
-- Writes require a portfolio-writer role: same set as the recon writer
-- (loan_officer | admin), kept as its own predicate so the two domains
-- can diverge later without coupling.
create or replace function public.is_portfolio_writer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid()
      and status = 'active'
      and role in ('loan_officer', 'admin')
  );
$$;

-- =============================================================
-- RLS
-- =============================================================

alter table public.portfolio_entities         enable row level security;
alter table public.portfolio_policy           enable row level security;
alter table public.portfolio_snapshots        enable row level security;
alter table public.portfolio_borrowers        enable row level security;
alter table public.portfolio_loans            enable row level security;
alter table public.portfolio_loan_repayments  enable row level security;
alter table public.portfolio_snapshot_dq      enable row level security;

-- portfolio_entities
drop policy if exists portfolio_entities_select_operators on public.portfolio_entities;
create policy portfolio_entities_select_operators
on public.portfolio_entities for select to authenticated
using (public.is_active_operator());

drop policy if exists portfolio_entities_write_writers on public.portfolio_entities;
create policy portfolio_entities_write_writers
on public.portfolio_entities for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

-- portfolio_policy
drop policy if exists portfolio_policy_select_operators on public.portfolio_policy;
create policy portfolio_policy_select_operators
on public.portfolio_policy for select to authenticated
using (public.is_active_operator());

drop policy if exists portfolio_policy_write_writers on public.portfolio_policy;
create policy portfolio_policy_write_writers
on public.portfolio_policy for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

-- portfolio_snapshots
drop policy if exists portfolio_snapshots_select_operators on public.portfolio_snapshots;
create policy portfolio_snapshots_select_operators
on public.portfolio_snapshots for select to authenticated
using (public.is_active_operator());

drop policy if exists portfolio_snapshots_write_writers on public.portfolio_snapshots;
create policy portfolio_snapshots_write_writers
on public.portfolio_snapshots for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

-- portfolio_borrowers
drop policy if exists portfolio_borrowers_select_operators on public.portfolio_borrowers;
create policy portfolio_borrowers_select_operators
on public.portfolio_borrowers for select to authenticated
using (public.is_active_operator());

drop policy if exists portfolio_borrowers_write_writers on public.portfolio_borrowers;
create policy portfolio_borrowers_write_writers
on public.portfolio_borrowers for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

-- portfolio_loans
drop policy if exists portfolio_loans_select_operators on public.portfolio_loans;
create policy portfolio_loans_select_operators
on public.portfolio_loans for select to authenticated
using (public.is_active_operator());

drop policy if exists portfolio_loans_write_writers on public.portfolio_loans;
create policy portfolio_loans_write_writers
on public.portfolio_loans for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

-- portfolio_loan_repayments
drop policy if exists portfolio_loan_repayments_select_operators on public.portfolio_loan_repayments;
create policy portfolio_loan_repayments_select_operators
on public.portfolio_loan_repayments for select to authenticated
using (public.is_active_operator());

drop policy if exists portfolio_loan_repayments_write_writers on public.portfolio_loan_repayments;
create policy portfolio_loan_repayments_write_writers
on public.portfolio_loan_repayments for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

-- portfolio_snapshot_dq
drop policy if exists portfolio_snapshot_dq_select_operators on public.portfolio_snapshot_dq;
create policy portfolio_snapshot_dq_select_operators
on public.portfolio_snapshot_dq for select to authenticated
using (public.is_active_operator());

drop policy if exists portfolio_snapshot_dq_write_writers on public.portfolio_snapshot_dq;
create policy portfolio_snapshot_dq_write_writers
on public.portfolio_snapshot_dq for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

-- =============================================================
-- Seed data
-- =============================================================

-- Both entities exist from day one; Junto Soluciones holds no portfolio
-- yet but the ingest pipeline must accept it the moment its data lands.
insert into public.portfolio_entities (code, display_name, legal_name)
values
  ('crediclaro',       'Crediclaro',       'Crediclaro, S.A.'),
  ('junto_soluciones', 'Junto Soluciones', 'Junto Soluciones, S.A.')
on conflict (code) do nothing;

-- Default policy v1. Values are the spec's documented defaults; risk
-- supplies ECL coverage rates later (left null on purpose).
insert into public.portfolio_policy (
  effective_from,
  charge_off_dpd_threshold,
  management_cutoff_date,
  cash_advance_always_new,
  stage_2_dpd_min,
  stage_3_dpd_min,
  npl_dpd_min,
  notes
) values (
  '2026-01-01',
  365,
  '2025-01-01',
  true,
  30,
  90,
  90,
  'Initial defaults. Charge-off threshold and management cutoff per build spec §9. ECL coverage rates pending risk-team input.'
) on conflict (effective_from) do nothing;
