import assert from 'node:assert/strict';
import test from 'node:test';

import { createReadinessProbe } from '../src/readiness.js';

function tableWithResult(result) {
  let reads = 0;
  let pageSize;
  return {
    get reads() { return reads; },
    get pageSize() { return pageSize; },
    listEntities(options) {
      assert.deepEqual(options.queryOptions, { select: ['PartitionKey'] });
      assert.equal(options.abortSignal instanceof AbortSignal, true);
      return {
        byPage(settings) {
          pageSize = settings.maxPageSize;
          return {
            async next() {
              reads += 1;
              if (result instanceof Error) throw result;
              return { value: result, done: false };
            },
          };
        },
      };
    },
  };
}

test('an empty existing table is ready after an authorized one-item list', async () => {
  const table = tableWithResult([]);
  const probe = createReadinessProbe({ tableClient: table, lookupConfigured: true });
  assert.equal(await probe.check(), true);
  assert.equal(table.reads, 1);
  assert.equal(table.pageSize, 1);
});

test('a missing or unauthorized table is not ready', async () => {
  for (const statusCode of [403, 404]) {
    const table = tableWithResult(Object.assign(new Error('private Azure detail'), { statusCode }));
    const probe = createReadinessProbe({ tableClient: table, lookupConfigured: true });
    assert.equal(await probe.check(), false);
  }
});

test('missing lookup configuration is not ready and does not query storage', async () => {
  const table = tableWithResult([]);
  const probe = createReadinessProbe({ tableClient: table, lookupConfigured: false });
  assert.equal(await probe.check(), false);
  assert.equal(table.reads, 0);
});

test('readiness caches a result briefly and rechecks after expiry', async () => {
  const table = tableWithResult([]);
  let now = 1000;
  const probe = createReadinessProbe({
    tableClient: table,
    lookupConfigured: true,
    ttlMs: 100,
    clock: () => now,
  });

  assert.equal(await probe.check(), true);
  now = 1050;
  assert.equal(await probe.check(), true);
  assert.equal(table.reads, 1);
  now = 1101;
  assert.equal(await probe.check(), true);
  assert.equal(table.reads, 2);
});

test('simultaneous readiness requests share one storage query', async () => {
  let finish;
  let reads = 0;
  const tableClient = {
    listEntities() {
      return {
        byPage() {
          return {
            next() {
              reads += 1;
              return new Promise((resolve) => { finish = resolve; });
            },
          };
        },
      };
    },
  };
  const probe = createReadinessProbe({ tableClient, lookupConfigured: true });
  const checks = Array.from({ length: 8 }, () => probe.check());
  assert.equal(reads, 1);
  finish({ value: [], done: false });
  assert.deepEqual(await Promise.all(checks), Array(8).fill(true));
});

test('an unresponsive table query times out even if it ignores the abort signal', async () => {
  let aborted = false;
  const tableClient = {
    listEntities({ abortSignal }) {
      return {
        byPage() {
          return {
            next() {
              return new Promise(() => {
                abortSignal.addEventListener('abort', () => {
                  aborted = true;
                }, { once: true });
              });
            },
          };
        },
      };
    },
  };
  const probe = createReadinessProbe({
    tableClient,
    lookupConfigured: true,
    timeoutMs: 20,
  });
  let guard;
  const didNotFinish = new Promise((resolve) => {
    guard = setTimeout(() => resolve('readiness check did not finish'), 100);
  });
  const result = await Promise.race([probe.check(), didNotFinish]);
  clearTimeout(guard);
  assert.equal(result, false);
  assert.equal(aborted, true);
});
