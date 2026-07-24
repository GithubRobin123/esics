CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SEQUENCE IF NOT EXISTS invoice_no_seq START 1;

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_no VARCHAR(30) UNIQUE NOT NULL,
  module VARCHAR(10) NOT NULL CHECK (module IN ('air','sea')),
  invoice_date DATE NOT NULL,
  mawb_no VARCHAR(20),
  hawb_no VARCHAR(20),
  mbl_no VARCHAR(20),
  hbl_no VARCHAR(20),
  consignee_name VARCHAR(200),
  amount DECIMAL(12,2) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'INR',
  description TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  profile_id UUID,
  created_by UUID,
  user_id UUID,
  period_from DATE,
  period_to DATE,
  rate_type VARCHAR(20),
  quantity INTEGER,
  rate DECIMAL(10,2),
  taxable_amount DECIMAL(12,2),
  gst_rate DECIMAL(5,2),
  gst_amount DECIMAL(12,2),
  round_off DECIMAL(6,2),
  total_amount DECIMAL(12,2),
  buyer_snapshot JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_module ON invoices(module);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at DESC);
