import { configuredRecipients, emailStatus, EmailError } from './transport.mjs';
import { normalizeEmail } from '../auth/store.mjs';
import { codeError } from '../platform/db.mjs';

const verifiedMembers = (platform, householdId) => platform.prepare(`SELECT u.id, u.email, m.version
  FROM users u JOIN household_memberships m ON m.user_id = u.id
  WHERE m.household_id = ? AND m.status = 'active' AND u.enrolled_at IS NOT NULL`).all(householdId);

export function createRecipientPolicy({ platform, householdId, generation, mode, config, readFile } = {}) {
  const initialized = () => Boolean(platform.prepare('SELECT 1 FROM notification_policy WHERE household_id = ?').get(householdId));
  const mark = () => platform.prepare('INSERT OR IGNORE INTO notification_policy (household_id, initialized_at) VALUES (?, ?)').run(householdId, Date.now());
  const current = () => {
    const row = platform.prepare('SELECT status, generation FROM households WHERE id = ?').get(householdId);
    return row?.status === 'active' && Number(row.generation) === generation;
  };
  const save = (userId, subscribed, version) => platform.prepare(`INSERT INTO notification_subscriptions
    (household_id, user_id, subscribed, membership_version, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(household_id, user_id) DO UPDATE SET subscribed = excluded.subscribed,
      membership_version = excluded.membership_version, updated_at = excluded.updated_at`)
    .run(householdId, userId, subscribed ? 1 : 0, version, Date.now());

  async function initialize() {
    if (mode === 'demo' || initialized()) return;
    const served = platform.prepare('SELECT serves_store FROM households WHERE id = ?').get(householdId);
    if (served?.serves_store !== 1) { mark(); return; }
    const addresses = await configuredRecipients(config, readFile ? { readFile } : {});
    if (initialized()) return;
    const members = verifiedMembers(platform, householdId);
    const selected = addresses.map(address => {
      let canonical;
      try { canonical = normalizeEmail(address); } catch { return null; }
      return members.find(m => m.email === canonical);
    });
    if (!selected.length || selected.some(m => !m)) throw new EmailError('recipient_unverified');
    platform.exec('BEGIN IMMEDIATE');
    try {
      for (const m of selected) save(m.id, true, m.version);
      mark(); platform.exec('COMMIT');
    } catch (err) { platform.exec('ROLLBACK'); throw err; }
  }

  function subscribed() {
    return platform.prepare(`SELECT u.id AS userId, u.email, m.version FROM notification_subscriptions s
      JOIN household_memberships m ON m.household_id = s.household_id AND m.user_id = s.user_id
      JOIN users u ON u.id = s.user_id
      WHERE s.household_id = ? AND s.subscribed = 1 AND s.membership_version = m.version
        AND m.status = 'active' AND u.enrolled_at IS NOT NULL ORDER BY u.id`).all(householdId);
  }

  const policy = {
    householdId, generation,
    async resolve() {
      if (!current()) throw new EmailError('paused');
      if (mode === 'demo') return (await configuredRecipients(config, readFile ? { readFile } : {})).map(email => ({ email }));
      await initialize();
      const recipients = subscribed();
      if (!recipients.length) throw new EmailError('recipient_unverified');
      return recipients;
    },
    async status() {
      let selected;
      try { selected = await policy.resolve(); } catch (err) {
        if (!(err instanceof EmailError)) throw err;
        return { transport: config.emailTransport ?? 'dev', state: err.code, recipient: null, recipients: 0, detail: err.message };
      }
      return emailStatus({ ...config, emailTo: selected.map(r => r.email).join(','), emailToFile: null });
    },
    authorize(recipient) {
      if (!current()) throw new EmailError('paused');
      if (mode !== 'demo' && !subscribed().some(m => m.userId === recipient.userId && m.email === recipient.email && m.version === recipient.version)) {
        throw new EmailError('recipient_unverified');
      }
    },
    async list() {
      try { await initialize(); } catch (err) { if (!(err instanceof EmailError)) throw err; }
      const selected = new Set(subscribed().map(m => m.userId));
      return verifiedMembers(platform, householdId).map(m => ({ userId: m.id, subscribed: selected.has(m.id) }));
    },
    update(rows, actorUserId) {
      if (!Array.isArray(rows) || rows.length > 100 || rows.some(r => !r || Object.keys(r).some(k => !['userId', 'subscribed'].includes(k))
        || typeof r.userId !== 'string' || typeof r.subscribed !== 'boolean') || new Set(rows.map(r => r.userId)).size !== rows.length) throw codeError('bad_subscriptions');
      const members = verifiedMembers(platform, householdId);
      if (rows.some(r => !members.some(m => m.id === r.userId))) throw codeError('bad_subscriptions');
      platform.exec('BEGIN IMMEDIATE');
      try {
        platform.prepare('UPDATE notification_subscriptions SET subscribed = 0 WHERE household_id = ?').run(householdId);
        for (const r of rows) save(r.userId, r.subscribed, members.find(m => m.id === r.userId).version);
        mark();
        platform.prepare(`INSERT INTO audit_events (at, actor_user_id, household_id, action, outcome)
          VALUES (?, ?, ?, 'household.subscriptions', 'ok')`).run(Date.now(), actorUserId ?? null, householdId);
        platform.exec('COMMIT');
      } catch (err) { platform.exec('ROLLBACK'); throw err; }
    },
  };
  return Object.freeze(policy);
}
