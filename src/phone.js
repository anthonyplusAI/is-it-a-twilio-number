import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalizePhoneNumber(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 40 || !/^[+\d().\s-]+$/u.test(trimmed)) return null;

  let candidate;
  if (trimmed.startsWith('+')) {
    if (!/^\+[\d().\s-]+$/u.test(trimmed)) return null;
    candidate = trimmed;
  } else {
    const digits = trimmed.replace(/\D/gu, '');
    if (digits.length === 10) candidate = digits;
    else if (digits.length === 11 && digits.startsWith('1')) candidate = `+${digits}`;
    else return null;
  }

  const parsed = parsePhoneNumberFromString(candidate, 'US');
  if (!parsed?.isValid()) return null;
  return { e164: parsed.number, nationalFormat: parsed.formatNational() };
}

export function classifyLookupResponse(lookupData) {
  const lineTypeInfo = lookupData?.line_type_intelligence;
  const carrierName = typeof lineTypeInfo?.carrier_name === 'string'
    ? lineTypeInfo.carrier_name.trim().slice(0, 120) || null
    : null;
  const lineType = typeof lineTypeInfo?.type === 'string'
    ? lineTypeInfo.type.trim().slice(0, 40) || null
    : null;

  if (Number(lineTypeInfo?.error_code) === 60601) {
    return {
      status: 'unavailable',
      carrierName: null,
      lineType,
      reason: 'Canadian carrier data requires separate authorization, so Lookup returned no carrier name for this check.',
    };
  }

  if (lineTypeInfo?.error_code != null || !carrierName) {
    return {
      status: 'unavailable',
      carrierName: null,
      lineType,
      reason: 'Lookup returned no usable carrier name, so there is no carrier signal to assess.',
    };
  }

  if (/\btwilio\b/iu.test(carrierName)) {
    return {
      status: 'twilio_signal',
      carrierName,
      lineType,
      reason: 'Lookup returned a carrier name containing Twilio. This is a clue, not proof that Twilio hosts the number.',
    };
  }

  return {
    status: 'no_signal',
    carrierName,
    lineType,
    reason: 'Lookup returned a different carrier. The number may still use Twilio services.',
  };
}
