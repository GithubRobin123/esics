/**
 * Pure calculation + validation for the standalone Tax Invoice module.
 *
 * No database, no Express, no side effects — everything here is a function of
 * its inputs, so it can be reasoned about (and unit-tested) in isolation.
 *
 * The server ALWAYS recomputes totals with this module before persisting.
 * Whatever amounts the browser sends are treated as display-only and thrown
 * away, so a tampered or stale client can never write bad money values.
 */

import { INVOICE_SUPPLIER } from './invoiceConstants';

/** Supplier's own state code — first 2 digits of its GSTIN (06 = Haryana). */
export const SUPPLIER_STATE_CODE = INVOICE_SUPPLIER.gstin.slice(0, 2);

export type GstMode = 'cgst_sgst' | 'igst';

export interface TaxInvoiceItemInput {
  description: string;
  hsn_sac?: string | null;
  quantity: number;
  unit?: string | null;
  rate: number;
  gst_rate: number;
}

export interface TaxInvoiceItemComputed extends TaxInvoiceItemInput {
  line_no: number;
  /** quantity * rate, rounded to 2dp */
  amount: number;
}

/** One row of the GST summary table, grouped by slab. */
export interface GstSlabBreakup {
  gst_rate: number;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_tax: number;
}

export interface TaxInvoiceTotals {
  items: TaxInvoiceItemComputed[];
  gst_mode: GstMode;
  subtotal: number;
  discount: number;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_tax: number;
  round_off: number;
  total_amount: number;
  breakup: GstSlabBreakup[];
}

/** Round to 2 decimals, guarding against binary-float noise (1.005 -> 1.01). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * CGST+SGST when the customer is in the supplier's own state, IGST otherwise.
 * A party with no state code is treated as inter-state (IGST), which is the
 * safe default — it never silently under-charges tax.
 */
export function resolveGstMode(partyStateCode?: string | null): GstMode {
  const code = (partyStateCode || '').trim();
  if (code && code === SUPPLIER_STATE_CODE) return 'cgst_sgst';
  return 'igst';
}

export class TaxInvoiceValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'TaxInvoiceValidationError';
  }
}

const MAX_MONEY = 99_999_999.99; // fits NUMERIC(14,2) with room to spare

/**
 * Validates raw line items coming off the wire and coerces them to numbers.
 * Throws TaxInvoiceValidationError (HTTP 400) on anything unusable, so a bad
 * payload fails loudly at the edge instead of writing NaN into the database.
 */
export function normaliseItems(raw: any): TaxInvoiceItemInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TaxInvoiceValidationError('At least one line item is required.');
  }
  if (raw.length > 200) {
    throw new TaxInvoiceValidationError('An invoice cannot have more than 200 line items.');
  }

  return raw.map((it: any, i: number) => {
    const where = `Line ${i + 1}`;

    const description = String(it?.description ?? '').trim();
    if (!description) throw new TaxInvoiceValidationError(`${where}: description is required.`);
    if (description.length > 500) throw new TaxInvoiceValidationError(`${where}: description is too long (max 500).`);

    const quantity = Number(it?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new TaxInvoiceValidationError(`${where}: quantity must be a number greater than 0.`);
    }

    const rate = Number(it?.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new TaxInvoiceValidationError(`${where}: rate must be 0 or more.`);
    }

    const gst_rate = Number(it?.gst_rate);
    if (!Number.isFinite(gst_rate) || gst_rate < 0 || gst_rate > 100) {
      throw new TaxInvoiceValidationError(`${where}: GST % must be between 0 and 100.`);
    }

    if (round2(quantity * rate) > MAX_MONEY) {
      throw new TaxInvoiceValidationError(`${where}: line amount is too large.`);
    }

    return {
      description,
      hsn_sac: it?.hsn_sac ? String(it.hsn_sac).trim().slice(0, 20) : null,
      quantity,
      unit: it?.unit ? String(it.unit).trim().slice(0, 20) : null,
      rate,
      gst_rate,
    };
  });
}

/**
 * The single source of truth for invoice arithmetic.
 *
 * An invoice-level discount is apportioned across the GST slabs in proportion
 * to each slab's share of the subtotal — required for correctness, because tax
 * must be charged on the post-discount value of each slab, not on the gross.
 * The final slab absorbs any allocation remainder so the apportioned parts sum
 * back to the discount exactly (no stray paisa).
 *
 * The grand total is rounded to the nearest rupee, with the difference exposed
 * as `round_off` so the printed invoice always balances.
 */
