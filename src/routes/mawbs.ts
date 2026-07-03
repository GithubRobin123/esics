import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

const toDateOrNull = (v: any) => (v && String(v).trim() !== '' ? v : null);
const toNumOrNull = (v: any) => (v !== '' && v !== null && v !== undefined ? Number(v) : null);
// Flight No. and IGM No. must be stored in caps — CGM/transmission files are generated verbatim from these columns
const upper = (v: any) => (v === null || v === undefined ? v : String(v).toUpperCase());

// Helper: get base MAWB number (strip -A1, -P2, -D3 suffixes)
function getBaseNo(mawbNo: string): string {
  return mawbNo.replace(/-[APD]\d+$/, '');
}

// Helper: get next sequence for a suffix type
async function getNextSeq(baseNo: string, suffix: 'A' | 'P' | 'D'): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as cnt FROM mawbs WHERE mawb_no LIKE $1`,
    [`${baseNo}-${suffix}%`]
  );
  return parseInt(result.rows[0].cnt) + 1;
}

// List MAWBs (server-side pagination)
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search } = req.query;
    const page     = Math.max(1, parseInt(String(req.query.page  || '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'))));
    const offset   = (page - 1) * pageSize;
    const isAdmin  = req.user?.role === 'master_admin' || req.user?.role === 'admin';

    // Optional location filter — sent by frontend based on user's selected session location
    const locationFilter = req.query.customs_house_code as string || '';
    // Optional status filter — e.g. 'draft' to exclude transmitted MAWBs
    const statusFilter = req.query.status as string || '';

    const params: any[] = [];
    const conditions: string[] = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(m.mawb_no ILIKE $${params.length} OR m.origin ILIKE $${params.length})`);
    }
    // Filter by selected session location (applies to all roles)
    if (locationFilter) {
      params.push(locationFilter);
      conditions.push(`m.customs_house_code = $${params.length}`);
    }
    // Filter by status (e.g. 'draft' to exclude transmitted MAWBs)
    if (statusFilter) {
      params.push(statusFilter);
      conditions.push(`m.status = $${params.length}`);
    }
    // Non-admins see only their own MAWBs
    if (!isAdmin) {
      params.push(req.user?.id);
      conditions.push(`m.created_by = $${params.length}`);
    }

    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM mawbs m${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const limitIdx  = params.length + 1;
    const offsetIdx = params.length + 2;

    const result = await pool.query(
      `SELECT m.*, p.profile_code, p.company_name, p.icegate_code, p.pan_number,
              (SELECT COUNT(*) FROM hawbs h WHERE h.mawb_id = m.id) as hawb_count
       FROM mawbs m LEFT JOIN profiles p ON m.profile_id = p.id
       ${where}
       ORDER BY m.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, pageSize, offset]
    );

    res.json({ data: result.rows, total, page, pageSize });
  } catch (err) {
    logger.error('MAWBS', 'GET / error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single MAWB with HAWBs
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT m.*, p.profile_code, p.company_name
       FROM mawbs m LEFT JOIN profiles p ON m.profile_id = p.id
       WHERE m.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ message: 'MAWB not found' });
      return;
    }
    const hawbs = await pool.query(
      'SELECT * FROM hawbs WHERE mawb_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ ...result.rows[0], hawbs: hawbs.rows });
  } catch (err) {
    logger.error('MAWBS', `GET /${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create MAWB with optional HAWBs in one transaction
router.post('/with-hawbs', async (req: AuthRequest, res: Response): Promise<void> => {
  const {
    mawb_no,
    mawb_date,
    origin,
    destination,
    total_packages,
    gross_weight,
    customs_house_code,
    profile_id,
    hawbs,
  } = req.body;

  if (!mawb_no || !origin || !destination) {
    res.status(400).json({ message: 'mawb_no, origin, destination required' });
    return;
  }

  if (!/^\d+$/.test(mawb_no)) {
    res.status(400).json({ message: 'MAWB number must contain digits only' });
    return;
  }

  const incomingHawbs = Array.isArray(hawbs) ? hawbs : [];
  const preparedHawbs = incomingHawbs
    .map((row: any, index: number) => {
      const hawbNo = String(row?.hawb_no || '').trim().toUpperCase();
      const itemDescription = String(row?.item_description || '').trim().toUpperCase();
      const totalPackagesText = String(row?.total_packages ?? '').trim();
      const grossWeightText = String(row?.gross_weight ?? '').trim();

      return {
        rowNo: index + 1,
        hawb_no: hawbNo,
        origin: String(row?.origin || '').trim() || origin,
        destination: String(row?.destination || '').trim() || destination,
        total_packages: totalPackagesText,
        gross_weight: grossWeightText,
        item_description: itemDescription,
        hasData: Boolean(hawbNo || totalPackagesText || grossWeightText || itemDescription),
      };
    })
    .filter((row: any) => row.hasData);

  const seenHawbs = new Set<string>();
  for (const row of preparedHawbs) {
    if (!row.hawb_no) {
      res.status(400).json({ message: `HAWB number is required for row ${row.rowNo}.` });
      return;
    }
    if (!row.origin || !row.destination) {
      res.status(400).json({ message: `Origin and destination are required for HAWB row ${row.rowNo}.` });
      return;
    }

    const hawbKey = row.hawb_no.toUpperCase();
    if (seenHawbs.has(hawbKey)) {
      res.status(400).json({ message: `Duplicate HAWB number "${row.hawb_no}" in the same save request.` });
      return;
    }
    seenHawbs.add(hawbKey);
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    const existingMawb = await client.query('SELECT id FROM mawbs WHERE mawb_no = $1', [mawb_no]);
    if (existingMawb.rows.length > 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      res.status(400).json({ message: 'MAWB number already exists. Please use a unique MAWB number.' });
      return;
    }

    const mawbResult = await client.query(
      `INSERT INTO mawbs (mawb_no, mawb_date, origin, destination, shipment_type,
        total_packages, gross_weight, item_description, customs_house_code,
        profile_id, created_by, message_type, status)
       VALUES ($1,$2,$3,$4,'T',$5,$6,'CONSOL',$7,$8,$9,'F','draft') RETURNING *`,
      [mawb_no, toDateOrNull(mawb_date), origin, destination,
       toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       customs_house_code || null, profile_id || null, req.user?.id]
    );

    const createdMawb = mawbResult.rows[0];
    const createdHawbs: any[] = [];

    for (const row of preparedHawbs) {
      const existingHawb = await client.query('SELECT id FROM hawbs WHERE hawb_no = $1', [row.hawb_no]);
      if (existingHawb.rows.length > 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        res.status(400).json({ message: `HAWB number "${row.hawb_no}" already exists.` });
        return;
      }

      const hawbResult = await client.query(
        `INSERT INTO hawbs (mawb_id, hawb_no, origin, destination, shipment_type,
          total_packages, gross_weight, item_description, profile_id, created_by, message_type)
         VALUES ($1,$2,$3,$4,'T',$5,$6,$7,$8,$9,$10) RETURNING *`,
        [createdMawb.id, row.hawb_no, row.origin, row.destination,
         toNumOrNull(row.total_packages) || 0, toNumOrNull(row.gross_weight) || 0,
         row.item_description || null, req.user?.profile_id, req.user?.id, createdMawb.message_type || 'F']
      );
      createdHawbs.push(hawbResult.rows[0]);
    }

    await client.query('COMMIT');
    transactionStarted = false;

    logger.info(
      'MAWBS',
      `Created MAWB with inline HAWBs: ${mawb_no} (${createdHawbs.length} HAWBs) by user=${req.user?.id}`
    );
    res.status(201).json({ mawb: createdMawb, hawbs: createdHawbs });
  } catch (err) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
    }
    logger.error('MAWBS', `POST /with-hawbs error (mawb_no=${req.body.mawb_no})`, err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

// Create MAWB (Fresh - message_type F)
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { mawb_no, mawb_date, origin, destination, total_packages, gross_weight, customs_house_code, profile_id } = req.body;
  if (!mawb_no || !origin || !destination) {
    res.status(400).json({ message: 'mawb_no, origin, destination required' });
    return;
  }
  if (!/^\d+$/.test(mawb_no)) {
    res.status(400).json({ message: 'MAWB number must contain digits only' });
    return;
  }
  try {
    // Enforce unique MAWB number
    const existing = await pool.query('SELECT id FROM mawbs WHERE mawb_no = $1', [mawb_no]);
    if (existing.rows.length > 0) {
      res.status(400).json({ message: 'MAWB number already exists. Please use a unique MAWB number.' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO mawbs (mawb_no, mawb_date, origin, destination, shipment_type,
        total_packages, gross_weight, item_description, customs_house_code,
        profile_id, created_by, message_type, status)
       VALUES ($1,$2,$3,$4,'T',$5,$6,'CONSOL',$7,$8,$9,'F','draft') RETURNING *`,
      [mawb_no, toDateOrNull(mawb_date), origin, destination,
       toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       customs_house_code || null, profile_id || null, req.user?.id]
    );
    logger.info('MAWBS', `Created MAWB: ${mawb_no} by user=${req.user?.id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('MAWBS', `POST / create error (mawb_no=${req.body.mawb_no})`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Edit MAWB (same number, message_type stays F, can update flight details)
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { mawb_date, origin, destination, total_packages, gross_weight,
    flight_no, flight_origin_date, igm_no, igm_date, customs_house_code, profile_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE mawbs SET mawb_date=$1, origin=$2, destination=$3,
       total_packages=$4, gross_weight=$5, item_description='CONSOL',
       flight_no=$6, flight_origin_date=$7, igm_no=$8, igm_date=$9,
       customs_house_code=$10, profile_id=$11, updated_at=NOW(),
       status='draft', transmission_date=NULL
       WHERE id=$12 RETURNING *`,
      [toDateOrNull(mawb_date), origin, destination,
       toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       upper(flight_no) || null, toDateOrNull(flight_origin_date),
       upper(igm_no) || null, toDateOrNull(igm_date),
       customs_house_code || null, profile_id || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('MAWBS', `PUT /${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Amend MAWB – creates new MAWB with suffix -A1, -A2… message_type=A
router.post('/amend/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orig = await pool.query('SELECT * FROM mawbs WHERE id = $1', [req.params.id]);
    if (orig.rows.length === 0) { res.status(404).json({ message: 'MAWB not found' }); return; }
    const m = orig.rows[0];
    const baseNo = getBaseNo(m.mawb_no);
    const seq = await getNextSeq(baseNo, 'A');
    const newNo = `${baseNo}-A${seq}`;

    const { mawb_date, origin, destination, total_packages, gross_weight,
      flight_no, flight_origin_date, igm_no, igm_date, customs_house_code, profile_id } = req.body;

    const result = await pool.query(
      `INSERT INTO mawbs (mawb_no, mawb_date, origin, destination, shipment_type,
        total_packages, gross_weight, item_description, flight_no, flight_origin_date,
        igm_no, igm_date, customs_house_code, profile_id, created_by,
        message_type, parent_mawb_id, amendment_seq, status)
       VALUES ($1,$2,$3,$4,'T',$5,$6,'CONSOL',$7,$8,$9,$10,$11,$12,$13,'A',$14,$15,'draft') RETURNING *`,
      [newNo,
       // Amend date defaults to today (the amendment is a new file dated when it's filed)
       toDateOrNull(mawb_date) || new Date().toISOString().slice(0, 10), origin || m.origin, destination || m.destination,
       toNumOrNull(total_packages) !== null ? toNumOrNull(total_packages) : m.total_packages,
       toNumOrNull(gross_weight) !== null ? toNumOrNull(gross_weight) : parseFloat(m.gross_weight),
       upper(flight_no) || m.flight_no || null, toDateOrNull(flight_origin_date || m.flight_origin_date),
       upper(igm_no) || m.igm_no || null, toDateOrNull(igm_date || m.igm_date),
       customs_house_code || m.customs_house_code || null,
       profile_id || m.profile_id || null, req.user?.id, m.id, seq]
    );
    logger.info('MAWBS', `Amended MAWB: ${newNo} from id=${req.params.id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('MAWBS', `POST /amend/${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Part MAWB – creates new MAWB with suffix -P1, -P2… message_type=F
router.post('/part/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orig = await pool.query('SELECT * FROM mawbs WHERE id = $1', [req.params.id]);
    if (orig.rows.length === 0) { res.status(404).json({ message: 'MAWB not found' }); return; }
    const m = orig.rows[0];
    const baseNo = getBaseNo(m.mawb_no);
    const seq = await getNextSeq(baseNo, 'P');
    const newNo = `${baseNo}-P${seq}`;

    const { mawb_date, origin, destination, total_packages, gross_weight,
      flight_no, flight_origin_date, igm_no, igm_date, customs_house_code, profile_id } = req.body;

    const result = await pool.query(
      `INSERT INTO mawbs (mawb_no, mawb_date, origin, destination, shipment_type,
        total_packages, gross_weight, item_description, flight_no, flight_origin_date,
        igm_no, igm_date, customs_house_code, profile_id, created_by,
        message_type, parent_mawb_id, amendment_seq, status)
       VALUES ($1,$2,$3,$4,'T',$5,$6,'CONSOL',$7,$8,$9,$10,$11,$12,$13,'F',$14,$15,'draft') RETURNING *`,
      [newNo,
       toDateOrNull(mawb_date || m.mawb_date), origin || m.origin, destination || m.destination,
       toNumOrNull(total_packages) !== null ? toNumOrNull(total_packages) : m.total_packages,
       toNumOrNull(gross_weight) !== null ? toNumOrNull(gross_weight) : parseFloat(m.gross_weight),
       upper(flight_no) || m.flight_no || null, toDateOrNull(flight_origin_date || m.flight_origin_date),
       upper(igm_no) || m.igm_no || null, toDateOrNull(igm_date || m.igm_date),
       customs_house_code || m.customs_house_code || null,
       profile_id || m.profile_id || null, req.user?.id, m.id, seq]
    );
    logger.info('MAWBS', `Part MAWB: ${newNo} from id=${req.params.id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('MAWBS', `POST /part/${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete-Copy MAWB – creates new MAWB with suffix -D1, -D2… message_type=D
router.post('/delete-copy/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orig = await pool.query('SELECT * FROM mawbs WHERE id = $1', [req.params.id]);
    if (orig.rows.length === 0) { res.status(404).json({ message: 'MAWB not found' }); return; }
    const m = orig.rows[0];
    const baseNo = getBaseNo(m.mawb_no);
    const seq = await getNextSeq(baseNo, 'D');
    const newNo = `${baseNo}-D${seq}`;

    const { mawb_date, origin, destination, total_packages, gross_weight,
      flight_no, flight_origin_date, igm_no, igm_date, customs_house_code, profile_id } = req.body;

    const result = await pool.query(
      `INSERT INTO mawbs (mawb_no, mawb_date, origin, destination, shipment_type,
        total_packages, gross_weight, item_description, flight_no, flight_origin_date,
        igm_no, igm_date, customs_house_code, profile_id, created_by,
        message_type, parent_mawb_id, amendment_seq, status)
       VALUES ($1,$2,$3,$4,'T',$5,$6,'CONSOL',$7,$8,$9,$10,$11,$12,$13,'D',$14,$15,'draft') RETURNING *`,
      [newNo,
       toDateOrNull(mawb_date || m.mawb_date), origin || m.origin, destination || m.destination,
       toNumOrNull(total_packages) !== null ? toNumOrNull(total_packages) : m.total_packages,
       toNumOrNull(gross_weight) !== null ? toNumOrNull(gross_weight) : parseFloat(m.gross_weight),
       upper(flight_no) || m.flight_no || null, toDateOrNull(flight_origin_date || m.flight_origin_date),
       upper(igm_no) || m.igm_no || null, toDateOrNull(igm_date || m.igm_date),
       customs_house_code || m.customs_house_code || null,
       profile_id || m.profile_id || null, req.user?.id, m.id, seq]
    );
    logger.info('MAWBS', `Delete-copy MAWB: ${newNo} from id=${req.params.id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('MAWBS', `POST /delete-copy/${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Permanent Delete MAWB — only allowed while still in draft (never transmitted)
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT status FROM mawbs WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ message: 'MAWB not found' });
      return;
    }
    if (existing.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      res.status(400).json({ message: 'Cannot permanently delete a transmitted MAWB. Use Delete & Copy instead.' });
      return;
    }
    await client.query('DELETE FROM transmissions WHERE mawb_id = $1', [req.params.id]);
    await client.query('DELETE FROM mawbs WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    logger.info('MAWBS', `Deleted MAWB id=${req.params.id} by user=${req.user?.id}`);
    res.json({ message: 'Deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('MAWBS', `DELETE /${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

export default router;
