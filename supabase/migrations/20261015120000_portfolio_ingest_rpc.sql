-- Portfolio Analytics & Board Report — Transactional Ingest RPC, Batches & Policy Audit (Fases 1, 2 & 4)

-- =============================================================
-- 1. Admin helper & Audit Events table (Fase 4.1)
-- =============================================================
create or replace function public.is_portfolio_admin()
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
      and role = 'admin'
  );
$$;

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  table_name text not null,
  record_id uuid,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_table_created_idx
  on public.audit_events (table_name, created_at desc);

alter table public.audit_events enable row level security;

drop policy if exists audit_events_select_operators on public.audit_events;
create policy audit_events_select_operators
on public.audit_events for select to authenticated
using (public.is_active_operator());

-- Restrict portfolio_policy write access to admins only
drop policy if exists portfolio_policy_write_writers on public.portfolio_policy;
drop policy if exists portfolio_policy_write_admin on public.portfolio_policy;
create policy portfolio_policy_write_admin
on public.portfolio_policy for all to authenticated
using (public.is_portfolio_admin())
with check (public.is_portfolio_admin());

create or replace function public.log_portfolio_policy_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    insert into public.audit_events (actor_id, table_name, record_id, action, old_data, new_data)
    values (auth.uid(), 'portfolio_policy', new.id, 'INSERT', null, to_jsonb(new));
    return new;
  elsif (tg_op = 'UPDATE') then
    insert into public.audit_events (actor_id, table_name, record_id, action, old_data, new_data)
    values (auth.uid(), 'portfolio_policy', new.id, 'UPDATE', to_jsonb(old), to_jsonb(new));
    return new;
  elsif (tg_op = 'DELETE') then
    insert into public.audit_events (actor_id, table_name, record_id, action, old_data, new_data)
    values (auth.uid(), 'portfolio_policy', old.id, 'DELETE', to_jsonb(old), null);
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists portfolio_policy_audit on public.portfolio_policy;
create trigger portfolio_policy_audit
after insert or update or delete on public.portfolio_policy
for each row execute function public.log_portfolio_policy_audit();

-- Ensure base policy v1.0 is effective for historical 2025 snapshots as well
update public.portfolio_policy
set effective_from = '2020-01-01'
where version = 'v1.0' and effective_from > '2020-01-01';

-- =============================================================
-- 2. Explicit has_repayments flag on snapshots (Fase 2.1)
-- =============================================================
alter table public.portfolio_snapshots
  add column if not exists has_repayments boolean not null default false;

