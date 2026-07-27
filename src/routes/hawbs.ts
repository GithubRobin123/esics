import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const toNumOrNull = (v: any) => (v !== '' && v !== null && v !== undefined ? Number(v) : null);
const toDateOrNull = (v: any) => (v && String(v).trim() !== '' ? v : null);
const today = () => new Date().toISOString().slice(0, 10);
// HAWB No and description must be stored in caps — CGM/transmission files are generated verbatim from these columns
const upper = (v: any) => (v === null || v === undefined ? v : String(v).toUpperCase());
// Port of Origin: 1-3 alphanumeric characters (letters and digits both allowed)
const PORT_CODE_RE = /^[A-Za-z0-9]{1,3}$/;

const router = Router();
router.use(authenticate);

const hawbSelect = `
  SELECT h.*, m.mawb_no, m.message_type as mawb_message_type,
         m.origin as mawb_origin, m.destination as mawb_destination,
         m.status as mawb_status,
         m.transmission_date as mawb_transmission_date,
         CASE
           WHEN m.transmission_date IS NOT NULL OR m.status = 'transmitted' THEN 'transmitted'
           ELSE COALESCE(h.status, 'draft')
         END as status
  FROM hawbs h
  LEFT JOIN mawbs m ON h.mawb_id = m.id
`;

