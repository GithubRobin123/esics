-- EDISS Schema Migration v8: Standalone Tax Invoice module (manual entry)
--
-- This module is INDEPENDENT of the existing `invoices` table (which lives in
-- the shared `ediss_invoices` database and is auto-generated from MAWB/HBL
-- counts). Nothing here touches that flow:
--   * different database  — these tables live in the main app DB (ediss_db)
--   * different tables    — all prefixed `tax_invoice`
--   * different sequence  — `tax_invoice_no_seq`, not `invoice_no_seq`
--
-- Every statement is IF NOT EXISTS / idempotent — safe to re-run.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Invoice numbers for this module only.
CREATE SEQUENCE IF NOT EXISTS tax_invoice_no_seq START 1;

-- ─── Party master ─────────────────────────────────────────────────────────────
-- Reusable customer records so the operator doesn't retype billing details.
CREATE TABLE IF NOT EXISTS tax_invoice_parties (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(200) NOT NULL,
  gstin         VARCHAR(15),
  address1      VARCHAR(200),
  address2      VARCHAR(200),
  city          VARCHAR(100),
  state         VARCHAR(100),
  -- First two digits of the GSTIN. Drives CGST+SGST vs IGST.
  state_code    VARCHAR(2),
  pincode       VARCHAR(10),
  email         VARCHAR(150),
  phone         VARCHAR(30),
  is_active     BOOLEAN DEFAULT TRUE,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_inv_parties_name   ON tax_invoice_parties(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_tax_inv_parties_active ON tax_invoice_parties(is_active);

-- ─── Invoice header ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_invoices (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_no        VARCHAR(40) UNIQUE NOT NULL,
  invoice_date      DATE NOT NULL,

  party_id          UUID REFERENCES tax_invoice_parties(id),
  -- Frozen copy of the party's billing details at issue time, so later edits to
  -- the party master never retroactively alter an issued invoice.
  party_snapshot    JSONB NOT NULL,

  place_of_supply   VARCHAR(100),
  gst_mode          VARCHAR(10) NOT NULL CHECK (gst_mode IN ('cgst_sgst', 'igst')),

  -- Money. All values are already rounded to 2dp by the server before insert.
  subtotal          NUMERIC(14,2) NOT NULL DEFAULT 0,  -- sum of line amounts
  discount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxable_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,  -- subtotal - discount
  cgst_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  round_off         NUMERIC(8,2)  NOT NULL DEFAULT 0,
  total_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- Cancelled invoices keep their number (audit trail) but drop out of
  -- every outstanding/pending total.
  is_cancelled      BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at      TIMESTAMP,
  cancelled_by      UUID REFERENCES users(id),

  notes             TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_invoices_party      ON tax_invoices(party_id);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_date       ON tax_invoices(invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_created_by ON tax_invoices(created_by);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_cancelled  ON tax_invoices(is_cancelled);

-- ─── Invoice line items ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_invoice_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id    UUID NOT NULL REFERENCES tax_invoices(id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL,
  description   VARCHAR(500) NOT NULL,
  hsn_sac       VARCHAR(20),
  quantity      NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit          VARCHAR(20),
  rate          NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_rate      NUMERIC(5,2)  NOT NULL DEFAULT 18,
  amount        NUMERIC(14,2) NOT NULL DEFAULT 0,   -- quantity * rate, 2dp
  UNIQUE (invoice_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_tax_invoice_items_invoice ON tax_invoice_items(invoice_id);

-- ─── Payment receipts ─────────────────────────────────────────────────────────
-- Source of truth for "how much has been received". Paid/pending amounts are
-- always derived from SUM(amount) here, never stored on the header, so the two
-- can't drift apart. Supports partial payments.
CREATE TABLE IF NOT EXISTS tax_invoice_payments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id    UUID NOT NULL REFERENCES tax_invoices(id) ON DELETE CASCADE,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  paid_on       DATE NOT NULL DEFAULT CURRENT_DATE,
  method        VARCHAR(30),      -- NEFT / RTGS / UPI / Cheque / Cash / Other
  reference     VARCHAR(100),     -- UTR, cheque no, etc.
  notes         TEXT,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_invoice_payments_invoice ON tax_invoice_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_tax_invoice_payments_date    ON tax_invoice_payments(paid_on DESC);