-- =============================================================
-- 3. Ingest Batches & Data Quality Log (Fase 4.2)
-- =============================================================
create table if not exists public.portfolio_ingest_batches (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,
  sha256_loans text not null,
  sha256_repayments text,
  rows_loans int not null default 0,
  rows_repayments int not null default 0,
  sum_balance_source numeric(15, 2) not null default 0,
  sum_balance_ingested numeric(15, 2) not null default 0,
  future_payments_excluded int not null default 0,
  cash_ahead_count int not null default 0,
  admin_excluded_count int not null default 0,
  admin_excluded_amount numeric(15, 2) not null default 0,
  unknown_methods text[] not null default '{}',
  missing_custom_fields text[] not null default '{}',
  missing_released_date_count int not null default 0,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists portfolio_ingest_batches_snapshot_idx
  on public.portfolio_ingest_batches (snapshot_id, created_at desc);

alter table public.portfolio_ingest_batches enable row level security;

drop policy if exists portfolio_ingest_batches_select_operators on public.portfolio_ingest_batches;
create policy portfolio_ingest_batches_select_operators
on public.portfolio_ingest_batches for select to authenticated
using (public.is_active_operator());

drop policy if exists portfolio_ingest_batches_write_writers on public.portfolio_ingest_batches;
create policy portfolio_ingest_batches_write_writers
on public.portfolio_ingest_batches for all to authenticated
using (public.is_portfolio_writer())
with check (public.is_portfolio_writer());

-- =============================================================
-- 4. Atomic Snapshot Replacement RPC (Fase 1.2)
-- =============================================================
create or replace function public.portfolio_replace_snapshot(
  p_entity_id uuid,
  p_snapshot_date date,
  p_snapshot jsonb,
  p_loans jsonb,
  p_repayments jsonb,
  p_batch jsonb default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_snapshot_id uuid;
begin
  -- 1. Upsert snapshot master record
  insert into public.portfolio_snapshots (
    entity_id,
    snapshot_date,
    as_of_date,
    policy_id,
    total_open_balance,
    total_open_loans,
    cer30_balance,
    cer30_percentage,
    cer90_balance,
    cer90_percentage,
    total_collected_handover,
    cash_ahead_count,
    future_payments_excluded_count,
    has_repayments,
    source_files,
    status,
    updated_at
  ) values (
    p_entity_id,
    p_snapshot_date,
    coalesce((p_snapshot->>'as_of_date')::date, p_snapshot_date),
    nullif(p_snapshot->>'policy_id', '')::uuid,
    coalesce((p_snapshot->>'total_open_balance')::numeric(15, 2), 0),
    coalesce((p_snapshot->>'total_open_loans')::int, 0),
    coalesce((p_snapshot->>'cer30_balance')::numeric(15, 2), 0),
    coalesce((p_snapshot->>'cer30_percentage')::numeric(5, 2), 0),
    coalesce((p_snapshot->>'cer90_balance')::numeric(15, 2), 0),
    coalesce((p_snapshot->>'cer90_percentage')::numeric(5, 2), 0),
    coalesce((p_snapshot->>'total_collected_handover')::numeric(15, 2), 0),
    coalesce((p_snapshot->>'cash_ahead_count')::int, 0),
    coalesce((p_snapshot->>'future_payments_excluded_count')::int, 0),
    coalesce((p_snapshot->>'has_repayments')::boolean, false),
    coalesce(p_snapshot->'source_files', '{}'::jsonb),
    coalesce(p_snapshot->>'status', 'completed'),
    now()
  )
  on conflict (entity_id, snapshot_date) do update set
    as_of_date = excluded.as_of_date,
    policy_id = excluded.policy_id,
    total_open_balance = excluded.total_open_balance,
    total_open_loans = excluded.total_open_loans,
    cer30_balance = excluded.cer30_balance,
    cer30_percentage = excluded.cer30_percentage,
    cer90_balance = excluded.cer90_balance,
    cer90_percentage = excluded.cer90_percentage,
    total_collected_handover = excluded.total_collected_handover,
    cash_ahead_count = excluded.cash_ahead_count,
    future_payments_excluded_count = excluded.future_payments_excluded_count,
    has_repayments = excluded.has_repayments,
    source_files = excluded.source_files,
    status = excluded.status,
    updated_at = now()
  returning id into v_snapshot_id;

  -- 2. Delete previous loans, repayments, and batches for this snapshot
  delete from public.portfolio_loans where snapshot_id = v_snapshot_id;
  delete from public.portfolio_loan_repayments where snapshot_id = v_snapshot_id;
  delete from public.portfolio_ingest_batches where snapshot_id = v_snapshot_id;

  -- 3. Insert loans from jsonb array
  if p_loans is not null and jsonb_typeof(p_loans) = 'array' and jsonb_array_length(p_loans) > 0 then
    insert into public.portfolio_loans (
      snapshot_id,
      entity_id,
      snapshot_date,
      source_loan_id,
      loan_number,
      full_name,
      borrower_mobile,
      product,
      segment,
      segment_idx,
      secured,
      balance,
      dpd,
      dpd_loandisk,
      bucket,
      bucket_idx,
      cash_ahead,
      is_open,
      released_date,
      status_raw,
      past_due,
      pending_due,
      total_due_amount,
      loan_duration,
      installments_count,
      repayment_cycle,
      cycle_type,
      last_payment_date,
      last_payment_amount,
      pg,
      tg,
      tc,
      gc,
      mr,
      combo_key,
      raw
    )
    select
      v_snapshot_id,
      p_entity_id,
      p_snapshot_date,
      r.source_loan_id,
      r.loan_number,
      r.full_name,
      r.borrower_mobile,
      r.product,
      r.segment,
      r.segment_idx,
      coalesce(r.secured, false),
      coalesce(r.balance, 0),
      coalesce(r.dpd, 0),
      coalesce(r.dpd_loandisk, 0),
      r.bucket,
      coalesce(r.bucket_idx, 0),
      coalesce(r.cash_ahead, false),
      coalesce(r.is_open, false),
      r.released_date,
      r.status_raw,
      coalesce(r.past_due, 0),
      coalesce(r.pending_due, 0),
      coalesce(r.total_due_amount, 0),
      r.loan_duration,
      r.installments_count,
      r.repayment_cycle,
      coalesce(r.cycle_type, 0),
      r.last_payment_date,
      coalesce(r.last_payment_amount, 0),
      r.pg,
      r.tg,
      r.tc,
      r.gc,
      r.mr,
      r.combo_key,
      coalesce(r.raw, '{}'::jsonb)
    from jsonb_to_recordset(p_loans) as r(
      source_loan_id text,
      loan_number text,
      full_name text,
      borrower_mobile text,
      product text,
      segment text,
      segment_idx int,
      secured boolean,
      balance numeric(15, 2),
      dpd int,
      dpd_loandisk int,
      bucket text,
      bucket_idx int,
      cash_ahead boolean,
      is_open boolean,
      released_date date,
      status_raw text,
      past_due numeric(15, 2),
      pending_due numeric(15, 2),
      total_due_amount numeric(15, 2),
      loan_duration text,
      installments_count int,
      repayment_cycle text,
      cycle_type int,
      last_payment_date date,
      last_payment_amount numeric(15, 2),
      pg text,
      tg text,
      tc text,
      gc text,
      mr text,
      combo_key text,
      raw jsonb
    );
  end if;

  -- 4. Insert repayments from jsonb array
  if p_repayments is not null and jsonb_typeof(p_repayments) = 'array' and jsonb_array_length(p_repayments) > 0 then
    insert into public.portfolio_loan_repayments (
      snapshot_id,
      entity_id,
      snapshot_date,
      source_repayment_id,
      source_loan_id,
      collection_date,
      principal_amount,
      interest_amount,
      penalty_amount,
      fees_amount,
      total_amount,
      ingresos_amount,
      method_raw,
      is_real,
      is_admin,
      is_unknown_method,
      raw
    )
    select
      v_snapshot_id,
      p_entity_id,
      p_snapshot_date,
      r.source_repayment_id,
      r.source_loan_id,
      r.collection_date,
      coalesce(r.principal_amount, 0),
      coalesce(r.interest_amount, 0),
      coalesce(r.penalty_amount, 0),
      coalesce(r.fees_amount, 0),
      coalesce(r.total_amount, 0),
      coalesce(r.ingresos_amount, 0),
      r.method_raw,
      coalesce(r.is_real, true),
      coalesce(r.is_admin, false),
      coalesce(r.is_unknown_method, false),
      coalesce(r.raw, '{}'::jsonb)
    from jsonb_to_recordset(p_repayments) as r(
      source_repayment_id text,
      source_loan_id text,
      collection_date date,
      principal_amount numeric(15, 2),
      interest_amount numeric(15, 2),
      penalty_amount numeric(15, 2),
      fees_amount numeric(15, 2),
      total_amount numeric(15, 2),
      ingresos_amount numeric(15, 2),
      method_raw text,
      is_real boolean,
      is_admin boolean,
      is_unknown_method boolean,
      raw jsonb
    );
  end if;

  -- 5. Insert batch metadata if provided
  if p_batch is not null and jsonb_typeof(p_batch) = 'object' then
    insert into public.portfolio_ingest_batches (
      snapshot_id,
      sha256_loans,
      sha256_repayments,
      rows_loans,
      rows_repayments,
      sum_balance_source,
      sum_balance_ingested,
      future_payments_excluded,
      cash_ahead_count,
      admin_excluded_count,
      admin_excluded_amount,
      unknown_methods,
      missing_custom_fields,
      missing_released_date_count,
      uploaded_by
    ) values (
      v_snapshot_id,
      coalesce(p_batch->>'sha256_loans', ''),
      p_batch->>'sha256_repayments',
      coalesce((p_batch->>'rows_loans')::int, 0),
      coalesce((p_batch->>'rows_repayments')::int, 0),
      coalesce((p_batch->>'sum_balance_source')::numeric(15, 2), 0),
      coalesce((p_batch->>'sum_balance_ingested')::numeric(15, 2), 0),
      coalesce((p_batch->>'future_payments_excluded')::int, 0),
      coalesce((p_batch->>'cash_ahead_count')::int, 0),
      coalesce((p_batch->>'admin_excluded_count')::int, 0),
      coalesce((p_batch->>'admin_excluded_amount')::numeric(15, 2), 0),
      coalesce(
        array(select jsonb_array_elements_text(coalesce(p_batch->'unknown_methods', '[]'::jsonb))),
        '{}'::text[]
      ),
      coalesce(
        array(select jsonb_array_elements_text(coalesce(p_batch->'missing_custom_fields', '[]'::jsonb))),
        '{}'::text[]
      ),
      coalesce((p_batch->>'missing_released_date_count')::int, 0),
      coalesce(nullif(p_batch->>'uploaded_by', '')::uuid, auth.uid())
    );
  end if;

  return v_snapshot_id;
end;
$$;

