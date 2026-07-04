import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { generateIGM, generateIGMFileName } from '../utils/igmGenerator';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

const toDateOrNull = (v: any) => (v && String(v).trim() !== '' ? v : null);
const toNumOrNull = (v: any) => (v !== '' && v !== null && v !== undefined ? v : null);

// ─── IGM Flights ─────────────────────────────────────────────────────────────

router.get('/flights', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT f.*, p.profile_code,
         (SELECT COUNT(*) FROM igm_mawbs m WHERE m.igm_flight_id = f.id) as mawb_count
       FROM igm_flights f LEFT JOIN profiles p ON f.profile_id = p.id
       ORDER BY f.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('IGM', 'Route error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/flights/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const flight = await pool.query('SELECT * FROM igm_flights WHERE id = $1', [req.params.id]);
    if (flight.rows.length === 0) { res.status(404).json({ message: 'Not found' }); return; }
    const mawbs = await pool.query('SELECT * FROM igm_mawbs WHERE igm_flight_id = $1 ORDER BY created_at ASC', [req.params.id]);
    res.json({ ...flight.rows[0], mawbs: mawbs.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/flights', async (req: AuthRequest, res: Response): Promise<void> => {
  const { message_type, customs_house_code, flight_no, flight_origin_date,
    expected_arrival, port_of_origin, port_of_destination, registration_no,
    nil_cargo, igm_no, igm_date, profile_id } = req.body;
  if (!flight_no || !flight_origin_date || !port_of_origin || !port_of_destination) {
    res.status(400).json({ message: 'flight_no, flight_origin_date, port_of_origin, port_of_destination required' });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO igm_flights (message_type, customs_house_code, flight_no, flight_origin_date,
        expected_arrival, port_of_origin, port_of_destination, registration_no, nil_cargo,
        igm_no, igm_date, profile_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [message_type || 'F', customs_house_code || null, flight_no,
       toDateOrNull(flight_origin_date), toDateOrNull(expected_arrival),
       port_of_origin, port_of_destination, registration_no || null,
       nil_cargo || 'N', igm_no || null, toDateOrNull(igm_date),
       profile_id || req.user?.profile_id, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('IGM', 'Route error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/flights/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { message_type, customs_house_code, flight_no, flight_origin_date,
    expected_arrival, port_of_origin, port_of_destination, registration_no,
    nil_cargo, igm_no, igm_date } = req.body;
  try {
    const result = await pool.query(
      `UPDATE igm_flights SET message_type=$1, customs_house_code=$2, flight_no=$3,
       flight_origin_date=$4, expected_arrival=$5, port_of_origin=$6, port_of_destination=$7,
       registration_no=$8, nil_cargo=$9, igm_no=$10, igm_date=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [message_type || 'F', customs_house_code || null, flight_no,
       toDateOrNull(flight_origin_date), toDateOrNull(expected_arrival),
       port_of_origin, port_of_destination, registration_no || null,
       nil_cargo || 'N', igm_no || null, toDateOrNull(igm_date), req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/flights/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM igm_flights WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── IGM MAWBs ────────────────────────────────────────────────────────────────

router.get('/mawbs', async (req: AuthRequest, res: Response): Promise<void> => {
  const { igm_flight_id } = req.query;
  try {
    let query = 'SELECT m.*, f.flight_no, f.port_of_origin as f_origin FROM igm_mawbs m LEFT JOIN igm_flights f ON m.igm_flight_id = f.id';
    const params: any[] = [];
    if (igm_flight_id) { query += ' WHERE m.igm_flight_id = $1'; params.push(igm_flight_id); }
    query += ' ORDER BY m.created_at ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/mawbs', async (req: AuthRequest, res: Response): Promise<void> => {
  const { igm_flight_id, message_type, customs_house_code, flight_no, flight_origin_date,
    uld_number, mawb_no, mawb_date, port_of_origin, port_of_destination,
    shipment_type, total_packages, gross_weight, item_description,
    special_handling_code, igm_no, igm_date } = req.body;
  if (!igm_flight_id || !mawb_no || !port_of_origin || !port_of_destination) {
    res.status(400).json({ message: 'igm_flight_id, mawb_no, port_of_origin, port_of_destination required' });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO igm_mawbs (igm_flight_id, message_type, customs_house_code, flight_no,
        flight_origin_date, uld_number, mawb_no, mawb_date, port_of_origin, port_of_destination,
        shipment_type, total_packages, gross_weight, item_description, special_handling_code,
        igm_no, igm_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [igm_flight_id, message_type || 'F', customs_house_code || null, flight_no || null,
       toDateOrNull(flight_origin_date), uld_number || null, mawb_no, toDateOrNull(mawb_date),
       port_of_origin, port_of_destination, shipment_type || 'T',
       toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       item_description || null, special_handling_code || null,
       igm_no || null, toDateOrNull(igm_date), req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('IGM', 'Route error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/mawbs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { message_type, customs_house_code, flight_no, flight_origin_date, uld_number,
    mawb_no, mawb_date, port_of_origin, port_of_destination, shipment_type,
    total_packages, gross_weight, item_description, special_handling_code, igm_no, igm_date } = req.body;
  try {
    const result = await pool.query(
      `UPDATE igm_mawbs SET message_type=$1, customs_house_code=$2, flight_no=$3,
       flight_origin_date=$4, uld_number=$5, mawb_no=$6, mawb_date=$7, port_of_origin=$8,
       port_of_destination=$9, shipment_type=$10, total_packages=$11, gross_weight=$12,
       item_description=$13, special_handling_code=$14, igm_no=$15, igm_date=$16, updated_at=NOW()
       WHERE id=$17 RETURNING *`,
      [message_type || 'F', customs_house_code || null, flight_no || null,
       toDateOrNull(flight_origin_date), uld_number || null, mawb_no, toDateOrNull(mawb_date),
       port_of_origin, port_of_destination, shipment_type || 'T',
       toNumOrNull(total_packages) || 0, toNumOrNull(gross_weight) || 0,
       item_description || null, special_handling_code || null,
       igm_no || null, toDateOrNull(igm_date), req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/mawbs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM igm_mawbs WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── Generate & Transmit IGM ──────────────────────────────────────────────────

router.post('/transmit/:flightId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const flightResult = await pool.query(
      `SELECT f.*, p.customs_house_code as p_customs, p.profile_code
       FROM igm_flights f LEFT JOIN profiles p ON f.profile_id = p.id
       WHERE f.id = $1`, [req.params.flightId]
    );
    if (flightResult.rows.length === 0) { res.status(404).json({ message: 'Flight not found' }); return; }
    const flight = flightResult.rows[0];

    const mawbsResult = await pool.query(
      'SELECT * FROM igm_mawbs WHERE igm_flight_id = $1 ORDER BY created_at ASC', [req.params.flightId]
    );

    const customsCode = flight.customs_house_code || flight.p_customs || 'INDEL4';
    const airlineCode = flight.flight_no?.slice(0, 2) || flight.profile_code || 'AL';

    const fileContent = generateIGM(
      { ...flight, customs_house_code: customsCode },
      mawbsResult.rows.map(m => ({ ...m, customs_house_code: customsCode }))
    );
    const fileName = generateIGMFileName(customsCode, airlineCode);

    // Save transmission
    await pool.query(
      `INSERT INTO transmissions (transmission_type, file_name, file_content, customs_house_code, profile_id, sent_by)
       VALUES ('IGM', $1, $2, $3, $4, $5)`,
      [fileName, fileContent, customsCode, flight.profile_id, req.user?.id]
    );

    await pool.query('UPDATE igm_flights SET status=$1, transmitted_at=NOW() WHERE id=$2', ['transmitted', req.params.flightId]);

    // application/octet-stream — avoids mobile browsers renaming the file to .txt
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(fileContent);
  } catch (err) {
    logger.error('IGM', 'Route error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/preview/:flightId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const flightResult = await pool.query(
      `SELECT f.*, p.customs_house_code as p_customs, p.profile_code
       FROM igm_flights f LEFT JOIN profiles p ON f.profile_id = p.id WHERE f.id = $1`, [req.params.flightId]
    );
    if (flightResult.rows.length === 0) { res.status(404).json({ message: 'Flight not found' }); return; }
    const flight = flightResult.rows[0];
    const mawbsResult = await pool.query('SELECT * FROM igm_mawbs WHERE igm_flight_id = $1', [req.params.flightId]);
    const customsCode = flight.customs_house_code || flight.p_customs || 'INDEL4';
    const airlineCode = flight.flight_no?.slice(0, 2) || 'AL';
    const fileContent = generateIGM(
      { ...flight, customs_house_code: customsCode },
      mawbsResult.rows.map(m => ({ ...m, customs_house_code: customsCode }))
    );
    const fileName = generateIGMFileName(customsCode, airlineCode);
    res.json({ file_name: fileName, content: fileContent, mawb_count: mawbsResult.rows.length });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
