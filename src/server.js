import { createApp } from './app.js';
import { createTwilioLookup } from './lookup.js';
import { createQuotaLimiter, createTableClientFromEnv } from './quota.js';
import { createReadinessProbe } from './readiness.js';

function configuredLimit(name, fallback) {
  return process.env[name] === undefined ? fallback : Number(process.env[name]);
}

try {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');

  const tableClient = createTableClientFromEnv();
  const twilioKeySid = process.env.TWILIO_API_KEY_SID;
  const twilioKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const hashSecret = process.env.IP_HASH_SECRET;

  if (process.env.NODE_ENV === 'production'
    && (!tableClient || !twilioKeySid || !twilioKeySecret || !hashSecret)) {
    throw new Error('Production lookup configuration is incomplete');
  }

  let quotaLimiter;
  if (tableClient) {
    quotaLimiter = createQuotaLimiter({
      tableClient,
      hashSecret,
      maxPerIpHour: configuredLimit('MAX_LOOKUPS_PER_IP_HOUR', 5),
      maxPerDay: configuredLimit('MAX_LOOKUPS_PER_DAY', 100),
    });
  }
  const lookup = twilioKeySid && twilioKeySecret
    ? createTwilioLookup({ apiKeySid: twilioKeySid, apiKeySecret: twilioKeySecret })
    : null;
  const readinessProbe = createReadinessProbe({
    tableClient,
    lookupConfigured: Boolean(quotaLimiter && lookup),
  });

  const server = createApp({ quotaLimiter, lookup, readinessProbe })
    .listen(port, '0.0.0.0', (error) => {
      if (error) {
        process.stderr.write('Startup failed: HTTP listener is unavailable.\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`Listening on port ${port}\n`);
    });
  process.on('SIGTERM', () => server.close());
} catch {
  process.stderr.write('Startup failed: lookup configuration or quota storage is unavailable.\n');
  process.exitCode = 1;
}
