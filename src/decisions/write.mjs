import { getSetting, setSetting, actionTx, parseJson as parse } from '../store/db.mjs';
import { buildScenario, loadContent, defaultPicks, wargameLists } from '../scenario/build.mjs';
import { upsertFact } from '../store/facts.mjs';
import { ToolError } from '../tools/errors.mjs';

const write = async (db, fn) => await actionTx(db, fn);

function pickIndexOf(list, index) {
  let i = index;
  if (typeof index === 'string' && !/^\d+$/.test(index)) i = list.findIndex(x => x && x.id === index);
  else if (typeof index === 'string') i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new ToolError('bad_input', `index must be 0 to ${list.length - 1}`);
  return i;
}

async function currentWargame(db, name) {
  if (name !== 'salary' && name !== 'deferral') throw new ToolError('not_found', `no war game ${name}`);
  const wargame = (await loadContent(db)).wargame || {};
  if (!wargame[name]) throw new ToolError('not_found', `no war game ${name}`);
  // D3: a war game kept only for reference is not a current choice.
  if (typeof wargame[name].unavailable === 'string') throw new ToolError('conflict', 'war game unavailable');
  return wargame;
}

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


async function decisionEvent(db, recId, action, arg, status, now, actor) {
  await db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(recId, now, action, arg, status, status, actor);
}

export async function decisionState(db, id) {
  const decision = await db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) ?? null;
  const key = DECIDED_FACT[decision?.wargame];
  return { decision, fact: key ? await db.prepare('SELECT * FROM facts WHERE key = ?').get(key) ?? null : null,
    picks: await db.prepare("SELECT * FROM settings WHERE key = 'wargame.picks'").get() ?? null };
}

export async function pickWargame(db, name, point, { onWrite } = {}) {
  return await write(db, async (db) => {
    const wargame = await currentWargame(db, name);
    const list = wargameLists(wargame)[name];
    const index = pickIndexOf(list, point);
    const before = await db.prepare("SELECT * FROM settings WHERE key = 'wargame.picks'").get() ?? null;
    const picks = { ...defaultPicks(wargame), ...(await getSetting(db, 'wargame.picks', null) || {}), [name]: index };
    await setSetting(db, 'wargame.picks', picks);
    const after = await db.prepare("SELECT * FROM settings WHERE key = 'wargame.picks'").get();
    await onWrite?.(before, after);
    return { name, index, label: String(list[index].label ?? list[index].id) };
  });
}

export async function decide(db, id, { point: selected, clock, now = new Date().toISOString(), actor = 'ui', onWrite } = {}) {
  const row = await db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
  if (!row) throw new ToolError('not_found', `no decision ${id}`);
  const name = row.wargame;
  if (name !== 'salary' && name !== 'deferral') throw new ToolError('bad_input', 'this decision has no war game to pick from');
  if (row.status === 'decided') throw new ToolError('conflict', 'already decided; revisit it first');
  if (row.status !== 'open' || row.unavailable_reason) throw new ToolError('conflict', 'this decision is not open');
  const scenario = await buildScenario(db, { clock });
  const live = scenario.decisions.find(d => d.id === row.id);
  if (!live || live.status !== 'open') throw new ToolError('conflict', 'this decision is not open');
  const wargame = await currentWargame(db, name);
  const list = wargameLists(wargame)[name];
  const stored = await getSetting(db, 'wargame.picks', null) || {};
  const index = selected ?? stored[name] ?? defaultPicks(wargame)[name];
  const i = pickIndexOf(list, index);
  const point = list[i];
  const line = decidedLineFor(name, point, scenario.fig);
  return await write(db, async (db) => {
    const before = await decisionState(db, id);
    await db.prepare("UPDATE decisions SET status = 'decided', decided_line = ? WHERE id = ?").run(line, row.id);
    await setSetting(db, 'wargame.picks', { ...defaultPicks(wargame), ...stored, [name]: i });
    if (name === 'salary') {
      const salaryFig = scenario.fig[`wg.salary.${point.id}.salary`];
      // The game names the S corp it was built for; a decided salary binds to that business only.
      if (salaryFig && Number.isFinite(salaryFig.v) && salaryFig.v > 0 && typeof wargame.salary.entity === 'string') {
        await upsertFact(db, {
          key: DECIDED_FACT.salary, value: { entity: wargame.salary.entity, salary: salaryFig.v }, src: DECIDE_SRC.salary, asOf: scenario.meta.clock, confirmed: true, now,
          provenance: { parser: 'decide', locator: { decision: row.id, point: point.id, figure: `wg.salary.${point.id}.salary` } },
        });
      }
    } else {
      const amountFig = scenario.fig[`wg.deferral.${point.id}.amount`];
      if (amountFig && Number.isFinite(amountFig.v)) {
        await upsertFact(db, {
          key: DECIDED_FACT.deferral, value: { option: point.id, amount: amountFig.v }, src: DECIDE_SRC.deferral, asOf: scenario.meta.clock,
          confirmed: true, now, provenance: { parser: 'decide', locator: { decision: row.id, option: point.id, figure: `wg.deferral.${point.id}.amount` } },
        });
      }
    }
    if (row.rec_id && await db.prepare('SELECT 1 FROM recs WHERE id = ?').get(row.rec_id)) {
      const rec = await db.prepare('SELECT status FROM recs WHERE id = ?').get(row.rec_id);
      await decisionEvent(db, row.rec_id, 'decide', point.id, rec.status, now, actor);
    }
    const after = await decisionState(db, id);
    onWrite?.(before, after);
    return { decision: { id, status: 'decided', decidedLine: line }, decidedIndex: i };
  });
}

export async function revisit(db, id, { now = new Date().toISOString(), actor = 'ui', onWrite } = {}) {
  const row = await db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
  if (!row) throw new ToolError('not_found', `no decision ${id}`);
  const name = row.wargame;
  if (row.status !== 'decided' || (name !== 'salary' && name !== 'deferral')) throw new ToolError('conflict', 'only a decision you decided here can be revisited');
  const game = (await loadContent(db)).wargame || {};
  const list = wargameLists(game)[name] || [];
  const fact = await db.prepare('SELECT locator FROM facts WHERE key = ?').get(DECIDED_FACT[name]);
  const locator = parse(fact?.locator, {});
  const prior = locator.point ?? locator.option ?? (await getSetting(db, 'wargame.picks', {}))[name] ?? defaultPicks(game)[name];
  const priorIndex = typeof prior === 'string' && !/^\d+$/.test(prior) ? list.findIndex(p => p.id === prior) : Number(prior);
  const decidedIndex = Number.isInteger(priorIndex) && priorIndex >= 0 && priorIndex < list.length ? priorIndex : null;
  return await write(db, async (db) => {
    const before = await decisionState(db, id);
    await db.prepare("UPDATE decisions SET status = 'open', decided_line = NULL WHERE id = ?").run(row.id);
    await db.prepare('DELETE FROM facts WHERE key = ? AND src = ?').run(DECIDED_FACT[name], DECIDE_SRC[name]);
    if (row.rec_id && await db.prepare('SELECT 1 FROM recs WHERE id = ?').get(row.rec_id)) {
      const rec = await db.prepare('SELECT status FROM recs WHERE id = ?').get(row.rec_id);
      await decisionEvent(db, row.rec_id, 'revisit', null, rec.status, now, actor);
    }
    const after = await decisionState(db, id);
    onWrite?.(before, after, { decidedIndex });
    return { decision: { id, status: 'open' }, decidedIndex };
  });
}
