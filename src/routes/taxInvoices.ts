/**
 * Standalone Tax Invoice module — manual-entry GST invoices.
 *
 * Deliberately independent of the auto-generated `invoices` flow in
 * routes/reports.ts (different database, tables and number sequence).
 * Nothing in this file reads or writes MAWB/HAWB/profile data.
 *
 * Every route here is admin-only; the gate is applied once at the router
 * level below so a new endpoint can't accidentally be added unprotected.
 */

import { Router, Response } from 'express';
import type { PoolClient } from 'pg';
import pool from '../db';
import { authenticate, requireRole, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import {
  computeTaxInvoice,
  resolveGstMode,
  normaliseInvoiceNo,
  formatInvoiceNo,
  financialYear,
  invoiceSeqNumber,
  invoiceFileBaseName,
  isRateBasis,
  buildPartySnapshot,
  round2,
  TaxInvoiceValidationError,
} from '../utils/taxInvoiceCalc';
import { renderInvoicePdf, PdfInvoice } from '../utils/taxInvoicePdf';
import { renderInvoiceExcel } from '../utils/taxInvoiceExcel';

const router = Router();

// Auth first, then the admin gate — applies to EVERY route in this file.
router.use(authenticate);
router.use(requireRole(['master_admin', 'admin']));

/** Payments are the source of truth for "how much is received". */
const PAID_JOIN = `
  LEFT JOIN (
    SELECT invoice_id, SUM(amount) AS paid
    FROM tax_invoice_payments
    GROUP BY invoice_id
  ) p ON p.invoice_id = i.id
`;

/** NUMERIC is exact in Postgres, so these comparisons need no epsilon. */
const STATUS_EXPR = `
  CASE
    WHEN i.is_cancelled THEN 'cancelled'
    WHEN COALESCE(p.paid, 0) <= 0 THEN 'pending'
    WHEN COALESCE(p.paid, 0) < i.total_amount THEN 'partial'
    ELSE 'paid'
  END
`;

/** Pending is zero for cancelled invoices — they must not inflate outstanding. */
const PENDING_EXPR = `
  CASE WHEN i.is_cancelled THEN 0
       ELSE GREATEST(i.total_amount - COALESCE(p.paid, 0), 0)
  END
`;

function fail(res: Response, err: any, where: string): void {
  if (err instanceof TaxInvoiceValidationError) {
    res.status(400).json({ message: err.message });
    return;
  }
  if (err?.code === '23505') {
    res.status(409).json({ message: 'That invoice number is already in use. Pick a different one.' });
    return;
  }
  // invalid_text_representation — a malformed UUID in the URL. Treat as "not
  // found" rather than letting Postgres' parse error surface as a 500.
  if (err?.code === '22P02') {
    res.status(404).json({ message: 'Not found' });
    return;
  }
  if (err?.status && err?.message) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  logger.error('TAX_INVOICE', `${where} failed`, err);
  res.status(500).json({ message: 'Server error' });
}

/** Postgres NUMERIC arrives as a string via pg — coerce for JSON consumers. */
function numify<T extends Record<string, any>>(row: T, keys: string[]): T {
  const out: any = { ...row };
  for (const k of keys) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  return out;
}

/**
 * A Postgres DATE is parsed by pg into a JS Date at LOCAL midnight, which then
 * serialises to JSON as a UTC timestamp — e.g. 2026-09-29 in IST becomes
 * "2026-09-28T18:30:00.000Z". Any consumer that slices the first 10 characters
 * gets the wrong calendar day.
 *
 * Every date is therefore selected separately as text (`<field>_str`) and
 * swapped over the raw column here, so the API only ever emits plain
 * "YYYY-MM-DD" and no timezone can shift it.
 */
function fixDates<T extends Record<string, any>>(row: T, fields: string[]): T {
  const out: any = { ...row };
  for (const f of fields) {
    const src = `${f}_str`;
    if (out[src] !== undefined) { out[f] = out[src]; delete out[src]; }
  }
  return out;
}

const INVOICE_NUM_FIELDS = [
  'subtotal', 'discount', 'taxable_amount', 'cgst_amount', 'sgst_amount',
  'igst_amount', 'round_off', 'total_amount', 'amount_paid', 'pending_amount',
];
const ITEM_NUM_FIELDS = ['quantity', 'rate', 'gst_rate', 'amount', 'line_no'];
const PARTY_NUM_FIELDS = ['rate'];

function clampPage(q: any): { limit: number; offset: number; page: number; pageSize: number } {
  const page = Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(String(q.pageSize ?? '25'), 10) || 25));
  return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
}

