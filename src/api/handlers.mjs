import { setPackActive, packIsActive } from '../packs/state.mjs';
import { writePreference } from '../actions/preferences.mjs';
import { adoptSuggestions } from '../goals/write.mjs';
import { randomUUID } from 'node:crypto';
import { requireActor, undoAction, ensureActionConversation, receiptsFor, receiptMessages } from '../actions/receipts.mjs';
import { writeRec } from '../store/recs.mjs';
import { latestProposal, claimProposal, markProposal, executeProposal, isPlainConfirmation } from '../actions/proposals.mjs';
import { ownerStatements } from '../actions/evidence.mjs';
import { ToolError } from '../tools/errors.mjs';
import { queueAccountPairs } from '../ingest/account-merge.mjs';
// API handlers. Each takes { household, db, config, engine, packs, answerer, params, body } and
// returns the JSON response body (status 200) or throws HttpError. Financial routes run in one
// household context: db, engine, packs and answerer come from ctx.household, and config is the
// instance configuration. Every action writes the store and answers
// with the fresh scenario, so the browser swaps it in. Model calls are awaited before any write
// transaction opens; only the writes run inside tx(). ctx.packs is the live pack view
// (src/packs/live.mjs).
//
// Ask threads (src/api/threads.mjs): POST /api/threads creates one (and asks its first question,
// from a rec when the body names recId), POST /api/ask continues a thread or a pack conversation by
// key, and POST /api/recs/:id/start-over detaches a rec's threads from its dialog. Naming runs
// after the reply's transaction commits and before the response is built. Trash older than 30 days
// is purged when the thread list, a thread or the scenario is read. Both asking routes stream as
// Server-Sent Events on request (src/api/router.mjs); the stored turn and the final body are the same.
// Stored proposals (src/actions/proposals.mjs): when an Ask thread's latest message carries an
// unresolved provenance.pendingAction, a typed explicit yes (POST /api/ask) or POST
// /api/threads/:id/proposals/:messageId decides it without a model call. The claim is one
// synchronous transaction before any await, so a double click or a second yes runs it once. A stale
// proposal (not the latest message, changed data, no longer allowed, or refused when it runs)
// writes nothing and goes to the model with a note that leads the reply.
// Both asking routes take an optional `context: [{ kind, id }]` (the references the owner pointed
// at, src/api/context-refs.mjs), validated before any write or stream start (400 when malformed)
// and passed to the answerer as `refs`.

import { getSetting, setSetting, schemaVersion, listMigrations, tx, cents, parseJson as parse } from '../store/db.mjs';
import { buildScenario, clockNow, loadContent, defaultPicks, wargameLists } from '../scenario/build.mjs';
import { ACTION_STATUS } from '../shared/rules.mjs';
import { OWNERS, isOwner } from '../shared/rec-links.mjs';
import { escapeUserText } from '../shared/tokens.mjs';
import { wrapBlocks } from '../shared/answer-text.mjs';
import { seedDemo } from '../../demo/seed.mjs';
import { clearStoredFiles, openVault, VaultError } from '../ingest/vault.mjs';
import { HttpError } from './http.mjs';
import { tourPending, setTourPending } from '../auth/tour.mjs';
import { parseRefs } from './context-refs.mjs';
import { upsertFact } from '../store/facts.mjs';
import { setRecOwner } from '../store/recs.mjs';
import { findQuestion, isIndex } from './questions.mjs';
import { whatIfOwnerText } from './answerer.mjs';
import { buildYourPlans, YourPlansRefusal } from '../packs/your-plans.mjs';
import { EngineOffError, BudgetExceededError } from '../engine/index.mjs';
import { refreshLivePacks } from '../packs/live.mjs';
import { messageOut } from '../scenario/build.mjs';
import { isThreadKey, threadRow, getThread, newThreadKey, insertThread, listThreads, deleteThread,
  validateTitle, nameThread } from './threads.mjs';

const MAX_TEXT = 4000;
const MAX_LABEL = 200;
const MAX_FILE_IDS = 50;
const MAX_CAP_USD = 10000;
const TOGGLE_NOTE = 'Recommendations update on the next planning run.';

const paragraphs = list => wrapBlocks(Array.isArray(list) ? list : []);
const nowIso = () => new Date().toISOString();

export { scenarioOf } from './scenario.mjs';
import { scenarioOf } from './scenario.mjs';


// The current "today" for message timestamps: the scenario clock's date at the current time.
const stamp = ctx => clockNow(ctx.db, ctx.config && ctx.config.clock);

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

// A pack row's definition with its manifest fields when a loaded manifest backs it.
function packDef(ctx, row) {
  const def = parse(row.def, {});
  return ctx.packs ? ctx.packs.view(row.id, def) : def;
}

function recEvent(db, recId, action, arg, from, to, actor = 'ui') {
  db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(recId, nowIso(), action, arg == null ? null : String(arg), from, to, actor);
}

function ensureConversation(db, key) {
  db.prepare('INSERT OR IGNORE INTO conversations (key, created_at) VALUES (?, ?)').run(key, nowIso());
}

