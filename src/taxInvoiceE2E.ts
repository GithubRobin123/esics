/**
 * End-to-end exercise of the Tax Invoice HTTP API against a running backend.
 *
 *   BASE_URL=http://localhost:5099 ts-node --transpile-only src/taxInvoiceE2E.ts
 *
 * Creates a clearly-marked test party and invoice, drives every endpoint, then
 * removes everything it created. Cleanup runs even when an assertion fails, so
 * the database is left exactly as it was found.
 */

import jwt from 'jsonwebtoken';
import pool from './db';

const BASE = process.env.BASE_URL || 'http://localhost:5099';
const API = `${BASE}/api/tax-invoices`;

const TEST_PARTY = '__E2E TEST PARTY (safe to delete)__';

let pass = 0;
let fail = 0;
const created: { partyId?: string; invoiceId?: string } = {};

function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  // ─── Auth: sign a token for the existing admin, same as a real login ──────
  const admin = await pool.query(
    `SELECT id, username, role, profile_id FROM users WHERE role IN ('master_admin','admin') ORDER BY role LIMIT 1`
  );
  if (!admin.rows[0]) throw new Error('No admin user found to authenticate as');
  const adminUser = admin.rows[0];
  const token = jwt.sign(
    { id: adminUser.id, username: adminUser.username, role: adminUser.role, profile_id: adminUser.profile_id },
    process.env.JWT_SECRET || 'secret',
    { expiresIn: '10m' }
  );
  console.log(`Authenticated as ${adminUser.username} (${adminUser.role})\n`);

  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    const payload = ct.includes('application/json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, body: payload as any, contentType: ct, headers: res.headers };
  };

  // ─── Authorisation gate ───────────────────────────────────────────────────
  console.log('--- Access control ---');
  const noAuth = await fetch(API);
  ok('unauthenticated request is rejected', noAuth.status === 401, `got ${noAuth.status}`);

  const userRow = await pool.query(`SELECT id, username, role, profile_id FROM users WHERE role='user' LIMIT 1`);
  if (userRow.rows[0]) {
    const userToken = jwt.sign(
      { id: userRow.rows[0].id, username: userRow.rows[0].username, role: 'user', profile_id: userRow.rows[0].profile_id },
      process.env.JWT_SECRET || 'secret', { expiresIn: '10m' }
    );
    const asUser = await fetch(API, { headers: { Authorization: `Bearer ${userToken}` } });
    ok("role 'user' is forbidden (admin-only module)", asUser.status === 403, `got ${asUser.status}`);
  }

  // ─── Party ────────────────────────────────────────────────────────────────
  console.log('\n--- Party master ---');
  const mkParty = await call('POST', '/parties', {
    name: TEST_PARTY, gstin: '27AABCU9603R1ZX',
    address1: 'Plot 14, Sector 19', city: 'Navi Mumbai', state: 'Maharashtra', pincode: '400705',
    email: 'e2e@example.com', phone: '9999999999',
  });
  ok('create party', mkParty.status === 201, `status ${mkParty.status}`);
  created.partyId = mkParty.body?.id;
  ok('state code derived from GSTIN', mkParty.body?.state_code === '27', `got ${mkParty.body?.state_code}`);

  const badGstin = await call('POST', '/parties', { name: 'bad', gstin: 'NOPE' });
  ok('invalid GSTIN rejected', badGstin.status === 400, `status ${badGstin.status}`);

  const noName = await call('POST', '/parties', { name: '   ' });
  ok('blank party name rejected', noName.status === 400, `status ${noName.status}`);

  // ─── Numbering + preview ──────────────────────────────────────────────────
  console.log('\n--- Numbering and preview ---');
  const n1 = await call('GET', '/next-number');
  const n2 = await call('GET', '/next-number');
  ok('next-number returns a formatted number', /^EMS\/\d{4}-\d{2}\/\d{5}$/.test(n1.body?.invoice_no), n1.body?.invoice_no);
  ok('preview does not consume the number', n1.body?.invoice_no === n2.body?.invoice_no);

  const prev = await call('POST', '/preview', {
    party_id: created.partyId,
    discount: 150,
    items: [
      { description: 'Air manifest filing', quantity: 2, rate: 500, gst_rate: 18 },
      { description: 'Documentation', quantity: 1, rate: 500, gst_rate: 5 },
    ],
  });
  ok('preview succeeds', prev.status === 200, `status ${prev.status}`);
  ok('preview picks IGST for Maharashtra party', prev.body?.gst_mode === 'igst', prev.body?.gst_mode);
  ok('preview subtotal', prev.body?.subtotal === 1500, String(prev.body?.subtotal));
  ok('preview taxable after discount', prev.body?.taxable_amount === 1350, String(prev.body?.taxable_amount));
  ok('preview total', prev.body?.total_amount === 1535, String(prev.body?.total_amount));

  const badPrev = await call('POST', '/preview', { party_id: created.partyId, items: [] });
  ok('preview rejects empty items', badPrev.status === 400, `status ${badPrev.status}`);

  // ─── Create invoice ───────────────────────────────────────────────────────
  console.log('\n--- Create invoice ---');
  const mk = await call('POST', '/', {
    party_id: created.partyId,
    invoice_date: new Date().toISOString().slice(0, 10),
    discount: 150,
    notes: 'E2E test invoice',
    items: [
      { description: 'Air manifest filing', hsn_sac: '998439', quantity: 2, unit: 'NOS', rate: 500, gst_rate: 18 },
      { description: 'Documentation', hsn_sac: '998439', quantity: 1, unit: 'NOS', rate: 500, gst_rate: 5 },
    ],
  });
  ok('create invoice', mk.status === 201, `status ${mk.status} ${JSON.stringify(mk.body).slice(0, 200)}`);
  created.invoiceId = mk.body?.id;
  ok('invoice total matches preview', mk.body?.total_amount === 1535, String(mk.body?.total_amount));
  ok('two line items stored', mk.body?.items?.length === 2, String(mk.body?.items?.length));
  ok('status starts as pending', mk.body?.status === 'pending', mk.body?.status);
  ok('pending equals total', mk.body?.pending_amount === 1535, String(mk.body?.pending_amount));
  ok('party snapshot frozen onto invoice', mk.body?.party_snapshot?.name === TEST_PARTY);

  // A DATE column must not come back as a UTC timestamp, or the calendar day
  // shifts by one for anybody who slices the first 10 characters.
  const today = new Date().toISOString().slice(0, 10);
  const localToday = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
  ok('invoice_date is a plain YYYY-MM-DD string',
    /^\d{4}-\d{2}-\d{2}$/.test(String(mk.body?.invoice_date)), String(mk.body?.invoice_date));
  ok('invoice_date is the day we sent, not shifted',
    mk.body?.invoice_date === today || mk.body?.invoice_date === localToday,
    `got ${mk.body?.invoice_date}, sent ${today}`);

  const dupe = await call('POST', '/', {
    party_id: created.partyId,
    invoice_no: mk.body?.invoice_no,
    invoice_date: new Date().toISOString().slice(0, 10),
    items: [{ description: 'x', quantity: 1, rate: 1, gst_rate: 18 }],
  });
  ok('duplicate invoice number rejected with 409', dupe.status === 409, `status ${dupe.status}`);

  // Server must ignore client-supplied totals and recompute
  const tampered = await call('POST', '/', {
    party_id: created.partyId,
    invoice_date: new Date().toISOString().slice(0, 10),
    total_amount: 1, subtotal: 1, taxable_amount: 1,
    items: [{ description: 'Tamper check', quantity: 1, rate: 1000, gst_rate: 18 }],
  });
  ok('server recomputes totals, ignoring client values',
    tampered.body?.total_amount === 1180, String(tampered.body?.total_amount));
  if (tampered.body?.id) {
    await call('DELETE', `/${tampered.body.id}`);
  }

  // ─── Read + list ──────────────────────────────────────────────────────────
  console.log('\n--- Read and list ---');
  const got = await call('GET', `/${created.invoiceId}`);
  ok('fetch invoice by id', got.status === 200 && got.body?.id === created.invoiceId);

  const missing = await call('GET', '/not-a-uuid');
  ok('malformed id returns 404 not 500', missing.status === 404, `status ${missing.status}`);

  const list = await call('GET', `/?party_id=${created.partyId}`);
  ok('list filters by party', list.status === 200 && list.body?.data?.length >= 1, `${list.body?.total} row(s)`);

  const listPending = await call('GET', `/?status=pending&party_id=${created.partyId}`);
  ok('list filters by status', listPending.body?.data?.every((r: any) => r.status === 'pending') === true);

  // ─── Downloads ────────────────────────────────────────────────────────────
  console.log('\n--- Downloads ---');
  const pdfRes = await fetch(`${API}/${created.invoiceId}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  ok('PDF downloads', pdfRes.status === 200 && pdfBuf.subarray(0, 5).toString() === '%PDF-',
    `${pdfBuf.length} bytes, ${pdfRes.headers.get('content-type')}`);
  ok('PDF filename has no slash',
    !/filename="[^"]*\//.test(pdfRes.headers.get('content-disposition') || ''),
    pdfRes.headers.get('content-disposition') || '');

  const xlsRes = await fetch(`${API}/${created.invoiceId}/excel`, { headers: { Authorization: `Bearer ${token}` } });
  const xlsBuf = Buffer.from(await xlsRes.arrayBuffer());
  ok('Excel downloads', xlsRes.status === 200 && xlsBuf.subarray(0, 2).toString() === 'PK',
    `${xlsBuf.length} bytes`);

  // ─── Payments ─────────────────────────────────────────────────────────────
  console.log('\n--- Payments ---');
  const over = await call('POST', `/${created.invoiceId}/payments`, { amount: 99999 });
  ok('over-payment rejected', over.status === 400, `status ${over.status}`);

  const zero = await call('POST', `/${created.invoiceId}/payments`, { amount: 0 });
  ok('zero payment rejected', zero.status === 400, `status ${zero.status}`);

  const part = await call('POST', `/${created.invoiceId}/payments`, {
    amount: 500, method: 'NEFT', reference: 'E2E-UTR-1',
  });
  ok('partial payment accepted', part.status === 201, `status ${part.status}`);
  ok('payment paid_on is a plain date string',
    /^\d{4}-\d{2}-\d{2}$/.test(String(part.body?.payments?.[0]?.paid_on)),
    String(part.body?.payments?.[0]?.paid_on));
  ok('status becomes partial', part.body?.status === 'partial', part.body?.status);
  ok('pending reduced correctly', part.body?.pending_amount === 1035, String(part.body?.pending_amount));

  const rest = await call('POST', `/${created.invoiceId}/payments`, { amount: 1035, method: 'UPI' });
  ok('final payment accepted', rest.status === 201, `status ${rest.status}`);
  ok('status becomes paid', rest.body?.status === 'paid', rest.body?.status);
  ok('pending is zero', rest.body?.pending_amount === 0, String(rest.body?.pending_amount));

  // Editing below what was collected must be refused
  const shrink = await call('PUT', `/${created.invoiceId}`, {
    party_id: created.partyId,
    invoice_no: mk.body?.invoice_no,
    invoice_date: new Date().toISOString().slice(0, 10),
    items: [{ description: 'Tiny', quantity: 1, rate: 10, gst_rate: 18 }],
  });
  ok('edit below amount already paid is refused', shrink.status === 400, `status ${shrink.status}`);

  // ─── Dashboard ────────────────────────────────────────────────────────────
  console.log('\n--- Dashboard ---');
  const sum = await call('GET', `/dashboard/summary?party_id=${created.partyId}`);
  ok('summary reachable (not shadowed by /:id)', sum.status === 200, `status ${sum.status}`);
  ok('summary invoiced total', sum.body?.total_invoiced === 1535, String(sum.body?.total_invoiced));
  ok('summary received total', sum.body?.total_received === 1535, String(sum.body?.total_received));
  ok('summary pending is zero', sum.body?.total_pending === 0, String(sum.body?.total_pending));

  const byParty = await call('GET', `/dashboard/by-party?party_id=${created.partyId}&only_pending=false`);
  ok('by-party reachable', byParty.status === 200, `status ${byParty.status}`);
  ok('by-party returns our party', byParty.body?.[0]?.party_name === TEST_PARTY, byParty.body?.[0]?.party_name);

  const byPartyPending = await call('GET', `/dashboard/by-party?party_id=${created.partyId}`);
  ok('fully-paid party excluded from pending view', (byPartyPending.body?.length ?? 0) === 0,
    `${byPartyPending.body?.length} row(s)`);

  const creators = await call('GET', '/dashboard/creators');
  ok('creators list reachable', creators.status === 200 && Array.isArray(creators.body));

  // ─── Payment removal + cancel ─────────────────────────────────────────────
  console.log('\n--- Payment removal and cancel ---');
  const payments = (await call('GET', `/${created.invoiceId}`)).body?.payments ?? [];
  const rm = await call('DELETE', `/${created.invoiceId}/payments/${payments[0].id}`);
  ok('payment removal recalculates', rm.status === 200 && rm.body?.status !== 'paid', rm.body?.status);

  const cancelled = await call('POST', `/${created.invoiceId}/cancel`);
  ok('cancel succeeds', cancelled.status === 200 && cancelled.body?.is_cancelled === true);
  ok('cancelled invoice has zero pending', cancelled.body?.pending_amount === 0, String(cancelled.body?.pending_amount));

  const editCancelled = await call('PUT', `/${created.invoiceId}`, {
    party_id: created.partyId, invoice_no: 'X', invoice_date: '2026-01-01',
    items: [{ description: 'x', quantity: 1, rate: 1, gst_rate: 18 }],
  });
  ok('cancelled invoice cannot be edited', editCancelled.status === 400, `status ${editCancelled.status}`);

  const payCancelled = await call('POST', `/${created.invoiceId}/payments`, { amount: 10 });
  ok('cancelled invoice cannot take payment', payCancelled.status === 400, `status ${payCancelled.status}`);
}

async function cleanup() {
  console.log('\n--- Cleanup ---');
  try {
    if (created.invoiceId) {
      await pool.query(`DELETE FROM tax_invoice_payments WHERE invoice_id=$1`, [created.invoiceId]);
      await pool.query(`DELETE FROM tax_invoice_items WHERE invoice_id=$1`, [created.invoiceId]);
      await pool.query(`DELETE FROM tax_invoices WHERE id=$1`, [created.invoiceId]);
    }
    // Catch any invoice created by the tamper/dup checks against the test party.
    if (created.partyId) {
      await pool.query(
        `DELETE FROM tax_invoice_payments WHERE invoice_id IN (SELECT id FROM tax_invoices WHERE party_id=$1)`,
        [created.partyId]);
      await pool.query(
        `DELETE FROM tax_invoice_items WHERE invoice_id IN (SELECT id FROM tax_invoices WHERE party_id=$1)`,
        [created.partyId]);
      await pool.query(`DELETE FROM tax_invoices WHERE party_id=$1`, [created.partyId]);
      await pool.query(`DELETE FROM tax_invoice_parties WHERE id=$1`, [created.partyId]);
    }
    await pool.query(`DELETE FROM tax_invoice_parties WHERE name=$1`, [TEST_PARTY]);

    const left = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM tax_invoices) AS invoices,
              (SELECT COUNT(*)::int FROM tax_invoice_items) AS items,
              (SELECT COUNT(*)::int FROM tax_invoice_payments) AS payments,
              (SELECT COUNT(*)::int FROM tax_invoice_parties) AS parties`
    );
    console.log('  rows remaining in tax_invoice* tables:', left.rows[0]);
  } catch (e: any) {
    console.error('  CLEANUP FAILED:', e.message);
  }
}

main()
  .catch(e => { fail++; console.error('\nRUN ERROR:', e.message); })
  .then(cleanup)
  .then(async () => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    await pool.end().catch(() => {});
    process.exit(fail === 0 ? 0 : 1);
  });
