-- Index recon_transactions.upload_id for fast file deletion and upload-scoped queries
create index if not exists recon_transactions_upload_id_idx
  on public.recon_transactions (upload_id);
