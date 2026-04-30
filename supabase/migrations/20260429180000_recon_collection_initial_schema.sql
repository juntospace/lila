-- Rail Collection Reconciliation — initial schema.
-- Scope: BAC bank rail, manual Excel statement uploads.
-- Tables: bank_accounts, recon_uploads, recon_transactions, recon_links,
-- recon_manual_actions. RLS enabled on all five.
--
-- Money convention: *_minor bigint + currency char(3) (per CLAUDE.md §8.3).
-- The set_updated_at() function is defined in 20260427120000_user_profiles.sql.

-- =============================================================
-- Enums
-- =============================================================

do $$ begin
  create type bank_accounts_rail_enum as enum ('bac');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bank_accounts_status_enum as enum ('active', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type recon_uploads_method_enum as enum ('statement_excel');
exception when duplicate_object then null; end $$;

do $$ begin
  create type recon_uploads_status_enum as enum ('parsed', 'committed', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type recon_transactions_kind_enum as enum (
    'loan_inflow', 'reversal', 'non_loan', 'unknown'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type recon_transactions_state_enum as enum (
    'pending', 'confirmed', 'rejected', 'non_loan', 'pending_pair'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type recon_links_strategy_enum as enum (
    'auto_fifo_name_amount', 'manual'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type recon_manual_actions_action_enum as enum (
    'force_confirm', 'force_reject', 'reclassify'
  );
exception when duplicate_object then null; end $$;

-- =============================================================
-- Tables
-- =============================================================

create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  rail bank_accounts_rail_enum not null,
  account_number text not null,
  holder_name text not null,
  currency char(3) not null default 'USD',
  status bank_accounts_status_enum not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_accounts_rail_account_unique unique (rail, account_number)
);

create table if not exists public.recon_uploads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete restrict,
  method recon_uploads_method_enum not null,
  file_sha256 text not null,
  original_filename text,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),

  date_range_start date,
  date_range_end date,
  saldo_inicial_minor bigint,
  saldo_final_minor bigint,
  integrity_ok boolean,

  rows_total int not null default 0,
  rows_new int not null default 0,
  rows_duplicate int not null default 0,

  status recon_uploads_status_enum not null default 'parsed',
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Identical bytes for the same account = a duplicate upload attempt.
  constraint recon_uploads_account_sha_unique unique (account_id, file_sha256)
);

create index if not exists recon_uploads_account_uploaded_at_idx
  on public.recon_uploads (account_id, uploaded_at desc);

create table if not exists public.recon_transactions (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.recon_uploads(id) on delete restrict,
  account_id uuid not null references public.bank_accounts(id) on delete restrict,

  posted_at date not null,
  rail_native_ref text,                       -- BAC "Referencia"
  code text not null,                         -- PR | 4C | DA | AD | TX | FE | 4A | ...
  description text,

  debit_minor bigint not null default 0,
  credit_minor bigint not null default 0,
  balance_minor bigint,
  currency char(3) not null,

  -- DA-only fields (parsed from "DVTO {return_code}-{name}")
  return_code text,
  payer_name_raw text,

  -- Classification
  kind recon_transactions_kind_enum not null default 'unknown',
  state recon_transactions_state_enum not null default 'pending',
  confirmable_after timestamptz,              -- set on PR rows: posted_at + 24h

  -- Row idempotency: re-uploading the same logical line collapses here
  -- instead of inserting a duplicate. Hash composition is owned by the
  -- ingest layer (sha256 of account_id, posted_at, ref, code, desc,
  -- debit_minor, credit_minor, balance_minor).
  row_hash text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint recon_transactions_row_hash_unique unique (account_id, row_hash),
  -- A bank line is either a debit or a credit, never both, never negative.
  constraint recon_transactions_amount_check check (
    debit_minor  >= 0 and credit_minor >= 0
    and not (debit_minor > 0 and credit_minor > 0)
  )
);

create index if not exists recon_transactions_account_posted_at_idx
  on public.recon_transactions (account_id, posted_at);

create index if not exists recon_transactions_state_code_idx
  on public.recon_transactions (state, code);

-- Hot path: FIFO pairing scans unmatched PR/DA rows by account + date.
create index if not exists recon_transactions_pairing_idx
  on public.recon_transactions (account_id, code, state, posted_at)
  where code in ('PR', 'DA');

create table if not exists public.recon_links (
  pr_txn_id uuid primary key
    references public.recon_transactions(id) on delete restrict,
  da_txn_id uuid not null unique
    references public.recon_transactions(id) on delete restrict,
  match_strategy recon_links_strategy_enum not null,
  matched_by uuid references auth.users(id) on delete set null,
  matched_at timestamptz not null default now(),
  constraint recon_links_distinct_check check (pr_txn_id <> da_txn_id)
);

create table if not exists public.recon_manual_actions (
  id uuid primary key default gen_random_uuid(),
  txn_id uuid not null references public.recon_transactions(id) on delete restrict,
  action recon_manual_actions_action_enum not null,
  prior_state recon_transactions_state_enum,
  new_state recon_transactions_state_enum,
  prior_kind recon_transactions_kind_enum,
  new_kind recon_transactions_kind_enum,
  justification text not null
    check (length(btrim(justification)) > 0),
  acted_by uuid references auth.users(id) on delete set null,
  acted_at timestamptz not null default now()
);

create index if not exists recon_manual_actions_txn_idx
  on public.recon_manual_actions (txn_id, acted_at desc);

-- =============================================================
-- updated_at triggers
-- =============================================================

drop trigger if exists bank_accounts_set_updated_at on public.bank_accounts;
create trigger bank_accounts_set_updated_at
before update on public.bank_accounts
for each row execute function public.set_updated_at();

drop trigger if exists recon_uploads_set_updated_at on public.recon_uploads;
create trigger recon_uploads_set_updated_at
before update on public.recon_uploads
for each row execute function public.set_updated_at();

drop trigger if exists recon_transactions_set_updated_at on public.recon_transactions;
create trigger recon_transactions_set_updated_at
before update on public.recon_transactions
for each row execute function public.set_updated_at();

-- =============================================================
-- RLS
-- =============================================================

alter table public.bank_accounts        enable row level security;
alter table public.recon_uploads        enable row level security;
alter table public.recon_transactions   enable row level security;
alter table public.recon_links          enable row level security;
alter table public.recon_manual_actions enable row level security;

-- Operator predicates. SECURITY DEFINER lets policies query user_profiles
-- without forcing every caller to also have a SELECT policy on it.
create or replace function public.is_active_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid() and status = 'active'
  );
$$;

create or replace function public.is_recon_writer()
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

-- bank_accounts
drop policy if exists bank_accounts_select_operators on public.bank_accounts;
create policy bank_accounts_select_operators
on public.bank_accounts for select to authenticated
using (public.is_active_operator());

drop policy if exists bank_accounts_write_writers on public.bank_accounts;
create policy bank_accounts_write_writers
on public.bank_accounts for all to authenticated
using (public.is_recon_writer())
with check (public.is_recon_writer());

-- recon_uploads
drop policy if exists recon_uploads_select_operators on public.recon_uploads;
create policy recon_uploads_select_operators
on public.recon_uploads for select to authenticated
using (public.is_active_operator());

drop policy if exists recon_uploads_write_writers on public.recon_uploads;
create policy recon_uploads_write_writers
on public.recon_uploads for all to authenticated
using (public.is_recon_writer())
with check (public.is_recon_writer());

-- recon_transactions
drop policy if exists recon_transactions_select_operators on public.recon_transactions;
create policy recon_transactions_select_operators
on public.recon_transactions for select to authenticated
using (public.is_active_operator());

drop policy if exists recon_transactions_write_writers on public.recon_transactions;
create policy recon_transactions_write_writers
on public.recon_transactions for all to authenticated
using (public.is_recon_writer())
with check (public.is_recon_writer());

-- recon_links
drop policy if exists recon_links_select_operators on public.recon_links;
create policy recon_links_select_operators
on public.recon_links for select to authenticated
using (public.is_active_operator());

drop policy if exists recon_links_write_writers on public.recon_links;
create policy recon_links_write_writers
on public.recon_links for all to authenticated
using (public.is_recon_writer())
with check (public.is_recon_writer());

-- recon_manual_actions: append-only audit trail.
-- Any active operator may insert their own action; nobody updates/deletes
-- through the API (service role only).
drop policy if exists recon_manual_actions_select_operators on public.recon_manual_actions;
create policy recon_manual_actions_select_operators
on public.recon_manual_actions for select to authenticated
using (public.is_active_operator());

drop policy if exists recon_manual_actions_insert_self on public.recon_manual_actions;
create policy recon_manual_actions_insert_self
on public.recon_manual_actions for insert to authenticated
with check (public.is_active_operator() and acted_by = auth.uid());
