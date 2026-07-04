import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, requireRole, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { INVOICE_SUPPLIER, INVOICE_BANK, INVOICE_SAC_CODE, numberToWordsINR } from '../utils/invoiceConstants';

const router = Router();
router.use(authenticate);

// ─── Checklist Report ─────────────────────────────────────────────────────────
// Returns paginated MAWBs with their HAWB counts and transmission status
router.get('/checklist', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { from_date, to_date, profile_id, status } = req.query;
    const page     = Math.max(1, parseInt(String(req.query.page     || '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'))));
    const offset   = (page - 1) * pageSize;
    const isAdmin  = req.user?.role === 'master_admin' || req.user?.role === 'admin';

    const base = `
      FROM mawbs m
      LEFT JOIN profiles p ON m.profile_id = p.id
      LEFT JOIN users u ON m.created_by = u.id
      WHERE 1=1`;
    const params: any[] = [];
    let filters = '';
    let idx = 1;
    if (from_date) { filters += ` AND m.created_at >= $${idx++}`; params.push(from_date); }
    if (to_date)   { filters += ` AND m.created_at <= $${idx++}`; params.push(to_date + ' 23:59:59'); }
    if (profile_id){ filters += ` AND m.profile_id = $${idx++}`; params.push(profile_id); }
    if (status)    { filters += ` AND m.status = $${idx++}`; params.push(status); }
    if (!isAdmin)  { filters += ` AND m.created_by = $${idx++}`; params.push(req.user?.id); }

    const countResult = await pool.query(`SELECT COUNT(*) ${base}${filters}`, params);
    const total = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT m.*,
         p.profile_code, p.company_name,
         (SELECT COUNT(*) FROM hawbs h WHERE h.mawb_id = m.id) as hawb_count,
         (SELECT COALESCE(SUM(h.total_packages), 0) FROM hawbs h WHERE h.mawb_id = m.id) as hawb_total_packages,
         (SELECT COALESCE(SUM(h.gross_weight), 0) FROM hawbs h WHERE h.mawb_id = m.id) as hawb_total_weight,
         u.username as created_by_name
       ${base}${filters}
       ORDER BY m.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, pageSize, offset]
    );
    res.json({ data: dataResult.rows, total, page, pageSize });
  } catch (err) {
    logger.error('REPORTS', 'GET /checklist error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Account Statement ────────────────────────────────────────────────────────
router.get('/account-statement', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isAdmin = req.user?.role === 'master_admin' || req.user?.role === 'admin';
    const { from_date, to_date, location_code, sort_field, sort_dir } = req.query;
    const exportAll = req.query.export === 'true';
    const page     = Math.max(1, parseInt(String(req.query.page || '1')));
    const pageSize = 100; // fixed at 100 per page

    // Admins can filter by user; non-admins always see only their own records
    const user_id = isAdmin ? (req.query.user_id as string || '') : req.user?.id;

    const dir = sort_dir === 'asc' ? 'ASC' : 'DESC';
    const orderBy = sort_field === 'transmission_date' ? `m.transmission_date ${dir}`
      : sort_field === 'location' ? `m.customs_house_code ${dir}`
      : sort_field === 'user' ? `u.username ${dir}`
      : `m.created_at ${dir}`;

    const base = `
      FROM mawbs m
      LEFT JOIN profiles p ON m.profile_id = p.id
      LEFT JOIN users u ON m.created_by = u.id
      WHERE 1=1`;

    const params: any[] = [];
    let filters = '';
    let idx = 1;
    if (from_date)     { filters += ` AND m.created_at >= $${idx++}`; params.push(from_date); }
    if (to_date)       { filters += ` AND m.created_at <= $${idx++}`; params.push(to_date + ' 23:59:59'); }
    if (user_id)       { filters += ` AND m.created_by = $${idx++}`; params.push(user_id); }
    if (location_code) { filters += ` AND m.customs_house_code = $${idx++}`; params.push(location_code); }

    const selectCols = `
      SELECT m.id, m.mawb_no, m.created_at, m.transmission_date,
             m.customs_house_code, m.status, m.message_type,
             p.pan_number, p.company_name, u.username,
             (SELECT COUNT(*) FROM hawbs h WHERE h.mawb_id = m.id) AS hawb_count`;

    if (exportAll) {
      // No pagination — return all matching rows for CSV export
      const result = await pool.query(`${selectCols} ${base}${filters} ORDER BY ${orderBy}`, params);
      res.json(result.rows);
      return;
    }

    // Count total
    const countResult = await pool.query(`SELECT COUNT(*) ${base}${filters}`, params);
    const total = parseInt(countResult.rows[0].count);

    const offset = (page - 1) * pageSize;
    const dataResult = await pool.query(
      `${selectCols} ${base}${filters} ORDER BY ${orderBy} LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, pageSize, offset]
    );

    res.json({ data: dataResult.rows, total, page, pageSize });
  } catch (err) {
    logger.error('REPORTS', 'GET /account-statement error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Statement by Consol User ─────────────────────────────────────────────────
router.get('/statement-by-consol', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isAdmin = req.user?.role === 'master_admin' || req.user?.role === 'admin';
    const { from_date, to_date, user_id } = req.query;

    const params: any[] = [];
    const conditions: string[] = ['1=1'];
    let idx = 1;

    if (from_date) { conditions.push(`m.created_at >= $${idx++}`); params.push(from_date); }
    if (to_date)   { conditions.push(`m.created_at <= $${idx++}`); params.push(to_date + ' 23:59:59'); }
    // Admins can filter by user; non-admins see only their own
    if (isAdmin && user_id) {
      conditions.push(`m.created_by = $${idx++}`);
      params.push(user_id);
    } else if (!isAdmin) {
      conditions.push(`m.created_by = $${idx++}`);
      params.push(req.user?.id);
    }
    const where = conditions.join(' AND ');

    const result = await pool.query(`
      SELECT
        u.id as user_id, u.username, u.full_name,
        COUNT(DISTINCT m.id) as total_mawbs,
        COUNT(DISTINCT h.id) as total_hawbs,
        COALESCE(SUM(m.total_packages), 0) as total_packages,
        COALESCE(SUM(m.gross_weight)::numeric, 0) as total_weight,
        COUNT(DISTINCT t.id) as total_transmissions,
        MAX(t.sent_at) as last_transmission
      FROM mawbs m
      JOIN users u ON m.created_by = u.id
      LEFT JOIN hawbs h ON h.mawb_id = m.id
      LEFT JOIN transmissions t ON t.mawb_id = m.id
      WHERE ${where}
      GROUP BY u.id, u.username, u.full_name
      ORDER BY total_transmissions DESC
    `, params);
    res.json(result.rows);
  } catch (err) {
    logger.error('REPORTS', 'GET /statement-by-consol error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Statement by Consol (user-friendly, accessible to all) ───────────────────
router.get('/consol-statement', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isAdmin = req.user?.role === 'master_admin' || req.user?.role === 'admin';
    const { from_date, to_date, user_id } = req.query;
    const exportAll = req.query.export === 'true';
    const page     = Math.max(1, parseInt(String(req.query.page     || '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'))));

    const params: any[] = [];
    let filters = '';
    let idx = 1;
    if (from_date) { filters += ` AND m.created_at >= $${idx++}`; params.push(from_date); }
    if (to_date)   { filters += ` AND m.created_at <= $${idx++}`; params.push(to_date + ' 23:59:59'); }
    // Admins can filter by user; non-admins always see only their own
    const effectiveUserId = isAdmin ? (user_id as string || '') : req.user?.id;
    if (effectiveUserId) { filters += ` AND m.created_by = $${idx++}`; params.push(effectiveUserId); }

    const base = `
      FROM mawbs m
      LEFT JOIN profiles p ON m.profile_id = p.id
      LEFT JOIN users u ON m.created_by = u.id
      WHERE 1=1${filters}`;

    const selectCols = `
      SELECT m.id, m.mawb_no, m.created_at, m.transmission_date,
             m.customs_house_code, m.status, m.message_type, m.origin, m.destination,
             m.total_packages, m.gross_weight,
             p.pan_number, p.company_name, p.profile_code,
             u.username,
             (SELECT COUNT(*) FROM hawbs h WHERE h.mawb_id = m.id) AS hawb_count,
             (SELECT COALESCE(SUM(h.total_packages),0) FROM hawbs h WHERE h.mawb_id = m.id) AS hawb_total_packages,
             (SELECT COALESCE(SUM(h.gross_weight),0)  FROM hawbs h WHERE h.mawb_id = m.id) AS hawb_total_weight`;

    if (exportAll) {
      const result = await pool.query(`${selectCols} ${base} ORDER BY m.created_at DESC`, params);
      res.json(result.rows);
      return;
    }

    const countResult = await pool.query(`SELECT COUNT(*) ${base}`, params);
    const total = parseInt(countResult.rows[0].count);
    const offset = (page - 1) * pageSize;
    const dataResult = await pool.query(
      `${selectCols} ${base} ORDER BY m.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, pageSize, offset]
    );
    res.json({ data: dataResult.rows, total, page, pageSize });
  } catch (err) {
    logger.error('REPORTS', 'GET /statement-by-consol error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Statement with HAWB ──────────────────────────────────────────────────────
router.get('/statement-with-hawb', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { from_date, to_date } = req.query;
    let query = `
      SELECT m.mawb_no, m.origin, m.destination, m.status as mawb_status,
        m.flight_no, m.created_at as mawb_date,
        h.hawb_no, h.total_packages, h.gross_weight, h.item_description,
        h.consignee_name, h.created_at as hawb_date,
        p.profile_code, p.company_name
      FROM mawbs m
      LEFT JOIN hawbs h ON h.mawb_id = m.id
      LEFT JOIN profiles p ON m.profile_id = p.id
      WHERE 1=1`;
    const params: any[] = [];
    let idx = 1;
    if (from_date) { query += ` AND m.created_at >= $${idx++}`; params.push(from_date); }
    if (to_date) { query += ` AND m.created_at <= $${idx++}`; params.push(to_date + ' 23:59:59'); }
    query += ' ORDER BY m.created_at DESC, h.created_at ASC LIMIT 500';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Download file list ───────────────────────────────────────────────────────
router.get('/download-files', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isAdmin = req.user?.role === 'master_admin' || req.user?.role === 'admin';
    // Non-admins can only see their own files
    const filterUserId = isAdmin ? (req.query.user_id as string || null) : req.user?.id;
    const filterMawbNo = req.query.mawb_no as string || null;

    const params: any[] = [];
    const conditions: string[] = [];
    let idx = 1;

    if (filterUserId)  { conditions.push(`t.sent_by = $${idx++}`); params.push(filterUserId); }
    if (filterMawbNo)  { conditions.push(`m.mawb_no ILIKE $${idx++}`); params.push(`%${filterMawbNo}%`); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(
      `SELECT t.id, t.transmission_type, t.file_name, t.sent_at, t.status,
              m.mawb_no, u.id as user_id, u.username
       FROM transmissions t
       LEFT JOIN mawbs m ON t.mawb_id = m.id
       LEFT JOIN users u ON t.sent_by = u.id
       ${where}
       ORDER BY t.sent_at DESC LIMIT 500`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Download specific file content
router.get('/download-files/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM transmissions WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ message: 'File not found' }); return; }
    const t = result.rows[0];
    // application/octet-stream — avoids mobile browsers renaming .cgm to .cgm.txt
    // (text/plain is registered to .txt in Android's MIME table; octet-stream isn't
    // mapped to any extension, so the given filename is kept as-is).
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${t.file_name}"`);
    res.send(t.file_content || '');
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── CAN / DO ─────────────────────────────────────────────────────────────────

router.get('/can-do', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { type } = req.query;
    let query = `SELECT c.*, u.username as created_by_name FROM can_do c LEFT JOIN users u ON c.created_by = u.id WHERE 1=1`;
    const params: any[] = [];
    if (type) { query += ` AND c.type = $1`; params.push(type); }
    query += ' ORDER BY c.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/can-do', async (req: AuthRequest, res: Response): Promise<void> => {
  const { type, reference_no, mawb_no, hawb_no, consignee_name, consignee_address,
    issue_date, valid_till, customs_house_code, remarks } = req.body;
  if (!type || !['CAN', 'DO'].includes(type)) {
    res.status(400).json({ message: 'type must be CAN or DO' });
    return;
  }
  const toD = (v: any) => (v && String(v).trim() !== '' ? v : null);
  try {
    const result = await pool.query(
      `INSERT INTO can_do (type, reference_no, mawb_no, hawb_no, consignee_name, consignee_address,
        issue_date, valid_till, customs_house_code, remarks, profile_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [type, reference_no || null, mawb_no || null, hawb_no || null,
       consignee_name || null, consignee_address || null,
       toD(issue_date), toD(valid_till), customs_house_code || null,
       remarks || null, req.user?.profile_id, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/can-do/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { type, reference_no, mawb_no, hawb_no, consignee_name, consignee_address,
    issue_date, valid_till, customs_house_code, remarks, status } = req.body;
  const toD = (v: any) => (v && String(v).trim() !== '' ? v : null);
  try {
    const result = await pool.query(
      `UPDATE can_do SET type=$1, reference_no=$2, mawb_no=$3, hawb_no=$4, consignee_name=$5,
       consignee_address=$6, issue_date=$7, valid_till=$8, customs_house_code=$9, remarks=$10,
       status=$11, updated_at=NOW() WHERE id=$12 RETURNING *`,
      [type, reference_no || null, mawb_no || null, hawb_no || null, consignee_name || null,
       consignee_address || null, toD(issue_date), toD(valid_till), customs_house_code || null,
       remarks || null, status || 'active', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/can-do/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM can_do WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Invoices (Accounting) ────────────────────────────────────────────────────

router.get('/invoices', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { status } = req.query;
    let query = `SELECT i.*, u.username as created_by_name FROM invoices i LEFT JOIN users u ON i.created_by = u.id WHERE 1=1`;
    const params: any[] = [];
    if (status) { query += ' AND i.status = $1'; params.push(status); }
    query += ' ORDER BY i.created_at DESC LIMIT 200';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/invoices', async (req: AuthRequest, res: Response): Promise<void> => {
  const { invoice_no, invoice_date, mawb_no, hawb_no, consignee_name,
    amount, currency, description } = req.body;
  if (!invoice_no || !invoice_date) {
    res.status(400).json({ message: 'invoice_no and invoice_date required' });
    return;
  }
  const toD = (v: any) => (v && String(v).trim() !== '' ? v : null);
  try {
    const result = await pool.query(
      `INSERT INTO invoices (invoice_no, invoice_date, mawb_no, hawb_no, consignee_name,
        amount, currency, description, profile_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [invoice_no, toD(invoice_date), mawb_no || null, hawb_no || null, consignee_name || null,
       amount || 0, currency || 'INR', description || null, req.user?.profile_id, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') { res.status(400).json({ message: 'Invoice number already exists' }); return; }
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/invoices/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { invoice_no, invoice_date, mawb_no, hawb_no, consignee_name,
    amount, currency, description, status } = req.body;
  const toD = (v: any) => (v && String(v).trim() !== '' ? v : null);
  try {
    const result = await pool.query(
      `UPDATE invoices SET invoice_no=$1, invoice_date=$2, mawb_no=$3, hawb_no=$4,
       consignee_name=$5, amount=$6, currency=$7, description=$8, status=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [invoice_no, toD(invoice_date), mawb_no || null, hawb_no || null, consignee_name || null,
       amount || 0, currency || 'INR', description || null, status || 'pending', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/invoices/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Air Invoice (auto-generated from the customer's profile billing plan) ────
// A profile carries exactly one of: monthly_rate, per_mbl_rate, per_hbl_rate.
// Generation sums the user's transmitted MAWB/HAWB activity for the chosen
// period, applies the profile's GST rate, and always rounds the final total
// UP to the next whole rupee (e.g. 849.60 -> 850.00).

function roundUpToRupee(amount: number): { total: number; roundOff: number } {
  const total = Math.ceil(amount - 1e-9); // epsilon guard against float noise
  const roundOff = Math.round((total - amount) * 100) / 100;
  return { total, roundOff };
}

async function findBillingProfile(userId: string): Promise<any> {
  const r = await pool.query(
    `SELECT * FROM profiles WHERE user_id = $1
       AND (monthly_rate IS NOT NULL OR per_mbl_rate IS NOT NULL OR per_hbl_rate IS NOT NULL)
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function nextInvoiceNo(): Promise<string> {
  const r = await pool.query(
    `SELECT COALESCE(MAX(invoice_no::int), 0) + 1 AS next
     FROM invoices WHERE invoice_no ~ '^[0-9]+$'`
  );
  return String(r.rows[0].next).padStart(5, '0');
}

async function computeAirInvoice(userId: string, fromDate: string, toDate: string): Promise<any> {
  const profile = await findBillingProfile(userId);
  if (!profile) {
    throw { status: 400, message: 'No billing rate (Monthly / Per MBL / Per HBL) is configured on any profile for this user.' };
  }
  const ratesSet = [profile.monthly_rate, profile.per_mbl_rate, profile.per_hbl_rate]
    .filter((v: any) => v !== null && v !== undefined);
  if (ratesSet.length !== 1) {
    throw { status: 400, message: `Exactly one billing rate (Monthly / Per MBL / Per HBL) must be set on the profile — found ${ratesSet.length}.` };
  }

  const toDateEnd = `${toDate} 23:59:59`;
  let rateType: string, quantity: number, rate: number, description: string;

  if (profile.monthly_rate !== null && profile.monthly_rate !== undefined) {
    rateType = 'monthly';
    quantity = 1;
    rate = Number(profile.monthly_rate);
    description = 'AIR CONSOL MANIFEST - MONTHLY CHARGES';
  } else if (profile.per_mbl_rate !== null && profile.per_mbl_rate !== undefined) {
    rateType = 'mbl';
    rate = Number(profile.per_mbl_rate);
    const r = await pool.query(
      `SELECT COUNT(*) FROM mawbs WHERE created_by = $1 AND transmission_date IS NOT NULL
         AND transmission_date >= $2 AND transmission_date <= $3`,
      [userId, fromDate, toDateEnd]
    );
    quantity = parseInt(r.rows[0].count);
    description = 'AIR CONSOL MANIFEST (MBL)';
  } else {
    rateType = 'hbl';
    rate = Number(profile.per_hbl_rate);
    const r = await pool.query(
      `SELECT COUNT(*) FROM hawbs h JOIN mawbs m ON h.mawb_id = m.id
       WHERE m.created_by = $1 AND m.transmission_date IS NOT NULL
         AND m.transmission_date >= $2 AND m.transmission_date <= $3`,
      [userId, fromDate, toDateEnd]
    );
    quantity = parseInt(r.rows[0].count);
    description = 'AIR CONSOL MANIFEST (HBL)';
  }

  const gstRate = Number(profile.gst_rate ?? 18);
  const taxableAmount = Math.round(quantity * rate * 100) / 100;
  const gstAmount = Math.round(taxableAmount * gstRate) / 100;
  const beforeRound = Math.round((taxableAmount + gstAmount) * 100) / 100;
  const { total, roundOff } = roundUpToRupee(beforeRound);

  const buyer = {
    company_name: profile.billing_company || profile.company_name,
    address1: profile.address1 || '',
    address2: profile.address2 || '',
    billing_state: profile.billing_state || '',
    gstin: profile.gstin || '',
    email: profile.user_email || '',
  };

  return { profile_id: profile.id, rateType, quantity, rate, description, taxableAmount, gstRate, gstAmount, roundOff, total, buyer };
}

// Preview a would-be invoice without persisting anything
router.get('/air-invoice/preview', requireRole(['master_admin', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { user_id, from_date, to_date } = req.query;
    if (!user_id || !from_date || !to_date) {
      res.status(400).json({ message: 'user_id, from_date and to_date are required' });
      return;
    }
    const calc = await computeAirInvoice(String(user_id), String(from_date), String(to_date));
    const suggestedInvoiceNo = await nextInvoiceNo();
    res.json({
      ...calc,
      suggested_invoice_no: suggestedInvoiceNo,
      invoice_date: new Date().toISOString().slice(0, 10),
      period_from: from_date,
      period_to: to_date,
      supplier: INVOICE_SUPPLIER,
      bank: INVOICE_BANK,
      sac_code: INVOICE_SAC_CODE,
      amount_in_words: numberToWordsINR(calc.total),
    });
  } catch (err: any) {
    if (err?.status) { res.status(err.status).json({ message: err.message }); return; }
    logger.error('REPORTS', 'GET /air-invoice/preview error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Persist the invoice (admin picks the final Invoice No. / Date, defaulting to the suggestion)
router.post('/air-invoice/generate', requireRole(['master_admin', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { user_id, from_date, to_date, invoice_no, invoice_date } = req.body;
    if (!user_id || !from_date || !to_date) {
      res.status(400).json({ message: 'user_id, from_date and to_date are required' });
      return;
    }
    const calc = await computeAirInvoice(user_id, from_date, to_date);
    const finalInvoiceNo = (invoice_no && String(invoice_no).trim()) || await nextInvoiceNo();
    const finalInvoiceDate = (invoice_date && String(invoice_date).trim()) || new Date().toISOString().slice(0, 10);

    const result = await pool.query(
      `INSERT INTO invoices (
         invoice_no, invoice_date, amount, currency, description, status,
         profile_id, created_by, user_id, period_from, period_to, rate_type,
         quantity, rate, taxable_amount, gst_rate, gst_amount, round_off, total_amount, buyer_snapshot
       ) VALUES ($1,$2,$3,'INR',$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [finalInvoiceNo, finalInvoiceDate, calc.total, calc.description,
       calc.profile_id, req.user?.id, user_id, from_date, to_date, calc.rateType,
       calc.quantity, calc.rate, calc.taxableAmount, calc.gstRate, calc.gstAmount,
       calc.roundOff, calc.total, JSON.stringify(calc.buyer)]
    );

    logger.info('REPORTS', `Generated Air invoice ${finalInvoiceNo} for user=${user_id} (${from_date}..${to_date}) total=${calc.total}`);
    res.status(201).json({
      ...result.rows[0],
      buyer: calc.buyer,
      supplier: INVOICE_SUPPLIER,
      bank: INVOICE_BANK,
      sac_code: INVOICE_SAC_CODE,
      amount_in_words: numberToWordsINR(calc.total),
    });
  } catch (err: any) {
    if (err?.status) { res.status(err.status).json({ message: err.message }); return; }
    if (err.code === '23505') { res.status(400).json({ message: 'Invoice number already exists' }); return; }
    logger.error('REPORTS', 'POST /air-invoice/generate error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Fetch a previously generated Air invoice for reprinting
router.get('/air-invoice/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ message: 'Invoice not found' }); return; }
    const inv = result.rows[0];
    res.json({
      ...inv,
      buyer: inv.buyer_snapshot,
      supplier: INVOICE_SUPPLIER,
      bank: INVOICE_BANK,
      sac_code: INVOICE_SAC_CODE,
      amount_in_words: numberToWordsINR(Number(inv.total_amount || inv.amount)),
    });
  } catch (err) {
    logger.error('REPORTS', `GET /air-invoice/${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
