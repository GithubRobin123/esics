-- EDISS Schema Migration v9: billing rate on Tax Invoice parties
--
-- Each party can carry one billing rate and the basis it is charged on:
--   'hawb' = As per HAWB, 'mawb' = As per MAWB, 'hbl' = As per HBL.
-- The New Invoice form pre-fills the line rate from here; the operator still
-- enters the quantity (number of HAWB/MAWB/HBL) for each invoice and may
-- override the rate on that invoice without changing the party.
--
-- Additive only — both columns are nullable, so existing parties are untouched
-- and simply have no rate until one is set. Idempotent, safe to re-run.

ALTER TABLE tax_invoice_parties ADD COLUMN IF NOT EXISTS rate_basis VARCHAR(10);
ALTER TABLE tax_invoice_parties ADD COLUMN IF NOT EXISTS rate       NUMERIC(12,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoice_parties_rate_basis_chk') THEN
    ALTER TABLE tax_invoice_parties ADD CONSTRAINT tax_invoice_parties_rate_basis_chk
      CHECK (rate_basis IS NULL OR rate_basis IN ('hawb', 'mawb', 'hbl'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoice_parties_rate_chk') THEN
    ALTER TABLE tax_invoice_parties ADD CONSTRAINT tax_invoice_parties_rate_chk
      CHECK (rate IS NULL OR rate >= 0);
  END IF;
END $$;
