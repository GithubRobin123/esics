import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { generateCGM, generateCGMFileName, MawbData, HawbData } from '../utils/cgmGenerator';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

// Logged query helper — logs SQL + params then executes
async function dbq(tag: string, sql: string, params?: any[]): Promise<any> {
  const p = params ? JSON.stringify(params) : '[]';
  logger.info('SQL', `[${tag}] ${sql.replace(/\s+/g, ' ').trim()} | params=${p}`);
  return pool.query(sql, params);
}

// Get or increment file control number for a user+location
async function getNextControlNumber(userId: string, locationCode: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, control_number FROM file_control_numbers WHERE user_id = $1 AND location_code = $2',
      [userId, locationCode]
    );
    logger.info('SQL', `[ctrl_num] SELECT file_control_numbers user_id=${userId} loc=${locationCode} → rows=${existing.rows.length} val=${existing.rows[0]?.control_number}`);
    let controlNum: number;
    if (existing.rows.length > 0) {
      controlNum = existing.rows[0].control_number + 1;
      logger.info('SQL', `[ctrl_num] UPDATE control_number=${controlNum} id=${existing.rows[0].id}`);
      await client.query(
        'UPDATE file_control_numbers SET control_number = $1 WHERE id = $2',
        [controlNum, existing.rows[0].id]
      );
    } else {
      controlNum = 1;
      logger.info('SQL', `[ctrl_num] INSERT new row user_id=${userId} loc=${locationCode} control_number=1`);
      await client.query(
        'INSERT INTO file_control_numbers (user_id, location_code, control_number) VALUES ($1, $2, 1)',
        [userId, locationCode]
      );
    }
    await client.query('COMMIT');
    return controlNum;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Strip -A1/-P1/-D1 suffixes from MAWB/HAWB numbers for CGM output
const stripSuffix = (no: string) => (no || '').replace(/-[APD]\d+$/, '').trim();

const todayIso = () => new Date().toISOString().slice(0, 10);

// Fresh MAWBs need no HAWB date (unchanged behavior). Part/Amend/Delete-copy MAWBs
// (i.e. any MAWB with a parent_mawb_id) are required to carry a HAWB date — fall
// back to today's date if one was never filled in from the UI.
const resolveHawbDate = (hawbDate: any, isChildMawb: boolean) => hawbDate || (isChildMawb ? todayIso() : undefined);

