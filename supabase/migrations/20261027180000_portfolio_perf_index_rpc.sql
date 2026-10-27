-- Portfolio Performance Optimization: Covering Index and Last Payment Map RPC

CREATE INDEX IF NOT EXISTS portfolio_repayments_snapshot_real_loan_date_idx
  ON public.portfolio_loan_repayments (snapshot_id, is_real, source_loan_id, collection_date DESC);

CREATE OR REPLACE FUNCTION public.get_portfolio_last_payment_map(p_snapshot_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    jsonb_object_agg(source_loan_id, last_d),
    '{}'::jsonb
  )
  FROM (
    SELECT source_loan_id, MAX(collection_date)::text as last_d
    FROM public.portfolio_loan_repayments
    WHERE snapshot_id = p_snapshot_id AND is_real = true
    GROUP BY source_loan_id
  ) agg;
$$;
