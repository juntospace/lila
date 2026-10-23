-- Fast server-side helpers for BAC reconciliation recompute
-- Avoids thousands of round-trips over PostgREST on large account histories.

create or replace function public.recon_wipe_auto_links(
  p_account_id uuid,
  p_since_date date default null
)
returns int
language plpgsql
security definer
as $$
declare
  deleted_count int;
begin
  if p_since_date is not null then
    delete from public.recon_links
    where match_strategy in ('auto_batch_link', 'auto_fifo_name_amount')
      and pr_txn_id in (
        select id from public.recon_transactions
        where account_id = p_account_id and posted_at >= p_since_date
      );
  else
    delete from public.recon_links
    where match_strategy in ('auto_batch_link', 'auto_fifo_name_amount')
      and pr_txn_id in (
        select id from public.recon_transactions
        where account_id = p_account_id
      );
  end if;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.recon_bulk_update_states(p_txn_ids uuid[], p_state public.recon_transactions_state_enum)
returns int
language plpgsql
security definer
as $$
declare
  updated_count int;
begin
  update public.recon_transactions
  set state = p_state
  where id = any(p_txn_ids);
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

create index if not exists recon_transactions_open_items_idx
on public.recon_transactions (account_id, code, posted_at)
where state in ('pending', 'pending_pair');

create index if not exists recon_transactions_account_code_posted_idx
on public.recon_transactions (account_id, code, posted_at desc);

grant execute on function public.recon_wipe_auto_links(uuid, date) to authenticated, service_role;
grant execute on function public.recon_bulk_update_states(uuid[], public.recon_transactions_state_enum) to authenticated, service_role;
