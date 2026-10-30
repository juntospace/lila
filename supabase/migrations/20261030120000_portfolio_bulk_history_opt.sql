-- Portfolio Bulk History Optimization:
-- 1. Covering index for historical open loans across 100+ snapshots
-- 2. Fast RPC get_board_historical_loans to replace 90+ paginated REST calls
-- 3. Deduplication-aware get_portfolio_last_payment_map & get_board_repayments_summary
--    so historical snapshots do not need to duplicate 37,000 repayment rows each.

-- 1. Covering index for Board historical open loans scan
CREATE INDEX IF NOT EXISTS portfolio_loans_entity_open_date_covering_idx
  ON public.portfolio_loans (entity_id, is_open, snapshot_date ASC, source_loan_id ASC)
  INCLUDE (segment_idx, bucket_idx, balance, dpd);

-- Fix any existing snapshots where has_repayments was left false during chunked fallback ingest
UPDATE public.portfolio_snapshots
SET has_repayments = true
WHERE has_repayments = false
  AND coalesce((source_files->>'hasRepaymentsFile')::boolean, false) = true;

-- 2. RPC: Single-call historical open loans loader for Board Report
CREATE OR REPLACE FUNCTION public.get_board_historical_loans(
  p_entity_id uuid,
  p_asof date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_array(
        snapshot_date::text,
        source_loan_id,
        segment_idx,
        bucket_idx,
        balance,
        dpd
      )
      ORDER BY snapshot_date ASC, source_loan_id ASC
    ),
    '[]'::jsonb
  )
  FROM public.portfolio_loans
  WHERE entity_id = p_entity_id
    AND is_open = true
    AND snapshot_date <= p_asof;
$$;

-- 3. Upgrade get_portfolio_last_payment_map to support precomputed source_files map
--    and fallback to entity's cumulative repayments up to snapshot_date
CREATE OR REPLACE FUNCTION public.get_portfolio_last_payment_map(p_snapshot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity_id uuid;
  v_snapshot_date date;
  v_source_files jsonb;
  v_rep_snapshot_id uuid;
  v_result jsonb;
BEGIN
  SELECT entity_id, snapshot_date, source_files
  INTO v_entity_id, v_snapshot_date, v_source_files
  FROM public.portfolio_snapshots
  WHERE id = p_snapshot_id;

  IF v_entity_id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  -- Fast path 1: precomputed lastRealPaymentMap stored at ingest time from the exact ZIP
  IF v_source_files IS NOT NULL
     AND jsonb_typeof(v_source_files->'lastRealPaymentMap') = 'object' THEN
    RETURN v_source_files->'lastRealPaymentMap';
  END IF;

  -- Fast path 2: repayments stored directly under this snapshot_id
  IF EXISTS (
    SELECT 1 FROM public.portfolio_loan_repayments
    WHERE snapshot_id = p_snapshot_id
    LIMIT 1
  ) THEN
    v_rep_snapshot_id := p_snapshot_id;
  ELSE
    -- Fallback: resolve closest snapshot >= v_snapshot_date (or latest overall) that holds repayments
    SELECT s.id
    INTO v_rep_snapshot_id
    FROM public.portfolio_snapshots s
    WHERE s.entity_id = v_entity_id
      AND s.status = 'completed'
      AND EXISTS (
        SELECT 1 FROM public.portfolio_loan_repayments r
        WHERE r.snapshot_id = s.id
        LIMIT 1
      )
    ORDER BY
      (s.snapshot_date >= v_snapshot_date) DESC,
      ABS(s.snapshot_date - v_snapshot_date) ASC,
      s.snapshot_date DESC
    LIMIT 1;
  END IF;

  IF v_rep_snapshot_id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  SELECT COALESCE(
    jsonb_object_agg(source_loan_id, last_d),
    '{}'::jsonb
  )
  INTO v_result
  FROM (
    SELECT source_loan_id, MAX(collection_date)::text AS last_d
    FROM public.portfolio_loan_repayments
    WHERE snapshot_id = v_rep_snapshot_id
      AND is_real = true
      AND collection_date <= v_snapshot_date
    GROUP BY source_loan_id
  ) agg;

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- 4. Upgrade get_board_repayments_summary to resolve repayments from p_snapshot_id
--    or fallback to the entity's cumulative repayments snapshot filtered by collection_date <= p_asof
CREATE OR REPLACE FUNCTION public.get_board_repayments_summary(
  p_snapshot_id uuid,
  p_asof date,
  p_daily_start date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_entity_id uuid;
  v_rep_snapshot_id uuid;
  v_result jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.portfolio_loan_repayments
    WHERE snapshot_id = p_snapshot_id
    LIMIT 1
  ) THEN
    v_rep_snapshot_id := p_snapshot_id;
  ELSE
    SELECT entity_id INTO v_entity_id
    FROM public.portfolio_snapshots
    WHERE id = p_snapshot_id;

    IF v_entity_id IS NOT NULL THEN
      SELECT s.id
      INTO v_rep_snapshot_id
      FROM public.portfolio_snapshots s
      WHERE s.entity_id = v_entity_id
        AND s.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM public.portfolio_loan_repayments r
          WHERE r.snapshot_id = s.id
          LIMIT 1
        )
      ORDER BY
        (s.snapshot_date >= p_asof) DESC,
        ABS(s.snapshot_date - p_asof) ASC,
        s.snapshot_date DESC
      LIMIT 1;
    END IF;
  END IF;

  IF v_rep_snapshot_id IS NULL THEN
    RETURN jsonb_build_object('monthly', '[]'::jsonb, 'daily', '[]'::jsonb);
  END IF;

  WITH filtered AS (
    SELECT
      source_loan_id,
      collection_date,
      principal_amount,
      ingresos_amount,
      to_char(collection_date, 'YYYY-MM') AS month,
      to_char(collection_date, 'YYYY-MM-DD') AS cdate
    FROM public.portfolio_loan_repayments
    WHERE snapshot_id = v_rep_snapshot_id
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
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