// ═══════════════════════════════════════════════════════════════════════════
// Party master
// ═══════════════════════════════════════════════════════════════════════════

router.get('/parties', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const search = String(req.query.search ?? '').trim();
    const includeInactive = String(req.query.include_inactive ?? '') === 'true';

    const where: string[] = [];
    const params: any[] = [];
    if (!includeInactive) where.push('is_active = TRUE');
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(name) LIKE $${params.length} OR LOWER(COALESCE(gstin,'')) LIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const r = await pool.query(`SELECT * FROM tax_invoice_parties ${whereSql} ORDER BY name ASC LIMIT 500`, params);
    res.json(r.rows.map(row => numify(row, PARTY_NUM_FIELDS)));
  } catch (err) {
    fail(res, err, 'GET /parties');
  }
});

function readPartyBody(body: any) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new TaxInvoiceValidationError('Party name is required.');
  if (name.length > 200) throw new TaxInvoiceValidationError('Party name is too long (max 200).');

  const gstin = String(body?.gstin ?? '').trim().toUpperCase();
  if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) {
    throw new TaxInvoiceValidationError('GSTIN must be 15 characters — 2 digits followed by 13 letters/digits.');
  }

  // State code is the authority for CGST/SGST vs IGST; derive it from the
  // GSTIN when present so the two can never disagree.
  const state_code = gstin ? gstin.slice(0, 2) : String(body?.state_code ?? '').trim().slice(0, 2);

  // Billing rate is optional, but a basis and a rate only make sense together.
  const basisRaw = String(body?.rate_basis ?? '').trim().toLowerCase();
  if (basisRaw && !isRateBasis(basisRaw)) {
    throw new TaxInvoiceValidationError('Rate basis must be As per HAWB, As per MAWB or As per HBL.');
  }
  const rateRaw = body?.rate;
  const hasRate = rateRaw !== null && rateRaw !== undefined && String(rateRaw).trim() !== '';
  const rate = hasRate ? Number(rateRaw) : null;
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 99_999_999.99)) {
    throw new TaxInvoiceValidationError('Rate must be a number, 0 or more.');
  }
  if (basisRaw && rate === null) throw new TaxInvoiceValidationError('Enter the rate for the selected basis.');
  if (!basisRaw && rate !== null) throw new TaxInvoiceValidationError('Pick a rate basis (As per HAWB / MAWB / HBL) for this rate.');

  return {
    name,
    gstin: gstin || null,
    address1: String(body?.address1 ?? '').trim().slice(0, 200) || null,
    address2: String(body?.address2 ?? '').trim().slice(0, 200) || null,
    city: String(body?.city ?? '').trim().slice(0, 100) || null,
    state: String(body?.state ?? '').trim().slice(0, 100) || null,
    state_code: state_code || null,
    pincode: String(body?.pincode ?? '').trim().slice(0, 10) || null,
    email: String(body?.email ?? '').trim().slice(0, 150) || null,
    phone: String(body?.phone ?? '').trim().slice(0, 30) || null,
    rate_basis: basisRaw || null,
    rate: rate === null ? null : round2(rate),
  };
}

