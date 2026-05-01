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
