-- Portfolio Analytics & Board Report — Schema (Bloque 1)
--
-- Tables:
--   portfolio_entities       — Crediclaro, Junto Soluciones
--   portfolio_policy         — Versioned CRO configuration (thresholds, buckets, prov rates)
--   portfolio_snapshots      — Snapshot master record per entity + date
--   portfolio_loans          — Enriched loan facts per snapshot (single source of truth)
--   portfolio_loan_repayments — Cleaned and classified repayments per snapshot

-- =============================================================
-- Helper function: is_portfolio_writer
-- =============================================================
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
-- 1. portfolio_entities
-- =============================================================
create table if not exists public.portfolio_entities (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  display_name text not null,
  legal_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portfolio_entities_code_unique unique (code)
);

alter table public.portfolio_entities enable row level security;

create policy portfolio_entities_select_operators
on public.portfolio_entities for select to authenticated
using (public.is_active_operator());

create policy portfolio_entities_write_writers
on public.portfolio_entities for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

drop trigger if exists portfolio_entities_set_updated_at on public.portfolio_entities;
create trigger portfolio_entities_set_updated_at
before update on public.portfolio_entities
for each row execute function public.set_updated_at();

-- =============================================================
-- 2. portfolio_policy (Versioned CRO parameters)
-- =============================================================
create table if not exists public.portfolio_policy (
  id uuid primary key default gen_random_uuid(),
  version text not null default 'v1.0',
  effective_from date not null,
  handover_date date not null default '2025-06-01',
  co_unsecured_dpd int not null default 180,
  co_secured_dpd int not null default 360,
  bucket_bins jsonb not null default '[-1, 0, 30, 60, 90, 180, 365, 1000000000]'::jsonb,
  bucket_names jsonb not null default '["Al día", "1-30", "31-60", "61-90", "91-180", "181-365", "365+"]'::jsonb,
  prov_rates jsonb not null default '[0.01, 0.05, 0.15, 0.25, 0.50, 0.90, 1.00]'::jsonb,
  real_methods jsonb not null default '["ach", "cheque", "yappy", "deposito en efectivo", "debito planilla (empleado)", "debito planilla"]'::jsonb,
  admin_methods jsonb not null default '["descuento por pronto pago", "finiquito otorgado", "traspaso a provision", "traspaso de saldo", "ajuste"]'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portfolio_policy_version_unique unique (version)
);

alter table public.portfolio_policy enable row level security;

create policy portfolio_policy_select_operators
on public.portfolio_policy for select to authenticated
using (public.is_active_operator());

create policy portfolio_policy_write_writers
on public.portfolio_policy for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

drop trigger if exists portfolio_policy_set_updated_at on public.portfolio_policy;
create trigger portfolio_policy_set_updated_at
before update on public.portfolio_policy
for each row execute function public.set_updated_at();

-- =============================================================
-- 3. portfolio_snapshots (Master date records)
-- =============================================================
create table if not exists public.portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.portfolio_entities(id) on delete restrict,
  snapshot_date date not null,
  as_of_date date not null,
  policy_id uuid references public.portfolio_policy(id) on delete restrict,
  total_open_balance numeric(15, 2) not null default 0,
  total_open_loans int not null default 0,
  cer30_balance numeric(15, 2) not null default 0,
  cer30_percentage numeric(5, 2) not null default 0,
  cer90_balance numeric(15, 2) not null default 0,
  cer90_percentage numeric(5, 2) not null default 0,
  total_collected_handover numeric(15, 2) not null default 0,
  cash_ahead_count int not null default 0,
  future_payments_excluded_count int not null default 0,
  source_files jsonb not null default '{}'::jsonb,
  status text not null default 'completed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portfolio_snapshots_entity_date_unique unique (entity_id, snapshot_date)
);

create index if not exists portfolio_snapshots_entity_date_idx
  on public.portfolio_snapshots (entity_id, snapshot_date desc);

alter table public.portfolio_snapshots enable row level security;

create policy portfolio_snapshots_select_operators
on public.portfolio_snapshots for select to authenticated
using (public.is_active_operator());

create policy portfolio_snapshots_write_writers
on public.portfolio_snapshots for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

drop trigger if exists portfolio_snapshots_set_updated_at on public.portfolio_snapshots;
create trigger portfolio_snapshots_set_updated_at
before update on public.portfolio_snapshots
for each row execute function public.set_updated_at();

