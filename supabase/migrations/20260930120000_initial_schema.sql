-- ============================================================================
-- Consolidated Initial Schema & Seed Migration
-- Generated on: 2026-09-30
-- Consolidated 20 migrations + seed data
-- ============================================================================

-- ============================================================================
-- Section: 20260427120000_user_profiles.sql
-- ============================================================================

-- Operator profiles + allowlist.
-- Borrowers will get their own table later; this one is operators only.

-- =============================================================
-- Enums
-- =============================================================

do $$ begin
  create type operator_role as enum ('agent', 'loan_officer', 'risk_analyst', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type operator_language as enum ('en', 'es');
exception when duplicate_object then null; end $$;

do $$ begin
  create type operator_status as enum ('active', 'disabled');
exception when duplicate_object then null; end $$;

-- =============================================================
-- Tables
-- =============================================================

create table if not exists public.operator_allowlist (
  email text primary key,
  role operator_role not null default 'agent',
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  phone text,
  role operator_role not null default 'agent',
  language operator_language not null default 'en',
  notification_prefs jsonb not null default jsonb_build_object(
    'email_application_assigned', true,
    'email_decision_required', true,
    'email_daily_digest', false,
    'whatsapp_urgent', false
  ),
  status operator_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================
-- updated_at trigger
-- =============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_profiles_set_updated_at on public.user_profiles;
create trigger user_profiles_set_updated_at
before update on public.user_profiles
for each row execute function public.set_updated_at();

-- =============================================================
-- RLS
-- =============================================================

alter table public.user_profiles enable row level security;
alter table public.operator_allowlist enable row level security;

-- user_profiles: self-only read/update; insert gated on operator_allowlist.

drop policy if exists user_profiles_select_self on public.user_profiles;
create policy user_profiles_select_self
on public.user_profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists user_profiles_update_self on public.user_profiles;
create policy user_profiles_update_self
on public.user_profiles
for update
to authenticated
using (id = auth.uid())
with check (
  id = auth.uid()
  -- Self-service updates may not change role or status.
  and role = (select role from public.user_profiles where id = auth.uid())
  and status = (select status from public.user_profiles where id = auth.uid())
);

drop policy if exists user_profiles_insert_self_on_allowlist on public.user_profiles;
create policy user_profiles_insert_self_on_allowlist
on public.user_profiles
for insert
to authenticated
with check (
  id = auth.uid()
  and email = (select email from auth.users where id = auth.uid())
  and exists (
    select 1
    from public.operator_allowlist a
    where lower(a.email) = lower((select email from auth.users where id = auth.uid()))
  )
);

-- operator_allowlist: no anon/authenticated policies — RLS enabled with no
-- policies means all reads/writes via the API are denied. The allowlist is
-- consulted only by the user_profiles_insert_self_on_allowlist policy
-- (running with definer rights on the joined table) and by service-role
-- admin tooling, which bypasses RLS.


-- ============================================================================
-- Section: 20260428200000_fix_user_profiles_rls.sql
-- ============================================================================

-- Fix: the previous RLS policies queried auth.users directly via
-- `(select email from auth.users where id = auth.uid())`, but the
-- `authenticated` role has no grants on auth.users, so the subquery
-- returns NULL and every check fails silently. Switch to auth.email(),
-- the canonical Supabase helper that reads the email claim from the JWT.

drop policy if exists user_profiles_update_self on public.user_profiles;
create policy user_profiles_update_self
on public.user_profiles
for update
to authenticated
using (id = auth.uid())
with check (
  id = auth.uid()
  and role = (select role from public.user_profiles where id = auth.uid())
  and status = (select status from public.user_profiles where id = auth.uid())
);

drop policy if exists user_profiles_insert_self_on_allowlist on public.user_profiles;
create policy user_profiles_insert_self_on_allowlist
on public.user_profiles
for insert
to authenticated
with check (
  id = auth.uid()
  and lower(email) = lower(auth.email())
  and exists (
    select 1
    from public.operator_allowlist a
    where lower(a.email) = lower(auth.email())
  )
);


-- ============================================================================
-- Section: 20260428210000_allowlist_select_self.sql
-- ============================================================================

-- Fix: the user_profiles INSERT policy contains
--   exists (select 1 from operator_allowlist where lower(email) = lower(auth.email()))
-- That subquery runs under the *authenticated* role and is itself subject
-- to RLS on operator_allowlist. The previous migration left allowlist with
-- RLS enabled and zero policies, so authenticated users see zero rows and
-- the EXISTS check is always false — blocking every legitimate operator.
--
-- Grant authenticated users SELECT on their own allowlist row only. They
-- still can't list other operators or modify the allowlist (no INSERT /
-- UPDATE / DELETE policies). Service-role admin tooling bypasses RLS and
-- stays in charge of writes.

drop policy if exists operator_allowlist_select_self on public.operator_allowlist;
create policy operator_allowlist_select_self
on public.operator_allowlist
for select
to authenticated
using (lower(email) = lower(auth.email()));


-- ============================================================================
-- Section: 20260428220000_role_from_allowlist_trigger.sql
-- ============================================================================

-- On user_profiles INSERT, copy the role from operator_allowlist so the
-- caller (the operator themselves) cannot escalate their own privilege by
-- passing role='admin' from the client. The function is SECURITY DEFINER
-- so the lookup bypasses RLS on operator_allowlist (the authenticated
-- role only has SELECT on its own row, which is enough for the existing
-- INSERT policy's EXISTS check, but we want a fresh lookup that doesn't
-- depend on the JWT email matching exactly the row we want to read).
--
-- Defense in depth: the INSERT policy already requires the email to be
-- on the allowlist; this trigger pins the role to whatever the allowlist
-- says, no matter what the client sent.

create or replace function public.set_user_profile_role_from_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  allowed_role operator_role;
begin
  select role into allowed_role
  from public.operator_allowlist
  where lower(email) = lower(new.email);

  if allowed_role is null then
    raise exception 'email % is not on the operator allowlist', new.email
      using errcode = '42501';
  end if;

  new.role := allowed_role;
  return new;
end;
$$;

drop trigger if exists user_profiles_role_from_allowlist on public.user_profiles;
create trigger user_profiles_role_from_allowlist
before insert on public.user_profiles
for each row execute function public.set_user_profile_role_from_allowlist();


-- ============================================================================
-- Section: 20260429180000_recon_collection_initial_schema.sql
-- ============================================================================

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


-- ============================================================================
-- Section: 20260501090000_recon_name_aliases.sql
-- ============================================================================

-- Persistent payer-name aliases for the reconciliation pairing engine.
--
-- When auto-pairing fails because BAC's PR description and the DA's
-- DVTO/RCZO description encode the same client under names that don't
-- agree on a prefix (e.g. "GRUPO RECA" vs "GRUPO RECA S A"), the
-- operator manually matches the DA to a PR. We capture the (PR, DA)
-- normalized name pair here so future ingests can pair the same client
-- without operator effort.
--
-- Scope is per-account so a borrower's name on one Junto account never
-- leaks into pairing decisions on another. Same RLS pattern as the rest
-- of the recon module: operator-read, recon-writer-write.

create table if not exists public.name_aliases (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.bank_accounts(id) on delete cascade,
  rail bank_accounts_rail_enum not null,
  pr_name_normalized text not null
    check (length(btrim(pr_name_normalized)) > 0),
  da_name_normalized text not null
    check (length(btrim(da_name_normalized)) > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- A manual pair is identified by the (account, both names) triple.
  -- Re-confirming a pair is a no-op via ON CONFLICT.
  constraint name_aliases_account_names_unique
    unique (account_id, pr_name_normalized, da_name_normalized)
);

-- Hot path: the recompute pass loads every alias for the account in one
-- query, so an account-scoped index is enough.
create index if not exists name_aliases_account_idx
  on public.name_aliases (account_id);

-- =============================================================
-- RLS
-- =============================================================

alter table public.name_aliases enable row level security;

drop policy if exists name_aliases_select_operators on public.name_aliases;
create policy name_aliases_select_operators
on public.name_aliases for select to authenticated
using (public.is_active_operator());

drop policy if exists name_aliases_write_writers on public.name_aliases;
create policy name_aliases_write_writers
on public.name_aliases for all to authenticated
using (public.is_recon_writer())
with check (public.is_recon_writer());


-- ============================================================================
-- Section: 20260503100000_recon_manual_actions_cascade.sql
-- ============================================================================

-- Change recon_manual_actions.txn_id from ON DELETE RESTRICT to CASCADE.
--
-- Why: deleteUpload removes an upload's recon_transactions, and any
-- audit rows tied to those transactions need to go too. The original
-- ON DELETE RESTRICT plus the table's "append-only via the API" RLS
-- (no DELETE policy) made deletes impossible without bypassing
-- security. CASCADE fires at the database level — RLS still blocks
-- direct DELETEs through PostgREST, so operators can't tamper with
-- the audit trail directly; rows only disappear when their underlying
-- transaction does, which is the only physically meaningful moment
-- to drop them.

alter table public.recon_manual_actions
  drop constraint if exists recon_manual_actions_txn_id_fkey;

alter table public.recon_manual_actions
  add constraint recon_manual_actions_txn_id_fkey
    foreign key (txn_id)
    references public.recon_transactions(id)
    on delete cascade;


-- ============================================================================
-- Section: 20260505120000_recon_links_auto_batch_link.sql
-- ============================================================================

-- Tier 5 PR 2: extend recon_links match_strategy enum with 'auto_batch_link'.
--
-- The pairing pipeline used to insert links with strategy = 'auto_fifo_name_amount'
-- (per-row FIFO + ±1-day window). The new batch-aware pipeline groups PRs by
-- raw `Referencia` and DAs by consecutive sequence, then links a DA batch to
-- one or more PR batches as a single transaction. Links inserted by that
-- pipeline carry strategy = 'auto_batch_link' so we can tell them apart from
-- legacy auto-pairings (and from operator-placed manual pairings).
--
-- Strictly additive — existing rows keep their current strategy values.

alter type public.recon_links_strategy_enum add value if not exists 'auto_batch_link';


-- ============================================================================
-- Section: 20260517120000_recon_bg_rail.sql
-- ============================================================================

-- BG rail support (Banco General, Crediclaro account).
--
-- Adds:
--   1. 'bg' to bank_accounts_rail_enum.
--   2. 'statement_bg_excel' and 'ach_detail_bg_excel' to recon_uploads_method_enum.
--   3. recon_ach_batch_lines table — per-client breakdown of an ACH Debit
--      batch response. One row per debtor; the parent recon_uploads row
--      carries the batch's filename + effective date + summary counts.
--
-- BG's reconciliation flow differs from BAC's: instead of pairing
-- forward/reverse transactions across statements, we pair ONE lump
-- credit + ONE lump debit row in the statement with the per-client
-- breakdown in the ACH detail file. The per-client outcomes (approved
-- or rejected with an R-code) drive loan-payment state in later chunks.

-- 1. Rail enum
alter type public.bank_accounts_rail_enum add value if not exists 'bg';

-- 2. Method enum
alter type public.recon_uploads_method_enum add value if not exists 'statement_bg_excel';
alter type public.recon_uploads_method_enum add value if not exists 'ach_detail_bg_excel';

-- 3. recon_ach_batch_lines
create table if not exists public.recon_ach_batch_lines (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.recon_uploads(id) on delete restrict,
  account_id uuid not null references public.bank_accounts(id) on delete restrict,

  -- Batch envelope (carried from the file's preamble for convenience).
  batch_filename text not null,
  batch_effective_date date not null,

  -- Per-client line.
  routing_code text not null,                 -- e.g. "0071" (Banco General)
  target_account text not null,               -- debtor's account number
  amount_minor bigint not null,
  beneficiary_id text,                        -- debtor's national/business id
  beneficiary_name text,                      -- debtor's name (truncated)
  addenda text,                               -- raw ACH addenda field
  error_code text,                            -- e.g. "R10"; null = approved
  error_description text,                     -- e.g. "NO EXISTE AUTORIZACION DEL RECIBIDOR"
  observations text,

  -- Row idempotency: re-uploading the same line collapses here.
  row_hash text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint recon_ach_batch_lines_row_hash_unique unique (account_id, row_hash),
  constraint recon_ach_batch_lines_amount_check check (amount_minor >= 0)
);

create index if not exists recon_ach_batch_lines_account_effective_idx
  on public.recon_ach_batch_lines (account_id, batch_effective_date desc);

create index if not exists recon_ach_batch_lines_filename_idx
  on public.recon_ach_batch_lines (account_id, batch_filename);

-- updated_at trigger
drop trigger if exists recon_ach_batch_lines_set_updated_at on public.recon_ach_batch_lines;
create trigger recon_ach_batch_lines_set_updated_at
before update on public.recon_ach_batch_lines
for each row execute function public.set_updated_at();

-- RLS
alter table public.recon_ach_batch_lines enable row level security;

drop policy if exists recon_ach_batch_lines_select_operators on public.recon_ach_batch_lines;
create policy recon_ach_batch_lines_select_operators
on public.recon_ach_batch_lines for select to authenticated
using (public.is_active_operator());

drop policy if exists recon_ach_batch_lines_write_writers on public.recon_ach_batch_lines;
create policy recon_ach_batch_lines_write_writers
on public.recon_ach_batch_lines for all to authenticated
using (public.is_recon_writer())
with check (public.is_recon_writer());


-- ============================================================================
-- Section: 20260721220000_grant_public_tables.sql
-- ============================================================================

-- Grant schema usage to anon, authenticated, and service_role.
grant usage on schema public to anon, authenticated, service_role;

-- Grant data privileges to authenticated operators and service_role (RLS enforces row-level policies).
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

-- Default privileges for future tables/functions
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;


-- ============================================================================
-- Section: 20260721223000_recon_storage_bucket.sql
-- ============================================================================

-- Supabase Storage bucket for bank statements (recon module).
-- Private bucket: accessed only via RLS and short-lived signed URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'recon-statements',
  'recon-statements',
  false,
  10485760, -- 10 MB limit
  array[
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
) on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = array[
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ];

-- RLS policies on storage.objects

drop policy if exists "recon_statements_select_operators" on storage.objects;
create policy "recon_statements_select_operators"
on storage.objects for select to authenticated
using (bucket_id = 'recon-statements' and public.is_active_operator());

drop policy if exists "recon_statements_insert_writers" on storage.objects;
create policy "recon_statements_insert_writers"
on storage.objects for insert to authenticated
with check (bucket_id = 'recon-statements' and public.is_recon_writer());

drop policy if exists "recon_statements_delete_writers" on storage.objects;
create policy "recon_statements_delete_writers"
on storage.objects for delete to authenticated
using (bucket_id = 'recon-statements' and public.is_recon_writer());


-- ============================================================================
-- Section: 20260721230000_recon_uploads_storage_path.sql
-- ============================================================================

-- Add storage_path column to recon_uploads table to store the path in recon-statements bucket.

alter table public.recon_uploads
  add column if not exists storage_path text;


-- ============================================================================
-- Section: 20260730000000_recon_upload_id_index.sql
-- ============================================================================

-- Index recon_transactions.upload_id for fast file deletion and upload-scoped queries
create index if not exists recon_transactions_upload_id_idx
  on public.recon_transactions (upload_id);


-- ============================================================================
-- Section: 20260829120000_recon_bg_v2_schema.sql
-- ============================================================================

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


-- ============================================================================
-- Section: 20260908180000_recon_transactions_upload_id_nullable.sql
-- ============================================================================

-- Make recon_transactions.upload_id nullable so multi-file sync pipelines (like CCBG v2)
-- can insert transactions without requiring a single file upload_id.
alter table public.recon_transactions alter column upload_id drop not null;


-- ============================================================================
-- Section: 20260914210000_fix_bg_confirmed_inflows.sql
-- ============================================================================

-- Fix Banco General confirmed loan inflows and mark aggregate batch deposits as non_loan

-- 1. Mark confirmed incoming loan transfers for Banco General accounts
update public.recon_transactions
set state = 'confirmed'
where account_id in (select id from public.bank_accounts where rail = 'bg')
  and kind = 'loan_inflow'
  and state = 'pending'
  and credit_minor > 0
  and (
    code in ('2627', '2626', 'TRANSF_ONLINE', 'TRANSF_MOVIL', 'ACH_XPRESS')
    or (
      code in ('48', 'ACH')
      and description not ilike 'DEPOSITO YAPPY%'
      and description not ilike 'LOTE ACH%'
    )
  );

-- 2. Mark aggregate batches (DEPOSITO YAPPY and LOTE ACH BG) as non_loan so they do not distort loan inflow totals
update public.recon_transactions
set kind = 'non_loan', state = 'non_loan'
where account_id in (select id from public.bank_accounts where rail = 'bg')
  and (
    description ilike 'DEPOSITO YAPPY%'
    or description ilike 'LOTE ACH%'
  );


-- ============================================================================
-- Section: 20260915203000_fix_bg_yappy_confirmed_and_active_batches.sql
-- ============================================================================

-- Reclassify DEPOSITO YAPPY as confirmed loan inflows and reactivate all BG batches

-- 1. Mark DEPOSITO YAPPY as loan_inflow + confirmed so Yappy collections sum into the Confirmed totals
update public.recon_transactions
set kind = 'loan_inflow', state = 'confirmed'
where account_id in (select id from public.bank_accounts where rail = 'bg')
  and description ilike 'DEPOSITO YAPPY%';

-- 2. Reactivate historical Yappy batches
update public.recon_bg_yappy_batches
set is_active = true
where account_id in (select id from public.bank_accounts where rail = 'bg');

-- 3. Reactivate historical ACH Debit batches
update public.recon_bg_batches
set is_active = true
where account_id in (select id from public.bank_accounts where rail = 'bg');


-- ============================================================================
-- Section: 20260916160000_cleanup_bg_duplicate_transactions.sql
-- ============================================================================

-- Migration: 20260916160000_cleanup_bg_duplicate_transactions.sql
-- Clean up legacy duplicate rows from recon_transactions for Banco General accounts.
-- Banco General transactions are managed by CCBG v2 (syncSnapshotToDatabase)
-- where row_hash contains "|bg_".
-- Legacy ingest (ingestBGStatementFile / ingestBGAchDetailFile) inserted rows with
-- raw 64-char SHA256 hashes, which duplicated transfers and distorted confirmed totals.

-- 1. Remove legacy duplicate rows (raw sha256 row_hashes) for BG accounts
delete from public.recon_transactions
where account_id in (select id from public.bank_accounts where rail = 'bg')
  and row_hash not like '%|bg_%';

-- 2. Ensure settled Yappy batches from recon_bg_yappy_batches are present as canonical DEPOSITO_YAPPY rows
insert into public.recon_transactions (
  account_id,
  posted_at,
  code,
  description,
  debit_minor,
  credit_minor,
  balance_minor,
  currency,
  payer_name_raw,
  rail_native_ref,
  kind,
  state,
  row_hash
)
select
  yb.account_id,
  yb.credit_date,
  'DEPOSITO_YAPPY',
  'DEPOSITO YAPPY (' || coalesce(yb.declared_count, yb.report_count, 0) || ' transacciones)',
  0,
  yb.credit_amount_minor,
  null,
  'USD',
  'YAPPY',
  yb.batch_uid,
  'loan_inflow',
  'confirmed',
  yb.account_id || '|bg_yappy_dep|' || yb.batch_uid
from public.recon_bg_yappy_batches yb
where yb.is_active = true
on conflict (account_id, row_hash) do update
set
  kind = 'loan_inflow',
  state = 'confirmed',
  credit_minor = excluded.credit_minor;


-- ============================================================================
-- Section: 20260922150000_recon_manual_assignments_payer_info.sql
-- ============================================================================

-- =============================================================
-- Migration: Add payer_name and loan_ref to recon_manual_assignments
-- Allows operators to assign client and loan reference to unassigned
-- direct deposits (DEPOSITO) in Banco General.
-- =============================================================

alter table public.recon_manual_assignments
  add column if not exists payer_name text,
  add column if not exists loan_ref text;


-- ============================================================================
-- Section: 20260930120000_sync_bg_ach_batches_to_transactions.sql
-- ============================================================================

-- Migration: 20260930120000_sync_bg_ach_batches_to_transactions.sql
-- Synchronize active ACH Collection Batches from recon_bg_batches into recon_transactions.
-- Ensures settled/approved ACH batch amounts are included in daily loan inflow totals (total captado en el día),
-- reports, and exports for Banco General accounts.

insert into public.recon_transactions (
  account_id,
  posted_at,
  code,
  description,
  debit_minor,
  credit_minor,
  balance_minor,
  currency,
  payer_name_raw,
  rail_native_ref,
  kind,
  state,
  row_hash
)
select
  b.account_id,
  coalesce(b.credit_date, b.effective_date, to_date(b.batch_date_str, 'YYYYMMDD')),
  'COBRO_ACH',
  case
    when b.batch_filename is not null and b.batch_filename != ''
      then 'LOTE ACH - ' || b.batch_filename || ' (' || coalesce(b.succeeded_transactions, b.succeeded_rows_count, 0) || ' exitosas)'
    else 'LOTE ACH ' || b.batch_date_str || ' (' || coalesce(b.succeeded_transactions, b.succeeded_rows_count, 0) || ' exitosas)'
  end,
  0,
  coalesce(b.succeeded_amount_minor, b.itemized_succeeded_amount_minor, 0),
  null,
  'USD',
  'BANCO GENERAL - LOTE ACH',
  b.batch_uid,
  'loan_inflow'::public.recon_transactions_kind_enum,
  case
    when b.status in ('settled', 'settled_no_reversals') then 'confirmed'::public.recon_transactions_state_enum
    else 'pending'::public.recon_transactions_state_enum
  end,
  b.account_id || '|bg_ach_batch|' || b.batch_uid
from public.recon_bg_batches b
where b.is_active = true
  and coalesce(b.succeeded_amount_minor, b.itemized_succeeded_amount_minor, 0) > 0
on conflict (account_id, row_hash) do update
set
  kind = excluded.kind,
  state = excluded.state,
  credit_minor = excluded.credit_minor;


-- ============================================================================
-- Section: seed.sql (Initial Seed Data)
-- ============================================================================

-- Seed data applied by `supabase db reset` (local) and on initial setup.
-- Production seeding happens through the admin console once it exists.

insert into public.operator_allowlist (email, role) values ('admin@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('antonio@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('ronel@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('darwins@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('cesar@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('ajromeroesclusa@gmail.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('pateticarluis@gmail.com', 'admin') on conflict do nothing;

-- Seed dev user in auth.users & public.user_profiles
do $$
declare
  uid uuid := '00000000-0000-0000-0000-000000000001'::uuid;
begin
  if not exists (select 1 from auth.users where email = 'admin@somosjunto.com') then
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      'admin@somosjunto.com', crypt('Password123!', gen_salt('bf')), now(),
      '{"provider": "email", "providers": ["email"]}', '{"full_name": "Admin User"}',
      now(), now(), '', '', '', ''
    );

    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) values (
      uid, uid, format('{"sub":"%s","email":"%s"}', uid, 'admin@somosjunto.com')::jsonb,
      'email', 'admin@somosjunto.com', now(), now(), now()
    );

    insert into public.user_profiles (id, email, full_name, role, status)
    values (uid, 'admin@somosjunto.com', 'Admin User', 'admin', 'active')
    on conflict (id) do update set role = 'admin', status = 'active';
  end if;
end $$;

-- Default BAC account for testing & integration.
insert into public.bank_accounts (rail, account_number, holder_name, currency)
values ('bac', '100412600', 'JUNTO SOLUCIONES, S.A.', 'USD')
on conflict (rail, account_number) do nothing;

-- Default Banco General account for testing & integration (Crediclaro).
insert into public.bank_accounts (rail, account_number, holder_name, currency)
values ('bg', '03-43-01-106691-6', 'CREDICLARO, S.A.', 'USD')
on conflict (rail, account_number) do nothing;

