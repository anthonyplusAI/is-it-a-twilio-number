import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';

test('startup exits unsuccessfully when the HTTP port is already in use', async (t) => {
  const blocker = createServer().listen(0, '0.0.0.0');
  await new Promise((resolve) => blocker.once('listening', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      PORT: String(blocker.address().port),
    },
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.notEqual(exitCode, 0);
  assert.doesNotMatch(stdout, /Listening on port/);
});
