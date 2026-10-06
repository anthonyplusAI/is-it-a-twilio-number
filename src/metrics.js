import { setTimeout as delay } from 'node:timers/promises';

const OUTCOMES = ['twilio_signal', 'no_signal', 'unavailable', 'failed'];
const OUTCOME_SET = new Set(OUTCOMES);
const DAY_MS = 24 * 60 * 60 * 1000;

function hasStatus(error, status) {
  return error?.statusCode === status || error?.status === status;
}

function isTableNotFound(error) {
  return error?.code === 'TableNotFound'
    || error?.details?.errorCode === 'TableNotFound'
    || error?.response?.headers?.get?.('x-ms-error-code') === 'TableNotFound'
    || error?.response?.headers?.['x-ms-error-code'] === 'TableNotFound';
}

function currentTime(clock) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Metrics clock is invalid');
  }
  return now;
}

function validatedDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
    throw new Error('Invalid metrics day');
  }
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error('Invalid metrics day');
  }
  return day;
}

function emptyCounts() {
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
}

function parseCounts(entity) {
  if (typeof entity?.counts !== 'string') throw new Error('Invalid metrics entity');
  let stored;
  try {
    stored = JSON.parse(entity.counts);
  } catch {
    throw new Error('Invalid metrics entity');
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('Invalid metrics entity');
  }
  const counts = emptyCounts();
  for (const [outcome, count] of Object.entries(stored)) {
    if (!OUTCOME_SET.has(outcome) || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid metrics entity');
    }
    counts[outcome] = count;
  }
  return counts;
}

async function getIfPresent(tableClient, day, rowKey) {
  try {
    return await tableClient.getEntity(day, rowKey);
  } catch (error) {
    if (hasStatus(error, 404) && !isTableNotFound(error)) return null;
    throw error;
  }
}

function parseAttempts(entity) {
  if (!entity) return 0;
  if (!Number.isSafeInteger(entity.total) || entity.total < 0) {
    throw new Error('Invalid quota entity');
  }
  return entity.total;
}

export function createMetricsStore({
  tableClient,
  clock = () => new Date(),
  maxRetries = 64,
}) {
  if (!tableClient) throw new Error('A metrics table client is required');
  if (typeof clock !== 'function') throw new Error('Metrics clock is invalid');
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error('Metrics maxRetries must be a positive integer');
  }

  return {
    async record(outcome, reservationDay) {
      if (!OUTCOME_SET.has(outcome)) throw new Error('Invalid lookup outcome');
      const day = reservationDay === undefined
        ? currentTime(clock).toISOString().slice(0, 10)
        : validatedDay(reservationDay);

      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const current = await getIfPresent(tableClient, day, 'outcomes');
        const counts = current ? parseCounts(current) : emptyCounts();
        if (current && !current.etag) throw new Error('Invalid metrics entity');
        counts[outcome] += 1;

        try {
          const entity = {
            partitionKey: day,
            rowKey: 'outcomes',
            counts: JSON.stringify(counts),
          };
          if (current) {
            await tableClient.updateEntity(entity, 'Replace', { etag: current.etag });
          } else {
            await tableClient.createEntity(entity);
          }
          return;
        } catch (error) {
          if (!hasStatus(error, current ? 412 : 409)) throw error;
        }

        await delay(Math.min(10, attempt + 1) + Math.floor(Math.random() * 4));
      }
      throw new Error('Metrics update was too busy');
    },

    async summary({ dailyLimit }) {
      if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) {
        throw new Error('dailyLimit must be a positive integer');
      }
      const now = currentTime(clock);
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const dates = Array.from({ length: 30 }, (_, index) =>
        new Date(today - (29 - index) * DAY_MS).toISOString().slice(0, 10));

      // An entity read returns 404 for both a missing row and a missing table.
      // This probe lets an empty table show zero while a deleted table fails closed.
      await tableClient
        .listEntities({ queryOptions: { select: ['PartitionKey'] } })
        .byPage({ maxPageSize: 1 })
        .next();

      const rows = await Promise.all(dates.map(async (date) => {
        // A reservation is written before its outcome. Reading outcomes first
        // prevents a newer outcome from being paired with an older quota count.
        const outcomes = await getIfPresent(tableClient, date, 'outcomes');
        const quota = await getIfPresent(tableClient, date, 'quota');
        return { date, attempts: parseAttempts(quota), counts: outcomes ? parseCounts(outcomes) : emptyCounts() };
      }));

      const outcomes = { ...emptyCounts(), untracked: 0 };
      let last30Days = 0;
      let last7Days = 0;
      for (const [index, row] of rows.entries()) {
        last30Days += row.attempts;
        if (index >= 23) last7Days += row.attempts;
        for (const outcome of OUTCOMES) outcomes[outcome] += row.counts[outcome];
      }
      const tracked = OUTCOMES.reduce((sum, outcome) => sum + outcomes[outcome], 0);
      outcomes.untracked = Math.max(0, last30Days - tracked);

      return {
        timezone: 'UTC',
        generatedAt: now.toISOString(),
        dailyLimit,
        totals: { today: rows[29].attempts, last7Days, last30Days },
        outcomes,
        days: rows.map(({ date, attempts }) => ({ date, attempts })),
      };
    },
  };
}