router.post('/parties', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const p = readPartyBody(req.body);
    const r = await pool.query(
      `INSERT INTO tax_invoice_parties
         (name, gstin, address1, address2, city, state, state_code, pincode, email, phone,
          rate_basis, rate, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [p.name, p.gstin, p.address1, p.address2, p.city, p.state, p.state_code, p.pincode, p.email, p.phone,
       p.rate_basis, p.rate, req.user?.id]
    );
    res.status(201).json(numify(r.rows[0], PARTY_NUM_FIELDS));
  } catch (err) {
    fail(res, err, 'POST /parties');
  }
});

router.put('/parties/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const p = readPartyBody(req.body);
    const r = await pool.query(
      `UPDATE tax_invoice_parties SET
         name=$1, gstin=$2, address1=$3, address2=$4, city=$5, state=$6,
         state_code=$7, pincode=$8, email=$9, phone=$10, rate_basis=$11, rate=$12, updated_at=NOW()
       WHERE id=$13 RETURNING *`,
      [p.name, p.gstin, p.address1, p.address2, p.city, p.state, p.state_code, p.pincode, p.email, p.phone,
       p.rate_basis, p.rate, req.params.id]
    );
    if (!r.rows[0]) { res.status(404).json({ message: 'Party not found' }); return; }
    res.json(numify(r.rows[0], PARTY_NUM_FIELDS));
  } catch (err) {
    fail(res, err, 'PUT /parties/:id');
  }
});

// Soft delete — invoices keep their frozen party_snapshot regardless.
router.delete('/parties/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `UPDATE tax_invoice_parties SET is_active=FALSE, updated_at=NOW() WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!r.rows[0]) { res.status(404).json({ message: 'Party not found' }); return; }
    res.json({ message: 'Party deactivated' });
  } catch (err) {
    fail(res, err, 'DELETE /parties/:id');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Numbering + preview
// ═══════════════════════════════════════════════════════════════════════════

/** Peeks at the counter WITHOUT consuming a value (preview must not burn numbers). */
async function peekCounter(): Promise<number> {
  const r = await pool.query(`SELECT last_value, is_called FROM tax_invoice_no_seq`);
  const { last_value, is_called } = r.rows[0];
  return is_called ? Number(last_value) + 1 : Number(last_value);
}

/** Highest counter value already printed on an invoice in financial year `fy` (0 if none). */
async function highestUsedNumber(fy: string): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_no FROM '^EMS/[0-9]{4}-[0-9]{2}/([0-9]{1,12})$') AS BIGINT)), 0) AS n
     FROM tax_invoices WHERE invoice_no LIKE $1`,
    [`EMS/${fy}/%`]
  );
  return Number(r.rows[0].n);
}

/**
 * The number the next invoice should get: the counter, but never one already
 * printed on an invoice this financial year. Invoices saved before the counter
 * learned to advance on save never moved it, so without this such a database
 * would keep suggesting a number that is already taken.
 */
async function nextFreeNumber(fromCounter?: number): Promise<number> {
  const counter = fromCounter ?? await peekCounter();
  return Math.max(counter, (await highestUsedNumber(financialYear(new Date()))) + 1);
}

async function suggestInvoiceNo(): Promise<string> {
  return formatInvoiceNo(await nextFreeNumber());
}

async function numberingState() {
  const fy = financialYear(new Date());
  const next = await nextFreeNumber();
  return {
    financial_year: fy,
    next_number: next,
    next_invoice_no: formatInvoiceNo(next),
    highest_used: await highestUsedNumber(fy),
  };
}

/**
 * Moves the counter past an invoice number that has just been saved, so the
 * next suggestion is always +1. The form always sends the number it showed,
 * so without this the counter would never move and every new invoice would be
 * offered the same, already-taken number. Never moves the counter backwards —
 * saving a lower hand-typed number leaves it where it is.
 */
async function advanceCounterPast(client: PoolClient, invoiceNo: string): Promise<void> {
  const n = invoiceSeqNumber(invoiceNo, financialYear(new Date()));
  if (n === null || n < 1) return;
  await client.query(
    `SELECT setval('tax_invoice_no_seq',
       GREATEST($1::bigint, (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM tax_invoice_no_seq)),
       true)`,
    [n]
  );
}

router.get('/next-number', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ invoice_no: await suggestInvoiceNo() });
  } catch (err) {
    fail(res, err, 'GET /next-number');
  }
});

/** Where the invoice counter stands — shown next to the Invoice No. field. */
router.get('/numbering', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json(await numberingState());
  } catch (err) {
    fail(res, err, 'GET /numbering');
  }
});

/**
 * Sets the number the next invoice will get; each invoice after it is +1.
 * Used when invoices were already issued elsewhere, so numbering carries on
 * from there instead of starting at 1. Refuses a number already printed on an
 * invoice this financial year, which would otherwise produce duplicates.
 */
router.put('/numbering', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const raw = String(req.body?.next_number ?? '').trim();
    if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) {
      throw new TaxInvoiceValidationError('Next invoice number must be a whole number, 1 or more.');
    }
    const next = Number(raw);

    const fy = financialYear(new Date());
    const highest = await highestUsedNumber(fy);
    if (next <= highest) {
      throw new TaxInvoiceValidationError(
        `${formatInvoiceNo(highest)} has already been issued. The next number must be ${highest + 1} or higher.`
      );
    }

    await pool.query(`SELECT setval('tax_invoice_no_seq', $1::bigint, false)`, [next]);
    logger.info('TAX_INVOICE', `Invoice counter set to ${next} by ${req.user?.username ?? req.user?.id}`);
    res.json(await numberingState());
  } catch (err) {
    fail(res, err, 'PUT /numbering');
  }
});

/**
 * Computes totals for the form as typed, without touching the database.
 * The UI could do this arithmetic itself, but routing it through the same
 * server module guarantees the preview matches what actually gets saved.
 */
router.post('/preview', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { items, discount, party_id, party } = req.body ?? {};

    let partyData: any = party ?? null;
    if (party_id) {
      const pr = await pool.query(`SELECT * FROM tax_invoice_parties WHERE id=$1`, [party_id]);
      if (!pr.rows[0]) { res.status(404).json({ message: 'Party not found' }); return; }
      partyData = pr.rows[0];
    }

    const gstMode = resolveGstMode(partyData?.state_code);
    const totals = computeTaxInvoice(items, discount, gstMode);

    res.json({
      ...totals,
      party_snapshot: buildPartySnapshot(partyData || {}),
      suggested_invoice_no: await suggestInvoiceNo(),
    });
  } catch (err) {
    fail(res, err, 'POST /preview');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Invoices
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { limit, offset, page, pageSize } = clampPage(req.query);
    const { search, party_id, created_by, status, from_date, to_date } = req.query as Record<string, string>;

    const where: string[] = [];
    const params: any[] = [];

    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      where.push(`(LOWER(i.invoice_no) LIKE $${params.length} OR LOWER(i.party_snapshot->>'name') LIKE $${params.length})`);
    }
    if (party_id)   { params.push(party_id);   where.push(`i.party_id = $${params.length}`); }
    if (created_by) { params.push(created_by); where.push(`i.created_by = $${params.length}`); }
    if (from_date)  { params.push(from_date);  where.push(`i.invoice_date >= $${params.length}`); }
    if (to_date)    { params.push(to_date);    where.push(`i.invoice_date <= $${params.length}`); }
    if (status && ['pending', 'partial', 'paid', 'cancelled'].includes(status)) {
      params.push(status);
      where.push(`${STATUS_EXPR} = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM tax_invoices i ${PAID_JOIN} ${whereSql}`,
      params
    );

    params.push(limit, offset);
    const rows = await pool.query(
      `SELECT i.*, u.username AS created_by_username,
              TO_CHAR(i.invoice_date, 'YYYY-MM-DD') AS invoice_date_str,
              COALESCE(p.paid, 0) AS amount_paid,
              ${PENDING_EXPR} AS pending_amount,
              ${STATUS_EXPR} AS status
       FROM tax_invoices i
       ${PAID_JOIN}
       LEFT JOIN users u ON u.id = i.created_by
       ${whereSql}
       ORDER BY i.invoice_date DESC, i.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: rows.rows.map(r => fixDates(numify(r, INVOICE_NUM_FIELDS), ['invoice_date'])),
      total: countRes.rows[0].total,
      page,
      pageSize,
    });
  } catch (err) {
    fail(res, err, 'GET /');
  }
});

