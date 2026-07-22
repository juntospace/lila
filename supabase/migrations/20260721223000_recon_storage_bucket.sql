-- Supabase Storage bucket for bank statements (recon module).
-- Private bucket: accessed only via RLS and short-lived signed URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'recon-statements',
  'recon-statements',
  false,
  10485760, -- 10 MB limit
  array[
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
) on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = array[
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ];

-- RLS policies on storage.objects

drop policy if exists "recon_statements_select_operators" on storage.objects;
create policy "recon_statements_select_operators"
on storage.objects for select to authenticated
using (bucket_id = 'recon-statements' and public.is_active_operator());

drop policy if exists "recon_statements_insert_writers" on storage.objects;
create policy "recon_statements_insert_writers"
on storage.objects for insert to authenticated
with check (bucket_id = 'recon-statements' and public.is_recon_writer());

drop policy if exists "recon_statements_delete_writers" on storage.objects;
create policy "recon_statements_delete_writers"
on storage.objects for delete to authenticated
using (bucket_id = 'recon-statements' and public.is_recon_writer());
