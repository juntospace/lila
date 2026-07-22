# Lila — Strategic Context

## What It Is

Lila is Junto's full lending platform — tech-oriented and AI-powered.

## Product Scope

- Merchant Cash Advance (MCA) for MSMEs — primary
- Personal loans — secondary
- Target market: Panama

## Vision

Replace manual/legacy lending processes with an end-to-end digital platform:
- AI-driven underwriting and risk scoring
- Automated origination and disbursement
- Merchant-facing portal
- Back-office operations

## Architecture Decisions

- **Payment Reconciliation Module (Recon)**:
  - Supports BAC and Banco General rails using manual Excel statement uploads.
  - Transactions are classified (`loan_inflow`, `reversal`, `non_loan`, etc.) and reconciled (e.g., pairing PRs and DAs).
  - **File reference persistence**: Uploaded statement files are tracked in the `recon_uploads` table, which acts as the reference for each file upload session. It enforces file-level deduplication via a unique SHA-256 hash (`file_sha256`). Individual records are stored in `recon_transactions` with an `upload_id` linking back to `recon_uploads`.
  - **Supabase Storage (`recon-statements`)**: Private storage bucket created for bank statements with a 10 MB limit and restricted MIME types (`.xls`, `.xlsx`). RLS policies grant read access to active operators (`public.is_active_operator()`) and write/delete access to recon writers (`public.is_recon_writer()`).

## Key People

_(To be added)_

## Integrations / Tools

- **LoanDisk** — loan management system (API docs in `../docs/loandisk-api/`)
- **Supabase Edge Functions** — e.g. `supabase/functions/bac-recon/` used during file uploads via `/recon/upload`.
- **Supabase Storage** — private bucket `recon-statements` for statement file persistence.

## Active Priorities

_(To be defined with Antonio)_

## Notes & Decisions

- 2026-04-27: Project named "Lila", directory initialized
- 2026-07-21: Configured default BAC account (`100412600` · `JUNTO SOLUCIONES, S.A.`) in seeds and local database for reconciliation testing.
- 2026-07-21: Created private Supabase Storage bucket `recon-statements` with RLS policies in migration `20260721223000_recon_storage_bucket.sql`.
- 2026-07-22: Linked BAC Excel statement upload in `uploadStatement` with private Supabase Storage bucket `recon-statements` (path: `<account_id>/<file_sha256>.<ext>`) and concurrent `bac-recon` Edge Function validation. Added `storage_path text` column to `recon_uploads` in migration `20260721230000_recon_uploads_storage_path.sql` and ensured transactional rollback (removing storage object and deleting records on error) as well as storage object deletion upon calling `deleteUpload`.

---
_Last updated: 2026-07-22_