// List HAWBs (server-side pagination, optionally filtered by mawb_id / search)
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { mawb_id, search } = req.query;
  const page     = Math.max(1, parseInt(String(req.query.page     || '1')));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'))));
  const offset   = (page - 1) * pageSize;
  const isAdmin  = req.user?.role === 'master_admin' || req.user?.role === 'admin';
  const locationFilter = req.query.customs_house_code as string || '';

  try {
    const params: any[] = [];
    const conditions: string[] = [];

    if (mawb_id) {
      conditions.push(`h.mawb_id = $${params.length + 1}`);
      params.push(mawb_id);
    }
    if (search) {
      conditions.push(`(h.hawb_no ILIKE $${params.length + 1} OR h.origin ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }
    // Filter by selected session location (via the parent MAWB's customs_house_code)
    if (locationFilter) {
      conditions.push(`m.customs_house_code = $${params.length + 1}`);
      params.push(locationFilter);
    }
    // Non-admins see only their own HAWBs
    if (!isAdmin) {
      conditions.push(`h.created_by = $${params.length + 1}`);
      params.push(req.user?.id);
    }

    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM hawbs h LEFT JOIN mawbs m ON h.mawb_id = m.id${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const limitIdx  = params.length + 1;
    const offsetIdx = params.length + 2;

    const result = await pool.query(
      `${hawbSelect}
       ${where}
       ORDER BY h.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, pageSize, offset]
    );

    res.json({ data: result.rows, total, page, pageSize });
  } catch (err) {
    logger.error('HAWBS', 'GET / error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single HAWB
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `${hawbSelect} WHERE h.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) { res.status(404).json({ message: 'Not found' }); return; }
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('HAWBS', `GET /${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create single HAWB
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { mawb_id, hawb_no, origin, destination, total_packages, gross_weight, item_description, hawb_date } = req.body;
  if (!mawb_id || !hawb_no || !origin || !destination) {
    res.status(400).json({ message: 'mawb_id, hawb_no, origin, destination required' });
    return;
  }
  if (!PORT_CODE_RE.test(origin)) {
    res.status(400).json({ message: 'Port of Origin must be 1-3 alphanumeric characters.' });
    return;
  }
  try {
    const mawbResult = await pool.query('SELECT message_type, origin, destination, status, parent_mawb_id FROM mawbs WHERE id = $1', [mawb_id]);
    if (mawbResult.rows.length === 0) { res.status(404).json({ message: 'MAWB not found' }); return; }
    const mawb = mawbResult.rows[0];

    if (mawb.status !== 'draft') {
      res.status(400).json({ message: 'Cannot add HAWB to a transmitted MAWB. Use Amend or Part to make changes.' });
      return;
    }

    // Fresh HAWBs don't need a date; Part/Amend/Delete (child MAWBs) default to today if not given
    const isChildMawb = !!mawb.parent_mawb_id;
    const resolvedHawbDate = toDateOrNull(hawb_date) || (isChildMawb ? today() : null);

    const result = await pool.query(
      `INSERT INTO hawbs (mawb_id, hawb_no, origin, destination, shipment_type,
        total_packages, gross_weight, item_description, profile_id, created_by, message_type, hawb_date)
       VALUES ($1,$2,$3,$4,'T',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [mawb_id, upper(hawb_no), origin || mawb.origin, destination || mawb.destination,
       toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       upper(item_description) || null, req.user?.profile_id, req.user?.id, mawb.message_type || 'F', resolvedHawbDate]
    );
    logger.info('HAWBS', `Created HAWB: ${hawb_no} in mawb_id=${mawb_id} by user=${req.user?.id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('HAWBS', `POST / create error (hawb_no=${req.body.hawb_no})`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create multiple HAWBs at once (batch)
router.post('/batch', async (req: AuthRequest, res: Response): Promise<void> => {
  const { mawb_id, hawbs } = req.body;
  if (!mawb_id || !hawbs || !Array.isArray(hawbs) || hawbs.length === 0) {
    res.status(400).json({ message: 'mawb_id and hawbs array required' });
    return;
  }
  const client = await pool.connect();
  try {
    const mawbResult = await client.query(
      'SELECT message_type, origin, destination, status, parent_mawb_id FROM mawbs WHERE id = $1', [mawb_id]
    );
    if (mawbResult.rows.length === 0) {
      res.status(404).json({ message: 'MAWB not found' });
      return; // finally will release the client
    }
    const mawb = mawbResult.rows[0];

    if (mawb.status !== 'draft') {
      res.status(400).json({ message: 'Cannot add HAWBs to a transmitted MAWB. Use Amend or Part to make changes.' });
      return;
    }

    // Fresh HAWBs don't need a date; Part/Amend/Delete (child MAWBs) default to today if not given
    const isChildMawb = !!mawb.parent_mawb_id;

    await client.query('BEGIN');
    const created = [];
    for (const h of hawbs) {
      if (!h.hawb_no || String(h.hawb_no).trim() === '') continue;
      const rowOrigin = h.origin || mawb.origin;
      if (!PORT_CODE_RE.test(rowOrigin)) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: `Port of Origin "${rowOrigin}" must be 1-3 alphanumeric characters.` });
        return; // finally will release the client
      }
      const resolvedHawbDate = toDateOrNull(h.hawb_date) || (isChildMawb ? today() : null);
      const r = await client.query(
        `INSERT INTO hawbs (mawb_id, hawb_no, origin, destination, shipment_type,
          total_packages, gross_weight, item_description, profile_id, created_by, message_type, hawb_date)
         VALUES ($1,$2,$3,$4,'T',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [mawb_id, upper(h.hawb_no), h.origin || mawb.origin, h.destination || mawb.destination,
         toNumOrNull(h.total_packages) || 0, toNumOrNull(h.gross_weight) || 0,
         upper(h.item_description) || null, req.user?.profile_id, req.user?.id, mawb.message_type || 'F', resolvedHawbDate]
      );
      created.push(r.rows[0]);
    }
    await client.query('COMMIT');
    logger.info('HAWBS', `Batch created ${created.length} HAWBs in mawb_id=${mawb_id} by user=${req.user?.id}`);
    res.status(201).json(created);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('HAWBS', `POST /batch error (mawb_id=${req.body.mawb_id})`, err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

// Edit HAWB (update existing, MAWB unchanged)
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { hawb_no, origin, destination, total_packages, gross_weight, item_description, hawb_date } = req.body;
  if (origin && !PORT_CODE_RE.test(origin)) {
    res.status(400).json({ message: 'Port of Origin must be 1-3 alphanumeric characters.' });
    return;
  }
  try {
    const result = await pool.query(
      `UPDATE hawbs SET hawb_no=$1, origin=$2, destination=$3,
       total_packages=$4, gross_weight=$5, item_description=$6,
       hawb_date=COALESCE($7, hawb_date), updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [upper(hawb_no), origin, destination,
       toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       upper(item_description) || null, toDateOrNull(hawb_date), req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('HAWBS', `PUT /${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Amend HAWB – creates new HAWB record with message_type='A' linked to amended MAWB
// (also used to carry an existing HAWB into a Part or Delete-copy MAWB — always a
// child MAWB, so the date defaults to today when not supplied from the UI)
router.post('/amend/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orig = await pool.query(
      `SELECT h.*, m.mawb_no FROM hawbs h LEFT JOIN mawbs m ON h.mawb_id = m.id WHERE h.id = $1`,
      [req.params.id]
    );
    if (orig.rows.length === 0) { res.status(404).json({ message: 'HAWB not found' }); return; }
    const h = orig.rows[0];
    const { mawb_id, origin, destination, total_packages, gross_weight, item_description, hawb_date } = req.body;
    const resolvedHawbDate = toDateOrNull(hawb_date) || toDateOrNull(h.hawb_date) || today();

    const result = await pool.query(
      `INSERT INTO hawbs (mawb_id, hawb_no, origin, destination, shipment_type,
        total_packages, gross_weight, item_description, profile_id, created_by,
        message_type, parent_hawb_id, hawb_date)
       VALUES ($1,$2,$3,$4,'T',$5,$6,$7,$8,$9,'A',$10,$11) RETURNING *`,
      [mawb_id || h.mawb_id, upper(h.hawb_no),
       origin || h.origin, destination || h.destination,
       toNumOrNull(total_packages) !== null ? toNumOrNull(total_packages) : h.total_packages,
       toNumOrNull(gross_weight) !== null ? toNumOrNull(gross_weight) : parseFloat(h.gross_weight),
       upper(item_description !== undefined ? item_description : h.item_description),
       req.user?.profile_id, req.user?.id, h.id, resolvedHawbDate]
    );
    logger.info('HAWBS', `Amended HAWB id=${req.params.id} by user=${req.user?.id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('HAWBS', `POST /amend/${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get checklist data: MAWBs with their HAWBs for a profile/location
router.get('/checklist/data', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { customs_house_code, mawb_id } = req.query;
    const isAdmin = req.user?.role === 'master_admin' || req.user?.role === 'admin';
    let mawbQuery = `SELECT m.*, p.profile_code, p.pan_number,
                       (SELECT COUNT(*) FROM hawbs h WHERE h.mawb_id = m.id) as hawb_count
                     FROM mawbs m LEFT JOIN profiles p ON m.profile_id = p.id
                     WHERE 1=1`;
    const params: any[] = [];
    // When a specific MAWB is requested, show it regardless of transmission status
    if (mawb_id) {
      mawbQuery += ` AND m.id = $${params.length + 1}`;
      params.push(mawb_id);
    } else {
      mawbQuery += ` AND (m.transmission_date IS NOT NULL OR m.status = 'transmitted')`;
    }
    if (customs_house_code) {
      mawbQuery += ` AND (m.customs_house_code = $${params.length + 1} OR p.customs_house_code = $${params.length + 1})`;
      params.push(customs_house_code);
    }
    // Non-admins see only their own MAWBs in checklist
    if (!isAdmin) {
      mawbQuery += ` AND m.created_by = $${params.length + 1}`;
      params.push(req.user?.id);
    }
    mawbQuery += ' ORDER BY m.transmission_date DESC LIMIT 50';
    const mawbs = await pool.query(mawbQuery, params);

    const result = [];
    for (const mawb of mawbs.rows) {
      const hawbs = await pool.query(
        `SELECT h.*, m.status as mawb_status,
                m.transmission_date as mawb_transmission_date,
                CASE
                  WHEN m.transmission_date IS NOT NULL OR m.status = 'transmitted' THEN 'transmitted'
                  ELSE COALESCE(h.status, 'draft')
                END as status
         FROM hawbs h
         LEFT JOIN mawbs m ON h.mawb_id = m.id
         WHERE h.mawb_id = $1
         ORDER BY h.created_at ASC`,
        [mawb.id]
      );
      result.push({ ...mawb, hawbs: hawbs.rows });
    }
    res.json(result);
  } catch (err) {
    logger.error('HAWBS', 'GET /checklist/data error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete HAWB (permanent)
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM hawbs WHERE id = $1', [req.params.id]);
    logger.info('HAWBS', `Deleted HAWB id=${req.params.id} by user=${req.user?.id}`);
    res.json({ message: 'Deleted' });
  } catch (err) {
    logger.error('HAWBS', `DELETE /${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
