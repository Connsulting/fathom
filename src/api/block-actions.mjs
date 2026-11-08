import { randomUUID } from 'node:crypto';
import { HttpError } from './http.mjs';
import { getThread } from './threads.mjs';
import { clockNow } from '../scenario/build.mjs';
import { parseJson, tx } from '../store/db.mjs';
import { escapeUserText } from '../shared/tokens.mjs';
import { callTool } from '../tools/index.mjs';
import { ToolError } from '../tools/errors.mjs';
import { scenarioOf } from './handlers.mjs';
import { BLOCK_ACTIONS } from '../blocks/actions.mjs';

export async function blockAct(ctx) {
  const { db, params, body } = ctx;
  if (!body || !['pick', 'decide'].includes(body.action) || Object.keys(body).some(k => !['action', 'option'].includes(k)) ||
    (body.action === 'decide' && Object.hasOwn(body, 'option'))) throw new HttpError(400, 'Invalid block action');
  const thread = getThread(db, params.id);
  if (!thread) throw new HttpError(404, 'no such conversation');
  if (thread.trashedAt) throw new HttpError(409, 'Restore this conversation to continue');
  const id = /^m(\d{1,15})$/.exec(params.messageId);
  const message = id && db.prepare("SELECT provenance FROM messages WHERE id = ? AND conversation_key = ? AND role = 'fathom'").get(Number(id[1]), thread.key);
  const block = parseJson(message?.provenance, {}).blocks?.find(b => b.id === params.blockId);
  if (!block) throw new HttpError(404, 'no such block');
  const snap = block.snapshot, action = snap?.action;
  if (block.op !== 'compare' || action?.kind !== 'wargame' || !Object.hasOwn(BLOCK_ACTIONS, action.name)) throw new HttpError(400, 'This block has no actions');
  if (body.action === 'pick' && (!Number.isInteger(body.option) || body.option < 0 || body.option >= snap.options.length)) throw new HttpError(400, 'Invalid option');
  const now = clockNow(db, ctx.config?.clock);
  const turnId = randomUUID();
  const toolCtx = { db, now, clock: ctx.config?.clock, config: ctx.config, actorId: ctx.identity?.id,
    conversationKey: thread.key, turnId, channel: 'ask', household: ctx.household, services: ctx.household?.services,
    dataDir: ctx.household?.root, scopes: ctx.scopes,
    replan: ctx.scheduler ? () => ctx.scheduler.runNow('plan') : null,
    queuePlan: ctx.scheduler ? () => ctx.scheduler.soon?.('plan', 'ingest') : null };
  try {
    const live = await callTool('recommendations', { operation: 'wargame', name: action.name }, toolCtx);
    const decision = action.decisionId && scenarioOf(ctx).decisions.find(d => d.id === action.decisionId && d.wargame === action.name);
    if (!['open', 'upcoming'].includes(live.status) || decision && !['open', 'upcoming'].includes(decision.status)) throw new HttpError(409, 'This war game is no longer available to pick');
    const option = body.action === 'pick' ? snap.options[body.option] : snap.options.find(o => o.id === live.picked);
    if (!option?.id) throw new HttpError(409, 'The picked option is not in this answer. Ask again');
    if (body.action === 'decide' && (!decision || decision.status !== 'open')) throw new HttpError(409, 'This decision is not open');
    const args = body.action === 'pick' ? { operation: 'pick_point', name: action.name, point: option.id }
      : { operation: 'decide', decisionId: action.decisionId, point: option.id };
    const result = await callTool('act_on_recommendation', args, toolCtx);
    const text = body.action === 'pick' ? `You picked ${option.label}.` : `You decided on ${option.label}. Your plan uses it from the next planning run.`;
    const provenance = { blockControl: `${params.messageId}:${params.blockId}:pick-${snap.options.indexOf(option)}`, actionTurn: turnId, actions: result.receipt ? [result.receipt] : [] };
    const messageId = tx(db, () => {
      const row = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts, provenance) VALUES (?, 'fathom', ?, '[]', 0, ?, ?)")
        .run(thread.key, `<p>${escapeUserText(text)}</p>`, now, JSON.stringify(provenance));
      db.prepare('UPDATE conversations SET last_at = ?, archived_at = NULL WHERE key = ?').run(now, thread.key);
      return 'm' + row.lastInsertRowid;
    });
    const scenario = scenarioOf(ctx);
    return { scenario, message: scenario.live.conversations[thread.key].find(m => m.id === messageId) };
  } catch (e) {
    if (e instanceof ToolError) throw new HttpError(e.code === 'forbidden' ? 403 : 409, e.message);
    throw e;
  }
}
