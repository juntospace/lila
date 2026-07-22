-- Grant schema usage to anon, authenticated, and service_role.
grant usage on schema public to anon, authenticated, service_role;

-- Grant data privileges to authenticated operators and service_role (RLS enforces row-level policies).
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

-- Default privileges for future tables/functions
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
