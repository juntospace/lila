-- Seed data applied by `supabase db reset` (local) and on initial setup.
-- Production seeding happens through the admin console once it exists.

insert into public.operator_allowlist (email, role) values ('antonio@somosjunto.com', 'admin');
insert into public.operator_allowlist (email, role) values ('ronel@somosjunto.com', 'admin');
insert into public.operator_allowlist (email, role) values ('darwins@somosjunto.com', 'admin');
insert into public.operator_allowlist (email, role) values ('cesar@somosjunto.com', 'admin');
insert into public.operator_allowlist (email, role) values ('ajromeroesclusa@gmail.com', 'admin');
insert into public.operator_allowlist (email, role) values ('pateticarluis@gmail.com', 'admin');

-- Default BAC account for testing & integration.
insert into public.bank_accounts (rail, account_number, holder_name, currency)
values ('bac', '100412600', 'JUNTO SOLUCIONES, S.A.', 'USD')
on conflict (rail, account_number) do nothing;