export function computeTaxInvoice(
  rawItems: any,
  discountInput: any,
  gstMode: GstMode
): TaxInvoiceTotals {
  const inputs = normaliseItems(rawItems);

  const items: TaxInvoiceItemComputed[] = inputs.map((it, i) => ({
    ...it,
    line_no: i + 1,
    amount: round2(it.quantity * it.rate),
  }));

  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));

  const discount = round2(Number(discountInput) || 0);
  if (discount < 0) throw new TaxInvoiceValidationError('Discount cannot be negative.');
  if (discount > subtotal) throw new TaxInvoiceValidationError('Discount cannot exceed the invoice subtotal.');

  const taxable_amount = round2(subtotal - discount);

  // Group lines by GST slab, preserving first-seen order for a stable summary.
  const slabOrder: number[] = [];
  const grossBySlab = new Map<number, number>();
  for (const it of items) {
    if (!grossBySlab.has(it.gst_rate)) {
      grossBySlab.set(it.gst_rate, 0);
      slabOrder.push(it.gst_rate);
    }
    grossBySlab.set(it.gst_rate, round2(grossBySlab.get(it.gst_rate)! + it.amount));
  }

  // Apportion the discount across slabs, last slab taking the remainder.
  const breakup: GstSlabBreakup[] = [];
  let allocated = 0;
  slabOrder.forEach((slab, idx) => {
    const gross = grossBySlab.get(slab)!;
    const isLast = idx === slabOrder.length - 1;

    const slabDiscount = isLast
      ? round2(discount - allocated)
      : subtotal > 0
        ? round2((gross / subtotal) * discount)
        : 0;
    allocated = round2(allocated + slabDiscount);

    const slabTaxable = round2(gross - slabDiscount);
    const slabTax = round2((slabTaxable * slab) / 100);

    // Half to CGST, half to SGST. The halves are rounded independently and the
    // SGST side takes the remainder so cgst + sgst === slabTax exactly.
    const cgst = gstMode === 'cgst_sgst' ? round2(slabTax / 2) : 0;
    const sgst = gstMode === 'cgst_sgst' ? round2(slabTax - cgst) : 0;
    const igst = gstMode === 'igst' ? slabTax : 0;

    breakup.push({
      gst_rate: slab,
      taxable_amount: slabTaxable,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: igst,
      total_tax: slabTax,
    });
  });

  const cgst_amount = round2(breakup.reduce((s, b) => s + b.cgst_amount, 0));
  const sgst_amount = round2(breakup.reduce((s, b) => s + b.sgst_amount, 0));
  const igst_amount = round2(breakup.reduce((s, b) => s + b.igst_amount, 0));
  const total_tax = round2(cgst_amount + sgst_amount + igst_amount);

  const beforeRound = round2(taxable_amount + total_tax);
  const total_amount = Math.round(beforeRound);          // nearest rupee
  const round_off = round2(total_amount - beforeRound);

  if (total_amount > MAX_MONEY) {
    throw new TaxInvoiceValidationError('Invoice total is too large.');
  }

  return {
    items,
    gst_mode: gstMode,
    subtotal,
    discount,
    taxable_amount,
    cgst_amount,
    sgst_amount,
    igst_amount,
    total_tax,
    round_off,
    total_amount,
    breakup,
  };
}

/** Indian financial year label for a date, e.g. 2026-09-29 -> "2026-27". */
export function financialYear(d: Date): string {
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1; // FY starts in April (month 3)
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Formats a sequence value into the module's invoice number, e.g. "EMS/2026-27/00042". */
export function formatInvoiceNo(seq: number, when: Date = new Date()): string {
  return `${String(seq).padStart(3, '0')}`;
}

/**
 * The running-counter part of an invoice number issued in financial year `fy`,
 * e.g. ("EMS/2026-27/00042", "2026-27") -> 42. Null for any other shape —
 * a hand-typed number like "INV-7" or one from a different year never moves
 * the counter.
 */
export function invoiceSeqNumber(invoiceNo: string, fy: string): number | null {
  const m = (String(invoiceNo ?? '').trim().toUpperCase());
  if (!m || m[1] !== fy) return null;
  return Number(m[2]);
}

// ─── Party billing rate ──────────────────────────────────────────────────────

/** What a party's rate is charged per. */
export const RATE_BASES = ['hawb', 'mawb', 'hbl'] as const;
export type RateBasis = typeof RATE_BASES[number];

export function isRateBasis(v: any): v is RateBasis {
  return (RATE_BASES as readonly string[]).includes(v);
}

// ─── Download file name ──────────────────────────────────────────────────────

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** First word of a party name, e.g. "M/s. Navi Mumbai Logistics" -> "NAVI". */
export function partyFirstName(name?: string | null): string {
  const cleaned = String(name ?? '').toUpperCase().replace(/^\s*M\s*\/\s*S\b\.?\s*/, '');
  const first = cleaned.trim().split(/\s+/)[0] || '';
  return first.replace(/[^A-Z0-9]/g, '') || 'PARTY';
}

/**
 * Download file name (without extension), all capitals:
 *   <INVOICE NO>_<PARTY FIRST NAME>_<MON>_BILL_<YYYY>
 *   e.g. EMS-2026-27-00042_NAVI_SEP_BILL_2026
 *
 * Month and year come from the invoice date. '/' and '_' inside the invoice
 * number become '-', so '_' only ever separates the parts.
 */
export function invoiceFileBaseName(invoiceNo: string, partyName: string | null | undefined, invoiceDate: string): string {
  const no = String(invoiceNo ?? '').toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'INVOICE';
  const d = /^(\d{4})-(\d{2})-\d{2}/.exec(String(invoiceDate ?? ''));
  const month = d ? MONTHS[Number(d[2]) - 1] ?? '' : '';
  const year = d ? d[1] : '';
  return [no, partyFirstName(partyName), month, 'BILL', year].filter(Boolean).join('_');
}

/** Validates an operator-supplied invoice number override. */
export function normaliseInvoiceNo(raw: any): string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) throw new TaxInvoiceValidationError('Invoice number is required.');
  if (s.length > 40) throw new TaxInvoiceValidationError('Invoice number is too long (max 40).');
  if (!/^[A-Z0-9/_-]+$/.test(s)) {
    throw new TaxInvoiceValidationError('Invoice number may only contain letters, digits, slash, hyphen and underscore.');
  }
  return s;
}

/** Builds the frozen party snapshot stored on the invoice. */
export function buildPartySnapshot(party: any) {
  return {
    name: party?.name ?? '',
    gstin: party?.gstin ?? '',
    address1: party?.address1 ?? '',
    address2: party?.address2 ?? '',
    city: party?.city ?? '',
    state: party?.state ?? '',
    state_code: party?.state_code ?? '',
    pincode: party?.pincode ?? '',
    email: party?.email ?? '',
    phone: party?.phone ?? '',
  };
}
