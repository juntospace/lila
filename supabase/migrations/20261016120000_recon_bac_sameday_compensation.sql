-- Migration: Add same-day compensation and balance metadata columns to recon_uploads
-- Enables BAC reconciliation to evaluate cut-off time (14:30) and deferred vs. available balance.

alter table public.recon_uploads
  add column if not exists statement_downloaded_at timestamptz,
  add column if not exists saldo_disponible_minor bigint,
  add column if not exists saldo_diferido_minor bigint;

comment on column public.recon_uploads.statement_downloaded_at is
  'Exact timestamp of bank statement download/generation as parsed from file header (in America/Panama timezone).';

comment on column public.recon_uploads.saldo_disponible_minor is
  'Available balance (Saldo Disponible) in minor currency units (cents).';

comment on column public.recon_uploads.saldo_diferido_minor is
  'Retained and deferred balance (Retenidos y diferidos) in minor currency units (cents). Zero indicates clearing settlement is complete.';

