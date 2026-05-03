-- Change recon_manual_actions.txn_id from ON DELETE RESTRICT to CASCADE.
--
-- Why: deleteUpload removes an upload's recon_transactions, and any
-- audit rows tied to those transactions need to go too. The original
-- ON DELETE RESTRICT plus the table's "append-only via the API" RLS
-- (no DELETE policy) made deletes impossible without bypassing
-- security. CASCADE fires at the database level — RLS still blocks
-- direct DELETEs through PostgREST, so operators can't tamper with
-- the audit trail directly; rows only disappear when their underlying
-- transaction does, which is the only physically meaningful moment
-- to drop them.

alter table public.recon_manual_actions
  drop constraint if exists recon_manual_actions_txn_id_fkey;

alter table public.recon_manual_actions
  add constraint recon_manual_actions_txn_id_fkey
    foreign key (txn_id)
    references public.recon_transactions(id)
    on delete cascade;
