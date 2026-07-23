-- Add storage_path column to recon_uploads table to store the path in recon-statements bucket.

alter table public.recon_uploads
  add column if not exists storage_path text;
