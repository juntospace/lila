-- Fix: the previous RLS policies queried auth.users directly via
-- `(select email from auth.users where id = auth.uid())`, but the
-- `authenticated` role has no grants on auth.users, so the subquery
-- returns NULL and every check fails silently. Switch to auth.email(),
-- the canonical Supabase helper that reads the email claim from the JWT.

drop policy if exists user_profiles_update_self on public.user_profiles;
create policy user_profiles_update_self
on public.user_profiles
for update
to authenticated
using (id = auth.uid())
with check (
  id = auth.uid()
  and role = (select role from public.user_profiles where id = auth.uid())
  and status = (select status from public.user_profiles where id = auth.uid())
);

drop policy if exists user_profiles_insert_self_on_allowlist on public.user_profiles;
create policy user_profiles_insert_self_on_allowlist
on public.user_profiles
for insert
to authenticated
with check (
  id = auth.uid()
  and lower(email) = lower(auth.email())
  and exists (
    select 1
    from public.operator_allowlist a
    where lower(a.email) = lower(auth.email())
  )
);
