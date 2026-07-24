import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import dotenv from 'dotenv';
import { logger, getCallerLocation } from './utils/logger';
import { applyAppEnv } from './utils/env';

// Allow self-signed certificates for Supabase pooler connection
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

dotenv.config();
applyAppEnv();

// Shared invoices database — holds the `invoices` table + `invoice_no_seq`
// sequence used by BOTH the air and sea backends, so invoice numbers are
// never duplicated across the two systems.
const host = process.env.INVOICES_DB_HOST || process.env.DB_HOST || 'localhost';
const port = parseInt(process.env.INVOICES_DB_PORT || process.env.DB_PORT || '5432');
const database = process.env.INVOICES_DB_NAME || 'ediss_invoices';
const user = process.env.INVOICES_DB_USER || process.env.DB_USER || 'postgres';
const password = process.env.INVOICES_DB_PASSWORD || process.env.DB_PASSWORD || '';
const isRemote = host.includes('supabase');

logger.info('INVOICES_DB', `Connecting to ${host}:${port}/${database} (${isRemote ? 'remote/supabase' : 'local'})`);

const pool = new Pool({
  host,
  port,
  database,
  user,
  password,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  ...(isRemote ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('connect', () => {
  logger.debug('INVOICES_DB', 'New client connected from pool');
});

pool.on('error', (err) => {
  logger.error('INVOICES_DB', 'Unexpected error on idle DB client', err);
});

type QueryArgs = [string, any[]?] | [{ text: string; values?: any[] }];

function loggedQuery<R extends QueryResultRow = any>(
  queryFn: (...args: any[]) => Promise<QueryResult<R>>,
  args: QueryArgs
): Promise<QueryResult<R>> {
  const caller = getCallerLocation();
  const start = Date.now();

  const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
  const params = typeof args[0] === 'string' ? (args[1] as any[] | undefined) : args[0].values;

  return queryFn(...args)
    .then((result) => {
      logger.query(sql, params, Date.now() - start, caller, 'OK');
      return result;
    })
    .catch((error) => {
      logger.query(sql, params, Date.now() - start, caller, 'ERROR');
      throw error;
    });
}

const invoicesDbProxy = new Proxy(pool, {
  get(target, prop) {
    if (prop === 'query') {
      return (...args: QueryArgs) => loggedQuery(target.query.bind(target), args);
    }

    if (prop === 'connect') {
      return () =>
        (target.connect() as Promise<PoolClient>).then((client) => {
          const clientQuery = client.query.bind(client);
          return new Proxy(client, {
            get(c, p) {
              if (p === 'query') {
                return (...args: QueryArgs) => loggedQuery(clientQuery, args);
              }
              return (c as any)[p];
            },
          });
        });
    }

    return (target as any)[prop];
  },
});

export default invoicesDbProxy;
