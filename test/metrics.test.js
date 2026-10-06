import assert from 'node:assert/strict';
import test from 'node:test';

import { createMetricsStore } from '../src/metrics.js';

class FakeTable {
  entities = new Map();
  tableExists = true;

  listEntities() {
    return {
      byPage: () => ({
        next: async () => {
          if (!this.tableExists) {
            throw Object.assign(new Error('TableNotFound'), {
              statusCode: 404,
              code: 'TableNotFound',
            });
          }
          return { value: [], done: false };
        },
      }),
    };
  }

  seed(entity) {
    this.entities.set(`${entity.partitionKey}/${entity.rowKey}`, {
      ...structuredClone(entity),
      etag: '"1"',
    });
  }

  async getEntity(partitionKey, rowKey) {
    await Promise.resolve();
    if (!this.tableExists) {
      throw Object.assign(new Error('TableNotFound'), {
        statusCode: 404,
        code: 'TableNotFound',
      });
    }
    const entity = this.entities.get(`${partitionKey}/${rowKey}`);
    if (!entity) throw Object.assign(new Error('EntityNotFound'), { statusCode: 404, code: 'EntityNotFound' });
    return structuredClone(entity);
  }

  async createEntity(entity) {
    await Promise.resolve();
    const key = `${entity.partitionKey}/${entity.rowKey}`;
    if (this.entities.has(key)) throw { statusCode: 409 };
    this.seed(entity);
  }

  async updateEntity(entity, mode, options) {
    await Promise.resolve();
    assert.equal(mode, 'Replace');
    const key = `${entity.partitionKey}/${entity.rowKey}`;
    const current = this.entities.get(key);
    if (!current || options?.etag !== current.etag) throw { statusCode: 412 };
    const nextEtag = `"${Number(current.etag.replaceAll('"', '')) + 1}"`;
    this.entities.set(key, { ...structuredClone(entity), etag: nextEtag });
  }
}

function store(table, now = '2026-10-06T00:15:00.000Z') {
  return createMetricsStore({ tableClient: table, clock: () => new Date(now) });
}

test('records one aggregate outcome in the UTC day without copying quota details', async () => {
  const table = new FakeTable();
  table.seed({
    partitionKey: '2026-10-06',
    rowKey: 'quota',
    total: 1,
    ipHourCounts: '{"00:private-hash":1}',
  });

  await store(table).record('twilio_signal');

  const outcomeRow = await table.getEntity('2026-10-06', 'outcomes');
  assert.deepEqual(JSON.parse(outcomeRow.counts), {
    twilio_signal: 1,
    no_signal: 0,
    unavailable: 0,
    failed: 0,
  });
  assert.deepEqual(Object.keys(outcomeRow).sort(), ['counts', 'etag', 'partitionKey', 'rowKey']);
  assert.doesNotMatch(JSON.stringify(outcomeRow), /private-hash|ipHourCounts|phoneNumber/);
  assert.equal((await table.getEntity('2026-10-06', 'quota')).total, 1);
});

test('concurrent outcome records preserve every increment through ETag conflicts', async () => {
  const table = new FakeTable();
  const metrics = store(table);

  await Promise.all(Array.from({ length: 20 }, () => metrics.record('no_signal')));

  const row = await table.getEntity('2026-10-06', 'outcomes');
  assert.equal(JSON.parse(row.counts).no_signal, 20);
});

test('records an outcome on the reservation day when the UTC clock has crossed midnight', async () => {
  const table = new FakeTable();
  const metrics = store(table, '2026-10-06T00:00:01.000Z');

  await metrics.record('failed', '2026-10-05');

  const row = await table.getEntity('2026-10-05', 'outcomes');
  assert.equal(JSON.parse(row.counts).failed, 1);
  assert.equal(table.entities.has('2026-10-06/outcomes'), false);
});

test('rejects an invalid explicit reservation day before writing metrics', async () => {
  const table = new FakeTable();
  const metrics = store(table);

  await assert.rejects(metrics.record('failed', '2026-02-30'), /Invalid metrics day/);
  await assert.rejects(metrics.record('failed', '2026-10-6'), /Invalid metrics day/);
  assert.equal(table.entities.size, 0);
});

