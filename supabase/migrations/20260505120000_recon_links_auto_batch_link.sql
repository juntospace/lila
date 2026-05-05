-- Tier 5 PR 2: extend recon_links match_strategy enum with 'auto_batch_link'.
--
-- The pairing pipeline used to insert links with strategy = 'auto_fifo_name_amount'
-- (per-row FIFO + ±1-day window). The new batch-aware pipeline groups PRs by
-- raw `Referencia` and DAs by consecutive sequence, then links a DA batch to
-- one or more PR batches as a single transaction. Links inserted by that
-- pipeline carry strategy = 'auto_batch_link' so we can tell them apart from
-- legacy auto-pairings (and from operator-placed manual pairings).
--
-- Strictly additive — existing rows keep their current strategy values.

alter type public.recon_links_strategy_enum add value if not exists 'auto_batch_link';
