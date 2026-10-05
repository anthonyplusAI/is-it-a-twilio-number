export class LookupServiceError extends Error {
  constructor(code) {
    super(code === 'service_unavailable'
      ? 'The lookup service is unavailable.'
      : 'The carrier lookup could not be completed.');
    this.name = 'LookupServiceError';
    this.code = code;
  }
}

export function createTwilioLookup({
  apiKeySid,
  apiKeySecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
}) {
  if (!apiKeySid || !apiKeySecret) throw new Error('Twilio API key credentials are required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const authorization = `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`;

  return async function lookup(e164) {
    if (typeof e164 !== 'string' || !/^\+[1-9]\d{1,14}$/u.test(e164)) {
      throw new LookupServiceError('lookup_failed');
    }
    const url = new URL(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}`);
    url.searchParams.set('Fields', 'line_type_intelligence');

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new LookupServiceError('lookup_failed');
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new LookupServiceError('lookup_failed');
    }

    if (!response.ok) {
      if (Number(payload?.code) === 60601) {
        return {
          valid: true,
          phone_number: e164,
          line_type_intelligence: { carrier_name: null, type: null, error_code: 60601 },
        };
      }
      if (response.status === 401 || response.status === 403) {
        throw new LookupServiceError('service_unavailable');
      }
      throw new LookupServiceError('lookup_failed');
    }

    if (!payload || typeof payload !== 'object' || typeof payload.valid !== 'boolean') {
      throw new LookupServiceError('lookup_failed');
    }
    return payload;
  };
}
