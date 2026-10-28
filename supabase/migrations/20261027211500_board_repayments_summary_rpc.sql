-- RPC function to compute aggregated monthly and daily repayment summaries for Board Report
-- Single-pass filtering to avoid scanning 37,000+ rows multiple times
CREATE OR REPLACE FUNCTION get_board_repayments_summary(
  p_snapshot_id uuid,
  p_asof date,
  p_daily_start date
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH filtered AS (
  SELECT
    source_loan_id,
    collection_date,
    principal_amount,
    ingresos_amount,
    to_char(collection_date, 'YYYY-MM') AS month,
    to_char(collection_date, 'YYYY-MM-DD') AS cdate
  FROM portfolio_loan_repayments
  WHERE snapshot_id = p_snapshot_id
    AND is_real = true
    AND collection_date <= p_asof
),
monthly AS (
  SELECT
    source_loan_id,
    month,
    ROUND(SUM(principal_amount)::numeric, 2) AS prin,
    ROUND(SUM(ingresos_amount)::numeric, 2) AS inc
  FROM filtered
  GROUP BY source_loan_id, month
),
daily AS (
  SELECT
    source_loan_id,
    cdate,
    ROUND(SUM(principal_amount)::numeric, 2) AS prin,
    ROUND(SUM(ingresos_amount)::numeric, 2) AS inc
  FROM filtered
  WHERE collection_date >= p_daily_start
  GROUP BY source_loan_id, cdate
)
SELECT jsonb_build_object(
  'monthly', COALESCE((SELECT jsonb_agg(jsonb_build_array(source_loan_id, month, prin, inc)) FROM monthly), '[]'::jsonb),
  'daily', COALESCE((SELECT jsonb_agg(jsonb_build_array(source_loan_id, cdate, prin, inc)) FROM daily), '[]'::jsonb)
);
$$;
