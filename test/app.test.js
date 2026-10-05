import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/app.js';

const TWILIO_RESPONSE = {
  calling_country_code: '1',
  country_code: 'US',
  phone_number: '+14159929960',
  national_format: '(415) 992-9960',
  valid: true,
  validation_errors: null,
  line_type_intelligence: {
    error_code: null,
    mobile_country_code: '240',
    mobile_network_code: '38',
    carrier_name: 'Twilio - SMS/MMS-SVR',
    type: 'nonFixedVoip',
  },
};

async function startApp(t, options) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function submit(baseUrl, phoneNumber) {
  return fetch(`${baseUrl}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  });
}

test('health check is available without making a paid lookup', async (t) => {
  const baseUrl = await startApp(t, {});
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('readiness returns 200 only after its storage probe succeeds', async (t) => {
  const baseUrl = await startApp(t, {
    quotaLimiter: { reserve: async () => ({ allowed: true }) },
    lookup: async () => TWILIO_RESPONSE,
    readinessProbe: { check: async () => true },
  });
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('readiness hides storage failures and returns 503', async (t) => {
  const baseUrl = await startApp(t, {
    quotaLimiter: { reserve: async () => ({ allowed: true }) },
    lookup: async () => TWILIO_RESPONSE,
    readinessProbe: { check: async () => { throw new Error('private Azure detail'); } },
  });
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ready: false });
});

test('readiness refuses a successful table probe when lookup is not configured', async (t) => {
  const baseUrl = await startApp(t, { readinessProbe: { check: async () => true } });
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ready: false });
});

test('returns an honest Twilio signal and normalized number', async (t) => {
  const baseUrl = await startApp(t, {
    quotaLimiter: { reserve: async () => ({ allowed: true }) },
    lookup: async () => TWILIO_RESPONSE,
  });
  const response = await submit(baseUrl, '(415) 992-9960');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'twilio_signal');
  assert.equal(body.e164, '+14159929960');
  assert.equal(body.nationalFormat, '(415) 992-9960');
  assert.equal(body.carrierName, 'Twilio - SMS/MMS-SVR');
  assert.equal(body.lineType, 'nonFixedVoip');
  assert.match(body.reason, /not proof/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('invalid input is rejected before consuming quota or calling Twilio', async (t) => {
  let externalCalls = 0;
  const baseUrl = await startApp(t, {
    quotaLimiter: { reserve: async () => { externalCalls += 1; return { allowed: true }; } },
    lookup: async () => { externalCalls += 1; return TWILIO_RESPONSE; },
  });
  const response = await submit(baseUrl, 'not a phone number');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_number');
  assert.equal(externalCalls, 0);
});

test('quota denial stops a billable lookup and tells the visitor when to retry', async (t) => {
  let lookupCalls = 0;
  const baseUrl = await startApp(t, {
    quotaLimiter: { reserve: async () => ({ allowed: false, retryAfterSeconds: 240 }) },
    lookup: async () => { lookupCalls += 1; return TWILIO_RESPONSE; },
  });
  const response = await submit(baseUrl, '+14159929960');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '240');
  assert.deepEqual(await response.json(), {
    error: { code: 'rate_limited', message: 'Lookup limit reached. Please try again later.', retryAfterSeconds: 240 },
  });
  assert.equal(lookupCalls, 0);
});

test('quota uses the trusted rightmost forwarded IP, not a forged earlier value', async (t) => {
  let reservedIp;
  const baseUrl = await startApp(t, {
    quotaLimiter: {
      reserve: async (ip) => {
        reservedIp = ip;
        return { allowed: true };
      },
    },
    lookup: async () => TWILIO_RESPONSE,
  });
  const response = await fetch(`${baseUrl}/api/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.12, 203.0.113.45',
    },
    body: JSON.stringify({ phoneNumber: '+14159929960' }),
  });
  assert.equal(response.status, 200);
  assert.equal(reservedIp, '203.0.113.45');
});

test('a storage outage fails closed without calling Twilio', async (t) => {
  let lookupCalls = 0;
  const baseUrl = await startApp(t, {
    quotaLimiter: { reserve: async () => { throw new Error('private storage detail'); } },
    lookup: async () => { lookupCalls += 1; return TWILIO_RESPONSE; },
  });
  const response = await submit(baseUrl, '+14159929960');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'service_unavailable');
  assert.equal(lookupCalls, 0);
});

test('an upstream failure returns a safe error without exposing provider details', async (t) => {
  const baseUrl = await startApp(t, {
    quotaLimiter: { reserve: async () => ({ allowed: true }) },
    lookup: async () => { throw new Error('private number +14159929960 and credential'); },
  });
  const response = await submit(baseUrl, '+14159929960');
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'lookup_failed');
  assert.doesNotMatch(JSON.stringify(body), /14159929960|credential/);
});

test('missing server configuration fails closed', async (t) => {
  const baseUrl = await startApp(t, {});
  const response = await submit(baseUrl, '+14159929960');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'service_unavailable');
});
