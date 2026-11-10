-- Migration: 20261109210000_portfolio_loans_principal_interest_balance.sql
-- Description: Add principal_balance and interest_balance to portfolio_loans to support "BASE DEL SALDO" (Saldo total / Capital / Capital + int.)

ALTER TABLE public.portfolio_loans
  ADD COLUMN IF NOT EXISTS principal_balance numeric(15, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest_balance numeric(15, 2) DEFAULT 0;

-- Update existing rows where principal_balance was 0 to default to balance
UPDATE public.portfolio_loans
SET principal_balance = balance
WHERE principal_balance = 0 OR principal_balance IS NULL;
