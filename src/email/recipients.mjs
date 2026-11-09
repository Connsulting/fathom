import { configuredRecipients, emailStatus, EmailError } from './transport.mjs';
import { normalizeEmail } from '../auth/store.mjs';
import { codeError } from '../platform/db.mjs';
import { currentHandle } from '../storage/index.mjs';

const verifiedMembers = async (platform, householdId) => await platform.prepare(`SELECT u.id, u.email, m.version
  FROM users u JOIN household_memberships m ON m.user_id = u.id
  WHERE m.household_id = ? AND m.status = 'active' AND u.enrolled_at IS NOT NULL`).all(householdId);

export function createRecipientPolicy({ platform: scope, householdId, generation, mode, config, readFile } = {}) {
  // Statements follow this policy's open platform transaction in the current async context.
  const platform = { prepare: text => currentHandle(scope).prepare(text) };
  const policyRow = async () => await platform.prepare('SELECT initialized_at, skipped_recipients FROM notification_policy WHERE household_id = ?').get(householdId);
  const initialized = async () => (await policyRow())?.initialized_at != null;
  const skippedRecipients = async () => (await policyRow())?.skipped_recipients ?? 0;
  const mark = async (skipped, initializedAt = Date.now()) => {
    if (skipped === undefined) skipped = await skippedRecipients();
    return await platform.prepare(`INSERT INTO notification_policy
    (household_id, initialized_at, skipped_recipients) VALUES (?, ?, ?)
    ON CONFLICT(household_id) DO UPDATE SET initialized_at = excluded.initialized_at, skipped_recipients = excluded.skipped_recipients
      WHERE notification_policy.initialized_at IS NULL`).run(householdId, initializedAt, skipped);
  };
  const current = async () => {
    const row = await platform.prepare('SELECT status, generation FROM households WHERE id = ?').get(householdId);
    return row?.status === 'active' && Number(row.generation) === generation;
  };
  const save = async (userId, subscribed, version) => await platform.prepare(`INSERT INTO notification_subscriptions
    (household_id, user_id, subscribed, membership_version, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(household_id, user_id) DO UPDATE SET subscribed = excluded.subscribed,
      membership_version = excluded.membership_version, updated_at = excluded.updated_at`)
    .run(householdId, userId, subscribed ? 1 : 0, version, Date.now());

  async function initialize() {
    if (mode === 'demo' || await initialized()) return;
    const served = await platform.prepare('SELECT serves_store FROM households WHERE id = ?').get(householdId);
    if (served?.serves_store !== 1) { await mark(); return; }
    const addresses = await configuredRecipients(config, readFile ? { readFile } : {});
    if (await initialized()) return;
    const members = await verifiedMembers(platform, householdId);
    const selected = addresses.map(address => {
      let canonical;
      try { canonical = normalizeEmail(address); } catch { return null; }
      return members.find(m => m.email === canonical);
    }).filter(Boolean);
    await scope.transaction(async (scope) => {
      if (!await initialized()) {
        for (const m of selected) await save(m.id, true, m.version);
        await mark(addresses.length - selected.length, selected.length ? Date.now() : null);
      }
    });
  }

  async function subscribed() {
    return await platform.prepare(`SELECT u.id AS userId, u.email, m.version FROM notification_subscriptions s
      JOIN household_memberships m ON m.household_id = s.household_id AND m.user_id = s.user_id
      JOIN users u ON u.id = s.user_id
      WHERE s.household_id = ? AND s.subscribed = 1 AND s.membership_version = m.version
        AND m.status = 'active' AND u.enrolled_at IS NOT NULL ORDER BY u.id`).all(householdId);
  }

  const policy = {
    householdId, generation,
    async resolve() {
      if (!await current()) throw new EmailError('paused');
      if (mode === 'demo') {
        const addresses = await configuredRecipients(config, readFile ? { readFile } : {});
        if (!addresses.length) throw new EmailError('missing_config');
        return addresses.map(email => ({ email }));
      }
      await initialize();
      const recipients = await subscribed();
      if (!recipients.length) throw new EmailError('recipient_unverified');
      return recipients;
    },
    async status() {
      let selected;
      try { selected = await policy.resolve(); } catch (err) {
        if (!(err instanceof EmailError)) throw err;
        return { transport: config.emailTransport ?? 'dev', state: err.code, recipient: null, recipients: 0, skippedRecipients: await skippedRecipients(), detail: err.message };
      }
      const status = await emailStatus({ ...config, emailTo: selected.map(r => r.email).join(','), emailToFile: null });
      return { ...status, skippedRecipients: await skippedRecipients() };
    },
    async authorize(recipient) {
      if (!await current()) throw new EmailError('paused');
      if (mode !== 'demo' && !(await subscribed()).some(m => m.userId === recipient.userId && m.email === recipient.email && m.version === recipient.version)) {
        throw new EmailError('recipient_unverified');
      }
    },
    async list() {
      try { await initialize(); } catch (err) { if (!(err instanceof EmailError)) throw err; }
      const selected = new Set((await subscribed()).map(m => m.userId));
      return (await verifiedMembers(platform, householdId)).map(m => ({ userId: m.id, subscribed: selected.has(m.id) }));
    },
    async update(rows, actorUserId) {
      if (!Array.isArray(rows) || rows.length > 100 || rows.some(r => !r || Object.keys(r).some(k => !['userId', 'subscribed'].includes(k))
        || typeof r.userId !== 'string' || typeof r.subscribed !== 'boolean') || new Set(rows.map(r => r.userId)).size !== rows.length) throw codeError('bad_subscriptions');
      const members = await verifiedMembers(platform, householdId);
      if (rows.some(r => !members.some(m => m.id === r.userId))) throw codeError('bad_subscriptions');
      await scope.transaction(async (scope) => {
        await platform.prepare('UPDATE notification_subscriptions SET subscribed = 0 WHERE household_id = ?').run(householdId);
        for (const r of rows) await save(r.userId, r.subscribed, members.find(m => m.id === r.userId).version);
        await mark();
        await platform.prepare(`INSERT INTO audit_events (at, actor_user_id, household_id, action, outcome)
          VALUES (?, ?, ?, 'household.subscriptions', 'ok')`).run(Date.now(), actorUserId ?? null, householdId);
      });
    },
  };
  return Object.freeze(policy);
}
