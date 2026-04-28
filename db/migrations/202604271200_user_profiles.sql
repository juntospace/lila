-- Operator profiles + allowlist.
-- Borrowers will get their own table later; this one is operators only.

do $$ begin
  create type operator_role as enum ('agent', 'loan_officer', 'risk_analyst', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type operator_language as enum ('en', 'es');
exception when duplicate_object then null; end $$;

do $$ begin
  create type operator_status as enum ('active', 'disabled');
exception when duplicate_object then null; end $$;

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

alter table public.user_profiles enable row level security;
alter table public.operator_allowlist enable row level security;
