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
