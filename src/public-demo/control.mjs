import { currentHandle, openScope } from '../storage/index.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../api/http.mjs';

export const DEMO_LIMIT_MESSAGE = "The demo has hit today's limit. Please try again tomorrow.";
export const DEMO_OFF_MESSAGE = 'This feature is disabled in public demo mode.';
export const COOKIE_NAME = 'fathom_public_demo';

const ALLOWED = new Set([
  'GET /healthz', 'GET /api/auth/session', 'GET /api/scenario', 'GET /api/pace', 'GET /api/identity',
  'POST /api/recs/:id/action', 'POST /api/recs/:id/start-over',
  'POST /api/wargame/:name/pick', 'POST /api/decisions/:id/decide', 'POST /api/decisions/:id/revisit',
  'POST /api/packs/:id/toggle', 'POST /api/packs/:id/whatif', 'GET /api/packs/:id/entries/:entryId',
  'POST /api/ask', 'GET /api/threads', 'POST /api/threads', 'GET /api/threads/:id',
  'GET /api/threads/:id/blocks',
  'POST /api/threads/:id/rename', 'POST /api/threads/:id/archive', 'POST /api/threads/:id/trash',
  'POST /api/threads/:id/restore', 'POST /api/threads/:id/delete',
  'GET /api/accounts/:id', 'GET /api/accounts/:id/transactions', 'POST /api/accounts/:id/name',
  'GET /api/pnl', 'GET /api/pnl/rows', 'GET /api/spending', 'GET /api/spending/rows',
  'POST /api/accounts/:id/mask', 'POST /api/accounts/:id/owner', 'POST /api/accounts/:id/kind',
  'GET /api/accounts/:id/merge-candidates', 'POST /api/accounts/:id/merge',
  'POST /api/accounts/:id/archive', 'GET /api/sources',
  'GET /api/goals/suggestions', 'POST /api/goals', 'POST /api/goals/:id',
  'POST /api/goals/:id/archive', 'POST /api/goals/:id/delete', 'POST /api/goals/:id/suggestion',
  'POST /api/curve', 'POST /api/onboarding', 'POST /api/demo/reset',
  'GET /api/confirm', 'POST /api/confirm/list', 'POST /api/confirm/answers',
  'POST /api/confirm/reopen-many', 'GET /api/confirm/:id', 'POST /api/confirm/:id/answer',
  'POST /api/confirm/:id/reopen', 'POST /api/yearend/marks',
  'POST /api/advisor/reviews', 'POST /api/advisor/reviews/:id/verdict', 'POST /api/advisor/checkin',
]);

export const demoRouteBehavior = (method, path) => ALLOWED.has(`${method === 'HEAD' ? 'GET' : method} ${path}`) ? 'sandbox' : 'off';
const hash = value => createHash('sha256').update(value).digest('hex');

export async function createDemoControl(config, { now = Date.now } = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  const scope = await openScope({ path: join(config.dataDir, 'public-demo.sqlite') });
  // Statements follow an open atomic() transaction in the current async context.
  const db = { prepare: text => currentHandle(scope).prepare(text) };
  await scope.applySchema(`
    CREATE TABLE IF NOT EXISTS sandboxes (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, subject TEXT NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, creations INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, subject));
    CREATE TABLE IF NOT EXISTS rates (minute INTEGER NOT NULL, ip TEXT NOT NULL, requests INTEGER NOT NULL,
      PRIMARY KEY(minute, ip));`);
  const limits = config.publicDemoLimits;
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const atomic = async fn => await scope.transaction(async (scope) => await fn());
  const usage = async subject => {
    await db.prepare('INSERT OR IGNORE INTO usage(day, subject) VALUES (?, ?)').run(day(), subject);
    return await db.prepare('SELECT * FROM usage WHERE day = ? AND subject = ?').get(day(), subject);
  };
  const increment = async (subject, column, amount = 1) => {
    await db.prepare(`UPDATE usage SET ${column} = ${column} + ? WHERE day = ? AND subject = ?`).run(amount, day(), subject);
  };
  return {
    async rate(ip) {
      return await atomic(async () => {
        const minute = Math.floor(now() / 60000), key = hash(ip);
        const row = await db.prepare('SELECT requests FROM rates WHERE minute = ? AND ip = ?').get(minute, key);
        if (row?.requests >= limits.requests) return false;
        await db.prepare(`INSERT INTO rates VALUES (?, ?, 1) ON CONFLICT(minute, ip) DO UPDATE SET requests = requests + 1`).run(minute, key);
        return true;
      });
    },
    async reserveTurn(id, ip) {
      return await atomic(async () => {
        const visitor = `visitor:${id}`, address = `ip:${hash(ip)}`;
        if ((await usage(visitor)).turns >= limits.turns || (await usage(address)).turns >= limits.ipTurns) return false;
        await increment(visitor, 'turns'); await increment(address, 'turns');
        return true;
      });
    },
    async reserveRound(id, tokens, usd) {
      if (!Number.isSafeInteger(tokens) || tokens < 1 || !Number.isFinite(usd) || usd < 0) throw new TypeError('Invalid demo reservation');
      return await atomic(async () => {
        const visitor = `visitor:${id}`;
        const v = await usage(visitor), global = await usage('global');
        if (v.tokens + tokens > limits.tokens || global.calls >= limits.calls || global.usd + usd > limits.usd + 1e-12) return false;
        await increment(visitor, 'tokens', tokens); await increment('global', 'calls'); await increment('global', 'usd', usd);
        return true;
      });
    },
    async sandbox(cookie, ip) {
      return await atomic(async () => {
        if (typeof cookie === 'string' && /^[a-f0-9]{64}$/.test(cookie)) {
          const row = await db.prepare('SELECT * FROM sandboxes WHERE id = ? AND expires > ?').get(cookie, now());
          if (row) return row;
        }
        if ((await db.prepare('SELECT count(*) AS n FROM sandboxes').get()).n >= limits.sandboxes) throw new HttpError(503, 'The demo is busy. Please try again later.');
        const address = `ip:${hash(ip)}`;
        if ((await usage(address)).creations >= limits.creations) throw new HttpError(429, 'Demo sandbox creation limit reached. Please try again tomorrow.');
        const id = randomBytes(32).toString('hex'), expires = now() + limits.ttl * 1000;
        await db.prepare('INSERT INTO sandboxes VALUES (?, ?)').run(id, expires);
        await increment(address, 'creations');
        return { id, expires };
      });
    },
    async cleanup(remove = () => true) {
      for (const row of await db.prepare('SELECT id FROM sandboxes WHERE expires <= ?').all(now())) {
        if (remove(row.id) !== false) await db.prepare('DELETE FROM sandboxes WHERE id = ?').run(row.id);
      }
      await db.prepare('DELETE FROM rates WHERE minute < ?').run(Math.floor(now() / 60000));
      await db.prepare('DELETE FROM usage WHERE day < ?').run(day());
    },
    close: async () => await scope.close(),
  };
}