/** Loads a full invoice (header + items + payments) or null. */
async function loadInvoice(id: string): Promise<any | null> {
  const head = await pool.query(
    `SELECT i.*, u.username AS created_by_username,
            TO_CHAR(i.invoice_date, 'YYYY-MM-DD') AS invoice_date_str,
            COALESCE(p.paid, 0) AS amount_paid,
            ${PENDING_EXPR} AS pending_amount,
            ${STATUS_EXPR} AS status
     FROM tax_invoices i
     ${PAID_JOIN}
     LEFT JOIN users u ON u.id = i.created_by
     WHERE i.id = $1`,
    [id]
  );
  if (!head.rows[0]) return null;

  const items = await pool.query(
    `SELECT * FROM tax_invoice_items WHERE invoice_id=$1 ORDER BY line_no ASC`, [id]
  );
  const payments = await pool.query(
    `SELECT pay.*, u.username AS created_by_username,
            TO_CHAR(pay.paid_on, 'YYYY-MM-DD') AS paid_on_str
     FROM tax_invoice_payments pay
     LEFT JOIN users u ON u.id = pay.created_by
     WHERE pay.invoice_id=$1 ORDER BY pay.paid_on DESC, pay.created_at DESC`,
    [id]
  );

  return {
    ...fixDates(numify(head.rows[0], INVOICE_NUM_FIELDS), ['invoice_date']),
    items: items.rows.map(r => numify(r, ITEM_NUM_FIELDS)),
    payments: payments.rows.map(r => fixDates(numify(r, ['amount']), ['paid_on'])),
  };
}

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const inv = await loadInvoice(req.params.id);
    if (!inv) { res.status(404).json({ message: 'Invoice not found' }); return; }
    res.json(inv);
  } catch (err) {
    fail(res, err, 'GET /:id');
  }
});

