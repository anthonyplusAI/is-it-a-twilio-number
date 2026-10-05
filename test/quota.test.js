import assert from 'node:assert/strict';
import test from 'node:test';

import { createQuotaLimiter } from '../src/quota.js';

const HASH_SECRET = 'this-is-a-test-only-secret-with-more-than-32-characters';

class FakeTable {
  entities = new Map();

  async getEntity(partitionKey, rowKey) {
    await Promise.resolve();
    const entity = this.entities.get(`${partitionKey}/${rowKey}`);
    if (!entity) throw { statusCode: 404 };
    return structuredClone(entity);
  }

  async createEntity(entity) {
    await Promise.resolve();
    const key = `${entity.partitionKey}/${entity.rowKey}`;
    if (this.entities.has(key)) throw { statusCode: 409 };
    this.entities.set(key, { ...structuredClone(entity), etag: '"1"' });
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

function limiter(table, options = {}) {
  return createQuotaLimiter({
    tableClient: table,
    hashSecret: HASH_SECRET,
    maxPerIpHour: 2,
    maxPerDay: 10,
    clock: () => new Date('2026-10-05T12:00:00.000Z'),
    ...options,
  });
}

test('limits one IP per UTC hour while allowing another visitor', async () => {
  const table = new FakeTable();
  const quota = limiter(table);

  assert.equal((await quota.reserve('198.51.100.7')).allowed, true);
  assert.equal((await quota.reserve('198.51.100.7')).allowed, true);
  assert.deepEqual(await quota.reserve('198.51.100.7'), {
    allowed: false,
    retryAfterSeconds: 3600,
  });
  assert.equal((await quota.reserve('203.0.113.9')).allowed, true);

  const stored = [...table.entities.values()][0];
  assert.equal(stored.total, 3);
  assert.doesNotMatch(JSON.stringify(stored), /198\.51\.100\.7|203\.0\.113\.9/);
});

test('a global UTC day cap stops all visitors before another billable request', async () => {
  const quota = limiter(new FakeTable(), { maxPerIpHour: 10, maxPerDay: 3 });

  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
    assert.equal((await quota.reserve(ip)).allowed, true);
  }
  assert.deepEqual(await quota.reserve('198.51.100.4'), {
    allowed: false,
    retryAfterSeconds: 43200,
  });
});

test('concurrent reservations never exceed the global cap', async () => {
  const table = new FakeTable();
  const quota = limiter(table, { maxPerIpHour: 10, maxPerDay: 7 });

  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    quota.reserve(`198.51.100.${index + 1}`)));

  assert.equal(results.filter((result) => result.allowed).length, 7);
  assert.equal(results.filter((result) => !result.allowed).length, 5);
  assert.equal([...table.entities.values()][0].total, 7);
});

test('storage failures do not grant a lookup reservation', async () => {
  const quota = limiter({
    async getEntity() { throw new Error('storage offline'); },
  });
  await assert.rejects(quota.reserve('198.51.100.7'), /storage offline/);
});
