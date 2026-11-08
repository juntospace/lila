-- Portfolio v6 Parity:
-- 1. Add is_provision to portfolio_loan_repayments & provision_count / provision_amount to portfolio_ingest_batches
-- 2. Add "provision" to portfolio_policy.admin_methods
-- 3. Reclassify existing "Provision" / "Traspaso a Provisión" rows and backfill batches & snapshots
-- 4. Update portfolio_replace_snapshot & get_board_repayments_summary RPCs

-- =============================================================
-- 1. Schema additions
-- =============================================================
ALTER TABLE public.portfolio_loan_repayments
  ADD COLUMN IF NOT EXISTS is_provision boolean NOT NULL DEFAULT false;

ALTER TABLE public.portfolio_ingest_batches
  ADD COLUMN IF NOT EXISTS provision_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provision_amount numeric(15, 2) NOT NULL DEFAULT 0;

-- =============================================================
-- 2. Policy update: ensure "provision" is in admin_methods
-- =============================================================
UPDATE public.portfolio_policy
SET admin_methods = admin_methods || '["provision"]'::jsonb
WHERE NOT (admin_methods @> '["provision"]'::jsonb);

-- =============================================================
-- 3. Backfill existing repayments, batches, and snapshots
-- =============================================================
UPDATE public.portfolio_loan_repayments
SET
  is_provision = true,
  is_admin = true,
  is_real = false,
  is_unknown_method = false
WHERE regexp_replace(
  translate(lower(trim(coalesce(method_raw, ''))), 'áéíóúüñ', 'aeiouun'),
  '\s+',
  ' ',
  'g'
) IN ('provision', 'traspaso a provision');

-- Backfill portfolio_ingest_batches and portfolio_snapshots using the entity's cumulative repayments
DO $$
DECLARE
  r_snap RECORD;
  v_rep_snap_id uuid;
  v_prov_count int;
  v_prov_amount numeric(15, 2);
  v_admin_count int;
  v_admin_amount numeric(15, 2);
  v_handover numeric(15, 2);
BEGIN
  FOR r_snap IN
    SELECT id, entity_id, snapshot_date, has_repayments
    FROM public.portfolio_snapshots
    WHERE status = 'completed'
    ORDER BY snapshot_date ASC
  LOOP
    -- Resolve snapshot holding repayments for this entity
    v_rep_snap_id := NULL;
    IF EXISTS (
      SELECT 1 FROM public.portfolio_loan_repayments
      WHERE snapshot_id = r_snap.id
      LIMIT 1
    ) THEN
      v_rep_snap_id := r_snap.id;
    ELSE
      SELECT s.id INTO v_rep_snap_id
      FROM public.portfolio_snapshots s
      WHERE s.entity_id = r_snap.entity_id
        AND s.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM public.portfolio_loan_repayments r
          WHERE r.snapshot_id = s.id
          LIMIT 1
        )
      ORDER BY
        (s.snapshot_date >= r_snap.snapshot_date) DESC,
        ABS(s.snapshot_date - r_snap.snapshot_date) ASC,
        s.snapshot_date DESC
      LIMIT 1;
    END IF;

    IF v_rep_snap_id IS NOT NULL AND r_snap.has_repayments THEN
      SELECT
        COUNT(*) FILTER (WHERE is_provision = true),
        COALESCE(ROUND(SUM(total_amount) FILTER (WHERE is_provision = true)::numeric, 2), 0),
        COUNT(*) FILTER (WHERE is_admin = true AND is_provision = false),
        COALESCE(ROUND(SUM(total_amount) FILTER (WHERE is_admin = true AND is_provision = false)::numeric, 2), 0),
        COALESCE(ROUND(SUM(principal_amount + ingresos_amount) FILTER (WHERE is_real = true AND collection_date >= DATE '2025-06-01')::numeric, 2), 0)
      INTO
        v_prov_count,
        v_prov_amount,
        v_admin_count,
        v_admin_amount,
        v_handover
      FROM public.portfolio_loan_repayments
      WHERE snapshot_id = v_rep_snap_id
        AND collection_date <= r_snap.snapshot_date;

      UPDATE public.portfolio_ingest_batches
      SET
        provision_count = v_prov_count,
        provision_amount = v_prov_amount,
        admin_excluded_count = v_admin_count,
        admin_excluded_amount = v_admin_amount,
        unknown_methods = array_remove(array_remove(unknown_methods, 'Provision'), 'Provisión')
      WHERE snapshot_id = r_snap.id;

      UPDATE public.portfolio_snapshots
      SET
        total_collected_handover = v_handover,
        cached_dataset = NULL
      WHERE id = r_snap.id;
    ELSE
      UPDATE public.portfolio_ingest_batches
      SET unknown_methods = array_remove(array_remove(unknown_methods, 'Provision'), 'Provisión')
      WHERE snapshot_id = r_snap.id;

      UPDATE public.portfolio_snapshots
      SET cached_dataset = NULL
      WHERE id = r_snap.id;
    END IF;
  END LOOP;
