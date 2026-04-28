-- Fix: the user_profiles INSERT policy contains
--   exists (select 1 from operator_allowlist where lower(email) = lower(auth.email()))
-- That subquery runs under the *authenticated* role and is itself subject
-- to RLS on operator_allowlist. The previous migration left allowlist with
-- RLS enabled and zero policies, so authenticated users see zero rows and
-- the EXISTS check is always false — blocking every legitimate operator.
--
-- Grant authenticated users SELECT on their own allowlist row only. They
-- still can't list other operators or modify the allowlist (no INSERT /
-- UPDATE / DELETE policies). Service-role admin tooling bypasses RLS and
-- stays in charge of writes.

drop policy if exists operator_allowlist_select_self on public.operator_allowlist;
create policy operator_allowlist_select_self
on public.operator_allowlist
for select
to authenticated
using (lower(email) = lower(auth.email()));
