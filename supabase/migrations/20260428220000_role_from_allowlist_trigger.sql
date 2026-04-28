-- On user_profiles INSERT, copy the role from operator_allowlist so the
-- caller (the operator themselves) cannot escalate their own privilege by
-- passing role='admin' from the client. The function is SECURITY DEFINER
-- so the lookup bypasses RLS on operator_allowlist (the authenticated
-- role only has SELECT on its own row, which is enough for the existing
-- INSERT policy's EXISTS check, but we want a fresh lookup that doesn't
-- depend on the JWT email matching exactly the row we want to read).
--
-- Defense in depth: the INSERT policy already requires the email to be
-- on the allowlist; this trigger pins the role to whatever the allowlist
-- says, no matter what the client sent.

create or replace function public.set_user_profile_role_from_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  allowed_role operator_role;
begin
  select role into allowed_role
  from public.operator_allowlist
  where lower(email) = lower(new.email);

  if allowed_role is null then
    raise exception 'email % is not on the operator allowlist', new.email
      using errcode = '42501';
  end if;

  new.role := allowed_role;
  return new;
end;
$$;

drop trigger if exists user_profiles_role_from_allowlist on public.user_profiles;
create trigger user_profiles_role_from_allowlist
before insert on public.user_profiles
for each row execute function public.set_user_profile_role_from_allowlist();