/** Shared validation + arithmetic for create and update. */
async function prepareInvoice(body: any) {
  const { party_id, items, discount, invoice_date, place_of_supply, notes } = body ?? {};

  if (!party_id) throw new TaxInvoiceValidationError('A party must be selected.');
  const pr = await pool.query(`SELECT * FROM tax_invoice_parties WHERE id=$1`, [party_id]);
  const party = pr.rows[0];
  if (!party) throw new TaxInvoiceValidationError('Selected party no longer exists.');

  const dateStr = String(invoice_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(new Date(dateStr).getTime())) {
    throw new TaxInvoiceValidationError('Invoice date must be a valid date (YYYY-MM-DD).');
  }

  const gstMode = resolveGstMode(party.state_code);
  const totals = computeTaxInvoice(items, discount, gstMode);

  return {
    party,
    totals,
    invoice_date: dateStr,
    place_of_supply: String(place_of_supply ?? party.state ?? '').trim().slice(0, 100) || null,
    notes: notes ? String(notes).slice(0, 2000) : null,
  };
}

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    const prepared = await prepareInvoice(req.body);

    // Use the operator's number if given (the form always sends the one it
    // suggested), else consume the next free counter value.
    const invoiceNo = req.body?.invoice_no
      ? normaliseInvoiceNo(req.body.invoice_no)
      : formatInvoiceNo(await nextFreeNumber(
          Number((await client.query(`SELECT nextval('tax_invoice_no_seq') AS n`)).rows[0].n)
        ));

    await client.query('BEGIN');

    const t = prepared.totals;
    const head = await client.query(
      `INSERT INTO tax_invoices
         (invoice_no, invoice_date, party_id, party_snapshot, place_of_supply, gst_mode,
          subtotal, discount, taxable_amount, cgst_amount, sgst_amount, igst_amount,
          round_off, total_amount, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        invoiceNo, prepared.invoice_date, prepared.party.id,
        JSON.stringify(buildPartySnapshot(prepared.party)),
        prepared.place_of_supply, t.gst_mode,
        t.subtotal, t.discount, t.taxable_amount, t.cgst_amount, t.sgst_amount,
        t.igst_amount, t.round_off, t.total_amount, prepared.notes, req.user?.id,
      ]
    );
    const invoiceId = head.rows[0].id;

    for (const it of t.items) {
      await client.query(
        `INSERT INTO tax_invoice_items
           (invoice_id, line_no, description, hsn_sac, quantity, unit, rate, gst_rate, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [invoiceId, it.line_no, it.description, it.hsn_sac, it.quantity, it.unit, it.rate, it.gst_rate, it.amount]
      );
    }

    await advanceCounterPast(client, invoiceNo);

    await client.query('COMMIT');
    res.status(201).json(await loadInvoice(invoiceId));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err, 'POST /');
  } finally {
    client.release();
  }
});

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT i.id, i.is_cancelled, COALESCE(SUM(pay.amount), 0) AS paid
       FROM tax_invoices i
       LEFT JOIN tax_invoice_payments pay ON pay.invoice_id = i.id
       WHERE i.id = $1
       GROUP BY i.id, i.is_cancelled`,
      [req.params.id]
    );
    if (!existing.rows[0]) { res.status(404).json({ message: 'Invoice not found' }); return; }
    if (existing.rows[0].is_cancelled) {
      res.status(400).json({ message: 'A cancelled invoice cannot be edited.' });
      return;
    }

    const prepared = await prepareInvoice(req.body);
    const t = prepared.totals;

    // Editing an invoice below what has already been collected would leave a
    // negative balance — block it rather than silently produce bad figures.
    const paid = Number(existing.rows[0].paid);
    if (paid > t.total_amount) {
      res.status(400).json({
        message: `Payments of Rs. ${paid.toFixed(2)} are already recorded against this invoice. ` +
                 `The new total (Rs. ${t.total_amount.toFixed(2)}) cannot be lower than that.`,
      });
      return;
    }

    const invoiceNo = normaliseInvoiceNo(req.body?.invoice_no);

    await client.query('BEGIN');

    await client.query(
      `UPDATE tax_invoices SET
         invoice_no=$1, invoice_date=$2, party_id=$3, party_snapshot=$4, place_of_supply=$5,
         gst_mode=$6, subtotal=$7, discount=$8, taxable_amount=$9, cgst_amount=$10,
         sgst_amount=$11, igst_amount=$12, round_off=$13, total_amount=$14, notes=$15,
         updated_at=NOW()
       WHERE id=$16`,
      [
        invoiceNo, prepared.invoice_date, prepared.party.id,
        JSON.stringify(buildPartySnapshot(prepared.party)),
        prepared.place_of_supply, t.gst_mode,
        t.subtotal, t.discount, t.taxable_amount, t.cgst_amount, t.sgst_amount,
        t.igst_amount, t.round_off, t.total_amount, prepared.notes, req.params.id,
      ]
    );

    // Line numbers are re-issued from 1, so replace the set wholesale.
    await client.query(`DELETE FROM tax_invoice_items WHERE invoice_id=$1`, [req.params.id]);
    for (const it of t.items) {
      await client.query(
        `INSERT INTO tax_invoice_items
           (invoice_id, line_no, description, hsn_sac, quantity, unit, rate, gst_rate, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.params.id, it.line_no, it.description, it.hsn_sac, it.quantity, it.unit, it.rate, it.gst_rate, it.amount]
      );
    }

    await advanceCounterPast(client, invoiceNo);

    await client.query('COMMIT');
    res.json(await loadInvoice(req.params.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err, 'PUT /:id');
  } finally {
    client.release();
  }
});

