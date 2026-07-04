import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, requireRole, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page     || '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '10'))));
    const offset   = (page - 1) * pageSize;
    const userId   = req.query.user_id as string || '';

    const params: any[] = [];
    const conditions: string[] = [];

    if (userId) {
      params.push(userId);
      conditions.push(`p.user_id = $${params.length}`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM profiles p ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const limitIdx  = params.length + 1;
    const offsetIdx = params.length + 2;

    const result = await pool.query(`
      SELECT p.*, p.user_id,
             u2.username as user_username, u2.full_name as user_full_name
      FROM profiles p
      LEFT JOIN users u2 ON u2.id = p.user_id
      ${where}
      ORDER BY p.company_name
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, [...params, pageSize, offset]);

    res.json({ data: result.rows, total, page, pageSize });
  } catch (err) {
    logger.error('PROFILES', 'GET / error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all control numbers (user_id + location_code + control_number)
router.get('/control-numbers', requireRole(['master_admin', 'admin']), async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      'SELECT user_id, location_code, control_number FROM file_control_numbers WHERE user_id IS NOT NULL'
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('PROFILES', 'GET /control-numbers error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM profiles WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ message: 'Profile not found' }); return; }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Helper: insert one profile row, skip if user_id+location_code already exists
async function upsertProfile(fields: any): Promise<{ created: boolean; row: any }> {
  const {
    user_id, company_name, location_code, customs_house_code, icegate_code,
    pan_number, user_prefix, consol_agent_id, user_email,
    address1, address2, gstin, billing_company, billing_state, gst_rate,
    pan_for_invoice, air_igm_rate, sea_consol_lcl_rate, sea_consol_fcl_rate,
    air_manifest_rate, air_manifest_min_bill,
    monthly_rate, per_mbl_rate, per_hbl_rate,
  } = fields;

  // profile_code = user_prefix + location_code (unique per user+location)
  const profileCode = `${(user_prefix || '').toUpperCase()}${(location_code || '').toUpperCase()}`;

  const result = await pool.query(
    `INSERT INTO profiles (
      profile_code, company_name, user_id,
      customs_house_code, icegate_code,
      pan_number, user_prefix, consol_agent_id, user_email,
      address1, address2, gstin, billing_company, billing_state, gst_rate,
      pan_for_invoice, air_igm_rate, sea_consol_lcl_rate, sea_consol_fcl_rate,
      air_manifest_rate, air_manifest_min_bill, location_code,
      monthly_rate, per_mbl_rate, per_hbl_rate
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
    )
    ON CONFLICT (user_id, location_code) DO NOTHING
    RETURNING *`,
    [
      profileCode, company_name, user_id || null,
      customs_house_code || location_code || null, icegate_code || null,
      pan_number || null, user_prefix || null, consol_agent_id || null, user_email || null,
      address1 || null, address2 || null, gstin || null, billing_company || null,
      billing_state || null, gst_rate || 18, pan_for_invoice || null,
      air_igm_rate || null, sea_consol_lcl_rate || null, sea_consol_fcl_rate || null,
      air_manifest_rate || null, air_manifest_min_bill || null, location_code || null,
      monthly_rate || null, per_mbl_rate || null, per_hbl_rate || null,
    ]
  );

  if (result.rows.length > 0) return { created: true, row: result.rows[0] };
  // Already exists — fetch it
  const existing = await pool.query(
    'SELECT * FROM profiles WHERE user_id = $1 AND location_code = $2',
    [user_id, location_code]
  );
  return { created: false, row: existing.rows[0] };
}

// Batch create profiles — one per location, skip duplicates
router.post('/batch', requireRole(['master_admin', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  const { location_codes, ...commonFields } = req.body;
  if (!commonFields.company_name) { res.status(400).json({ message: 'company_name required' }); return; }
  if (!Array.isArray(location_codes) || location_codes.length === 0) {
    res.status(400).json({ message: 'location_codes array required' }); return;
  }

  try {
    const results = [];
    let created = 0, skipped = 0;
    for (const locCode of location_codes) {
      const { created: wasCreated, row } = await upsertProfile({
        ...commonFields,
        location_code: locCode,
        customs_house_code: locCode,
      });
      results.push(row);
      if (wasCreated) created++; else skipped++;
    }
    logger.info('PROFILES', `Batch: created=${created} skipped=${skipped} for user=${commonFields.user_id}`);
    res.status(201).json({ created, skipped, profiles: results });
  } catch (err: any) {
    logger.error('PROFILES', 'POST /batch error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', requireRole(['master_admin', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  const { company_name, location_code, user_id } = req.body;
  if (!company_name) { res.status(400).json({ message: 'company_name required' }); return; }

  try {
    const { row } = await upsertProfile(req.body);
    if (user_id) {
      await pool.query('UPDATE users SET profile_id = $1 WHERE id = $2', [row.id, user_id]);
    }
    res.status(201).json(row);
  } catch (err: any) {
    logger.error('PROFILES', `POST / error (location=${location_code})`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', requireRole(['master_admin', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  const {
    company_name, address, city, state, country, phone, email,
    carn_number, customs_house_code, icegate_code,
    pan_number, user_prefix, consol_agent_id, user_email, agent_name,
    address1, address2, gstin, billing_company, billing_state, gst_rate,
    pan_for_invoice, air_igm_rate, sea_consol_lcl_rate, sea_consol_fcl_rate,
    air_manifest_rate, air_manifest_min_bill, location_code,
    monthly_rate, per_mbl_rate, per_hbl_rate,
    user_id,
  } = req.body;
  try {
    const result = await pool.query(
      `UPDATE profiles SET
        company_name=$1, address=$2, city=$3, state=$4, country=$5, phone=$6, email=$7,
        carn_number=$8, customs_house_code=$9, icegate_code=$10,
        pan_number=$11, user_prefix=$12, consol_agent_id=$13, user_email=$14, agent_name=$15,
        address1=$16, address2=$17, gstin=$18, billing_company=$19, billing_state=$20,
        gst_rate=$21, pan_for_invoice=$22, air_igm_rate=$23, sea_consol_lcl_rate=$24,
        sea_consol_fcl_rate=$25, air_manifest_rate=$26, air_manifest_min_bill=$27,
        location_code=$28, monthly_rate=$29, per_mbl_rate=$30, per_hbl_rate=$31,
        updated_at=NOW()
       WHERE id=$32 RETURNING *`,
      [company_name, address || null, city || null, state || null, country || 'India',
       phone || null, email || null, carn_number || null, customs_house_code || null, icegate_code || null,
       pan_number || null, user_prefix || null, consol_agent_id || null,
       user_email || null, agent_name || null, address1 || null, address2 || null,
       gstin || null, billing_company || null, billing_state || null,
       gst_rate || 18, pan_for_invoice || null,
       air_igm_rate || null, sea_consol_lcl_rate || null, sea_consol_fcl_rate || null,
       air_manifest_rate || null, air_manifest_min_bill || null,
       location_code || null, monthly_rate || null, per_mbl_rate || null, per_hbl_rate || null,
       req.params.id]
    );

    if (user_id) {
      await pool.query('UPDATE users SET profile_id = $1 WHERE id = $2', [req.params.id, user_id]);
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('PROFILES', 'Route error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', requireRole(['master_admin', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM profiles WHERE id = $1', [req.params.id]);
    res.json({ message: 'Profile deleted' });
  } catch (err) {
    logger.error('PROFILES', 'Route error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
