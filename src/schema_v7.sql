-- EDISS Schema Migration v7: Air invoice billing plan + auto-generated invoice details
-- Run these statements on your existing database

-- Profile-level billing plan for Air invoicing.
-- Exactly ONE of these three should be filled per profile — it determines how
-- that customer's usage is billed (flat monthly charge, per-MBL, or per-HBL).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS monthly_rate DECIMAL(10,2);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS per_mbl_rate DECIMAL(10,2);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS per_hbl_rate DECIMAL(10,2);

-- Extend invoices table to support auto-generated, period-based Air invoices.
-- Existing manual invoice rows are unaffected — these columns stay NULL for them.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_from DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_to DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rate_type VARCHAR(20);      -- monthly, mbl, hbl
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quantity INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rate DECIMAL(10,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS taxable_amount DECIMAL(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(5,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_amount DECIMAL(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS round_off DECIMAL(6,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total_amount DECIMAL(12,2);
-- Snapshot of the buyer's billing details at generation time (so later edits to
-- the profile don't retroactively change a previously issued invoice)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_snapshot JSONB;

-- invoice_no was UNIQUE + NOT NULL already (see schema_v2.sql) — auto-generated
-- invoices reuse the same column so both flows share one numbering sequence.
