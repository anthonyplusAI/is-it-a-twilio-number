#!/usr/bin/env node

import { normalizePhoneNumber, classifyLookupResponse } from '../src/phone.js';
import { createTwilioLookup } from '../src/lookup.js';

const input = process.argv.slice(2).join(' ').trim();
if (!input) {
  console.error('Usage: npm run check -- "+14155552671"');
  process.exitCode = 2;
} else {
  const phone = normalizePhoneNumber(input);
  if (!phone) {
    console.error('Enter a valid US 10-digit number or an international number starting with +.');
    process.exitCode = 2;
  } else if (!process.env.TWILIO_API_KEY_SID || !process.env.TWILIO_API_KEY_SECRET) {
    console.error('Set TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET before checking a number.');
    process.exitCode = 2;
  } else {
    try {
      const lookup = createTwilioLookup({
        apiKeySid: process.env.TWILIO_API_KEY_SID,
        apiKeySecret: process.env.TWILIO_API_KEY_SECRET,
      });
      const raw = await lookup(phone.e164);
      if (raw.valid === false) {
        console.error('Twilio could not validate this number.');
        process.exitCode = 2;
      } else {
        const result = classifyLookupResponse(raw);
        const headline = {
          twilio_signal: 'Twilio appears in carrier data',
          no_signal: 'Another carrier appears',
          unavailable: 'No carrier name returned',
        }[result.status];

        console.log(`${headline}\nNumber: ${phone.e164}`);
        if (result.carrierName) console.log(`Carrier: ${result.carrierName}`);
        if (result.lineType) console.log(`Line type: ${result.lineType}`);
        if (result.reason) console.log(result.reason);
      }
    } catch {
      console.error('The Twilio lookup could not be completed. Check credentials and try again.');
      process.exitCode = 1;
    }
  }
}
