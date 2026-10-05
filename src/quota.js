import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { TableClient } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';

const MAX_DAILY_RESERVATIONS = 1000;

function hasStatus(error, status) {
  return error?.statusCode === status || error?.status === status;
}

function validateLimit(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DAILY_RESERVATIONS) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_DAILY_RESERVATIONS}`);
  }
}

function retryAfter(now, utcBoundary) {
  return Math.max(1, Math.ceil((utcBoundary.getTime() - now.getTime()) / 1000));
}

function parseCounts(raw) {
  const counts = JSON.parse(raw);
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error('Invalid quota entity');
  }
  for (const count of Object.values(counts)) {
    if (!Number.isInteger(count) || count < 0) throw new Error('Invalid quota entity');
  }
  return counts;
}

export function createTableClientFromEnv(env = process.env) {
  const tableName = env.LOOKUP_QUOTA_TABLE || 'LookupQuota';
  if (env.AZURE_TABLE_CONNECTION_STRING) {
    return TableClient.fromConnectionString(env.AZURE_TABLE_CONNECTION_STRING, tableName);
  }
  const accountName = env.AZURE_STORAGE_ACCOUNT_NAME;
  if (!accountName) return null;
  if (!/^[a-z0-9]{3,24}$/u.test(accountName)) {
    throw new Error('AZURE_STORAGE_ACCOUNT_NAME is invalid');
  }
  return new TableClient(
    `https://${accountName}.table.core.windows.net`,
    tableName,
    new DefaultAzureCredential(),
  );
}

export function createQuotaLimiter({
  tableClient,
  hashSecret,
  maxPerIpHour = 5,
  maxPerDay = 100,
  clock = () => new Date(),
  maxRetries = 64,
}) {
  if (!tableClient) throw new Error('A quota table client is required');
  if (typeof hashSecret !== 'string' || hashSecret.length < 32) {
    throw new Error('IP_HASH_SECRET must have at least 32 characters');
  }
  validateLimit(maxPerIpHour, 'MAX_LOOKUPS_PER_IP_HOUR');
  validateLimit(maxPerDay, 'MAX_LOOKUPS_PER_DAY');

  return {
    async reserve(ip) {
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('Quota clock is invalid');
      }
      const day = now.toISOString().slice(0, 10);
      const hour = now.getUTCHours().toString().padStart(2, '0');
      const ipHash = createHmac('sha256', hashSecret)
        .update(`${day}:${String(ip || 'unknown')}`)
        .digest('hex')
        .slice(0, 32);
      const ipHourKey = `${hour}:${ipHash}`;
      const nextHour = new Date(now);
      nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
      const nextDay = new Date(now);
      nextDay.setUTCHours(24, 0, 0, 0);

      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        let current;
        try {
          current = await tableClient.getEntity(day, 'quota');
        } catch (error) {
          if (!hasStatus(error, 404)) throw error;
        }

        if (!current) {
          try {
            await tableClient.createEntity({
              partitionKey: day,
              rowKey: 'quota',
              total: 1,
              ipHourCounts: JSON.stringify({ [ipHourKey]: 1 }),
            });
            return { allowed: true };
          } catch (error) {
            if (!hasStatus(error, 409)) throw error;
          }
        } else {
          if (!Number.isInteger(current.total) || current.total < 0
            || typeof current.ipHourCounts !== 'string' || !current.etag) {
            throw new Error('Invalid quota entity');
          }
          const counts = parseCounts(current.ipHourCounts);
          if (current.total >= maxPerDay) {
            return { allowed: false, retryAfterSeconds: retryAfter(now, nextDay) };
          }
          const ipHourCount = counts[ipHourKey] || 0;
          if (ipHourCount >= maxPerIpHour) {
            return { allowed: false, retryAfterSeconds: retryAfter(now, nextHour) };
          }

          counts[ipHourKey] = ipHourCount + 1;
          const ipHourCounts = JSON.stringify(counts);
          if (Buffer.byteLength(ipHourCounts, 'utf8') > 60_000) {
            throw new Error('Quota entity is full');
          }
          try {
            await tableClient.updateEntity({
              partitionKey: day,
              rowKey: 'quota',
              total: current.total + 1,
              ipHourCounts,
            }, 'Replace', { etag: current.etag });
            return { allowed: true };
          } catch (error) {
            if (!hasStatus(error, 412)) throw error;
          }
        }

        await delay(Math.min(10, attempt + 1) + Math.floor(Math.random() * 4));
      }
      throw new Error('Quota reservation was too busy');
    },
  };
}
