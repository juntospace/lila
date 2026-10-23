-- Seed data applied by `supabase db reset` (local) and on initial setup.
-- Production seeding happens through the admin console once it exists.

insert into public.operator_allowlist (email, role) values ('admin@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('antonio@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('ronel@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('darwins@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('cesar@somosjunto.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('ajromeroesclusa@gmail.com', 'admin') on conflict do nothing;
insert into public.operator_allowlist (email, role) values ('pateticarluis@gmail.com', 'admin') on conflict do nothing;

-- Seed dev user in auth.users & public.user_profiles
do $$
declare
  uid uuid := '00000000-0000-0000-0000-000000000001'::uuid;
begin
  if not exists (select 1 from auth.users where email = 'admin@somosjunto.com') then
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      'admin@somosjunto.com', crypt('Password123!', gen_salt('bf')), now(),
      '{"provider": "email", "providers": ["email"]}', '{"full_name": "Admin User"}',
      now(), now(), '', '', '', ''
    );

    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) values (
      uid, uid, format('{"sub":"%s","email":"%s"}', uid, 'admin@somosjunto.com')::jsonb,
      'email', 'admin@somosjunto.com', now(), now(), now()
    );

    insert into public.user_profiles (id, email, full_name, role, status)
    values (uid, 'admin@somosjunto.com', 'Admin User', 'admin', 'active')
    on conflict (id) do update set role = 'admin', status = 'active';
  end if;
end $$;

-- Default BAC account for testing & integration.
insert into public.bank_accounts (rail, account_number, holder_name, currency)
values ('bac', '100412600', 'JUNTO SOLUCIONES, S.A.', 'USD')
on conflict (rail, account_number) do nothing;

-- Default Banco General account for testing & integration (Crediclaro).
insert into public.bank_accounts (rail, account_number, holder_name, currency)
values ('bg', '03-43-01-106691-6', 'CREDICLARO, S.A.', 'USD')
on conflict (rail, account_number) do nothing;
