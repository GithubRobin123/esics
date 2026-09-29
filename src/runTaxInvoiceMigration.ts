/**
 * Applies schema_v8_tax_invoices.sql to the main application database.
 *
 *   npm run migrate:tax-invoice
 *
 * The migration is fully idempotent (every statement is IF NOT EXISTS), so
 * re-running it is safe. It only CREATEs new `tax_invoice*` objects — it never
 * alters or drops anything belonging to the existing air system.
 */

import fs from 'fs';
import path from 'path';
import pool from './db';

const FILE = 'schema_v8_tax_invoices.sql';

function resolveSqlPath(): string {
  // Works both under ts-node (src/) and from a compiled dist/ build.
  const candidates = [
    path.join(__dirname, FILE),
    path.join(__dirname, '..', 'src', FILE),
    path.join(process.cwd(), 'src', FILE),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(`Could not find ${FILE}. Looked in:\n  ${candidates.join('\n  ')}`);
}

async function main(): Promise<void> {
  const sqlPath = resolveSqlPath();
  console.log(`Applying ${sqlPath}`);

  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
  console.log('Migration applied.\n');

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
