import { loadCategoryInputs } from '../categories/store.mjs';
// Suggested goal targets, store side: reads accounts, transactions, stored account values and the
// planner's room figures, runs the pure calculator (src/calc/targets.mjs) and returns one record per
// owner goal that is live and has no target. Pure reads; never writes.
//
// buildSuggestions(db, {clock?, goals?}) -> {clock, suggestions: [record], figures: {key: figure}}
//   figures are keyed suggest.<goalId>.<name> (target, monthlySpend, annualSpend, monthlySavings,
//   current, room.<part>). Settings 'goals.suggestions' = {<goalId>: {declined: true}} holds the
//   suggestions the owner undid (src/goals/write.mjs adopts the rest). The withdrawal rate is the
//   pack default unless a remembered preference names one (rememberedWithdrawalRate).

import { finite } from '../calc/pace.mjs';
import { getSetting, parseJson as parse } from '../store/db.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { accountHistory, paceClock } from '../pace/build.mjs';
import { loadGoals } from '../scenario/build.mjs';
import { planningYear, ownerOf } from '../jobs/planner/data.mjs';
import {
  TARGET_PARAMETERS, CASH_KINDS, INVESTMENT_KINDS, ROOM_PARTS, ASK,
  goalKind, isBusinessAccount, spendingInputs, spendingFigures, holdingsTotal, cushionPlan, independencePlan, taxPlan,
  questionWhy, suggestionFingerprint, horizonOf, horizonLabelOf,
} from '../calc/targets.mjs';
import { mapSeries } from '../shared/series.mjs';

export const SUGGEST_SETTING = 'goals.suggestions';

const isoDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

// The withdrawal rate the owner told Ask to remember, else the default. The newest remembered
// preference that names a withdrawal rate with a percent inside the allowed range wins; the number
// is the owner's own words, never a model figure.
const RATE_AFTER = /withdrawal rate\D{0,40}?(\d+(?:\.\d+)?)\s*%/i;
const RATE_BEFORE = /(\d+(?:\.\d+)?)\s*%[^.%\d]{0,30}?withdrawal rate/i;
export async function rememberedWithdrawalRate(db) {
  const rows = await db.prepare('SELECT text FROM preferences ORDER BY updated_at DESC, created_at DESC, id').all();
  for (const { text } of rows) {
    const m = RATE_AFTER.exec(text) || RATE_BEFORE.exec(text);
    const r = m ? Math.round(Number(m[1]) * 100) / 10000 : NaN;
    if (finite(r) && r >= TARGET_PARAMETERS.withdrawalRateMin && r <= TARGET_PARAMETERS.withdrawalRateMax) return r;
  }
  return TARGET_PARAMETERS.withdrawalRate;
}

// Goals that get a record: owner goals, not archived, not done, with no finite target.
// Only a balance goal (goal model kind) gets a suggested target; the other kinds carry their own amounts.
export const wantsSuggestion = g => g && g.origin === 'owner' && !g.archived && g.status !== 'done' && !finite(g.target) && (g.kind ?? 'balance') === 'balance';

// This tax year's usable room figures: kind 'm' or 'e', available, positive, and computed by a
// planner run whose planning year is the clock year. room.sep counts only without solo 401(k) room.
async function currentRooms(db, clock) {
  const year = Number(clock.slice(0, 4));
  const keys = ROOM_PARTS.map(p => p.key);
  const rows = await db.prepare(`SELECT key, v, kind, locator, unavailable_reason FROM figures WHERE key IN (${keys.map(() => '?').join(', ')})`).all(...keys);
  const usable = ROOM_PARTS.flatMap(p => {
    const r = rows.find(x => x.key === p.key);
    if (!r || !['m', 'e'].includes(r.kind) || r.unavailable_reason || !finite(r.v) || r.v <= 0) return [];
    const computedOn = isoDay(parse(r.locator, null)?.computedOn);
    if (!computedOn || planningYear(computedOn) !== year) return [];
    return [{ ...p, v: r.v, computedOn, taxYear: year }];
  });
  return usable.some(r => r.part === 'retirement') ? usable.filter(r => r.part !== 'sep') : usable;
}

async function holdings(db, accounts, kinds, clock) {
  return await mapSeries(accounts.filter(a => kinds.includes(a.kind) && !isBusinessAccount(a)), async a => ({ id: a.id, kind: a.kind, name: a.name, value: (await accountHistory(db, a.id, clock)).at(-1)?.value ?? null }));
}

// Accounts with a business flag: kind business, owner business, or named by the owner's
// accounts.businessEntity fact with a nonblank entity.
async function loadAccounts(db) {
  const row = await db.prepare("SELECT value FROM facts WHERE key = 'accounts.businessEntity' AND (src IS NULL OR src != 'planner')").get();
  const named = row ? parse(row.value, undefined) : undefined;
  const byAccount = named && typeof named === 'object' && !Array.isArray(named) ? named : {};
  const naming = await accountNaming(db);
  return (await db.prepare('SELECT id, name, kind, owner, inst, mask, display_name FROM accounts ORDER BY sort, id').all()).map(a => ({
    id: a.id, name: a.name, kind: a.kind, inst: a.inst, mask: a.mask, display_name: a.display_name, ...naming.hint(a.id),
    business: String(a.kind || '').toLowerCase() === 'business' || ownerOf(a.owner) === 'business'
      || (typeof byAccount[a.id] === 'string' && byAccount[a.id].trim() !== ''),
  }));
}

