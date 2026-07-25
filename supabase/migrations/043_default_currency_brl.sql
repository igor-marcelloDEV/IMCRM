-- ============================================================
-- 043_default_currency_brl.sql
--
-- IMCRM is now a Brazilian product (billing itself runs in BRL —
-- see migration 041). New accounts should default their own deal
-- currency to BRL instead of USD too, so a fresh signup's Pipelines
-- page shows R$ out of the box without a manual settings change.
--
-- Only changes the DEFAULT for future INSERTs — existing accounts
-- keep whatever `default_currency` they already have (someone may
-- have deliberately set it otherwise; this isn't a retroactive
-- migration of live data).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts ALTER COLUMN default_currency SET DEFAULT 'BRL';
