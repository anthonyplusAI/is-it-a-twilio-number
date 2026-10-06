import { fileURLToPath } from 'node:url';

import express from 'express';

import { classifyLookupResponse, normalizePhoneNumber } from './phone.js';

const defaultPublicDir = fileURLToPath(new URL('../public/', import.meta.url));
const adminHtml = fileURLToPath(new URL('./admin.html', import.meta.url));
const METRIC_WRITE_WAIT_MS = 400;

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

export function createApp({
  quotaLimiter,
  lookup,
  readinessProbe,
  metricsStore,
  adminAuth,
  dailyLimit = 100,
  publicDir = defaultPublicDir,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // ACA appends the client IP last in X-Forwarded-For; trust only its ingress hop.
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.get('/readyz', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!quotaLimiter || typeof lookup !== 'function' || !readinessProbe?.check) {
      return res.status(503).json({ ready: false });
    }
    try {
      const ready = await readinessProbe.check();
      return res.status(ready ? 200 : 503).json({ ready: Boolean(ready) });
    } catch {
      return res.status(503).json({ ready: false });
    }
  });

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', express.json({ limit: '1kb' }));

  app.get('/admin', (req, res, next) => {
    if (req.path === '/admin/') return next();
    return res.redirect(308, '/admin/');
  });
  app.use('/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!adminAuth || !metricsStore?.summary) {
      return res.status(503).send('Admin dashboard is unavailable.');
    }
    return adminAuth(req, res, next);
  });
  app.get('/admin/', (_req, res) => res.sendFile(adminHtml));
  app.get('/admin/metrics', async (_req, res) => {
    try {
      return res.json(await metricsStore.summary({ dailyLimit }));
    } catch {
      return sendError(res, 503, 'service_unavailable', 'Metrics are temporarily unavailable.');
    }
  });
  app.use('/admin', (_req, res) => res.status(404).send('This admin page does not exist.'));
  // The dashboard HTML lives outside the static directory; keep the obvious alias closed.
  app.get('/admin.html', (_req, res) => res.status(404).send('Not found.'));

  async function recordOutcome(outcome, day) {
    if (!metricsStore?.record) return;
    const pending = Promise.resolve().then(() => metricsStore.record(outcome, day)).catch(() => {
      process.stderr.write('Lookup outcome metric could not be recorded.\n');
    });
    let timer;
    await Promise.race([
      pending,
      new Promise((resolveTimer) => {
        timer = setTimeout(resolveTimer, METRIC_WRITE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  app.post('/api/check', async (req, res) => {
    const normalized = normalizePhoneNumber(req.body?.phoneNumber);
    if (!normalized) {
      return sendError(res, 400, 'invalid_number',
        'Enter a valid US number or an international number starting with +.');
    }
    if (!quotaLimiter || typeof lookup !== 'function') {
      return sendError(res, 503, 'service_unavailable', 'Lookups are temporarily unavailable.');
    }

    let reservation;
    try {
      reservation = await quotaLimiter.reserve(req.ip);
    } catch {
      return sendError(res, 503, 'service_unavailable', 'Lookups are temporarily unavailable.');
    }
    if (!reservation?.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(reservation?.retryAfterSeconds || 60));
      res.set('Retry-After', String(retryAfterSeconds));
      return sendError(res, 429, 'rate_limited', 'Lookup limit reached. Please try again later.', {
        retryAfterSeconds,
      });
    }

    let lookupData;
    try {
      lookupData = await lookup(normalized.e164);
    } catch (error) {
      await recordOutcome('failed', reservation.day);
      if (error?.code === 'service_unavailable') {
        return sendError(res, 503, 'service_unavailable', 'Lookups are temporarily unavailable.');
      }
      return sendError(res, 502, 'lookup_failed', 'The carrier lookup could not be completed.');
    }
    if (lookupData?.valid === false) {
      await recordOutcome('failed', reservation.day);
      return sendError(res, 400, 'invalid_number', 'This phone number could not be validated.');
    }
    if (lookupData?.valid !== true) {
      await recordOutcome('failed', reservation.day);
      return sendError(res, 502, 'lookup_failed', 'The carrier lookup could not be completed.');
    }

    const result = classifyLookupResponse(lookupData);
    await recordOutcome(result.status, reservation.day);
    return res.json({
      ...normalized,
      ...result,
    });
  });

  app.use('/api', (_req, res) =>
    sendError(res, 404, 'not_found', 'This API endpoint does not exist.'));
  app.use(express.static(publicDir, { index: 'index.html' }));
  app.use((error, req, res, _next) => {
    if (req.path.startsWith('/api/')) {
      if (error?.type === 'entity.parse.failed') {
        return sendError(res, 400, 'invalid_request', 'Send a valid JSON request.');
      }
      if (error?.type === 'entity.too.large') {
        return sendError(res, 413, 'invalid_request', 'The request is too large.');
      }
      return sendError(res, 500, 'server_error', 'The request could not be completed.');
    }
    return res.status(500).send('The page could not be loaded.');
  });
  return app;
}