router.post('/:id/cancel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `UPDATE tax_invoices
       SET is_cancelled=TRUE, cancelled_at=NOW(), cancelled_by=$1, updated_at=NOW()
       WHERE id=$2 AND is_cancelled=FALSE
       RETURNING id`,
      [req.user?.id, req.params.id]
    );
    if (!r.rows[0]) { res.status(404).json({ message: 'Invoice not found, or already cancelled' }); return; }
    res.json(await loadInvoice(req.params.id));
  } catch (err) {
    fail(res, err, 'POST /:id/cancel');
  }
});

// Hard delete is master_admin only, and refuses once money is recorded.
router.delete('/:id', requireRole(['master_admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const pay = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tax_invoice_payments WHERE invoice_id=$1`, [req.params.id]
    );
    if (pay.rows[0].n > 0) {
      res.status(400).json({ message: 'This invoice has recorded payments. Cancel it instead of deleting.' });
      return;
    }
    const r = await pool.query(`DELETE FROM tax_invoices WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) { res.status(404).json({ message: 'Invoice not found' }); return; }
    res.json({ message: 'Invoice deleted' });
  } catch (err) {
    fail(res, err, 'DELETE /:id');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Payments
// ═══════════════════════════════════════════════════════════════════════════

router.post('/:id/payments', async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the header so two concurrent receipts can't both pass the
    // over-payment check and jointly exceed the invoice total.
    const inv = await client.query(
      `SELECT id, total_amount, is_cancelled FROM tax_invoices WHERE id=$1 FOR UPDATE`,
      [req.params.id]
    );
    if (!inv.rows[0]) {
      await client.query('ROLLBACK');
      res.status(404).json({ message: 'Invoice not found' });
      return;
    }
    if (inv.rows[0].is_cancelled) {
      await client.query('ROLLBACK');
      res.status(400).json({ message: 'Cannot record a payment against a cancelled invoice.' });
      return;
    }

    const amount = round2(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ message: 'Payment amount must be greater than 0.' });
      return;
    }

    const paidRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid FROM tax_invoice_payments WHERE invoice_id=$1`,
      [req.params.id]
    );
    const alreadyPaid = Number(paidRes.rows[0].paid);
    const total = Number(inv.rows[0].total_amount);
    const outstanding = round2(total - alreadyPaid);

    if (amount > outstanding) {
      await client.query('ROLLBACK');
      res.status(400).json({
        message: `Amount exceeds the outstanding balance of Rs. ${outstanding.toFixed(2)}.`,
      });
      return;
    }

    const paidOn = String(req.body?.paid_on ?? '').trim();
    const paidOnValue = /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? paidOn : new Date().toISOString().slice(0, 10);

    await client.query(
      `INSERT INTO tax_invoice_payments (invoice_id, amount, paid_on, method, reference, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.params.id, amount, paidOnValue,
        req.body?.method ? String(req.body.method).slice(0, 30) : null,
        req.body?.reference ? String(req.body.reference).slice(0, 100) : null,
        req.body?.notes ? String(req.body.notes).slice(0, 2000) : null,
        req.user?.id,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json(await loadInvoice(req.params.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err, 'POST /:id/payments');
  } finally {
    client.release();
  }
});

router.delete('/:id/payments/:paymentId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `DELETE FROM tax_invoice_payments WHERE id=$1 AND invoice_id=$2 RETURNING id`,
      [req.params.paymentId, req.params.id]
    );
    if (!r.rows[0]) { res.status(404).json({ message: 'Payment not found' }); return; }
    res.json(await loadInvoice(req.params.id));
  } catch (err) {
    fail(res, err, 'DELETE /:id/payments/:paymentId');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Downloads
// ═══════════════════════════════════════════════════════════════════════════

/** e.g. EMS-2026-27-00042_NAVI_SEP_BILL_2026 — see invoiceFileBaseName. */
const downloadName = (inv: PdfInvoice) =>
  invoiceFileBaseName(inv.invoice_no, inv.party_snapshot?.name, inv.invoice_date);

/** Rebuilds the GST slab summary from stored rows so PDF/Excel match the saved invoice. */
function breakupFromItems(inv: any) {
  const isIntra = inv.gst_mode === 'cgst_sgst';
  const bySlab = new Map<number, number>();
  for (const it of inv.items) {
    bySlab.set(it.gst_rate, round2((bySlab.get(it.gst_rate) || 0) + it.amount));
  }

  // Re-apportion the stored discount exactly as computeTaxInvoice did.
  const slabs = Array.from(bySlab.keys());
  const subtotal = Number(inv.subtotal);
  const discount = Number(inv.discount);
  let allocated = 0;

  return slabs.map((slab, idx) => {
    const gross = bySlab.get(slab)!;
    const isLast = idx === slabs.length - 1;
    const slabDiscount = isLast
      ? round2(discount - allocated)
      : subtotal > 0 ? round2((gross / subtotal) * discount) : 0;
    allocated = round2(allocated + slabDiscount);

    const taxable = round2(gross - slabDiscount);
    const tax = round2((taxable * slab) / 100);
    const cgst = isIntra ? round2(tax / 2) : 0;
    const sgst = isIntra ? round2(tax - cgst) : 0;

    return {
      gst_rate: slab,
      taxable_amount: taxable,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: isIntra ? 0 : tax,
    };
  });
}

async function loadForRender(id: string): Promise<PdfInvoice | null> {
  const inv = await loadInvoice(id);
  if (!inv) return null;
  return { ...inv, breakup: breakupFromItems(inv) } as PdfInvoice;
}

router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const inv = await loadForRender(req.params.id);
    if (!inv) { res.status(404).json({ message: 'Invoice not found' }); return; }

    const buf = await renderInvoicePdf(inv);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName(inv)}.pdf"`);
    res.end(buf);
  } catch (err) {
    fail(res, err, 'GET /:id/pdf');
  }
});

