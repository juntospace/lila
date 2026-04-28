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
