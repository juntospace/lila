-- Seed placeholder ECL coverage rates on portfolio_policy.
--
-- Phase 2 slice 1 (KPI engine) needs the ECL matrix to compute total
-- provisions, coverage ratio, and net portfolio value. Risk hasn't
-- supplied production rates yet, so we insert a *new* policy version
-- with conservative placeholders. The board/investor views must visibly
-- flag these as placeholders until risk overrides them.
--
-- Pattern: never UPDATE an effective_from row — insert a later one and
-- the active-policy lookup (effective_from <= snapshot_date, ORDER BY
-- effective_from DESC LIMIT 1) picks it up automatically. Past snapshots
-- can be re-evaluated under any active policy without re-ingesting.
--
-- Placeholder coverage rates (conservative side, calibrate when risk
-- delivers the actual matrix):
--   Stage 1 (performing)         → 1%  (baseline expected loss)
--   Stage 2 (significant risk)   → 10% (early delinquency)
--   Stage 3 (credit impaired)    → 50% (default — assumes some recovery)

insert into public.portfolio_policy (
  effective_from,
  charge_off_dpd_threshold,
  management_cutoff_date,
  cash_advance_always_new,
  stage_2_dpd_min,
  stage_3_dpd_min,
  npl_dpd_min,
  ecl_stage_1_coverage,
  ecl_stage_2_coverage,
  ecl_stage_3_coverage,
  notes
) values (
  '2026-06-13',
  365,
  '2025-01-01',
  true,
  30,
  90,
  90,
  0.0100,
  0.1000,
  0.5000,
  'Placeholder ECL coverage rates pending risk-team input. UI must flag derived metrics (Total provisions, Coverage Ratio, Net Portfolio Value, Cost of Risk proxy) as placeholders until this row is superseded.'
) on conflict (effective_from) do nothing;
