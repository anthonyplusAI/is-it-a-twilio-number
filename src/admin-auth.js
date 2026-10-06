import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 8;
const MAX_FAILURE_RECORDS = 4096;
const MAX_AUTH_HEADER_LENGTH = 2048;

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function parseBasicCredentials(header) {
  if (typeof header !== 'string' || header.length > MAX_AUTH_HEADER_LENGTH) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(header);
  if (!match) return null;
  const encoded = match[1];
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) {
    return null;
  }
  const value = bytes.toString('utf8');
  const separator = value.indexOf(':');
  if (separator < 0) return null;
  return { username: value.slice(0, separator), password: value.slice(separator + 1) };
}

function setPrivateHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Vary', 'Authorization');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

export function createAdminAuth({
  password,
  clock = () => Date.now(),
  maxFailures = DEFAULT_MAX_FAILURES,
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  if (typeof password !== 'string' || password.length < 24 || password.length > 256) {
    throw new Error('ADMIN_PASSWORD must contain 24 to 256 characters');
  }
  if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 100
    || !Number.isInteger(windowMs) || windowMs < 1000) {
    throw new Error('Invalid admin login limits');
  }

  const expectedPasswordDigest = digest(password);
  const failures = new Map();

  function failureKey(ip) {
    return createHmac('sha256', password).update(String(ip || 'unknown')).digest('hex');
  }

  function prune(now) {
    if (failures.size <= MAX_FAILURE_RECORDS) return;
    for (const [key, value] of failures) {
      if (value.resetAt <= now) failures.delete(key);
    }
    while (failures.size > MAX_FAILURE_RECORDS) {
      failures.delete(failures.keys().next().value);
    }
  }

  return function adminAuth(req, res, next) {
    setPrivateHeaders(res);
    const now = Number(clock());
    if (!Number.isFinite(now)) return res.status(503).send('Admin access is unavailable.');
    prune(now);
    const key = failureKey(req.ip);
    const current = failures.get(key);
    if (current && current.resetAt > now && current.count >= maxFailures) {
      res.set('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).send('Too many login attempts. Try again later.');
    }

    const header = req.get('authorization');
    const credentials = parseBasicCredentials(header);
    if (credentials?.username === 'admin'
      && timingSafeEqual(digest(credentials.password), expectedPasswordDigest)) {
      failures.delete(key);
      return next();
    }

    if (header) {
      const count = current && current.resetAt > now ? current.count + 1 : 1;
      failures.set(key, { count, resetAt: current && current.resetAt > now
        ? current.resetAt : now + windowMs });
    }
    res.set('WWW-Authenticate', 'Basic realm="Lookup metrics", charset="UTF-8"');
    return res.status(401).send('Admin credentials required.');
  };
}