test('summary uses UTC days, 7 and 30 day windows, and counts older reservations as untracked', async () => {
  const table = new FakeTable();
  const quotas = [
    ['2026-09-07', 2],
    ['2026-09-29', 3],
    ['2026-09-30', 5],
    ['2026-10-05', 7],
    ['2026-10-06', 11],
  ];
  for (const [date, total] of quotas) {
    table.seed({ partitionKey: date, rowKey: 'quota', total, ipHourCounts: '{"private-hash":1}' });
  }
  table.seed({ partitionKey: '2026-09-07', rowKey: 'outcomes', counts: '{"twilio_signal":1}' });
  table.seed({ partitionKey: '2026-09-29', rowKey: 'outcomes', counts: '{"no_signal":2}' });
  table.seed({ partitionKey: '2026-09-30', rowKey: 'outcomes', counts: '{"unavailable":2}' });
  table.seed({ partitionKey: '2026-10-05', rowKey: 'outcomes', counts: '{"failed":1}' });
  table.seed({ partitionKey: '2026-10-06', rowKey: 'outcomes', counts: '{"twilio_signal":4}' });

  const result = await store(table).summary({ dailyLimit: 100 });

  assert.equal(result.timezone, 'UTC');
  assert.equal(result.generatedAt, '2026-10-06T00:15:00.000Z');
  assert.equal(result.dailyLimit, 100);
  assert.deepEqual(result.totals, { today: 11, last7Days: 23, last30Days: 28 });
  assert.deepEqual(result.outcomes, {
    twilio_signal: 5,
    no_signal: 2,
    unavailable: 2,
    failed: 1,
    untracked: 18,
  });
  assert.equal(result.days.length, 30);
  assert.deepEqual(result.days[0], { date: '2026-09-07', attempts: 2 });
  assert.deepEqual(result.days[1], { date: '2026-09-08', attempts: 0 });
  assert.deepEqual(result.days[22], { date: '2026-09-29', attempts: 3 });
  assert.deepEqual(result.days[23], { date: '2026-09-30', attempts: 5 });
  assert.deepEqual(result.days[28], { date: '2026-10-05', attempts: 7 });
  assert.deepEqual(result.days[29], { date: '2026-10-06', attempts: 11 });
  assert.doesNotMatch(JSON.stringify(result), /private-hash|ipHourCounts/);
});

test('summary counts a missing row as zero but surfaces other storage errors', async () => {
  const missing = await store(new FakeTable()).summary({ dailyLimit: 100 });
  assert.deepEqual(missing.totals, { today: 0, last7Days: 0, last30Days: 0 });
  assert.deepEqual(missing.outcomes, {
    twilio_signal: 0,
    no_signal: 0,
    unavailable: 0,
    failed: 0,
    untracked: 0,
  });

  const offlineTable = new FakeTable();
  offlineTable.getEntity = async () => {
    throw Object.assign(new Error('storage offline'), { statusCode: 503 });
  };
  const offline = store(offlineTable);
  await assert.rejects(offline.summary({ dailyLimit: 100 }), /storage offline/);
});

test('summary fails when the table itself is missing with HTTP 404', async () => {
  const table = new FakeTable();
  table.tableExists = false;

  await assert.rejects(store(table).summary({ dailyLimit: 100 }), /TableNotFound/);
});

test('summary fails if the table disappears after its availability probe', async () => {
  const table = new FakeTable();
  table.listEntities = () => ({
    byPage: () => ({
      next: async () => {
        table.tableExists = false;
        return { value: [], done: false };
      },
    }),
  });

  await assert.rejects(store(table).summary({ dailyLimit: 100 }), /TableNotFound/);
});

test('summary reads outcomes before quota so an observed outcome has its reservation count', async () => {
  const table = new FakeTable();
  table.seed({ partitionKey: '2026-10-06', rowKey: 'quota', total: 0, ipHourCounts: '{}' });
  table.seed({ partitionKey: '2026-10-06', rowKey: 'outcomes', counts: '{"twilio_signal":1}' });
  const getEntity = table.getEntity.bind(table);
  table.getEntity = async (day, rowKey) => {
    const entity = await getEntity(day, rowKey);
    if (day === '2026-10-06' && rowKey === 'outcomes') {
      table.seed({ partitionKey: day, rowKey: 'quota', total: 1, ipHourCounts: '{}' });
    }
    return entity;
  };

  const result = await store(table).summary({ dailyLimit: 100 });

  assert.equal(result.totals.today, 1);
  assert.equal(result.outcomes.twilio_signal, 1);
});

test('record rejects unknown outcomes and does not overwrite corrupt stored counts', async () => {
  const table = new FakeTable();
  const metrics = store(table);
  await assert.rejects(metrics.record('carrier_name'), /Invalid lookup outcome/);
  table.seed({ partitionKey: '2026-10-06', rowKey: 'outcomes', counts: '{broken' });
  await assert.rejects(metrics.record('failed'), /Invalid metrics entity/);
  assert.equal((await table.getEntity('2026-10-06', 'outcomes')).counts, '{broken');
});
