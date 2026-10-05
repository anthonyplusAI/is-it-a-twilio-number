import assert from 'node:assert/strict';
import test from 'node:test';

import { createTwilioLookup } from '../src/lookup.js';

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

test('requests only Line Type Intelligence with server-held API key credentials', async () => {
  let request;
  const lookup = createTwilioLookup({
    apiKeySid: 'SKtest',
    apiKeySecret: 'test-secret',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return Response.json(TWILIO_RESPONSE);
    },
  });

  assert.deepEqual(await lookup('+14159929960'), TWILIO_RESPONSE);
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://lookups.twilio.com');
  assert.equal(url.pathname, '/v2/PhoneNumbers/%2B14159929960');
  assert.equal(url.searchParams.get('Fields'), 'line_type_intelligence');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization,
    `Basic ${Buffer.from('SKtest:test-secret').toString('base64')}`);
});

test('treats Canadian carrier authorization error as unavailable data', async () => {
  const lookup = createTwilioLookup({
    apiKeySid: 'SKtest',
    apiKeySecret: 'test-secret',
    fetchImpl: async () => Response.json({ code: 60601, message: 'authorization required' }, { status: 400 }),
  });
  const result = await lookup('+14165550123');
  assert.equal(result.valid, true);
  assert.equal(result.line_type_intelligence.error_code, 60601);
});

test('does not expose upstream authentication errors', async () => {
  const lookup = createTwilioLookup({
    apiKeySid: 'SKtest',
    apiKeySecret: 'test-secret',
    fetchImpl: async () => Response.json({ message: 'private upstream detail' }, { status: 401 }),
  });
  await assert.rejects(lookup('+14159929960'), (error) =>
    error.code === 'service_unavailable' && !error.message.includes('private upstream detail'));
});

test('turns a network failure into a safe upstream error', async () => {
  const lookup = createTwilioLookup({
    apiKeySid: 'SKtest',
    apiKeySecret: 'test-secret',
    fetchImpl: async () => { throw new Error('URL contains +14159929960'); },
  });
  await assert.rejects(lookup('+14159929960'), (error) =>
    error.code === 'lookup_failed' && !error.message.includes('+14159929960'));
});
