// API handlers. Each takes { db, config, answerer, engine, params, body } and returns the JSON response
// body (status 200) or throws HttpError. Every action writes the store and answers with the
// fresh scenario, so the browser swaps it in.

import { getSetting, setSetting, schemaVersion, tx, parseJson as parse } from '../store/db.mjs';
import { buildScenario, loadContent, defaultPicks, wargameLists } from '../scenario/build.mjs';
import { ACTION_STATUS, packStatus } from '../shared/rules.mjs';
import { escapeUserText } from '../shared/tokens.mjs';
import { seedDemo } from '../../demo/seed.mjs';
import { clearStoredFiles } from '../ingest/vault.mjs';
import { runPlanning } from '../jobs/planner.mjs';
import { defaultPackDirs } from '../packs/state.mjs';
import { HttpError } from './http.mjs';
import { findQuestion, isIndex } from './questions.mjs';

export const ENGINE_OFF_HTML = '<p>Engine is off, so answers are paused. Switch it back on to get an answer.</p>';
const MAX_TEXT = 4000;
const MAX_LABEL = 200;

const paragraphs = list => (Array.isArray(list) ? list : []).map(p => `<p>${p}</p>`).join('');
const nowIso = () => new Date().toISOString();

function scenarioOf(ctx) {
  return buildScenario(ctx.db, { clock: ctx.config && ctx.config.clock });
}

// The current "today" for message timestamps: the scenario clock's date at the current time.
function stamp(ctx) {
  const clock = (ctx.config && ctx.config.clock) || getSetting(ctx.db, 'clock', null);
  const now = nowIso();
  return clock ? `${clock}T${now.slice(11)}` : now;
}

function visibleRec(db, id) {
  const row = db.prepare('SELECT * FROM recs WHERE id = ?').get(id);
  if (!row || row.status === 'hidden') throw new HttpError(404, `no recommendation ${id}`);
  return row;
}

