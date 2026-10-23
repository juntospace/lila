-- Migration to persist parsed payloads for Banco General (CCBG v2) files
-- Eliminates repetitive Supabase Storage HTTP downloads and CPU re-parsing in recomputes.

alter table public.recon_uploads
  add column if not exists parsed_payload jsonb default null,
  add column if not exists parser_version int default 1;

comment on column public.recon_uploads.parsed_payload is
  'Structured parsed file content (BgParsedStatement, BgParsedAchDetail, BgParsedYappyReport) cached in PostgreSQL to eliminate storage downloads.';

comment on column public.recon_uploads.parser_version is
  'Version number of the parser logic that generated parsed_payload. If the code parser version is incremented, lazy backfill re-parses from storage.';

