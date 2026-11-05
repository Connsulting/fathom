// Runtime engine over the store: ONE createEngine per process, whose controls hook re-reads the
// on/off switch (settings.engine.on plus the configured mode) and the monthly cap (settings.cap.usd)
// before every model round. Spend is recorded in spend_ledger in the store clock month, and
// accounting poison therefore lasts for the process.
//
// createSpendLedger(db) -> { monthSpendUsd('YYYYMM'), record({ts, purpose, costUsd, model, tokens}), recent(limit) }
// createRuntimeEngine({ db, config, clock? }) -> { mode, ledger, isOn(), capUsd(), now(), call(request), extract(request) }
//
// The credential is read once, at construction, from config.claudeCredentialFile and only in live
// mode. A failure resolves to no credential; its contents and the error are never logged.

import { getSetting } from '../store/db.mjs';
import { DEFAULT_CAP_USD } from '../scenario/build.mjs';
import { createEngine, loadCredential, ModelCallError } from './index.mjs';

const FAKE_TEXT = 'The fake engine has no scripted answer for this request.';
const FAKE_EXTRACT = '{"rows":[]}';

// Engine spend rounded up to whole cents, so sub-cent model calls are never undercounted against
// the cap. toFixed(6) first keeps exact cent amounts (0.05 * 100) from rounding up a cent.
const centsUp = n => Math.ceil(Number((n * 100).toFixed(6))) / 100;

export function createSpendLedger(db) {
  const sum = db.prepare('SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE yyyymm = ?');
  const insert = db.prepare('INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, ?, ?, ?, ?)');
  const latest = db.prepare('SELECT id, ts, purpose, model, cost_usd FROM spend_ledger ORDER BY id DESC LIMIT ?');
  return {
    monthSpendUsd(month) {
      if (typeof month !== 'string' || !/^\d{6}$/.test(month)) throw new TypeError('Month key must be YYYYMM');
      return Number(sum.get(`${month.slice(0, 4)}-${month.slice(4)}`).s);
    },
    record({ ts, purpose, costUsd, model, tokens } = {}) {
      if (!Number.isFinite(costUsd) || costUsd < 0) throw new TypeError('Invalid ledger cost');
      const time = new Date(ts);
      if (Number.isNaN(time.getTime())) throw new TypeError('Invalid ledger timestamp');
      const iso = time.toISOString();
      insert.run(iso, iso.slice(0, 7), String(purpose), centsUp(costUsd), String(model ?? ''), JSON.stringify(tokens ?? {}));
    },
    recent(limit = 10) {
      const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 10;
      return latest.all(n).map(r => ({ id: r.id, ts: r.ts, purpose: r.purpose, model: r.model, costUsd: r.cost_usd }));
    },
  };
}

export function createRuntimeEngine({ db, config, clock } = {}) {
  if (!db || !config) throw new TypeError('createRuntimeEngine needs db and config');
  const mode = config.engine;
  const ledger = createSpendLedger(db);

  const isOn = () => mode !== 'off' && (getSetting(db, 'engine', { on: true }) || {}).on !== false;
  const capUsd = () => {
    const cap = getSetting(db, 'cap', null);
    return cap && Number.isFinite(cap.usd) && cap.usd >= 0 ? cap.usd : DEFAULT_CAP_USD;
  };
  const now = () => {
    const iso = new Date().toISOString();
    const day = clock || config.clock || getSetting(db, 'clock', null);
    return day ? `${day}T${iso.slice(11)}` : iso;
  };

  let credential = null;
  const ready = mode === 'live' && config.claudeCredentialFile
    ? loadCredential(config.claudeCredentialFile).then(c => { credential = c; }, () => { credential = null; })
    : Promise.resolve();

  let engine = mode === 'live' ? null : build();
  function build() {
    return createEngine({ mode, ledger, credential: credential ?? undefined, now: () => new Date(now()),
      toolContext: { db }, controls: () => ({ on: isOn(), capUsd: capUsd() }) });
  }
  async function current() {
    await ready;
    if (mode === 'live' && !credential) throw new ModelCallError('Live engine has no credential');
    if (!engine) engine = build();
    return engine;
  }

  return {
    mode,
    ledger,
    isOn,
    capUsd,
    now,
    async call(request = {}) {
      const e = await current();
      const fake = mode === 'fake' ? (request.fake ?? [{ text: FAKE_TEXT }]) : undefined;
      return e.call({ ...request, fake });
    },
    async extract(request = {}) {
      const e = await current();
      const fake = mode === 'fake' ? (request.fake ?? [{ text: FAKE_EXTRACT }]) : undefined;
      return e.extract({ ...request, fake });
    },
  };
}
