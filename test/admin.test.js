import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminAuth } from '../src/admin-auth.js';
import { createApp } from '../src/app.js';

const PASSWORD = 'test-only-admin-password-with-32-characters';
const SAMPLE_METRICS = {
  timezone: 'UTC',
  generatedAt: '2026-10-06T12:00:00.000Z',
  dailyLimit: 100,
  totals: { today: 2, last7Days: 7, last30Days: 14 },
  outcomes: { twilio_signal: 2, no_signal: 3, unavailable: 1, failed: 1, untracked: 7 },
  days: [{ date: '2026-10-06', attempts: 2 }],
};

async function startApp(t, options = {}) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function basic(password = PASSWORD) {
  return `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
}

test('admin dashboard and metrics require the configured password', async (t) => {
  const baseUrl = await startApp(t, {
    adminAuth: createAdminAuth({ password: PASSWORD }),
    metricsStore: { summary: async () => SAMPLE_METRICS },
    dailyLimit: 100,
  });

  const redirect = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/admin/');

  for (const path of ['/admin/', '/admin/metrics']) {
    const denied = await fetch(`${baseUrl}${path}`);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') || '', /Basic realm=/);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
  }

  const page = await fetch(`${baseUrl}/admin/`, { headers: { Authorization: basic() } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Lookups|Activity|Metrics/i);

  const metrics = await fetch(`${baseUrl}/admin/metrics`, { headers: { Authorization: basic() } });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await metrics.json(), SAMPLE_METRICS);

  for (const path of ['/admin.html', '/admin%2Ehtml', '/%61dmin.html', '//admin.html']) {
    const bypass = await fetch(`${baseUrl}${path}`);
    assert.equal(bypass.status, 404, `${path} must not serve the dashboard HTML`);
  }
});

test('bad admin passwords are throttled and never reveal metrics', async (t) => {
  let now = 0;
  let summaries = 0;
  const baseUrl = await startApp(t, {
    adminAuth: createAdminAuth({
      password: PASSWORD,
      maxFailures: 3,
      windowMs: 60_000,
      clock: () => now,
    }),
    metricsStore: { summary: async () => { summaries += 1; return SAMPLE_METRICS; } },
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${baseUrl}/admin/metrics`, {
      headers: { Authorization: basic('wrong-password') },
    });
    assert.equal(response.status, 401);
  }
  const blocked = await fetch(`${baseUrl}/admin/metrics`, {
    headers: { Authorization: basic() },
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal(summaries, 0);

  now = 60_001;
  const allowed = await fetch(`${baseUrl}/admin/metrics`, {
    headers: { Authorization: basic() },
  });
  assert.equal(allowed.status, 200);
  assert.equal(summaries, 1);
});

test('a long Unicode password remains usable within the supported password length', async (t) => {
  const password = '漢'.repeat(200);
  const baseUrl = await startApp(t, {
    adminAuth: createAdminAuth({ password }),
    metricsStore: { summary: async () => SAMPLE_METRICS },
  });

  const response = await fetch(`${baseUrl}/admin/metrics`, {
    headers: { Authorization: basic(password) },
  });
  assert.equal(response.status, 200);
});

test('admin metrics fail closed when unconfigured or storage is unavailable', async (t) => {
  const unconfigured = await startApp(t, {});
  assert.equal((await fetch(`${unconfigured}/admin/metrics`)).status, 503);

  const configured = await startApp(t, {
    adminAuth: createAdminAuth({ password: PASSWORD }),
    metricsStore: { summary: async () => { throw new Error('private table details'); } },
  });
  const response = await fetch(`${configured}/admin/metrics`, {
    headers: { Authorization: basic() },
  });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private table details/);
});
