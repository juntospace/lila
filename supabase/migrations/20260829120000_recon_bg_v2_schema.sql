-- Banco General (CCBG v2) Reconciliation Schema
-- Extends LILA's public reconciliation schema for the Banco General rail (Crediclaro account).
-- Uses *_minor bigint money convention per CLAUDE.md §8.3.
-- All identifiers, tables, columns, and enums in English.

-- =============================================================
-- 1. Enums
-- =============================================================

-- Add yappy_bg_excel to recon_uploads_method_enum if not exists
alter type public.recon_uploads_method_enum add value if not exists 'yappy_bg_excel';

do $$ begin
  create type public.recon_bg_batch_status_enum as enum (
    'settled',
    'settled_no_reversals',
    'pending',
    'anomaly'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.recon_bg_item_status_enum as enum (
    'rejected',
    'confirmed',
    'pending'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.recon_bg_yappy_status_enum as enum (
    'received',
    'in_transit',
    'pending',
    'anomaly',
    'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.recon_bg_task_type_enum as enum (
    'missing_statement',
    'missing_ach_detail',
    'missing_yappy_report'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.recon_assignment_category_enum as enum (
    'loan',
    'non_loan',
    'other'
  );
exception when duplicate_object then null; end $$;

-- =============================================================
-- 2. ACH Batches Table (recon_bg_batches)
-- =============================================================

create table if not exists public.recon_bg_batches (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete restrict,
  upload_id uuid references public.recon_uploads(id) on delete set null,

  batch_uid text not null,                      -- e.g. "lote#20260814#TER15#r2" or "lote#20260814#s0"
  batch_date_str text not null,                 -- raw yyyymmdd string from filename or reversal
  batch_filename text,
  channel text,                                 -- e.g. "TER", "BG"
  fortnight smallint,                           -- 15, 30
  is_delinquent boolean not null default false, -- morosos
  retry_count smallint not null default 1,      -- reintento
  variant text,                                 -- "A" | "B" | "PDF"
  effective_date date,
  credit_date date,

  total_transactions int,
  succeeded_transactions int,
  declared_rejected_transactions int,
  rejected_rows_count int,
  succeeded_rows_count int,

  total_amount_minor bigint,
  rejected_amount_minor bigint,
  succeeded_amount_minor bigint,
  itemized_succeeded_amount_minor bigint,

  status public.recon_bg_batch_status_enum not null default 'pending',
  pending_reason text,

  credit_mov_uid text,
  reversals_mov_uids text[] not null default '{}',

  is_active boolean not null default true,      -- snapshot soft-delete flag

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint recon_bg_batches_account_uid_unique unique (account_id, batch_uid)
);

create index if not exists recon_bg_batches_account_date_idx
  on public.recon_bg_batches (account_id, batch_date_str);

create index if not exists recon_bg_batches_account_status_idx
  on public.recon_bg_batches (account_id, status);

-- =============================================================
-- 3. Yappy Batches Table (recon_bg_yappy_batches)
-- =============================================================

create table if not exists public.recon_bg_yappy_batches (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete restrict,
  upload_id uuid references public.recon_uploads(id) on delete set null,

  batch_uid text not null,                      -- e.g. "ypl#2026-08-06#0"
  credit_date date not null,
  transaction_date date,

  declared_count int,
  report_count int,

  credit_amount_minor bigint not null,
  report_amount_minor bigint,
  fee_amount_minor bigint,
  fee_rate numeric(8,4),

  status public.recon_bg_batch_status_enum not null default 'pending',
  pending_reason text,
  credit_mov_uid text,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint recon_bg_yappy_batches_account_uid_unique unique (account_id, batch_uid)
);

create index if not exists recon_bg_yappy_batches_account_credit_date_idx
  on public.recon_bg_yappy_batches (account_id, credit_date);

-- =============================================================
-- 4. Yappy Individual Lines (recon_bg_yappy_lines)
-- =============================================================

create table if not exists public.recon_bg_yappy_lines (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete restrict,
  upload_id uuid references public.recon_uploads(id) on delete set null,

  line_uid text not null,                       -- e.g. "yp#2026-08-05#ASQFN-57002240"
  posted_date date not null,
  posted_time text,
  reference text not null,
  client_name text,
  phone_number text,
  comment text,
  amount_minor bigint not null,

  bank_status text not null,                    -- "Procesado" | "En tránsito" | etc.
  status public.recon_bg_yappy_status_enum not null default 'pending',

  settlement_batch_uid text,
  settlement_date date,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint recon_bg_yappy_lines_account_uid_unique unique (account_id, line_uid)
);

create index if not exists recon_bg_yappy_lines_account_date_idx
  on public.recon_bg_yappy_lines (account_id, posted_date);

create index if not exists recon_bg_yappy_lines_account_ref_idx
  on public.recon_bg_yappy_lines (account_id, reference);

-- =============================================================
-- 5. Statement Coverage Table (recon_bg_coverage)
-- =============================================================

create table if not exists public.recon_bg_coverage (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete restrict,

  coverage_date date not null,
  is_provisional boolean not null default false,
  is_quarantined boolean not null default false,
  source_filenames text[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint recon_bg_coverage_account_date_unique unique (account_id, coverage_date)
);

create index if not exists recon_bg_coverage_account_date_idx
  on public.recon_bg_coverage (account_id, coverage_date);

-- =============================================================
-- 6. Missing Tasks / Actionable Pending (recon_bg_pending_tasks)
-- =============================================================

create table if not exists public.recon_bg_pending_tasks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete restrict,

  task_type public.recon_bg_task_type_enum not null,
  missing_item text not null,
  details text,
  affects_uid text,
  amount_minor bigint,
  is_resolved boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recon_bg_pending_tasks_account_resolved_idx
  on public.recon_bg_pending_tasks (account_id, is_resolved);

-- =============================================================
-- 7. Audit Alerts Table (recon_bg_audit_alerts)
-- =============================================================

create table if not exists public.recon_bg_audit_alerts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete restrict,

  message text not null,
  severity text not null default 'warn',        -- 'info' | 'warn' | 'error'

  created_at timestamptz not null default now()
);

create index if not exists recon_bg_audit_alerts_account_created_idx
  on public.recon_bg_audit_alerts (account_id, created_at desc);

-- =============================================================
-- 8. Manual Assignments Table (recon_manual_assignments)
-- =============================================================

create table if not exists public.recon_manual_assignments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete restrict,

  target_uid text not null,                     -- target movement or item uid, e.g. "2026-08-01#m000"
  category public.recon_assignment_category_enum not null default 'loan',
  notes text,

  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint recon_manual_assignments_account_target_unique unique (account_id, target_uid)
);

create index if not exists recon_manual_assignments_account_target_idx
  on public.recon_manual_assignments (account_id, target_uid);

-- =============================================================
-- 9. Updated At Triggers
-- =============================================================

drop trigger if exists recon_bg_batches_set_updated_at on public.recon_bg_batches;
create trigger recon_bg_batches_set_updated_at
before update on public.recon_bg_batches
for each row execute function public.set_updated_at();

drop trigger if exists recon_bg_yappy_batches_set_updated_at on public.recon_bg_yappy_batches;
create trigger recon_bg_yappy_batches_set_updated_at
before update on public.recon_bg_yappy_batches
for each row execute function public.set_updated_at();

drop trigger if exists recon_bg_yappy_lines_set_updated_at on public.recon_bg_yappy_lines;
create trigger recon_bg_yappy_lines_set_updated_at
before update on public.recon_bg_yappy_lines
for each row execute function public.set_updated_at();

drop trigger if exists recon_bg_coverage_set_updated_at on public.recon_bg_coverage;
create trigger recon_bg_coverage_set_updated_at
before update on public.recon_bg_coverage
for each row execute function public.set_updated_at();

drop trigger if exists recon_bg_pending_tasks_set_updated_at on public.recon_bg_pending_tasks;
create trigger recon_bg_pending_tasks_set_updated_at
before update on public.recon_bg_pending_tasks
for each row execute function public.set_updated_at();

drop trigger if exists recon_manual_assignments_set_updated_at on public.recon_manual_assignments;
create trigger recon_manual_assignments_set_updated_at
before update on public.recon_manual_assignments
for each row execute function public.set_updated_at();

-- =============================================================
-- 10. Row Level Security (RLS)
-- =============================================================

alter table public.recon_bg_batches enable row level security;
alter table public.recon_bg_yappy_batches enable row level security;
alter table public.recon_bg_yappy_lines enable row level security;
alter table public.recon_bg_coverage enable row level security;
alter table public.recon_bg_pending_tasks enable row level security;
alter table public.recon_bg_audit_alerts enable row level security;
alter table public.recon_manual_assignments enable row level security;

-- Read policies for active operators
create policy recon_bg_batches_select_operators on public.recon_bg_batches
  for select to authenticated using (public.is_active_operator());

create policy recon_bg_yappy_batches_select_operators on public.recon_bg_yappy_batches
  for select to authenticated using (public.is_active_operator());

create policy recon_bg_yappy_lines_select_operators on public.recon_bg_yappy_lines
  for select to authenticated using (public.is_active_operator());

create policy recon_bg_coverage_select_operators on public.recon_bg_coverage
  for select to authenticated using (public.is_active_operator());

create policy recon_bg_pending_tasks_select_operators on public.recon_bg_pending_tasks
  for select to authenticated using (public.is_active_operator());

create policy recon_bg_audit_alerts_select_operators on public.recon_bg_audit_alerts
  for select to authenticated using (public.is_active_operator());

create policy recon_manual_assignments_select_operators on public.recon_manual_assignments
  for select to authenticated using (public.is_active_operator());

-- Write policies for recon writers
create policy recon_bg_batches_write_writers on public.recon_bg_batches
  for all to authenticated using (public.is_recon_writer()) with check (public.is_recon_writer());

create policy recon_bg_yappy_batches_write_writers on public.recon_bg_yappy_batches
  for all to authenticated using (public.is_recon_writer()) with check (public.is_recon_writer());

create policy recon_bg_yappy_lines_write_writers on public.recon_bg_yappy_lines
  for all to authenticated using (public.is_recon_writer()) with check (public.is_recon_writer());

create policy recon_bg_coverage_write_writers on public.recon_bg_coverage
  for all to authenticated using (public.is_recon_writer()) with check (public.is_recon_writer());

create policy recon_bg_pending_tasks_write_writers on public.recon_bg_pending_tasks
  for all to authenticated using (public.is_recon_writer()) with check (public.is_recon_writer());

create policy recon_bg_audit_alerts_write_writers on public.recon_bg_audit_alerts
  for all to authenticated using (public.is_recon_writer()) with check (public.is_recon_writer());

create policy recon_manual_assignments_write_writers on public.recon_manual_assignments
  for all to authenticated using (public.is_recon_writer()) with check (public.is_recon_writer());

