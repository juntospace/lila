-- portfolio_loan_metric_facts view.
--
-- One row per loan per snapshot, with the repayment rollup attached.
-- Powers the KPI engine: lets the page load 2.3k rows instead of 2.3k
-- loans + 32k repayments per render.
--
-- security_invoker = on means RLS on the underlying tables applies as
-- the calling user (operator), not the view's owner. So no separate
-- policy needed; the view inherits portfolio_loans + portfolio_loan_repayments
-- policies. (Postgres 15+, which is what Supabase ships on.)
--
-- Derived columns:
--   cohort_month             — YYYY-MM-01 (text) for vintage analysis
--   cash_collected_minor     — Σ total_paid_minor where is_cash_collection
--   write_off_minor          — Σ total_paid_minor where method ilike 'traspaso a provision%'
--   finiquito_count          — count of settlement methods
--   cash_count               — count of cash repayments

create or replace view public.portfolio_loan_metric_facts
with (security_invoker = on) as
with rp as (
  select
    snapshot_id,
    source_loan_id,
    sum(case when is_cash_collection then total_paid_minor else 0 end) as cash_collected_minor,
    sum(case when method ilike 'traspaso a provision%' then total_paid_minor else 0 end) as write_off_minor,
    count(*) filter (where is_cash_collection) as cash_count,
    count(*) filter (where method ilike 'finiquito%') as finiquito_count
  from public.portfolio_loan_repayments
  group by snapshot_id, source_loan_id
)
select
  l.id                              as loan_pk,
  l.snapshot_id,
  l.entity_id,
  l.snapshot_date,
  l.source_loan_id,
  l.balance_amount_minor,
  l.principal_amount_minor,
  l.paid_amount_minor,
  l.past_due_minor,
  l.days_past_due,
  l.status_normalized,
  l.product_group,
  l.management_vintage,
  l.portfolio_segment,
  l.ifrs_stage,
  l.is_npl,
  l.released_date,
  l.maturity_date,
  l.loan_officer_raw,
  case
    when l.released_date is null then null
    else to_char(l.released_date, 'YYYY-MM-01')
  end                                                  as cohort_month,
  coalesce(rp.cash_collected_minor, 0)::bigint         as cash_collected_minor,
  coalesce(rp.write_off_minor,      0)::bigint         as write_off_minor,
  coalesce(rp.cash_count,           0)::int            as cash_count,
  coalesce(rp.finiquito_count,      0)::int            as finiquito_count
from public.portfolio_loans l
left join rp
  on rp.snapshot_id    = l.snapshot_id
 and rp.source_loan_id = l.source_loan_id;
