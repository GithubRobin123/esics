import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { generateEGM, generateEGMFileName } from '../utils/egmGenerator';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

const toDateOrNull = (v: any) => (v && String(v).trim() !== '' ? v : null);
const toNumOrNull = (v: any) => (v !== '' && v !== null && v !== undefined ? v : null);

// ─── EGM Flights ─────────────────────────────────────────────────────────────

router.get('/flights', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT f.*, p.profile_code,
         (SELECT COUNT(*) FROM egm_mawbs m WHERE m.egm_flight_id = f.id) as mawb_count
       FROM egm_flights f LEFT JOIN profiles p ON f.profile_id = p.id
       ORDER BY f.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/flights/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const flight = await pool.query('SELECT * FROM egm_flights WHERE id = $1', [req.params.id]);
    if (flight.rows.length === 0) { res.status(404).json({ message: 'Not found' }); return; }
    const mawbs = await pool.query(
      `SELECT m.*, (SELECT COUNT(*) FROM egm_hawbs h WHERE h.egm_mawb_id = m.id) as hawb_count
       FROM egm_mawbs m WHERE m.egm_flight_id = $1 ORDER BY m.created_at ASC`, [req.params.id]
    );
    res.json({ ...flight.rows[0], mawbs: mawbs.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/flights', async (req: AuthRequest, res: Response): Promise<void> => {
  const { message_type, customs_house_code, egm_no, egm_date, flight_no,
    flight_departure_date, port_of_origin, port_of_destination,
    registration_no, nil_cargo, profile_id } = req.body;
  if (!flight_no || !flight_departure_date || !port_of_origin || !port_of_destination) {
    res.status(400).json({ message: 'flight_no, flight_departure_date, port_of_origin, port_of_destination required' });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO egm_flights (message_type, customs_house_code, egm_no, egm_date,
        flight_no, flight_departure_date, port_of_origin, port_of_destination,
        registration_no, nil_cargo, profile_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [message_type || 'F', customs_house_code || null, egm_no || null, toDateOrNull(egm_date),
       flight_no, toDateOrNull(flight_departure_date), port_of_origin, port_of_destination,
       registration_no || null, nil_cargo || 'N',
       profile_id || req.user?.profile_id, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('EGM', 'Route error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/flights/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { message_type, customs_house_code, egm_no, egm_date, flight_no,
    flight_departure_date, port_of_origin, port_of_destination,
    registration_no, nil_cargo } = req.body;
  try {
    const result = await pool.query(
      `UPDATE egm_flights SET message_type=$1, customs_house_code=$2, egm_no=$3, egm_date=$4,
       flight_no=$5, flight_departure_date=$6, port_of_origin=$7, port_of_destination=$8,
       registration_no=$9, nil_cargo=$10, updated_at=NOW() WHERE id=$11 RETURNING *`,
      [message_type || 'F', customs_house_code || null, egm_no || null, toDateOrNull(egm_date),
       flight_no, toDateOrNull(flight_departure_date), port_of_origin, port_of_destination,
       registration_no || null, nil_cargo || 'N', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/flights/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM egm_flights WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── EGM MAWBs ────────────────────────────────────────────────────────────────

router.get('/mawbs', async (req: AuthRequest, res: Response): Promise<void> => {
  const { egm_flight_id } = req.query;
  try {
    let query = `SELECT m.*,
      (SELECT COUNT(*) FROM egm_hawbs h WHERE h.egm_mawb_id = m.id) as hawb_count
      FROM egm_mawbs m`;
    const params: any[] = [];
    if (egm_flight_id) { query += ' WHERE m.egm_flight_id = $1'; params.push(egm_flight_id); }
    query += ' ORDER BY m.created_at ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/mawbs', async (req: AuthRequest, res: Response): Promise<void> => {
  const { egm_flight_id, message_type, customs_house_code, egm_no, egm_date,
    mawb_no, mawb_date, port_of_loading, port_of_destination,
    shipment_type, total_packages, gross_weight, item_description } = req.body;
  if (!egm_flight_id || !mawb_no) {
    res.status(400).json({ message: 'egm_flight_id, mawb_no required' });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO egm_mawbs (egm_flight_id, message_type, customs_house_code, egm_no, egm_date,
        mawb_no, mawb_date, port_of_loading, port_of_destination, shipment_type,
        total_packages, gross_weight, item_description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [egm_flight_id, message_type || 'F', customs_house_code || null, egm_no || null,
       toDateOrNull(egm_date), mawb_no, toDateOrNull(mawb_date),
       port_of_loading || null, port_of_destination || null, shipment_type || 'T',
       toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       item_description || null, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('EGM', 'Route error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/mawbs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { message_type, customs_house_code, egm_no, egm_date, mawb_no, mawb_date,
    port_of_loading, port_of_destination, shipment_type,
    total_packages, gross_weight, item_description } = req.body;
  try {
    const result = await pool.query(
      `UPDATE egm_mawbs SET message_type=$1, customs_house_code=$2, egm_no=$3, egm_date=$4,
       mawb_no=$5, mawb_date=$6, port_of_loading=$7, port_of_destination=$8,
       shipment_type=$9, total_packages=$10, gross_weight=$11, item_description=$12, updated_at=NOW()
       WHERE id=$13 RETURNING *`,
      [message_type || 'F', customs_house_code || null, egm_no || null, toDateOrNull(egm_date),
       mawb_no, toDateOrNull(mawb_date), port_of_loading || null, port_of_destination || null,
       shipment_type || 'T', toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       item_description || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/mawbs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM egm_mawbs WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── EGM HAWBs ────────────────────────────────────────────────────────────────

router.get('/hawbs', async (req: AuthRequest, res: Response): Promise<void> => {
  const { egm_mawb_id } = req.query;
  try {
    let query = 'SELECT h.*, m.mawb_no FROM egm_hawbs h LEFT JOIN egm_mawbs m ON h.egm_mawb_id = m.id';
    const params: any[] = [];
    if (egm_mawb_id) { query += ' WHERE h.egm_mawb_id = $1'; params.push(egm_mawb_id); }
    query += ' ORDER BY h.created_at ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/hawbs', async (req: AuthRequest, res: Response): Promise<void> => {
  const { egm_mawb_id, message_type, customs_house_code, egm_no, egm_date,
    mawb_no, mawb_date, hawb_no, hawb_date, port_of_origin, port_of_destination,
    shipment_type, total_packages, gross_weight, item_description } = req.body;
  if (!egm_mawb_id || !hawb_no) {
    res.status(400).json({ message: 'egm_mawb_id, hawb_no required' });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO egm_hawbs (egm_mawb_id, message_type, customs_house_code, egm_no, egm_date,
        mawb_no, mawb_date, hawb_no, hawb_date, port_of_origin, port_of_destination,
        shipment_type, total_packages, gross_weight, item_description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [egm_mawb_id, message_type || 'F', customs_house_code || null, egm_no || null,
       toDateOrNull(egm_date), mawb_no || null, toDateOrNull(mawb_date),
       hawb_no, toDateOrNull(hawb_date), port_of_origin || null, port_of_destination || null,
       shipment_type || 'T', toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       item_description || null, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/hawbs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { message_type, customs_house_code, egm_no, egm_date, mawb_no, mawb_date,
    hawb_no, hawb_date, port_of_origin, port_of_destination,
    shipment_type, total_packages, gross_weight, item_description } = req.body;
  try {
    const result = await pool.query(
      `UPDATE egm_hawbs SET message_type=$1, customs_house_code=$2, egm_no=$3, egm_date=$4,
       mawb_no=$5, mawb_date=$6, hawb_no=$7, hawb_date=$8, port_of_origin=$9,
       port_of_destination=$10, shipment_type=$11, total_packages=$12, gross_weight=$13,
       item_description=$14, updated_at=NOW() WHERE id=$15 RETURNING *`,
      [message_type || 'F', customs_house_code || null, egm_no || null, toDateOrNull(egm_date),
       mawb_no || null, toDateOrNull(mawb_date), hawb_no, toDateOrNull(hawb_date),
       port_of_origin || null, port_of_destination || null, shipment_type || 'T',
       toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       item_description || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/hawbs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM egm_hawbs WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Generate & Transmit EGM ──────────────────────────────────────────────────

router.post('/transmit/:flightId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const flightResult = await pool.query(
      `SELECT f.*, p.customs_house_code as p_customs, p.profile_code
       FROM egm_flights f LEFT JOIN profiles p ON f.profile_id = p.id WHERE f.id = $1`,
      [req.params.flightId]
    );
    if (flightResult.rows.length === 0) { res.status(404).json({ message: 'Flight not found' }); return; }
    const flight = flightResult.rows[0];

    const mawbsResult = await pool.query(
      'SELECT * FROM egm_mawbs WHERE egm_flight_id = $1 ORDER BY created_at ASC', [req.params.flightId]
    );
    const hawbsResult = await pool.query(
      `SELECT h.* FROM egm_hawbs h
       JOIN egm_mawbs m ON h.egm_mawb_id = m.id
       WHERE m.egm_flight_id = $1 ORDER BY h.created_at ASC`, [req.params.flightId]
    );

    const customsCode = flight.customs_house_code || flight.p_customs || 'INDEL4';
    const airlineCode = flight.flight_no?.slice(0, 2) || flight.profile_code || 'AL';

    const fileContent = generateEGM(
      { ...flight, customs_house_code: customsCode },
      mawbsResult.rows.map(m => ({ ...m, customs_house_code: customsCode })),
      hawbsResult.rows.map(h => ({ ...h, customs_house_code: customsCode }))
    );
    const fileName = generateEGMFileName(customsCode, airlineCode);

    await pool.query(
      `INSERT INTO transmissions (transmission_type, file_name, file_content, customs_house_code, profile_id, sent_by)
       VALUES ('EGM', $1, $2, $3, $4, $5)`,
      [fileName, fileContent, customsCode, flight.profile_id, req.user?.id]
    );

    await pool.query('UPDATE egm_flights SET status=$1, transmitted_at=NOW() WHERE id=$2', ['transmitted', req.params.flightId]);

    // application/octet-stream — avoids mobile browsers renaming the file to .txt
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(fileContent);
  } catch (err) {
    logger.error('EGM', 'Route error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/preview/:flightId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const flightResult = await pool.query(
      `SELECT f.*, p.customs_house_code as p_customs, p.profile_code
       FROM egm_flights f LEFT JOIN profiles p ON f.profile_id = p.id WHERE f.id = $1`,
      [req.params.flightId]
    );
    if (flightResult.rows.length === 0) { res.status(404).json({ message: 'Flight not found' }); return; }
    const flight = flightResult.rows[0];
    const mawbsResult = await pool.query('SELECT * FROM egm_mawbs WHERE egm_flight_id = $1', [req.params.flightId]);
    const hawbsResult = await pool.query(
      `SELECT h.* FROM egm_hawbs h JOIN egm_mawbs m ON h.egm_mawb_id = m.id WHERE m.egm_flight_id = $1`,
      [req.params.flightId]
    );
    const customsCode = flight.customs_house_code || flight.p_customs || 'INDEL4';
    const airlineCode = flight.flight_no?.slice(0, 2) || 'AL';
    const fileContent = generateEGM(
      { ...flight, customs_house_code: customsCode },
      mawbsResult.rows.map(m => ({ ...m, customs_house_code: customsCode })),
      hawbsResult.rows.map(h => ({ ...h, customs_house_code: customsCode }))
    );
    const fileName = generateEGMFileName(customsCode, airlineCode);
    res.json({ file_name: fileName, content: fileContent, mawb_count: mawbsResult.rows.length, hawb_count: hawbsResult.rows.length });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