export async function buildSuggestions(db, { clock: override, goals } = {}) {
  const clock = await paceClock(db, override);
  const list = (goals || await loadGoals(db)).filter(wantsSuggestion);
  const out = { clock, suggestions: [], figures: {} };
  if (!list.length) return out;
  const settings = await getSetting(db, SUGGEST_SETTING, null) || {};
  const accounts = await loadAccounts(db);
  // Each input is read once, and only when some goal needs it.
  const lazy = fn => { let memo; return async () => (memo ??= { v: await fn() }).v; };
  const spending = lazy(async () => spendingInputs({
    ...await loadCategoryInputs(db),
    accounts,
    clock,
  }));
  const cash = lazy(async () => holdingsTotal(await holdings(db, accounts, CASH_KINDS, clock)));
  const invested = lazy(async () => holdingsTotal(await holdings(db, accounts, INVESTMENT_KINDS, clock)));
  const rooms = lazy(async () => await currentRooms(db, clock));
  const withdrawalRate = lazy(async () => await rememberedWithdrawalRate(db));

  for (const goal of list) {
    const entry = settings && typeof settings === 'object' ? settings[goal.id] : null;
    const { rec, figures } = suggestionFor({ goal, entry, clock, spending, cash, invested, rooms, withdrawalRate });
    out.suggestions.push(rec);
    Object.assign(out.figures, figures);
  }
  return out;
}

function suggestionFor({ goal, entry, clock, spending, cash, invested, rooms, withdrawalRate: rateOf }) {
  const { kind, reason } = goalKind(goal);
  const horizon = horizonOf(goal.horizon);
  const key = name => `suggest.${goal.id}.${name}`;
  const rec = {
    goalId: goal.id, title: goal.title ?? '', kind, state: 'question', targetDate: null, dateSource: null,
    horizonLabel: horizonLabelOf(horizon), track: null, trackLabel: null, accept: null, figures: {}, window: null,
    params: {}, covered: false, why: '', missing: reason ? [reason] : [], ask: null, fingerprint: '',
  };
  const figs = {};
  const inputs = {};
  const roomKeys = [];
  const put = (name, f) => { figs[key(name)] = f; rec.figures[name] = key(name); };

  if (kind === 'cushion' || kind === 'independence') {
    const sp = spending();
    const holding = kind === 'cushion' ? cash() : invested();
    const withdrawalRate = rateOf();
    rec.params = kind === 'cushion' ? { cushionMonths: TARGET_PARAMETERS.cushionMonths }
      : { withdrawalRate, realReturn: TARGET_PARAMETERS.realReturn };
    rec.window = sp.window;
    if (sp.window) Object.assign(inputs, { monthlySpend: sp.monthlySpend, annualSpend: sp.annualSpend, monthlySavings: sp.monthlySavings });
    if (holding.total != null) Object.assign(inputs, { current: holding.total, held: holding.held.map(h => h.id).sort() });
    rec.missing.push(...sp.missing);
    if (holding.total == null) rec.missing.push(kind === 'cushion' ? 'no_cash_balance' : 'no_investment_balance');
    if (!rec.missing.length) {
      const spFigs = spendingFigures(sp, { clock });
      const plan = kind === 'cushion'
        ? cushionPlan({ spending: sp, cash: holding, horizon, clock, goalId: goal.id })
        : independencePlan({ spending: sp, invested: holding, horizon, clock, goalId: goal.id, withdrawalRate });
      put('target', plan.figures.target);
      put('monthlySpend', spFigs.monthlySpend);
      if (kind === 'independence') put('annualSpend', spFigs.annualSpend);
      put('monthlySavings', spFigs.monthlySavings);
      put('current', plan.figures.current);
      const track = { accounts: holding.held.map(h => h.id) };
      Object.assign(rec, {
        state: 'suggested', targetDate: plan.targetDate, dateSource: plan.dateSource, track,
        trackLabel: holding.held.map(h => h.name || h.id).join(', '), covered: plan.covered, why: plan.why,
        accept: { target: plan.target, targetDate: plan.targetDate, track: { accounts: [...track.accounts] } },
      });
      inputs.target = plan.target;
    }
  } else if (kind === 'tax') {
    const usable = rooms();
    if (!usable.length) rec.missing.push('no_tax_room');
    else {
      const plan = taxPlan({ rooms: usable, clock, goalId: goal.id });
      put('target', plan.figures.target);
      rec.figures.rooms = [];
      for (const [part, f] of Object.entries(plan.figures.rooms)) {
        figs[key(`room.${part}`)] = f;
        rec.figures.rooms.push(key(`room.${part}`));
      }
      for (const r of usable) { roomKeys.push(r.key); inputs[r.key] = r.v; }
      Object.assign(rec, {
        state: 'suggested', targetDate: plan.targetDate, dateSource: plan.dateSource, why: plan.why,
        accept: { target: plan.target, targetDate: plan.targetDate, track: null },
      });
      inputs.target = plan.target;
    }
  }

  if (rec.state === 'question') {
    rec.ask = ASK;
    rec.why = questionWhy(rec.missing);
  }
  rec.fingerprint = suggestionFingerprint({
    title: goal.title ?? '', note: goal.note ?? '', horizon, kind, state: rec.state, missing: rec.missing, params: rec.params,
    inputs, window: rec.window, track: rec.track ? [...rec.track.accounts].sort() : null, rooms: roomKeys,
    targetDate: rec.targetDate, year: clock.slice(0, 4),
  });
  if (entry && entry.declined === true) rec.state = 'declined';
  return { rec, figures: figs };
}
