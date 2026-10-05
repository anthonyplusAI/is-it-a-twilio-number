import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyLookupResponse, normalizePhoneNumber } from '../src/phone.js';

test('normalizes a ten digit US number before a paid lookup', () => {
  assert.deepEqual(normalizePhoneNumber('(415) 992-9960'), {
    e164: '+14159929960',
    nationalFormat: '(415) 992-9960',
  });
});

test('accepts an international number when its country code is explicit', () => {
  assert.equal(normalizePhoneNumber('+44 20 7946 0958').e164, '+442079460958');
});

test('rejects an ambiguous non-US national number', () => {
  assert.equal(normalizePhoneNumber('020 7946 0958'), null);
});

test('rejects letters and extension text instead of looking up a different number', () => {
  assert.equal(normalizePhoneNumber('+1 415 992 9960 ext 123'), null);
});

test('reports a Twilio carrier name as a signal, not proof of hosting', () => {
  const result = classifyLookupResponse({
    valid: true,
    line_type_intelligence: {
      carrier_name: 'Twilio - SMS/MMS-SVR',
      type: 'nonFixedVoip',
      error_code: null,
    },
  });
  assert.equal(result.status, 'twilio_signal');
  assert.match(result.reason, /not proof that Twilio hosts the number/i);
});

test('a different carrier cannot rule out Twilio hosting', () => {
  const result = classifyLookupResponse({
    valid: true,
    line_type_intelligence: {
      carrier_name: 'T-Mobile USA',
      type: 'mobile',
      error_code: null,
    },
  });
  assert.equal(result.status, 'no_signal');
  assert.match(result.reason, /may still use Twilio services/i);
});

test('missing or unavailable carrier data stays inconclusive', () => {
  assert.equal(classifyLookupResponse({
    valid: true,
    line_type_intelligence: { carrier_name: null, type: 'tollFree', error_code: null },
  }).status, 'unavailable');
  assert.equal(classifyLookupResponse({
    valid: true,
    line_type_intelligence: { carrier_name: null, type: null, error_code: 60601 },
  }).status, 'unavailable');
});

test('Canadian carrier authorization gap is explained without implying a negative', () => {
  const result = classifyLookupResponse({
    valid: true,
    country_code: 'CA',
    line_type_intelligence: { carrier_name: null, type: null, error_code: 60601 },
  });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /Canadian carrier data requires separate authorization/i);
});
