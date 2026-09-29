import dns from 'dns';
dns.setDefaultResultOrder('ipv4first'); // Fix: Supabase ENOTFOUND on Windows Node.js

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pool from './db';

import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import profileRoutes from './routes/profiles';
import mawbRoutes from './routes/mawbs';
import hawbRoutes from './routes/hawbs';
import transmissionRoutes from './routes/transmissions';
import locationRoutes from './routes/locations';
import igmRoutes from './routes/igm';
import egmRoutes from './routes/egm';
import reportsRoutes from './routes/reports';
import taxInvoiceRoutes from './routes/taxInvoices';
import path from 'path/win32';
import { logger, sanitizeBody } from './utils/logger';
import { applyAppEnv } from './utils/env';

dotenv.config();
const appEnv = applyAppEnv();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Request logger ────────────────────────────────────────────────────────────
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const msg = `${req.method} ${req.path} → ${status} (${ms}ms)`;
    if (status >= 500) {
      logger.error('HTTP', msg);
    } else if (status >= 400) {
      logger.warn('HTTP', msg, {
        query: req.query,
        body: sanitizeBody(req.body),
      });
    } else {
      logger.info('HTTP', msg);
    }
  });
  next();
});

// Health check
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('SERVER', 'Health check failed', error);
    res.status(500).json({ status: 'ERROR', timestamp: new Date().toISOString() });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/mawbs', mawbRoutes);
app.use('/api/hawbs', hawbRoutes);
app.use('/api/transmissions', transmissionRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/igm', igmRoutes);
app.use('/api/egm', egmRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/tax-invoices', taxInvoiceRoutes);

// 404 handler
app.use((req: express.Request, res: express.Response) => {
  logger.warn('HTTP', `404 Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ message: 'Route not found' });
});

// Serve React Static Files
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// Handle React Routing (SPA)
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('EXPRESS', 'Unhandled error', err);
  res.status(500).json({ message: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info('SERVER', `EDISS Backend running on http://localhost:${PORT}`, {
    env: appEnv,
    port: PORT,
  });
});

export default app;