function packRow(db, id) {
  const row = db.prepare('SELECT * FROM packs_state WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, `no pack ${id}`);
  return row;
}

function recEvent(db, recId, action, arg, from, to, actor = 'ui') {
  db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(recId, nowIso(), action, arg == null ? null : String(arg), from, to, actor);
}

function ensureConversation(db, key) {
  db.prepare('INSERT OR IGNORE INTO conversations (key, created_at) VALUES (?, ?)').run(key, nowIso());
}

function pushMessage(ctx, key, role, text, { refs = [], notice = false } = {}) {
  ensureConversation(ctx.db, key);
  const r = ctx.db.prepare('INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(key, role, text, JSON.stringify(refs), notice ? 1 : 0, stamp(ctx));
  return Number(r.lastInsertRowid);
}

// ---------------------------------------------------------------- handlers

export function healthz(ctx) {
  return { ok: true, schema: schemaVersion(ctx.db) };
}

export function getScenario(ctx) {
  return scenarioOf(ctx);
}

export function recAction(ctx) {
  const { db } = ctx;
  const { id } = ctx.params;
  const { action, arg } = ctx.body;
  const row = visibleRec(db, id);
  if (typeof action !== 'string') throw new HttpError(400, 'action is required');
  const def = parse(row.def, {});

  if (action === 'task') {
    const tasks = Array.isArray(def.tasks) ? def.tasks : [];
    if (!isIndex(arg) || Number(arg) >= tasks.length) throw new HttpError(400, `task index must be 0 to ${tasks.length - 1}`);
    const i = Number(arg);
    const done = parse(row.tasks_done, []);
    const next = tasks.map((_, k) => !!done[k]);
    next[i] = !next[i];
    tx(db, () => {
      db.prepare('UPDATE recs SET tasks_done = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), nowIso(), id);
      recEvent(db, id, 'task', i, row.status, row.status);
    });
    return { scenario: scenarioOf(ctx) };
  }

  if (!Object.hasOwn(ACTION_STATUS, action)) throw new HttpError(400, `unknown action ${action}`);
  const status = ACTION_STATUS[action];
  let wake = def.wake != null ? def.wake : null;
  if (action === 'snooze') {
    if (arg != null && typeof arg !== 'string') throw new HttpError(400, 'snooze arg must be a label');
    if (arg && arg.length > MAX_LABEL) throw new HttpError(400, 'snooze label is too long');
    wake = arg ? arg : 'Next month';
  }
  tx(db, () => {
    db.prepare('UPDATE recs SET status = ?, wake = ?, updated_at = ? WHERE id = ?').run(status, wake, nowIso(), id);
    recEvent(db, id, action, action === 'snooze' ? wake : null, row.status, status);
  });
  return { scenario: scenarioOf(ctx) };
}

export function wargamePick(ctx) {
  const { db } = ctx;
  const { name } = ctx.params;
  if (name !== 'salary' && name !== 'deferral') throw new HttpError(404, `no war game ${name}`);
  const wargame = loadContent(db).wargame || {};
  if (!wargame[name]) throw new HttpError(404, `no war game ${name}`);
  // D3: a war game kept only for reference is not a current choice.
  if (typeof wargame[name].unavailable === 'string') throw new HttpError(409, 'war game unavailable');
  const list = wargameLists(wargame)[name];
  const { index } = ctx.body;
  let i = index;
  if (typeof index === 'string' && !/^\d+$/.test(index)) i = list.findIndex(x => x && x.id === index);
  else if (typeof index === 'string') i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new HttpError(400, `index must be 0 to ${list.length - 1}`);
  const picks = { ...defaultPicks(wargame), ...(getSetting(db, 'wargame.picks', null) || {}), [name]: i };
  setSetting(db, 'wargame.picks', picks);
  return { scenario: scenarioOf(ctx) };
}

const packActive = row => (row.active == null ? parse(row.def, {}).status === 'active' : !!row.active);

export function packToggle(ctx) {
  const { db } = ctx;
  const row = packRow(db, ctx.params.id);
  const def = parse(row.def, {});
  const turnOn = !packActive(row);
  const statusOf = db.prepare('SELECT status FROM recs WHERE id = ?');
  const setStatus = db.prepare('UPDATE recs SET status = ?, updated_at = ? WHERE id = ?');
  tx(db, () => {
    const unhid = [];
    if (turnOn) {
      for (const rid of def.recIds || []) {
        const r = statusOf.get(rid);
        if (r && r.status === 'hidden') {
          setStatus.run('proposed', nowIso(), rid);
          recEvent(db, rid, 'pack_on', row.id, 'hidden', 'proposed');
          unhid.push(rid);
        }
      }
    } else {
      const powered = new Set(db.prepare('SELECT * FROM packs_state WHERE id <> ?').all(row.id).filter(packActive)
        .flatMap(o => parse(o.def, {}).recIds || []));
      for (const rid of parse(row.unhid, [])) {
        const r = statusOf.get(rid);
        if (r && r.status === 'proposed' && !powered.has(rid)) {
          setStatus.run('hidden', nowIso(), rid);
          recEvent(db, rid, 'pack_off', row.id, 'proposed', 'hidden');
        }
      }
    }
    db.prepare('UPDATE packs_state SET active = ?, unhid = ?, updated_at = ? WHERE id = ?')
      .run(turnOn ? 1 : 0, JSON.stringify(unhid), nowIso(), row.id);
  });
  const after = packRow(db, row.id);
  const status = packStatus(def.status, { active: !!after.active, exploring: !!after.exploring });
  return { scenario: scenarioOf(ctx), status };
}

export function packWhatIf(ctx) {
  const { db } = ctx;
  const row = packRow(db, ctx.params.id);
  const def = parse(row.def, {});
  if (!def.whatIf) throw new HttpError(400, `pack ${row.id} has no what-if`);
  const key = 'pack:' + row.id;
  const engineOn = getSetting(db, 'engine', { on: true }).on !== false;
  tx(db, () => {
    let asked = !!row.what_if_asked;
    let done = !!row.what_if_done;
    if (!asked) { pushMessage(ctx, key, 'me', def.whatIf.prompt || ''); asked = true; }
    if (!done) {
      if (!engineOn) {
        const last = db.prepare('SELECT notice FROM messages WHERE conversation_key = ? ORDER BY id DESC LIMIT 1').get(key);
        if (!(last && last.notice)) pushMessage(ctx, key, 'fathom', ENGINE_OFF_HTML, { notice: true });
      } else {
        const refs = (def.whatIf.unlocks || []).map(u => u && u.recId).filter(Boolean);
        pushMessage(ctx, key, 'fathom', paragraphs(def.whatIf.a), { refs });
        done = true;
      }
    }
    db.prepare('UPDATE packs_state SET exploring = 1, what_if_asked = ?, what_if_done = ?, updated_at = ? WHERE id = ?')
      .run(asked ? 1 : 0, done ? 1 : 0, nowIso(), row.id);
  });
  return { scenario: scenarioOf(ctx) };
}

export function setEngine(ctx) {
  if (typeof ctx.body.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
  setSetting(ctx.db, 'engine', { on: ctx.body.on });
  return { scenario: scenarioOf(ctx) };
}

export async function ask(ctx) {
  const { db } = ctx;
  const { key = 'ask', questionId, text } = ctx.body;
  if (typeof key !== 'string' || !key) throw new HttpError(400, 'key must be a conversation key');
  const hasQ = questionId !== undefined && questionId !== null;
  const hasT = text !== undefined && text !== null;
  if (hasQ === hasT) throw new HttpError(400, 'send exactly one of questionId or text');
  if (hasQ && typeof questionId !== 'string' && !Number.isInteger(questionId)) throw new HttpError(400, 'questionId must be a string or an integer');
  if (hasT && typeof text !== 'string') throw new HttpError(400, 'text must be a string');
  const clean = hasT ? text.trim() : '';
  if (hasT && !clean) throw new HttpError(400, 'text is empty');
  if (clean.length > MAX_TEXT) throw new HttpError(400, `text is over ${MAX_TEXT} characters`);

  if (key.startsWith('pack:')) packRow(db, key.slice(5));
  else if (key !== 'ask') visibleRec(db, key);

  const scenario = scenarioOf(ctx);
  let mine;
  if (hasQ) {
    const q = findQuestion(scenario, key, questionId);
    if (!q) throw new HttpError(404, `no question ${questionId}`);
    mine = q.q;
  } else {
    mine = escapeUserText(clean);
  }

  const engineOn = scenario.live.engine;
  let reply = null;
  if (engineOn) {
    reply = await ctx.answerer.answer({ db, key, questionId: hasQ ? questionId : undefined, text: hasT ? clean : undefined });
    if (!reply) throw new HttpError(404, `no question ${questionId}`);
  }
  const id = tx(db, () => {
    pushMessage(ctx, key, 'me', mine);
    return engineOn
      ? pushMessage(ctx, key, 'fathom', paragraphs(reply.paragraphs), { refs: reply.refs || [], notice: !!reply.notice })
      : pushMessage(ctx, key, 'fathom', ENGINE_OFF_HTML, { notice: true });
  });
  const fresh = scenarioOf(ctx);
  const message = (fresh.live.conversations[key] || []).find(m => m.id === 'm' + id);
  return { scenario: fresh, message };
}

export function onboarding(ctx) {
  const { step } = ctx.body;
  if (!Number.isInteger(step) || step < 0 || step > 6) throw new HttpError(400, 'step must be an integer from 0 to 6');
  const cur = getSetting(ctx.db, 'onboarding', { done: false, step: 0 }) || { done: false, step: 0 };
  setSetting(ctx.db, 'onboarding', step === 6 ? { done: true, step: 6 } : { done: !!cur.done, step });
  return { scenario: scenarioOf(ctx) };
}

export async function demoReset(ctx) {
  if (getSetting(ctx.db, 'mode', null) !== 'demo') throw new HttpError(404, 'not found');
  seedDemo(ctx.db);
  await clearStoredFiles(ctx.config.dataDir);
  return { scenario: scenarioOf(ctx) };
}

const REAL_ONLY = 'planning runs on real stores only';

export async function planRun(ctx) {
  if (getSetting(ctx.db, 'mode', null) === 'demo') throw new HttpError(409, REAL_ONLY);
  const run = await runPlanning(ctx.db, ctx.engine || null, {
    now: (ctx.config && ctx.config.clock) || undefined,
    packDirs: defaultPackDirs(ctx.config && ctx.config.dataDir),
  });
  return { scenario: scenarioOf(ctx), run };
}
