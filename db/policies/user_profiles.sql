-- RLS for user_profiles.
-- Authenticated operators may read and update their own row only.
-- Inserts are allowed only when the signed-in email is on the allowlist
-- (this is how requireOperator() provisions a profile on first sign-in).

drop policy if exists user_profiles_select_self on public.user_profiles;
create policy user_profiles_select_self
on public.user_profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists user_profiles_update_self on public.user_profiles;
create policy user_profiles_update_self
on public.user_profiles
for update
to authenticated
using (id = auth.uid())
with check (
  id = auth.uid()
  -- Self-service updates may not change role or status.
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
  and email = (select email from auth.users where id = auth.uid())
  and exists (
    select 1
    from public.operator_allowlist a
    where lower(a.email) = lower((select email from auth.users where id = auth.uid()))
  )
);
