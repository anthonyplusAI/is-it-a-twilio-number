export function createReadinessProbe({
  tableClient,
  lookupConfigured,
  ttlMs = 10_000,
  timeoutMs = 5_000,
  clock = () => Date.now(),
}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) {
    throw new Error('Readiness cache duration must be from 1 to 60000 milliseconds');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    throw new Error('Readiness timeout must be from 1 to 15000 milliseconds');
  }

  let cachedReady = false;
  let expiresAt = 0;
  let pending = null;

  return {
    check() {
      if (!lookupConfigured || !tableClient) return Promise.resolve(false);
      if (clock() < expiresAt) return Promise.resolve(cachedReady);
      if (pending) return pending;

      pending = (async () => {
        const controller = new AbortController();
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Readiness table query timed out'));
          }, timeoutMs);
        });
        try {
          // Listing one key checks Table access even when the table has no quota rows yet.
          const firstPage = await Promise.race([
            tableClient
              .listEntities({
                queryOptions: { select: ['PartitionKey'] },
                abortSignal: controller.signal,
              })
              .byPage({ maxPageSize: 1 })
              .next(),
            timeout,
          ]);
          cachedReady = firstPage.done === false;
        } catch {
          cachedReady = false;
        } finally {
          clearTimeout(timer);
        }
        expiresAt = clock() + ttlMs;
        return cachedReady;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}