END;
$$;

-- =============================================================
-- 4. Update portfolio_replace_snapshot RPC
-- =============================================================
CREATE OR REPLACE FUNCTION public.portfolio_replace_snapshot(
  p_entity_id uuid,
  p_snapshot_date date,
  p_snapshot jsonb,
  p_loans jsonb,
  p_repayments jsonb,
  p_batch jsonb default null
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_snapshot_id uuid;
BEGIN
  -- 1. Upsert snapshot master record (clearing cached_dataset)
  INSERT INTO public.portfolio_snapshots (
    entity_id,
    snapshot_date,
    as_of_date,
    policy_id,
    total_open_balance,
    total_open_loans,
    cer30_balance,
    cer30_percentage,
    cer90_balance,
    cer90_percentage,
    total_collected_handover,
    cash_ahead_count,
    future_payments_excluded_count,
    has_repayments,
    source_files,
    cached_dataset,
    status,
    updated_at
  ) VALUES (
    p_entity_id,
    p_snapshot_date,
    coalesce((p_snapshot->>'as_of_date')::date, p_snapshot_date),
    nullif(p_snapshot->>'policy_id', '')::uuid,
    coalesce((p_snapshot->>'total_open_balance')::numeric(15, 2), 0),
    coalesce((p_snapshot->>'total_open_loans')::int, 0),
    coalesce((p_snapshot->>'cer30_balance')::numeric(15, 2), 0),
    coalesce((p_snapshot->>'cer30_percentage')::numeric(5, 2), 0),
    coalesce((p_snapshot->>'cer90_balance')::numeric(15, 2), 0),
    coalesce((p_snapshot->>'cer90_percentage')::numeric(5, 2), 0),
    coalesce((p_snapshot->>'total_collected_handover')::numeric(15, 2), 0),
    coalesce((p_snapshot->>'cash_ahead_count')::int, 0),
    coalesce((p_snapshot->>'future_payments_excluded_count')::int, 0),
    coalesce((p_snapshot->>'has_repayments')::boolean, false),
    coalesce(p_snapshot->'source_files', '{}'::jsonb),
    NULL,
    coalesce(p_snapshot->>'status', 'completed'),
    now()
  )
  ON CONFLICT (entity_id, snapshot_date) DO UPDATE SET
    as_of_date = excluded.as_of_date,
    policy_id = excluded.policy_id,
    total_open_balance = excluded.total_open_balance,
    total_open_loans = excluded.total_open_loans,
    cer30_balance = excluded.cer30_balance,
    cer30_percentage = excluded.cer30_percentage,
    cer90_balance = excluded.cer90_balance,
    cer90_percentage = excluded.cer90_percentage,
    total_collected_handover = excluded.total_collected_handover,
    cash_ahead_count = excluded.cash_ahead_count,
    future_payments_excluded_count = excluded.future_payments_excluded_count,
    has_repayments = excluded.has_repayments,
    source_files = excluded.source_files,
    cached_dataset = NULL,
    status = excluded.status,
    updated_at = now()
  RETURNING id INTO v_snapshot_id;

  -- 2. Delete previous loans, repayments, and batches for this snapshot
  DELETE FROM public.portfolio_loans WHERE snapshot_id = v_snapshot_id;
  DELETE FROM public.portfolio_loan_repayments WHERE snapshot_id = v_snapshot_id;
  DELETE FROM public.portfolio_ingest_batches WHERE snapshot_id = v_snapshot_id;

  -- 3. Insert loans from jsonb array
  IF p_loans IS NOT NULL AND jsonb_typeof(p_loans) = 'array' AND jsonb_array_length(p_loans) > 0 THEN
    INSERT INTO public.portfolio_loans (
      snapshot_id,
      entity_id,
      snapshot_date,
      source_loan_id,
      loan_number,
      full_name,
      borrower_mobile,
      product,
      segment,
      segment_idx,
      secured,
      balance,
      dpd,
      dpd_loandisk,
      bucket,
      bucket_idx,
      cash_ahead,
      is_open,
      released_date,
      status_raw,
      past_due,
      pending_due,
      total_due_amount,
      loan_duration,
      installments_count,
      repayment_cycle,
      cycle_type,
      last_payment_date,
      last_payment_amount,
      pg,
      tg,
      tc,
      gc,
      mr,
      combo_key,
      raw
    )
    SELECT
      v_snapshot_id,
      p_entity_id,
      p_snapshot_date,
      r.source_loan_id,
      r.loan_number,
      r.full_name,
      r.borrower_mobile,
      r.product,
      r.segment,
      r.segment_idx,
      coalesce(r.secured, false),
      coalesce(r.balance, 0),
      coalesce(r.dpd, 0),
      coalesce(r.dpd_loandisk, 0),
      r.bucket,
      coalesce(r.bucket_idx, 0),
      coalesce(r.cash_ahead, false),
      coalesce(r.is_open, false),
      r.released_date,
      r.status_raw,
      coalesce(r.past_due, 0),
      coalesce(r.pending_due, 0),
      coalesce(r.total_due_amount, 0),
      r.loan_duration,
      r.installments_count,
      r.repayment_cycle,
      coalesce(r.cycle_type, 0),
      r.last_payment_date,
      coalesce(r.last_payment_amount, 0),
      r.pg,
      r.tg,
      r.tc,
      r.gc,
      r.mr,
      r.combo_key,
      coalesce(r.raw, '{}'::jsonb)
    FROM jsonb_to_recordset(p_loans) AS r(
      source_loan_id text,
      loan_number text,
      full_name text,
      borrower_mobile text,
      product text,
      segment text,
      segment_idx int,
      secured boolean,
      balance numeric(15, 2),
      dpd int,
      dpd_loandisk int,
      bucket text,
      bucket_idx int,
      cash_ahead boolean,
      is_open boolean,
      released_date date,
      status_raw text,
      past_due numeric(15, 2),
      pending_due numeric(15, 2),
      total_due_amount numeric(15, 2),
      loan_duration text,
      installments_count int,
      repayment_cycle text,
      cycle_type int,
      last_payment_date date,
      last_payment_amount numeric(15, 2),
      pg text,
      tg text,
      tc text,
      gc text,
      mr text,
      combo_key text,
      raw jsonb
    );
  END IF;

  -- 4. Insert repayments from jsonb array
  IF p_repayments IS NOT NULL AND jsonb_typeof(p_repayments) = 'array' AND jsonb_array_length(p_repayments) > 0 THEN
    INSERT INTO public.portfolio_loan_repayments (
      snapshot_id,
      entity_id,
      snapshot_date,
      source_repayment_id,
      source_loan_id,
      collection_date,
      principal_amount,
      interest_amount,
      penalty_amount,
      fees_amount,
      total_amount,
      ingresos_amount,
      method_raw,
      is_real,
      is_admin,
      is_provision,
      is_unknown_method,
      raw
    )
    SELECT
      v_snapshot_id,
      p_entity_id,
      p_snapshot_date,
      r.source_repayment_id,
      r.source_loan_id,
      r.collection_date,
      coalesce(r.principal_amount, 0),
      coalesce(r.interest_amount, 0),
      coalesce(r.penalty_amount, 0),
      coalesce(r.fees_amount, 0),
      coalesce(r.total_amount, 0),
      coalesce(r.ingresos_amount, 0),
      r.method_raw,
      coalesce(r.is_real, true),
      coalesce(r.is_admin, false),
      coalesce(r.is_provision, false),
      coalesce(r.is_unknown_method, false),
      coalesce(r.raw, '{}'::jsonb)
    FROM jsonb_to_recordset(p_repayments) AS r(
      source_repayment_id text,
      source_loan_id text,
      collection_date date,
      principal_amount numeric(15, 2),
      interest_amount numeric(15, 2),
      penalty_amount numeric(15, 2),
      fees_amount numeric(15, 2),
      total_amount numeric(15, 2),
      ingresos_amount numeric(15, 2),
      method_raw text,
      is_real boolean,
      is_admin boolean,
      is_provision boolean,
      is_unknown_method boolean,
      raw jsonb
    );
  END IF;

  -- 5. Insert batch metadata if provided
  IF p_batch IS NOT NULL AND jsonb_typeof(p_batch) = 'object' THEN
    INSERT INTO public.portfolio_ingest_batches (
      snapshot_id,
      sha256_loans,
      sha256_repayments,
      rows_loans,
      rows_repayments,
      sum_balance_source,
      sum_balance_ingested,
      future_payments_excluded,
      cash_ahead_count,
      provision_count,
      provision_amount,
      admin_excluded_count,
      admin_excluded_amount,
      unknown_methods,
      missing_custom_fields,
      missing_released_date_count,
      uploaded_by
    ) VALUES (
      v_snapshot_id,
      coalesce(p_batch->>'sha256_loans', ''),
      p_batch->>'sha256_repayments',
      coalesce((p_batch->>'rows_loans')::int, 0),
      coalesce((p_batch->>'rows_repayments')::int, 0),
      coalesce((p_batch->>'sum_balance_source')::numeric(15, 2), 0),
      coalesce((p_batch->>'sum_balance_ingested')::numeric(15, 2), 0),
      coalesce((p_batch->>'future_payments_excluded')::int, 0),
      coalesce((p_batch->>'cash_ahead_count')::int, 0),
      coalesce((p_batch->>'provision_count')::int, 0),
      coalesce((p_batch->>'provision_amount')::numeric(15, 2), 0),
      coalesce((p_batch->>'admin_excluded_count')::int, 0),
      coalesce((p_batch->>'admin_excluded_amount')::numeric(15, 2), 0),
      coalesce(
        array(select jsonb_array_elements_text(coalesce(p_batch->'unknown_methods', '[]'::jsonb))),
        '{}'::text[]
      ),
      coalesce(
        array(select jsonb_array_elements_text(coalesce(p_batch->'missing_custom_fields', '[]'::jsonb))),
        '{}'::text[]
      ),
      coalesce((p_batch->>'missing_released_date_count')::int, 0),
      coalesce(nullif(p_batch->>'uploaded_by', '')::uuid, auth.uid())
    );
  END IF;

  RETURN v_snapshot_id;
END;
$$;

-- =============================================================
-- 5. Update get_board_repayments_summary RPC with prov_monthly & prov_daily
-- =============================================================
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
SET statement_timeout = '60s'
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
    RETURN jsonb_build_object(
      'monthly', '[]'::jsonb,
      'daily', '[]'::jsonb,
      'prov_monthly', '[]'::jsonb,
      'prov_daily', '[]'::jsonb
    );
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
  ),
  prov_filtered AS (
    SELECT
      source_loan_id,
      collection_date,
      (principal_amount + ingresos_amount) AS amt,
      to_char(collection_date, 'YYYY-MM') AS month,
      to_char(collection_date, 'YYYY-MM-DD') AS cdate
    FROM public.portfolio_loan_repayments
    WHERE snapshot_id = v_rep_snapshot_id
      AND is_provision = true
      AND collection_date <= p_asof
  ),
  prov_monthly AS (
    SELECT
      source_loan_id,
      month,
      ROUND(SUM(amt)::numeric, 2) AS amt
    FROM prov_filtered
    GROUP BY source_loan_id, month
  ),
  prov_daily AS (
    SELECT
      source_loan_id,
      cdate,
      ROUND(SUM(amt)::numeric, 2) AS amt
    FROM prov_filtered
    WHERE collection_date >= p_daily_start
    GROUP BY source_loan_id, cdate
  )
  SELECT jsonb_build_object(
    'monthly', COALESCE((SELECT jsonb_agg(jsonb_build_array(source_loan_id, month, prin, inc)) FROM monthly), '[]'::jsonb),
    'daily', COALESCE((SELECT jsonb_agg(jsonb_build_array(source_loan_id, cdate, prin, inc)) FROM daily), '[]'::jsonb),
    'prov_monthly', COALESCE((SELECT jsonb_agg(jsonb_build_array(source_loan_id, month, amt)) FROM prov_monthly), '[]'::jsonb),
    'prov_daily', COALESCE((SELECT jsonb_agg(jsonb_build_array(source_loan_id, cdate, amt)) FROM prov_daily), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

NOTIFY pgrst, 'reload schema';

