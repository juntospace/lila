-- Seed data applied by `supabase db reset` (local) and on initial setup.
-- Production seeding happens through the admin console once it exists.

insert into public.operator_allowlist (email, role)
values
  ('antonio@somosjunto.com', 'admin'),
  ('ajromeroesclusa@gmail.com', 'admin')
on conflict (email) do nothing;