router.get('/:id/excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const inv = await loadForRender(req.params.id);
    if (!inv) { res.status(404).json({ message: 'Invoice not found' }); return; }

    const buf = await renderInvoiceExcel(inv);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName(inv)}.xlsx"`);
    res.end(buf);
  } catch (err) {
    fail(res, err, 'GET /:id/excel');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard — outstanding money
// ═══════════════════════════════════════════════════════════════════════════

function dashboardFilters(query: any): { whereSql: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];
  if (query.party_id)   { params.push(query.party_id);   where.push(`i.party_id = $${params.length}`); }
  if (query.created_by) { params.push(query.created_by); where.push(`i.created_by = $${params.length}`); }
  if (query.from_date)  { params.push(query.from_date);  where.push(`i.invoice_date >= $${params.length}`); }
  if (query.to_date)    { params.push(query.to_date);    where.push(`i.invoice_date <= $${params.length}`); }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/dashboard/summary', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { whereSql, params } = dashboardFilters(req.query);
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS invoice_count,
         COUNT(*) FILTER (WHERE i.is_cancelled)::int AS cancelled_count,
         COUNT(*) FILTER (WHERE NOT i.is_cancelled AND ${PENDING_EXPR} > 0)::int AS pending_count,
         COALESCE(SUM(i.total_amount) FILTER (WHERE NOT i.is_cancelled), 0) AS total_invoiced,
         COALESCE(SUM(COALESCE(p.paid, 0)) FILTER (WHERE NOT i.is_cancelled), 0) AS total_received,
         COALESCE(SUM(${PENDING_EXPR}), 0) AS total_pending
       FROM tax_invoices i ${PAID_JOIN} ${whereSql}`,
      params
    );
    res.json(numify(r.rows[0], ['total_invoiced', 'total_received', 'total_pending']));
  } catch (err) {
    fail(res, err, 'GET /dashboard/summary');
  }
});

/** Outstanding grouped by party — the "who owes what" view. */
router.get('/dashboard/by-party', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { whereSql, params } = dashboardFilters(req.query);
    const onlyPending = String(req.query.only_pending ?? 'true') !== 'false';
    const having = onlyPending ? `HAVING COALESCE(SUM(${PENDING_EXPR}), 0) > 0` : '';

    const r = await pool.query(
      `SELECT
         i.party_id,
         COALESCE(MAX(pt.name), MAX(i.party_snapshot->>'name')) AS party_name,
         MAX(i.party_snapshot->>'gstin') AS gstin,
         COUNT(*) FILTER (WHERE NOT i.is_cancelled)::int AS invoice_count,
         COUNT(*) FILTER (WHERE NOT i.is_cancelled AND ${PENDING_EXPR} > 0)::int AS pending_count,
         COALESCE(SUM(i.total_amount) FILTER (WHERE NOT i.is_cancelled), 0) AS total_invoiced,
         COALESCE(SUM(COALESCE(p.paid, 0)) FILTER (WHERE NOT i.is_cancelled), 0) AS total_received,
         COALESCE(SUM(${PENDING_EXPR}), 0) AS total_pending,
         TO_CHAR(
           MIN(i.invoice_date) FILTER (WHERE NOT i.is_cancelled AND ${PENDING_EXPR} > 0),
           'YYYY-MM-DD'
         ) AS oldest_pending_date
       FROM tax_invoices i
       ${PAID_JOIN}
       LEFT JOIN tax_invoice_parties pt ON pt.id = i.party_id
       ${whereSql}
       GROUP BY i.party_id
       ${having}
       ORDER BY total_pending DESC`,
      params
    );
    res.json(r.rows.map(row => numify(row, ['total_invoiced', 'total_received', 'total_pending'])));
  } catch (err) {
    fail(res, err, 'GET /dashboard/by-party');
  }
});

/** Users who have created at least one invoice — populates the user filter. */
router.get('/dashboard/creators', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT u.id, u.username, u.full_name
       FROM tax_invoices i JOIN users u ON u.id = i.created_by
       ORDER BY u.username`
    );
    res.json(r.rows);
  } catch (err) {
    fail(res, err, 'GET /dashboard/creators');
  }
});

export default router;
