-- Add cached_dataset to portfolio_snapshots for instant Board Report loading
ALTER TABLE public.portfolio_snapshots
  ADD COLUMN IF NOT EXISTS cached_dataset jsonb;