// Appends a message and moves the conversation's last_at to it.
function pushMessage(ctx, key, role, text, { refs = [], notice = false, provenance = null } = {}) {
  ensureConversation(ctx.db, key);
  const ts = stamp(ctx);
  const r = ctx.db.prepare('INSERT INTO messages (conversation_key, role, text, refs, notice, ts, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(key, role, text, JSON.stringify(refs), notice ? 1 : 0, ts, provenance ? JSON.stringify(provenance) : null);
  ctx.db.prepare('UPDATE conversations SET last_at = ? WHERE key = ?').run(ts, key);
  return Number(r.lastInsertRowid);
}

// The seams the engine-backed handlers need; static-only fixtures construct the router without them.
function need(ctx, name) {
  if (!ctx[name]) throw new HttpError(503, 'engine not configured');
  return ctx[name];
}

// An answerer reply as a stored fathom message.
function pushReply(ctx, key, reply) {
  return pushMessage(ctx, key, 'fathom', paragraphs(reply.paragraphs), {
    refs: reply.refs || [], notice: !!reply.notice, provenance: reply.provenance || null,
  });
}

// ---------------------------------------------------------------- handlers

// Public: the highest store migration this binary ships and the platform schema version. No
// household ids, counts or paths.
const SHIPPED_SCHEMA = listMigrations().at(-1)?.id ?? 0;
export function healthz(ctx) {
  return { ok: true, schema: SHIPPED_SCHEMA, platformSchema: schemaVersion(ctx.platform) };
}

export function getIdentity(ctx) {
  return { identity: ctx.identity || null };
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

  if (def.question?.primary && ['complete', 'task'].includes(action)) throw new HttpError(409, 'save the answers to update this recommendation');

  if (action === 'task') {
    const tasks = Array.isArray(def.tasks) ? def.tasks : [];
    if (!isIndex(arg) || Number(arg) >= tasks.length) throw new HttpError(400, `task index must be 0 to ${tasks.length - 1}`);
    const i = Number(arg);
    const done = parse(row.tasks_done, []);
    // The step records who acted: the signed-in member, else the app.
    try { writeRec(db, id, 'step', { index: i, checked: !done[i] }, { now: nowIso(), actor: ctx.identity?.id || 'ui' }); }
    catch (e) { if (e instanceof ToolError) throw new HttpError(e.code === 'conflict' ? 409 : 400, e.message); throw e; }
    return { scenario: scenarioOf(ctx) };
  }

  try {
    if (action === 'owner') writeRec(db, id, 'owner', arg, { now: nowIso(), actor: 'ui', eventAction: 'owner' });
    else {
      if (!Object.hasOwn(ACTION_STATUS, action)) throw new ToolError('bad_input', `unknown action ${action}`);
      writeRec(db, id, 'status', { status: ACTION_STATUS[action], ...(action === 'snooze' ? { wake: arg } : {}) },
        { now: nowIso(), actor: 'ui', eventAction: action });
    }
  } catch (e) { if (e instanceof ToolError) throw new HttpError(400, e.message); throw e; }
  return { scenario: scenarioOf(ctx) };
}

// The rec action path's write (callers hold the transaction): sets the status ACTION_STATUS gives
// `action` and records it. `arg` is the wake label for snooze, a reason otherwise (the advisor
// veto dismisses with 'advisor vetoed').
export function applyStatusAction(db, row, action, arg = null) {
  const status = ACTION_STATUS[action];
  if (!status) throw new HttpError(400, `unknown action ${action}`);
  const wake = action === 'snooze' ? arg : (parse(row.def, {}).wake ?? null);
  db.prepare('UPDATE recs SET status = ?, wake = ?, updated_at = ? WHERE id = ?').run(status, wake, nowIso(), row.id);
  recEvent(db, row.id, action, arg, row.status, status);
}

// The index of a point (salary) or option (deferral) from a request value: an index, a digit string
// or a point id. Throws 400 outside the list.
function pickIndexOf(list, index) {
  let i = index;
  if (typeof index === 'string' && !/^\d+$/.test(index)) i = list.findIndex(x => x && x.id === index);
  else if (typeof index === 'string') i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new HttpError(400, `index must be 0 to ${list.length - 1}`);
  return i;
}

function currentWargame(db, name) {
  if (name !== 'salary' && name !== 'deferral') throw new HttpError(404, `no war game ${name}`);
  const wargame = loadContent(db).wargame || {};
  if (!wargame[name]) throw new HttpError(404, `no war game ${name}`);
  // D3: a war game kept only for reference is not a current choice.
  if (typeof wargame[name].unavailable === 'string') throw new HttpError(409, 'war game unavailable');
  return wargame;
}

export function wargamePick(ctx) {
  const { db } = ctx;
  const { name } = ctx.params;
  const wargame = currentWargame(db, name);
  const i = pickIndexOf(wargameLists(wargame)[name], ctx.body.index);
  const picks = { ...defaultPicks(wargame), ...(getSetting(db, 'wargame.picks', null) || {}), [name]: i };
  setSetting(db, 'wargame.picks', picks);
  return { scenario: scenarioOf(ctx) };
}

// ---------------------------------------------------------------- Decide on a picked point

const DECIDE_SRC = { salary: 'decide:salary', deferral: 'decide:deferral' };
const DECIDED_FACT = { salary: 'business.salaryDecided', deferral: 'business.deferralDecided' };

// The decided line for a picked point: its own label plus the figure tokens the registry holds for
// it, so every number resolves to a figure with its provenance. Keys the registry lacks are left out.
function decidedLineFor(name, point, fig) {
  const has = key => Object.hasOwn(fig, key);
  const k = (field) => `wg.${name}.${point.id}.${field}`;
  const label = String(point.label ?? point.id);
  if (name === 'salary') {
    const parts = [];
    if (has(k('tax'))) parts.push(`total tax of {f:${k('tax')}}`);
    if (has(k('x'))) parts.push(`pre-tax retirement room of {f:${k('x')}}`);
    return `You decided on ${label}${parts.length ? `, with ${parts.join(' and ')}` : ''}. Revisit it if your numbers change.`;
  }
  const parts = [];
  if (has(k('net'))) parts.push(`net tax change of {f:${k('net')}}`);
  if (has(k('decCash'))) parts.push(`December business cash of {f:${k('decCash')}}`);
  return `You decided: ${label}${parts.length ? `, with ${parts.join(' and ')}` : ''}. Revisit it if your numbers change.`;
}

function scheduleReplan(ctx) {
  if (!ctx.scheduler || typeof ctx.scheduler.soon !== 'function' || getSetting(ctx.db, 'mode', null) === 'demo') return;
  try { ctx.scheduler.soon('plan', 'decide', { immediate: true }); } catch { /* the next scheduled run picks it up */ }
}

// POST /api/decisions/:id/decide {index?}: decide the open war-game decision on the picked point
// (the index in the body, else the stored pick). It marks the decision decided with a decided line
// built from the point's figures, records the pick, writes the owner-stated assumption fact the
// planner reads on later runs (salary only: the chosen salary becomes the payroll assumption), and
// logs the action on the linked recommendation.
export function decisionDecide(ctx) {
  const { db } = ctx;
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(ctx.params.id);
  if (!row) throw new HttpError(404, `no decision ${ctx.params.id}`);
  const name = row.wargame;
  if (name !== 'salary' && name !== 'deferral') throw new HttpError(400, 'this decision has no war game to pick from');
  if (row.status === 'decided') throw new HttpError(409, 'already decided; revisit it first');
  if (row.status !== 'open' || row.unavailable_reason) throw new HttpError(409, 'this decision is not open');
  const scenario = scenarioOf(ctx);
  const live = scenario.decisions.find(d => d.id === row.id);
  if (!live || live.status !== 'open') throw new HttpError(409, 'this decision is not open');
  const wargame = currentWargame(db, name);
  const list = wargameLists(wargame)[name];
  const stored = getSetting(db, 'wargame.picks', null) || {};
  const index = ctx.body.index ?? stored[name] ?? defaultPicks(wargame)[name];
  const i = pickIndexOf(list, index);
  const point = list[i];
  const line = decidedLineFor(name, point, scenario.fig);
  const now = nowIso();
  tx(db, () => {
    db.prepare("UPDATE decisions SET status = 'decided', decided_line = ? WHERE id = ?").run(line, row.id);
    setSetting(db, 'wargame.picks', { ...defaultPicks(wargame), ...stored, [name]: i });
    if (name === 'salary') {
      const salaryFig = scenario.fig[`wg.salary.${point.id}.salary`];
      // The game names the S corp it was built for; a decided salary binds to that business only.
      if (salaryFig && Number.isFinite(salaryFig.v) && salaryFig.v > 0 && typeof wargame.salary.entity === 'string') {
        upsertFact(db, {
          key: DECIDED_FACT.salary, value: { entity: wargame.salary.entity, salary: salaryFig.v }, src: DECIDE_SRC.salary, asOf: scenario.meta.clock, confirmed: true, now,
          provenance: { parser: 'decide', locator: { decision: row.id, point: point.id, figure: `wg.salary.${point.id}.salary` } },
        });
      }
    } else {
      const amountFig = scenario.fig[`wg.deferral.${point.id}.amount`];
      if (amountFig && Number.isFinite(amountFig.v)) {
        upsertFact(db, {
          key: DECIDED_FACT.deferral, value: { option: point.id, amount: amountFig.v }, src: DECIDE_SRC.deferral, asOf: scenario.meta.clock,
          confirmed: true, now, provenance: { parser: 'decide', locator: { decision: row.id, option: point.id, figure: `wg.deferral.${point.id}.amount` } },
        });
      }
    }
    if (row.rec_id && db.prepare('SELECT 1 FROM recs WHERE id = ?').get(row.rec_id)) {
      const rec = db.prepare('SELECT status FROM recs WHERE id = ?').get(row.rec_id);
      recEvent(db, row.rec_id, 'decide', point.id, rec.status, rec.status);
    }
  });
  scheduleReplan(ctx);
  return { scenario: scenarioOf(ctx) };
}

// POST /api/decisions/:id/revisit: reopen a decision this action decided. The decided line and the
// assumption fact go, so the next planning run goes back to the data.
export function decisionRevisit(ctx) {
  const { db } = ctx;
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(ctx.params.id);
  if (!row) throw new HttpError(404, `no decision ${ctx.params.id}`);
  const name = row.wargame;
  if (row.status !== 'decided' || (name !== 'salary' && name !== 'deferral')) throw new HttpError(409, 'only a decision you decided here can be revisited');
  tx(db, () => {
    db.prepare("UPDATE decisions SET status = 'open', decided_line = NULL WHERE id = ?").run(row.id);
    db.prepare('DELETE FROM facts WHERE key = ? AND src = ?').run(DECIDED_FACT[name], DECIDE_SRC[name]);
    if (row.rec_id && db.prepare('SELECT 1 FROM recs WHERE id = ?').get(row.rec_id)) {
      const rec = db.prepare('SELECT status FROM recs WHERE id = ?').get(row.rec_id);
      recEvent(db, row.rec_id, 'revisit', null, rec.status, rec.status);
    }
  });
  scheduleReplan(ctx);
  return { scenario: scenarioOf(ctx) };
}

export function packToggle(ctx) {
  const row = packRow(ctx.db, ctx.params.id);
  const { pack } = setPackActive(ctx.db, row.id, !packIsActive(row));
  return { scenario: scenarioOf(ctx), status: pack.status, note: TOGGLE_NOTE };
}

export async function packWhatIf(ctx) {
  const { db } = ctx;
  const first = packRow(db, ctx.params.id);
  const def = packDef(ctx, first);
  if (!def.whatIf) throw new HttpError(400, `pack ${first.id} has no what-if`);
  const key = 'pack:' + first.id;
  const reply = first.what_if_done ? null
    : await need(ctx, 'answerer').whatIf({ db, packId: first.id, clock: ctx.config && ctx.config.clock });
  tx(db, () => {
    const row = packRow(db, first.id);
    let asked = !!row.what_if_asked;
    let done = !!row.what_if_done;
    if (!asked) { pushMessage(ctx, key, 'me', whatIfOwnerText(def)); asked = true; }
    if (!done && reply) {
      if (reply.notice) {
        const last = db.prepare('SELECT notice FROM messages WHERE conversation_key = ? ORDER BY id DESC LIMIT 1').get(key);
        if (!(last && last.notice)) pushReply(ctx, key, reply);
      } else {
        pushReply(ctx, key, reply);
        done = true;
      }
    }
    db.prepare('UPDATE packs_state SET exploring = 1, what_if_asked = ?, what_if_done = ?, updated_at = ? WHERE id = ?')
      .run(asked ? 1 : 0, done ? 1 : 0, nowIso(), row.id);
  });
  return { scenario: scenarioOf(ctx) };
}

// GET /api/packs/:id/entries/:entryId: one entry of a manifest-backed pack, from the loaded packs.
export function packEntry(ctx) {
  const entry = need(ctx, 'packs').entry(ctx.params.id, ctx.params.entryId);
  if (!entry) throw new HttpError(404, `no entry ${ctx.params.entryId} in pack ${ctx.params.id}`);
  return { entry };
}

export function setEngine(ctx) {
  if (typeof ctx.body.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
  setSetting(ctx.db, 'engine', { on: ctx.body.on });
  return { scenario: scenarioOf(ctx) };
}

export function setCap(ctx) {
  const { usd } = ctx.body;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_CAP_USD) {
    throw new HttpError(400, `usd must be a number from 0 to ${MAX_CAP_USD}`);
  }
  setSetting(ctx.db, 'cap', { usd: cents(usd) });
  return { scenario: scenarioOf(ctx) };
}

// POST /api/your-plans/build: extract the owner's plan and benefits documents into the private
// Your plans pack under the household root. Refused (409) while the engine is off, over the cap,
// when the household vault refuses (the vault's message, naming FATHOM_PLATFORM_KEY_FILE), or when
// the household root is inside the repository. Stored uploads are read through the household vault.
export async function yourPlansBuild(ctx) {
  const engine = need(ctx, 'engine');
  const { fileIds = [] } = ctx.body;
  if (!Array.isArray(fileIds) || fileIds.length > MAX_FILE_IDS || !fileIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
    throw new HttpError(400, `fileIds must be at most ${MAX_FILE_IDS} file id strings`);
  }
  if (!engine.isOn()) throw new HttpError(409, 'The engine is off, so Your plans cannot be built. Switch it on first.');
  let result;
  try {
    result = await buildYourPlans({ db: ctx.db, engine, household: ctx.household, fileIds,
      clock: (ctx.config && ctx.config.clock) || undefined });
  } catch (e) {
    if (e instanceof VaultError) throw new HttpError(409, e.message);
    if (e instanceof YourPlansRefusal) throw new HttpError(409, e.message);
    if (e instanceof EngineOffError) throw new HttpError(409, 'The engine is off, so Your plans cannot be built. Switch it on first.');
    if (e instanceof BudgetExceededError) throw new HttpError(409, "This month's engine budget is used up, so Your plans cannot be built. Raise the cap first.");
    throw e;
  }
  if (result.written) refreshLivePacks(ctx.db, { dataDir: ctx.household.root });
  const { written, entries, sources, warnings, dropped } = result;
  return { scenario: scenarioOf(ctx), result: { written, entries, sources, warnings, dropped } };
}

// The question in an ask body: exactly one of questionId (a string or an integer) and text (a
// non-empty string of at most MAX_TEXT characters after trimming). -> { hasQ, questionId, clean }
function askBody(body) {
  const { questionId, text } = body;
  const hasQ = questionId !== undefined && questionId !== null;
  const hasT = text !== undefined && text !== null;
  if (hasQ === hasT) throw new HttpError(400, 'send exactly one of questionId or text');
  if (hasQ && typeof questionId !== 'string' && !Number.isInteger(questionId)) throw new HttpError(400, 'questionId must be a string or an integer');
  if (hasT && typeof text !== 'string') throw new HttpError(400, 'text must be a string');
  const clean = hasT ? text.trim() : '';
  if (hasT && !clean) throw new HttpError(400, 'text is empty');
  if (clean.length > MAX_TEXT) throw new HttpError(400, `text is over ${MAX_TEXT} characters`);
  return { hasQ, questionId: hasQ ? questionId : undefined, clean };
}

// A thread row that can take a new message: 404 unknown, 409 trashed.
function openThreadRow(db, key) {
  const row = threadRow(db, key);
  if (!row) throw new HttpError(404, 'no such conversation');
  if (row.trashed_at) throw new HttpError(409, 'this conversation is in Trash; restore it to continue');
  return row;
}

// Names a thread when it is due; naming never fails the request.
async function maybeName(ctx, key) {
  if (!isThreadKey(key)) return;
  try {
    await nameThread({ db: ctx.db, engine: ctx.config?.publicDemo ? null : ctx.engine || null, key, clock: ctx.config && ctx.config.clock });
  } catch (e) {
    console.error('fathom: thread naming failed', e && e.name);
  }
}

// Streaming routes (ctx.onEvent set by the router for an event-stream request): a 'start' event
// names the conversation key before the model runs, so a client whose stream breaks knows which
// conversation to reload; the answerer's progress and text events follow.
function streamStart(ctx, key) {
  if (typeof ctx.onEvent === 'function') ctx.onEvent({ type: 'start', key });
}
const streaming = ctx => ({
  ...(typeof ctx.onEvent === 'function' ? { onEvent: ctx.onEvent } : {}),
  scopes: Array.isArray(ctx.scopes) ? ctx.scopes : undefined,
  actorId: ctx.identity?.id || (getSetting(ctx.db, 'mode', null) === 'demo' ? 'demo' : null),
  ownerText: typeof ctx.body.text === 'string' && ctx.body.questionId == null ? ctx.body.text.trim() : null,
  turnId: randomUUID(),
  replan: ctx.scheduler ? () => ctx.scheduler.runNow('plan') : null,
  queuePlan: ctx.scheduler ? () => ctx.scheduler.soon?.('plan', 'ingest') : null,
});

// Stores the owner message and the reply in `key`; `before` runs first inside the transaction.
function storeTurn(ctx, key, mine, reply, before) {
  return tx(ctx.db, () => {
    if (receiptsFor(ctx.db, key).length) ensureActionConversation(ctx.db, key, stamp(ctx), ctx.body.recId);
    if (before) before();
    const actorId = ctx.identity?.id || (getSetting(ctx.db, 'mode', null) === 'demo' ? 'demo' : null);
    const ownerInput = typeof ctx.body.text === 'string' && ctx.body.questionId == null && actorId
      ? { ownerInput: { actorId } } : null;
    pushMessage(ctx, key, 'me', mine, { provenance: ownerInput });
    return pushReply(ctx, key, reply);
  });
}

const replyIn = (scenario, key, id) => (scenario.live.conversations[key] || []).find(m => m.id === 'm' + id);

export async function ask(ctx) {
  const { db } = ctx;
  const { key } = ctx.body;
  if (typeof key !== 'string' || !key) throw new HttpError(400, 'key must be a conversation key');
  const { hasQ, questionId, clean } = askBody(ctx.body);
  const refs = parseRefs(ctx.body.context);

  const thread = isThreadKey(key);
  if (!thread && !key.startsWith('pack:')) {
    throw new HttpError(400, 'key must be an Ask thread or a pack conversation; ask about a recommendation through POST /api/threads with recId');
  }
  if (thread) openThreadRow(db, key);
  else packRow(db, key.slice(5));

  // A typed plain yes (no other content) to the thread's latest, unresolved proposal runs it (no
  // await before the claim); a yes that changes anything goes to the model.
  if (thread && !hasQ && isPlainConfirmation(clean)) {
    const proposal = latestProposal(db, key);
    if (proposal) return decideProposal(ctx, key, proposal.id, 'confirm', clean);
  }

  const scenario = scenarioOf(ctx);
  let mine;
  if (hasQ) {
    const q = findQuestion(scenario, key, questionId);
    if (!q) throw new HttpError(404, `no question ${questionId}`);
    mine = q.q;
  } else {
    mine = escapeUserText(clean);
  }

  streamStart(ctx, key);
  const reply = await need(ctx, 'answerer').answer({ db, key, questionId: hasQ ? questionId : undefined,
    text: hasQ ? undefined : clean, clock: ctx.config && ctx.config.clock, refs, ...streaming(ctx) });
  if (!reply) throw new HttpError(404, `no question ${questionId}`);
  // A thread may have been trashed or deleted while the model answered; asking unarchives it.
  const id = storeTurn(ctx, key, mine, reply, thread ? () => {
    openThreadRow(db, key);
    db.prepare('UPDATE conversations SET archived_at = NULL WHERE key = ?').run(key);
  } : null);
  await maybeName(ctx, key);
  const fresh = scenarioOf(ctx);
  return { scenario: fresh, message: replyIn(fresh, key, id) };
}

// ---------------------------------------------------------------- stored proposals

const CONFIRMED_TEXT = 'Done. The change is saved. You can undo it below.';
const DECLINED_TEXT = 'Okay, nothing was changed.';
const STALE_NOTE = 'That proposal is out of date, so nothing was saved.';

// Decides proposal row `id` in Ask thread `key` ('confirm' or 'decline') and stores the owner's
// `ownerText` with the reply. The claim runs synchronously before any await.
async function decideProposal(ctx, key, id, decision, ownerText) {
  const { db } = ctx;
  const claim = claimProposal(db, { key, id, decision, scopes: Array.isArray(ctx.scopes) ? ctx.scopes : undefined, at: stamp(ctx) });
  if (claim.status === 'missing') throw new HttpError(404, 'no such proposal');
  if (claim.status === 'resolved') throw new HttpError(409, 'this proposal was already answered');
  const turn = { ...ctx, body: { text: ownerText } };
  streamStart(ctx, key);
  let reply = null;
  let note = claim.status === 'stale' ? STALE_NOTE : null;
  if (claim.status === 'declined') reply = { paragraphs: [DECLINED_TEXT], refs: [] };
  else if (claim.status === 'confirmed') {
    const run = streaming(turn);
    const { pending } = claim;
    try {
      const afterTools = [];
      const toolContext = { queueAfterTools: task => afterTools.push(task), db, now: stamp(ctx), dataDir: ctx.household?.root, actorId: run.actorId,
        ownerText, turnId: run.turnId, replan: run.replan, queuePlan: run.queuePlan, conversationKey: key,
        recId: db.prepare('SELECT rec_id FROM conversations WHERE key = ?').get(key)?.rec_id ?? null, scopes: run.scopes, evidenceMessageId: id,
        channel: 'ask', household: ctx.household, services: ctx.household?.services };
      toolContext.ownerStatements = () => ownerStatements(toolContext);
      const result = await executeProposal(pending, toolContext);
      for (const task of afterTools) await task();
      reply = { paragraphs: [result?.undo?.available === false ? 'The refresh is queued. Its receipt records the outcome.' : CONFIRMED_TEXT], refs: [], provenance: { actionTurn: run.turnId, confirmedProposal: 'm' + id,
        tools: [{ name: pending.tool, args: { operation: pending.operation, ...pending.args }, result: JSON.parse(JSON.stringify(result ?? null)) }] } };
    } catch (e) {
      markProposal(db, id, 'stale', stamp(ctx));
      if (e?.name !== 'ToolError' && e?.name !== 'FactAnswerError') throw e;
      note = `That change was not saved: ${e.message}`;
    }
  }
  if (note) {
    reply = await need(ctx, 'answerer').answer({ db, key, text: ownerText, clock: ctx.config && ctx.config.clock, ...streaming(turn), staleNote: note });
    if (!reply) throw new HttpError(404, 'no answer');
  }
  const replyId = storeTurn(turn, key, escapeUserText(ownerText), reply, () => {
    openThreadRow(db, key);
    db.prepare('UPDATE conversations SET archived_at = NULL WHERE key = ?').run(key);
  });
  await maybeName(ctx, key);
  const fresh = scenarioOf(ctx);
  return { scenario: fresh, message: replyIn(fresh, key, replyId) };
}

// POST /api/threads/:id/proposals/:messageId { decision: 'confirm' | 'decline' }: Confirm stores
// "Confirmed" and runs the proposal as a typed yes would; Not now stores "Not now" and a fixed reply
// with no model call. 400 bad decision; 404 unknown thread or message, or no proposal on it; 409
// trashed thread or already decided.
export async function proposalDecide(ctx) {
  const { db } = ctx;
  const decision = ctx.body?.decision;
  if (decision !== 'confirm' && decision !== 'decline') throw new HttpError(400, 'decision must be confirm or decline');
  const thread = threadOrThrow(db, ctx.params.id);
  openThreadRow(db, thread.key);
  const m = /^m(\d{1,15})$/.exec(String(ctx.params.messageId ?? ''));
  if (!m) throw new HttpError(404, 'no such proposal');
  const out = await decideProposal(ctx, thread.key, Number(m[1]), decision, decision === 'confirm' ? 'Confirmed' : 'Not now');
  return { scenario: out.scenario, thread: threadOrThrow(db, thread.id), message: out.message };
}

// ---------------------------------------------------------------- Ask threads

const threadOrThrow = (db, id) => {
  const t = getThread(db, id);
  if (!t) throw new HttpError(404, 'no such conversation');
  return t;
};

export function threadList(ctx) {
  return listThreads(ctx.db);
}

// GET /api/threads/:id: the thread and its messages (as in scenario.live.conversations).
export async function threadGet(ctx) {
  const opened = threadOrThrow(ctx.db, ctx.params.id);
  await maybeName(ctx, opened.key);
  const thread = threadOrThrow(ctx.db, ctx.params.id);
  const messages = receiptMessages(ctx.db, thread.key, ctx.db.prepare('SELECT * FROM messages WHERE conversation_key = ? ORDER BY id').all(thread.key).map(messageOut));
  return { thread, messages };
}

// POST /api/threads: {} makes an empty thread; { text } or { questionId } (an Ask starter id) also
// asks the first question. The key is chosen before the model call and the row is written with
// the turn, so a failed answer leaves nothing behind. With recId the thread is asked from that rec
// (threadCreateFromRec).
export async function threadCreate(ctx) {
  const { db } = ctx;
  const body = ctx.body;
  const empty = (body.text === undefined || body.text === null) && (body.questionId === undefined || body.questionId === null);
  const refs = parseRefs(body.context);
  if (body.recId !== undefined && body.recId !== null) return threadCreateFromRec(ctx, empty, refs);
  if (empty) {
    const thread = tx(db, () => insertThread(db, newThreadKey(db), stamp(ctx)));
    return { scenario: scenarioOf(ctx), thread };
  }
  const { hasQ, questionId, clean } = askBody(body);
  let mine;
  let question;
  if (hasQ) {
    const starter = scenarioOf(ctx).live.askStarters.find(st => st.id === questionId);
    if (!starter) throw new HttpError(404, `no starter ${questionId}`);
    mine = starter.q;
    question = starter.q;
  } else {
    mine = escapeUserText(clean);
    question = clean;
  }
  const key = newThreadKey(db);
  streamStart(ctx, key);
  const reply = await need(ctx, 'answerer').answer({ db, key, text: question, clock: ctx.config && ctx.config.clock, refs, ...streaming(ctx) });
  if (!reply) throw new HttpError(404, 'no answer');
  const id = storeTurn(ctx, key, mine, reply, () => { if (!db.prepare('SELECT 1 FROM conversations WHERE key = ?').get(key)) insertThread(db, key, stamp(ctx)); });
  await maybeName(ctx, key);
  const fresh = scenarioOf(ctx);
  return { scenario: fresh, thread: threadOrThrow(db, key.slice(4)), message: replyIn(fresh, key, id) };
}

// POST /api/threads { recId, text | questionId }: a thread asked from a visible rec (404 unknown or
// hidden); a question is required (400) and questionId is a rec.qa index, id or exact question (404
// unknown). The row is written before the model call so the answerer's scenario resolves the rec
// context (recForKey); a failed or empty answer deletes it again while it holds no message.
async function threadCreateFromRec(ctx, empty, refs) {
  const { db } = ctx;
  const { recId } = ctx.body;
  if (typeof recId !== 'string' || !recId) throw new HttpError(400, 'recId must be a recommendation id');
  visibleRec(db, recId);
  if (empty) throw new HttpError(400, 'send questionId or text to ask about a recommendation');
  const { hasQ, questionId, clean } = askBody(ctx.body);
  let mine;
  if (hasQ) {
    const q = findQuestion(scenarioOf(ctx), recId, questionId);
    if (!q) throw new HttpError(404, `no question ${questionId}`);
    mine = q.q;
  } else {
    mine = escapeUserText(clean);
  }
  const key = newThreadKey(db);
  tx(db, () => insertThread(db, key, stamp(ctx), { recId }));
  let reply;
  try {
    streamStart(ctx, key);
    reply = await need(ctx, 'answerer').answer({ db, key, questionId: hasQ ? questionId : undefined,
      text: hasQ ? undefined : clean, clock: ctx.config && ctx.config.clock, refs, ...streaming(ctx) });
    if (!reply) throw new HttpError(404, hasQ ? `no question ${questionId}` : 'no answer');
  } catch (e) {
    dropIfEmpty(db, key);
    throw e;
  }
  // The thread may have been trashed or deleted while the model answered.
  const id = storeTurn(ctx, key, mine, reply, () => openThreadRow(db, key));
  await maybeName(ctx, key);
  const fresh = scenarioOf(ctx);
  return { scenario: fresh, thread: threadOrThrow(db, key.slice(4)), message: replyIn(fresh, key, id) };
}

// Deletes a thread row that holds no message (a rec thread whose first answer failed).
function dropIfEmpty(db, key) {
  db.prepare('DELETE FROM conversations WHERE key = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_key = ?) AND NOT EXISTS (SELECT 1 FROM action_receipts WHERE conversation_key = ?)').run(key, key, key);
}

// POST /api/recs/:id/start-over: detaches every thread asked from a visible rec that its dialog
// still shows, so the dialog opens a fresh composer. The threads stay in Ask untouched otherwise.
export function recStartOver(ctx) {
  const { db } = ctx;
  const { id } = ctx.params;
  visibleRec(db, id);
  db.prepare('UPDATE conversations SET rec_detached_at = ? WHERE rec_id = ? AND rec_detached_at IS NULL').run(stamp(ctx), id);
  return { scenario: scenarioOf(ctx) };
}

export function threadRename(ctx) {
  const thread = threadOrThrow(ctx.db, ctx.params.id);
  const title = validateTitle(ctx.body.title);
  if (!title) throw new HttpError(400, 'title must be 1 to 60 characters with no line breaks, control characters or < > { } `');
  ctx.db.prepare("UPDATE conversations SET title = ?, title_source = 'manual' WHERE key = ?").run(title, thread.key);
  return { scenario: scenarioOf(ctx), thread: threadOrThrow(ctx.db, thread.id) };
}

export function threadArchive(ctx) {
  const thread = threadOrThrow(ctx.db, ctx.params.id);
  if (thread.trashedAt) throw new HttpError(409, 'this conversation is in Trash');
  ctx.db.prepare('UPDATE conversations SET archived_at = coalesce(archived_at, ?) WHERE key = ?').run(stamp(ctx), thread.key);
  return { scenario: scenarioOf(ctx), thread: threadOrThrow(ctx.db, thread.id) };
}

// Trash keeps archived_at, so restore returns the thread to where it was.
export function threadTrash(ctx) {
  const thread = threadOrThrow(ctx.db, ctx.params.id);
  ctx.db.prepare('UPDATE conversations SET trashed_at = coalesce(trashed_at, ?) WHERE key = ?').run(stamp(ctx), thread.key);
  return { scenario: scenarioOf(ctx), thread: threadOrThrow(ctx.db, thread.id) };
}

// Out of Trash when trashed, else out of the archive.
export function threadRestore(ctx) {
  const thread = threadOrThrow(ctx.db, ctx.params.id);
  const column = thread.trashedAt ? 'trashed_at' : 'archived_at';
  ctx.db.prepare(`UPDATE conversations SET ${column} = NULL WHERE key = ?`).run(thread.key);
  return { scenario: scenarioOf(ctx), thread: threadOrThrow(ctx.db, thread.id) };
}

export function threadDelete(ctx) {
  const thread = threadOrThrow(ctx.db, ctx.params.id);
  if (!thread.trashedAt) throw new HttpError(409, 'only a conversation in Trash can be deleted forever');
  deleteThread(ctx.db, thread.key);
  return { scenario: scenarioOf(ctx) };
}

export function onboarding(ctx) {
  const { step } = ctx.body;
  if (!Number.isInteger(step) || step < 0 || step > 6) throw new HttpError(400, 'step must be an integer from 0 to 6');
  const cur = getSetting(ctx.db, 'onboarding', { done: false, step: 0 }) || { done: false, step: 0 };
  setSetting(ctx.db, 'onboarding', step === 6 ? { done: true, step: 6 } : { done: !!cur.done, step });
  // Only the not-done to done transition starts the tour, so users who finished onboarding before
  // the tour existed are never flagged.
  if (step === 6 && !cur.done) setTourPending(ctx, true);
  return { scenario: scenarioOf(ctx) };
}

// Reseeds the demo household's store and removes its stored objects; nothing outside its own root
// is touched.
export async function demoReset(ctx) {
  if (getSetting(ctx.db, 'mode', null) !== 'demo') throw new HttpError(404, 'not found');
  let vault;
  try {
    vault = await openVault(ctx.household);
  } catch (e) {
    if (e instanceof VaultError) throw new HttpError(409, e.message);
    throw e;
  }
  seedDemo(ctx.db);
  // MCP keys live in the platform api_keys table; a reset leaves none for this household.
  ctx.platform.prepare('DELETE FROM api_keys WHERE household_id = ?').run(ctx.household.householdId);
  await clearStoredFiles(vault);
  if (ctx.packs) ctx.packs.refresh();
  return { scenario: scenarioOf(ctx) };
}

export async function actionUndo(ctx) {
  const actorId = ctx.identity?.id || (getSetting(ctx.db, 'mode', null) === 'demo' ? 'demo' : null);
  const row = ctx.db.prepare('SELECT scope FROM action_receipts WHERE id = ?').get(ctx.params.id);
  if (!row) throw new HttpError(404, 'no such action');
  try {
    const out = await undoAction({ db: ctx.db, now: stamp(ctx), actorId,
      replan: ctx.scheduler ? () => ctx.scheduler.runNow('plan') : null,
      queuePlan: () => ctx.scheduler?.soon?.('plan', 'ingest') }, ctx.params.id, row.scope);
    return { ...out, scenario: scenarioOf(ctx) };
  } catch (e) { if (e instanceof ToolError) throw new HttpError(409, e.message); throw e; }
}

export function preferenceSave(ctx) {
  try {
    const out = writePreference({ db: ctx.db, now: stamp(ctx), actorId: ctx.identity?.id },
      { ...ctx.body, id: ctx.params.id }, { remove: ctx.removePreference === true });
    adoptSuggestions(ctx.db, { now: stamp(ctx), clock: ctx.config && ctx.config.clock });
    return { ...out, scenario: scenarioOf(ctx) };
  } catch (e) { if (e instanceof ToolError) throw new HttpError(400, e.message); throw e; }
}

export const preferenceDelete = ctx => preferenceSave({ ...ctx, removePreference: true });