// Generate CGM file for a MAWB
router.post('/generate-cgm/:mawbId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Step 1: Get MAWB row
    const mawbResult = await dbq('gen-cgm:mawb', 'SELECT * FROM mawbs WHERE id = $1', [req.params.mawbId]);
    if (mawbResult.rows.length === 0) { res.status(404).json({ message: 'MAWB not found' }); return; }
    const mawbRow = mawbResult.rows[0];
    logger.info('SQL', `[gen-cgm:mawb] found mawb_no=${mawbRow.mawb_no} profile_id=${mawbRow.profile_id} created_by=${mawbRow.created_by} customs_house_code=${mawbRow.customs_house_code}`);

    // Step 2: Find profile — try in order:
    //  a) MAWB's own profile_id (direct link)
    //  b) mawb.created_by + location (user who created the MAWB)
    //  c) req.user + location (user generating the file)
    //  d) location only (any profile for this customs location)
    const custCode = (mawbRow.customs_house_code || '').trim();
    let profileRow: any = {};

    if (mawbRow.profile_id) {
      const r = await dbq('gen-cgm:profile[1-by-id]', 'SELECT * FROM profiles WHERE id = $1', [mawbRow.profile_id]);
      logger.info('SQL', `[gen-cgm:profile[1-by-id]] rows=${r.rows.length} pan=${r.rows[0]?.pan_number} icegate=${r.rows[0]?.icegate_code}`);
      if (r.rows.length > 0 && (r.rows[0].pan_number || r.rows[0].icegate_code)) {
        profileRow = r.rows[0];
      }
    }

    if (!profileRow.pan_number && !profileRow.icegate_code) {
      // Try by MAWB creator + location
      const creatorId = mawbRow.created_by || req.user?.id;
      const r = await dbq('gen-cgm:profile[2-creator+loc]',
        `SELECT * FROM profiles WHERE user_id = $1 AND (location_code = $2 OR customs_house_code = $2)
         ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [creatorId, custCode]
      );
      logger.info('SQL', `[gen-cgm:profile[2-creator+loc]] creatorId=${creatorId} loc=${custCode} rows=${r.rows.length} pan=${r.rows[0]?.pan_number} icegate=${r.rows[0]?.icegate_code}`);
      if (r.rows.length > 0) profileRow = r.rows[0];
    }

    if (!profileRow.pan_number && !profileRow.icegate_code) {
      // Try by req.user + location
      const r = await dbq('gen-cgm:profile[3-requser+loc]',
        `SELECT * FROM profiles WHERE user_id = $1 AND (location_code = $2 OR customs_house_code = $2)
         ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [req.user?.id, custCode]
      );
      logger.info('SQL', `[gen-cgm:profile[3-requser+loc]] req.user=${req.user?.id} loc=${custCode} rows=${r.rows.length} pan=${r.rows[0]?.pan_number} icegate=${r.rows[0]?.icegate_code}`);
      if (r.rows.length > 0) profileRow = r.rows[0];
    }

    if (!profileRow.pan_number && !profileRow.icegate_code) {
      // Last resort: any profile for this location
      const r = await dbq('gen-cgm:profile[4-loc-only]',
        `SELECT * FROM profiles WHERE (location_code = $1 OR customs_house_code = $1)
         AND pan_number IS NOT NULL ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [custCode]
      );
      logger.info('SQL', `[gen-cgm:profile[4-loc-only]] loc=${custCode} rows=${r.rows.length} pan=${r.rows[0]?.pan_number} icegate=${r.rows[0]?.icegate_code}`);
      if (r.rows.length > 0) profileRow = r.rows[0];
    }

    logger.info('TRANSMISSIONS', `Profile for CGM: mawb_creator=${mawbRow.created_by} loc=${custCode} → profile_id=${profileRow.id} pan=${profileRow.pan_number} icegate=${profileRow.icegate_code}`);

    const hawbResult = await dbq('gen-cgm:hawbs', 'SELECT * FROM hawbs WHERE mawb_id = $1 ORDER BY created_at ASC', [req.params.mawbId]);
    logger.info('SQL', `[gen-cgm:hawbs] mawb_id=${req.params.mawbId} hawb_count=${hawbResult.rows.length}`);

    // Auto-derive customs house code
    const dest3 = (mawbRow.destination || '').trim().substring(0, 3).toUpperCase();
    const derivedChc = dest3.length === 3 ? `IN${dest3}4` : '';
    const customsCode = (mawbRow.customs_house_code || profileRow.customs_house_code || derivedChc || '').trim();
    const locationCode = profileRow.location_code || profileRow.customs_house_code || customsCode;

    // PAN number (field 2 in consmaster/conshouse) — from profile
    const consolAgentId = (profileRow.pan_number || profileRow.carn_number || '').trim();
    // Sender ID for HREC — icegate_code from profile
    const senderCode = (profileRow.icegate_code || profileRow.consol_agent_id || '').trim();
    // Username prefix: first 3 chars of username in uppercase
    const userPrefix = (req.user?.username?.substring(0, 3).toUpperCase() || '').trim();

    // MAWB number stripped of any -A/-P/-D suffix (always 11 digits in CGM)
    const baseMawbNo = stripSuffix(mawbRow.mawb_no);

    // Get control number per user+location
    const profileId = mawbRow.profile_id || profileRow.id || null;
    const userId = req.user?.id;
    let controlNum = 1;
    if (userId) {
      controlNum = await getNextControlNumber(userId, locationCode);
    }
    const controlNumber = `${userPrefix}${controlNum}`;

    const mawbData: MawbData = {
      carn_number: consolAgentId,
      customs_house_code: customsCode,
      igm_no: mawbRow.igm_no || '',
      igm_date: mawbRow.igm_date,
      flight_no: mawbRow.flight_no || '',
      flight_origin_date: mawbRow.flight_origin_date,
      mawb_no: baseMawbNo,
      mawb_date: mawbRow.mawb_date || resolveHawbDate(mawbRow.mawb_date, !!mawbRow.parent_mawb_id),
      origin: mawbRow.origin,
      destination: mawbRow.destination,
      shipment_type: 'T',
      total_packages: mawbRow.total_packages,
      gross_weight: parseFloat(mawbRow.gross_weight),
      item_description: 'CONSOL',
      message_type: mawbRow.message_type || 'F',
    };

    const isChildMawb = !!mawbRow.parent_mawb_id;
    const hawbData: HawbData[] = hawbResult.rows.map((h: any) => ({
      carn_number: consolAgentId,
      customs_house_code: customsCode,
      igm_no: mawbRow.igm_no || '',
      igm_date: mawbRow.igm_date,
      flight_no: mawbRow.flight_no || '',
      flight_origin_date: mawbRow.flight_origin_date,
      mawb_no: baseMawbNo,
      mawb_date: mawbRow.mawb_date || resolveHawbDate(mawbRow.mawb_date, isChildMawb),
      hawb_no: stripSuffix(h.hawb_no),
      hawb_date: resolveHawbDate(h.hawb_date, isChildMawb),
      origin: h.origin,
      destination: h.destination,
      shipment_type: 'T',
      total_packages: h.total_packages,
      gross_weight: parseFloat(h.gross_weight),
      item_description: h.item_description || 'AS PER INVOICE',
      message_type: h.message_type || mawbRow.message_type || 'F',
    }));

    const fileContent = generateCGM(mawbData, hawbData, {
      senderCode,
      receiverCode: customsCode,
      controlNumber,
      testMode: false,
    });

    // Build filename: CustomsCode + PAN(10) + UserPrefix(3) + ControlNum(4padded) + .cgm
    const panStr = (profileRow.pan_number || profileRow.carn_number || '').substring(0, 10).toUpperCase();
    const companyPrefix = userPrefix || (profileRow.company_name || '').replace(/\s+/g, '').substring(0, 3).toUpperCase();
    const fileName = generateCGMFileName(customsCode, panStr, companyPrefix, controlNum);

    // Save transmission record
    await pool.query(
      `INSERT INTO transmissions (transmission_type, file_name, file_content, mawb_id, customs_house_code, profile_id, sent_by)
       VALUES ('CGM',$1,$2,$3,$4,$5,$6)`,
      [fileName, fileContent, req.params.mawbId, customsCode, profileId, req.user?.id]
    );

    // Update MAWB status
    await pool.query(
      'UPDATE mawbs SET transmission_date=NOW(), status=$1 WHERE id=$2',
      ['transmitted', req.params.mawbId]
    );

    logger.info('TRANSMISSIONS', `CGM generated: ${fileName} for mawb_id=${req.params.mawbId} by user=${req.user?.id}`);
    res.json({ fileName, fileContent });
  } catch (err) {
    logger.error('TRANSMISSIONS', `POST /generate-cgm/${req.params.mawbId} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Preview CGM (returns JSON with content + filename)
router.get('/preview-cgm/:mawbId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const mawbResult = await pool.query(
      `SELECT m.*, p.carn_number, p.pan_number, p.user_prefix, p.consol_agent_id,
              p.customs_house_code as p_customs_code, p.profile_code,
              p.company_name, p.icegate_code, p.location_code as p_location
       FROM mawbs m LEFT JOIN profiles p ON m.profile_id = p.id WHERE m.id = $1`,
      [req.params.mawbId]
    );
    if (mawbResult.rows.length === 0) { res.status(404).json({ message: 'MAWB not found' }); return; }
    const mawbRow = mawbResult.rows[0];

    // Cascade profile lookup (same 4-level as generate-cgm)
    const custCodeP = (mawbRow.customs_house_code || '').trim();
    let profileRowP: any = {};

    if (mawbRow.profile_id) {
      const r = await pool.query('SELECT * FROM profiles WHERE id = $1', [mawbRow.profile_id]);
      if (r.rows.length > 0 && (r.rows[0].pan_number || r.rows[0].icegate_code)) profileRowP = r.rows[0];
    }
    if (!profileRowP.pan_number && !profileRowP.icegate_code) {
      const creatorId = mawbRow.created_by || req.user?.id;
      const r = await pool.query(
        `SELECT * FROM profiles WHERE user_id = $1 AND (location_code = $2 OR customs_house_code = $2)
         ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [creatorId, custCodeP]
      );
      if (r.rows.length > 0) profileRowP = r.rows[0];
    }
    if (!profileRowP.pan_number && !profileRowP.icegate_code) {
      const r = await pool.query(
        `SELECT * FROM profiles WHERE user_id = $1 AND (location_code = $2 OR customs_house_code = $2)
         ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [req.user?.id, custCodeP]
      );
      if (r.rows.length > 0) profileRowP = r.rows[0];
    }
    if (!profileRowP.pan_number && !profileRowP.icegate_code) {
      const r = await pool.query(
        `SELECT * FROM profiles WHERE (location_code = $1 OR customs_house_code = $1)
         AND pan_number IS NOT NULL ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [custCodeP]
      );
      if (r.rows.length > 0) profileRowP = r.rows[0];
    }

    const hawbResult = await pool.query('SELECT * FROM hawbs WHERE mawb_id = $1', [req.params.mawbId]);

    const dest3p = (mawbRow.destination || '').trim().substring(0, 3).toUpperCase();
    const derivedChcP = dest3p.length === 3 ? `IN${dest3p}4` : '';
    const customsCode = (mawbRow.customs_house_code || profileRowP.customs_house_code || derivedChcP || '').trim();
    const consolAgentId = (profileRowP.pan_number || profileRowP.carn_number || '').trim();
    const senderCode = (profileRowP.icegate_code || profileRowP.consol_agent_id || '').trim();
    const userPrefix = (req.user?.username?.substring(0, 3).toUpperCase() || '').trim();
    const baseMawbNo = stripSuffix(mawbRow.mawb_no);
    const controlNumber = `${userPrefix}PREVIEW`;

    const mawbData: MawbData = {
      carn_number: consolAgentId, customs_house_code: customsCode,
      igm_no: mawbRow.igm_no, igm_date: mawbRow.igm_date,
      flight_no: mawbRow.flight_no, flight_origin_date: mawbRow.flight_origin_date,
      mawb_no: baseMawbNo, mawb_date: mawbRow.mawb_date,
      origin: mawbRow.origin, destination: mawbRow.destination,
      shipment_type: 'T', total_packages: mawbRow.total_packages,
      gross_weight: parseFloat(mawbRow.gross_weight),
      item_description: 'CONSOL', message_type: mawbRow.message_type || 'F',
    };
    const isChildMawbP = !!mawbRow.parent_mawb_id;
    const hawbData: HawbData[] = hawbResult.rows.map((h: any) => ({
      carn_number: consolAgentId, customs_house_code: customsCode,
      igm_no: mawbRow.igm_no, igm_date: mawbRow.igm_date,
      flight_no: mawbRow.flight_no, flight_origin_date: mawbRow.flight_origin_date,
      mawb_no: baseMawbNo, mawb_date: mawbRow.mawb_date,
      hawb_no: stripSuffix(h.hawb_no), hawb_date: resolveHawbDate(h.hawb_date, isChildMawbP),
      origin: h.origin, destination: h.destination,
      shipment_type: 'T', total_packages: h.total_packages,
      gross_weight: parseFloat(h.gross_weight),
      item_description: h.item_description || 'AS PER INVOICE',
      message_type: h.message_type || mawbRow.message_type || 'F',
    }));

    const fileContent = generateCGM(mawbData, hawbData, {
      senderCode, receiverCode: customsCode, controlNumber, testMode: false,
    });
    const panStr = (profileRowP.pan_number || profileRowP.carn_number || '').substring(0, 10).toUpperCase();
    const companyPrefix = userPrefix || (profileRowP.company_name || '').replace(/\s+/g, '').substring(0, 3).toUpperCase();
    const fileName = generateCGMFileName(customsCode, panStr, companyPrefix, 0);
    res.json({ file_name: fileName, content: fileContent, hawb_count: hawbResult.rows.length });
  } catch (err) {
    logger.error('TRANSMISSIONS', `GET /preview-cgm/${req.params.mawbId} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get transmission history (users see only their own; admins see all)
router.get('/history', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isAdmin = req.user?.role === 'master_admin' || req.user?.role === 'admin';
    const page     = Math.max(1, parseInt(String(req.query.page     || '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'))));
    const offset   = (page - 1) * pageSize;

    const params: any[] = [];
    let where = '';
    if (!isAdmin) {
      where = 'WHERE t.sent_by = $1';
      params.push(req.user?.id);
    }

    const baseFrom = `
      FROM transmissions t
      LEFT JOIN mawbs m ON t.mawb_id = m.id
      LEFT JOIN users u ON t.sent_by = u.id
      LEFT JOIN profiles p ON t.profile_id = p.id
      ${where}`;

    const countResult = await pool.query(`SELECT COUNT(*) ${baseFrom}`, params);
    const total = parseInt(countResult.rows[0].count);

    const limitIdx  = params.length + 1;
    const offsetIdx = params.length + 2;

    const result = await pool.query(
      `SELECT t.id, t.transmission_type, t.file_name, t.sent_at, t.status,
              t.mawb_id, m.mawb_no, u.username,
              (SELECT COUNT(*) FROM hawbs WHERE mawb_id = t.mawb_id) as hawb_count,
              p.customs_house_code as location, p.pan_number
       ${baseFrom}
       ORDER BY t.sent_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, pageSize, offset]
    );
    res.json({ data: result.rows, total, page, pageSize });
  } catch (err) {
    logger.error('TRANSMISSIONS', 'GET /history error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Return the latest unsigned CGM content for a MAWB so signing can reuse it
// without calling generate-cgm again (which would increment the control number).
router.get('/latest/:mawbId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT file_name, file_content FROM transmissions
       WHERE mawb_id = $1
         AND transmission_type = 'CGM'
         AND file_content NOT LIKE '%<START-SIGNATURE>%'
       ORDER BY sent_at DESC LIMIT 1`,
      [req.params.mawbId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ message: 'No transmission found' });
      return;
    }
    const t = result.rows[0];
    res.json({ fileName: t.file_name, fileContent: t.file_content });
  } catch (err) {
    logger.error('TRANSMISSIONS', `GET /latest/${req.params.mawbId} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Re-download a stored transmission file by ID (uses stored filename)
router.get('/download/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM transmissions WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ message: 'File not found' }); return; }
    const t = result.rows[0];
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${t.file_name}"`);
    res.send(t.file_content || '');
  } catch (err) {
    logger.error('TRANSMISSIONS', `GET /download/${req.params.id} error`, err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
