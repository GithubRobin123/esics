/**
 * Applies the Tax Invoice migrations to the main application database, in order.
 *
 *   npm run migrate:tax-invoice
 *
 * Every migration is fully idempotent (IF NOT EXISTS / guarded), so re-running
 * is safe. They only create or extend `tax_invoice*` objects — never alter or
 * drop anything belonging to the existing air system.
 */

import fs from 'fs';
import path from 'path';
import pool from './db';

const FILES = [
  'schema_v8_tax_invoices.sql',
  'schema_v9_tax_invoice_party_rates.sql',
];

function resolveSqlPath(file: string): string {
  // Works both under ts-node (src/) and from a compiled dist/ build.
  const candidates = [
    path.join(__dirname, file),
    path.join(__dirname, '..', 'src', file),
    path.join(process.cwd(), 'src', file),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(`Could not find ${file}. Looked in:\n  ${candidates.join('\n  ')}`);
}

async function main(): Promise<void> {
  for (const file of FILES) {
    const sqlPath = resolveSqlPath(file);
    console.log(`Applying ${sqlPath}`);
    await pool.query(fs.readFileSync(sqlPath, 'utf8'));
  }
  console.log('Migrations applied.\n');

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'tax_invoice%'
     ORDER BY table_name`
  );
  console.log('Tables now present:');
  for (const r of tables.rows) console.log(`  - ${r.table_name}`);

  const seq = await pool.query(
    `SELECT sequencename FROM pg_sequences
     WHERE schemaname = 'public' AND sequencename = 'tax_invoice_no_seq'`
  );
  console.log(`Sequence tax_invoice_no_seq: ${seq.rowCount ? 'present' : 'MISSING'}`);

  const rateCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tax_invoice_parties'
       AND column_name IN ('rate_basis', 'rate')
     ORDER BY column_name`
  );
  console.log(`Party rate columns: ${rateCols.rows.map(r => r.column_name).join(', ') || 'MISSING'}`);

  // Confirm the pre-existing air tables are untouched and still readable.
  const untouched = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM mawbs)     AS mawbs,
       (SELECT COUNT(*) FROM hawbs)     AS hawbs,
       (SELECT COUNT(*) FROM users)     AS users,
       (SELECT COUNT(*) FROM locations) AS locations`
  );
  console.log('\nExisting tables still intact:', untouched.rows[0]);

  await pool.end();
}

main().catch(async (err) => {
  console.error('Migration failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