-- =============================================================
-- 4. portfolio_loans (Enriched loan facts)
-- =============================================================
create table if not exists public.portfolio_loans (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,
  entity_id uuid not null references public.portfolio_entities(id) on delete restrict,
  snapshot_date date not null,
  source_loan_id text not null,
  loan_number text,
  full_name text,
  borrower_mobile text,
  product text,
  segment text not null, -- 'Adelantos' | 'Personal con Garantía' | 'Personal sin Garantía'
  segment_idx int not null, -- 0 | 1 | 2
  secured boolean not null default false,
  balance numeric(15, 2) not null default 0,
  dpd int not null default 0, -- Adjusted DPD
  dpd_loandisk int not null default 0, -- Raw original DPD before cash adjustment
  bucket text not null, -- 'Al día', '1-30', '31-60', '61-90', '91-180', '181-365', '365+'
  bucket_idx int not null default 0,
  cash_ahead boolean not null default false,
  is_open boolean not null default false,
  released_date date,
  status_raw text,
  past_due numeric(15, 2) default 0,
  pending_due numeric(15, 2) default 0,
  total_due_amount numeric(15, 2) default 0,
  loan_duration text,
  installments_count int,
  repayment_cycle text,
  cycle_type int default 0, -- 0 monthly, 1 daily
  last_payment_date date,
  last_payment_amount numeric(15, 2) default 0,
  pg text, -- Préstamo Garantizado ('Si' | 'No')
  tg text, -- Tipo de Garantía ('Automóvil' | 'Moto' | 'NA')
  tc text, -- Tipo de Cartera ('Heredada' | 'Vigente')
  gc text, -- Gestor de Cobro
  mr text, -- Motor de Riesgo (Adelantos)
  combo_key text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portfolio_loans_snapshot_loan_unique unique (snapshot_id, source_loan_id)
);

create index if not exists portfolio_loans_snapshot_open_idx
  on public.portfolio_loans (snapshot_id, is_open);
create index if not exists portfolio_loans_snapshot_segment_idx
  on public.portfolio_loans (snapshot_id, segment);
create index if not exists portfolio_loans_snapshot_bucket_idx
  on public.portfolio_loans (snapshot_id, bucket_idx);
create index if not exists portfolio_loans_entity_date_idx
  on public.portfolio_loans (entity_id, snapshot_date desc);
create index if not exists portfolio_loans_source_loan_idx
  on public.portfolio_loans (source_loan_id);

alter table public.portfolio_loans enable row level security;

create policy portfolio_loans_select_operators
on public.portfolio_loans for select to authenticated
using (public.is_active_operator());

create policy portfolio_loans_write_writers
on public.portfolio_loans for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

drop trigger if exists portfolio_loans_set_updated_at on public.portfolio_loans;
create trigger portfolio_loans_set_updated_at
before update on public.portfolio_loans
for each row execute function public.set_updated_at();

-- =============================================================
-- 5. portfolio_loan_repayments (Repayments facts)
-- =============================================================
create table if not exists public.portfolio_loan_repayments (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,
  entity_id uuid not null references public.portfolio_entities(id) on delete restrict,
  snapshot_date date not null,
  source_repayment_id text,
  source_loan_id text not null,
  collection_date date not null,
  principal_amount numeric(15, 2) not null default 0,
  interest_amount numeric(15, 2) not null default 0,
  penalty_amount numeric(15, 2) not null default 0,
  fees_amount numeric(15, 2) not null default 0,
  total_amount numeric(15, 2) not null default 0,
  ingresos_amount numeric(15, 2) not null default 0,
  method_raw text,
  is_real boolean not null default true,
  is_admin boolean not null default false,
  is_unknown_method boolean not null default false,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists portfolio_repayments_snapshot_loan_idx
  on public.portfolio_loan_repayments (snapshot_id, source_loan_id);
create index if not exists portfolio_repayments_snapshot_date_real_idx
  on public.portfolio_loan_repayments (snapshot_id, collection_date, is_real);
create index if not exists portfolio_repayments_entity_date_idx
  on public.portfolio_loan_repayments (entity_id, snapshot_date desc);

alter table public.portfolio_loan_repayments enable row level security;

create policy portfolio_loan_repayments_select_operators
on public.portfolio_loan_repayments for select to authenticated
using (public.is_active_operator());

create policy portfolio_loan_repayments_write_writers
on public.portfolio_loan_repayments for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

drop trigger if exists portfolio_loan_repayments_set_updated_at on public.portfolio_loan_repayments;
create trigger portfolio_loan_repayments_set_updated_at
before update on public.portfolio_loan_repayments
for each row execute function public.set_updated_at();

-- =============================================================
-- Seed Initial Entities & Policy
-- =============================================================
insert into public.portfolio_entities (code, display_name, legal_name)
values
  ('crediclaro', 'Crediclaro', 'CREDICLARO, S.A.'),
  ('junto_soluciones', 'Junto Soluciones', 'JUNTO SOLUCIONES, S.A.')
on conflict (code) do nothing;

insert into public.portfolio_policy (
  version,
  effective_from,
  handover_date,
  co_unsecured_dpd,
  co_secured_dpd,
  notes
) values (
  'v1.0',
  '2026-01-01',
  '2025-06-01',
  180,
  360,
  'Configuración base MAIA (CRO) de política de riesgo para Junta Directiva y Cobranzas.'
) on conflict (version) do nothing;

