import { cents, parseJson } from '../store/db.mjs';
import { upsertFact, withInferredRecFacts } from '../store/facts.mjs';
import { resolveEntities, inferEntities, isOfficer } from '../jobs/planner/data.mjs';
import { inferMortgage } from '../calc/mortgage-inference.mjs';
import { docRecipient, payrollRecords, sameEmployer } from '../jobs/planner/payroll.mjs';
import { TAX_2026 } from '../calc/index.mjs';
import { activeInference } from '../shared/va529-plan.mjs';
import { isCollegeAccount } from '../shared/account-kinds.mjs';
import { PLAN_LABELS, inferPlanType } from '../shared/account-plans.mjs';
import { ownerEntityIdentity } from '../pnl/ledgers.mjs';

export const ADVISOR_KEYS = new Set(['retirement.planTermsConfirmed', 'retirement.aggregationConfirmed', 'business.salaryRange']);
export const DEFAULT_UNDO = Object.freeze({
  'household.filingStatusDefault': 'household.filingStatus',
  'business.cashBasisDefault': 'business.cashBasis',
  'accounts.va529CarryforwardDefault': 'accounts.va529',
  'business.entityInference': 'business.entities',
  'accounts.planTypeInference': 'accounts.planTypeInferred',
  'retirement.otherPlanDeferralsDefault': 'retirement.otherPlanDeferralsInferred',
});
const amount = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const ev = d => ({ table: 'documents', id: d.id, fileId: d.fileId ?? null });
const sourceFact = (data, value, rule, rows, assumption = false) => ({
  value, src: `derived:${data.clock}`, asOf: data.clock,
  provenance: { parser: 'derive', fileId: rows[0]?.fileId ?? null, locator: { rule, rows, ...(assumption ? { assumption: true } : {}) } },
});
const spousePresent = facts => !!(facts['household.birthYears']?.spouse || facts['household.names']?.spouse || facts['household.filingStatus'] === 'mfj');

export function deriveRecFacts(data, facts = {}, { entities = [] } = {}) {
  const out = {};
  if (data.taxYear !== 2026) return out;
  const docs = data.documents || [];
  const current = docs.filter(d => (d.docType === 'w2' && Number(d.taxYear) === data.year)
    || (d.docType === 'paystub' && d.fields.payDate?.slice(0, 4) === String(data.year) && d.fields.payDate <= data.clock));
  const sponsor = d => entities.find(e => e.classified && sameEmployer(data, e.name, d.fields.employerName));
  const prior = docs.filter(d => d.docType === 'w2' && Number(d.taxYear) === data.year - 1 && sponsor(d));
  const wages = {};
  const wageRows = [];
  for (const person of ['owner', 'spouse']) {
    const mine = prior.filter(d => sponsor(d)?.owner === person && docRecipient(data, d).person === person);
    // A second document may be a correction. Leave it for the existing conflict workflow.
    if (!prior.some(d => !docRecipient(data, d).person) && mine.length === 1 && amount(mine[0].fields.socialSecurityWages)) {
      wages[person] = mine[0].fields.socialSecurityWages;
      wageRows.push(ev(mine[0]));
    }
  }
  for (const person of ['owner', 'spouse']) {
    if (wages[person] !== undefined || prior.some(d => sponsor(d)?.owner === person)) continue;
    const corps = entities.filter(e => e.classified && e.type === 's_corp' && e.owner === person);
    if (corps.length !== 1) continue;
    const salary = (data.pnlHistory || []).filter(l => l.period?.slice(0, 4) === String(data.year - 1)
      && sameEmployer(data, l.entity, corps[0].name) && isOfficer(l.category));
    const total = cents(-salary.reduce((s, l) => s + l.amount, 0));
    if (!salary.length || !amount(total)) continue;
    wages[person] = total;
    wageRows.push(...salary.map(l => ({ table: 'pnl_lines', id: l.id, fileId: l.file_id ?? null })));
  }
  if (wageRows.length) out['retirement.priorYearFicaWages'] = sourceFact(data, wages, 'Prior-year sponsor W-2 Social Security wages by recipient, otherwise inferred from the S corp owner officer salary in the prior-year profit and loss', wageRows);

  const payroll = payrollRecords(data, entities, facts);
  const other = {};
  const otherRows = [];
  for (const person of ['owner', 'spouse']) {
    const mine = payroll.records.filter(r => r.person === person);
    const unknownRecipient = current.some(d => !docRecipient(data, d).person);
    if (!mine.length || unknownRecipient || payroll.blocks.some(b => !b.person || b.person === person)) continue;
    const outside = mine.filter(r => !r.household);
    if (outside.some(r => !r.deferralKnown)) continue;
    const contributions = facts['retirement.contributions'];
    if (outside.length && Array.isArray(contributions) && contributions.some(c => c?.person === person
      && c.plan === 'outside-401k' && !String(c.employer || '').trim())) continue;
    other[person] = { deferral: cents(outside.reduce((s, r) => s + r.deferral, 0)), catchUp: cents(outside.reduce((s, r) => s + r.catchUp, 0)) };
    otherRows.push(...current.filter(d => docRecipient(data, d).person === person).map(ev));
  }
  if (otherRows.length) out['retirement.otherPlanDeferrals'] = sourceFact(data, other, 'Outside-plan elective deferrals from payroll; no outside employer in the recorded employment gives zero', otherRows);

  const businessW2 = current.filter(d => d.docType === 'w2' && sponsor(d));
  if (entities.filter(e => e.classified).length === 1 && businessW2.length && businessW2.every(d => docRecipient(data, d).person)) {
    const only = businessW2.every(d => docRecipient(data, d).person === sponsor(d).owner);
    out['business.onlyEmployee'] = sourceFact(data, only, 'Business W-2 recipients compared with the business owner; based on payroll on file', businessW2.map(ev), true);
  }

  const personal = new Set((data.accounts || []).filter(a => !['business', 'hsa', '529', 'retirement'].includes(a.kind)).map(a => a.id));
  const txs = (data.transactions || []).filter(t => t.date >= `${data.year}-01-01` && t.date <= data.clock && personal.has(t.account_id));
  const eligible = txs.filter(t => /^(charitable?( donations?| contributions?)?|donations?|mortgage interest|real estate tax(?:es)?|property tax(?:es)?|personal property tax(?:es)?)$/i.test(String(t.category || '').trim()));
  if (facts['household.state'] === 'VA' && eligible.length) {
    const value = Math.max(0, cents(-eligible.reduce((s, t) => s + t.amount, 0)));
    out['tax.vaItemizedEstimate'] = sourceFact(data, value, 'Virginia estimate: net categorized charitable gifts, mortgage interest and property taxes paid year to date; state income tax and mortgage principal excluded', eligible.map(t => ({ table: 'transactions', id: t.id, fileId: t.file_id ?? null })), true);
  }

  const hsaAccounts = (data.accounts || []).filter(a => a.kind === 'hsa');
  const family = spousePresent(facts) || facts['household.dependents'] > 0 || facts['household.birthYears']?.dependents?.length > 0;
  for (const person of ['owner', 'spouse']) {
    const hsa = new Set(hsaAccounts.filter(a => a.owner === person).map(a => a.id));
    const contrib = (data.transactions || []).filter(t => hsa.has(t.account_id) && t.date >= `${data.year}-01-01` && t.date <= data.clock
      && t.amount > 0 && /contrib|deposit/i.test(`${t.category || ''} ${t.description || ''}`)
      && !/rollover|transfer|interest|dividend|employer|payroll/i.test(`${t.category || ''} ${t.description || ''}`));
    const employer = payroll.records.filter(r => r.person === person && r.hsa > 0);
    const birth = facts['household.birthYears']?.[person];
    const catchUp = birth && data.year - birth < TAX_2026.hsa.catchUpAge ? 0 : TAX_2026.hsa.catchUp;
    const limit = TAX_2026.hsa.self + catchUp;
    if (family && contrib.reduce((s, t) => s + t.amount, 0) + employer.reduce((s, r) => s + r.hsa, 0) > limit) {
      const rows = [...contrib.map(t => ({ table: 'transactions', id: t.id, fileId: t.file_id ?? null })), ...employer.flatMap(r => r.docIds.map(id => ev(docs.find(d => d.id === id))))];
      out['benefits.hsaCoverage'] = sourceFact(data, 'family', 'Household family member present and a participant HSA contributions exceed the self-only limit including applicable catch-up', rows, true);
      break;
    }
  }
  return out;
}

export async function prepareRecFacts(db, data) {
  const stored = Object.fromEntries((await db.prepare('SELECT * FROM facts').all()).map(r => [r.key, { ...r, value: parseJson(r.value, null) }]));
  const values = Object.fromEntries(Object.entries(stored).map(([k, r]) => [k, r.value]));
  const automatic = r => r && !r.confirmed && r.parser === 'derive' && String(r.src).startsWith('derived:');
  // Remove our old values before rederiving so removed documents cannot sustain a fact.
  for (const [key, row] of Object.entries(stored)) if (automatic(row)) {
    delete values[key];
  }
  const entityInference = inferEntities(data, values);
  if (entityInference.value.length) values['business.entities'] = entityInference.value;
  const mortgage = await inferMortgage(db, data.clock, values['obligations.mortgage']);
  if (mortgage.present) values['obligations.mortgage'] = mortgage.values;
  const entities = resolveEntities(data, values);
  const candidates = deriveRecFacts(data, values, { entities });
  const plans = {};
  const planRows = [];
  for (const account of data.accounts || []) {
    if (values['accounts.planType']?.[account.id] !== undefined || values['accounts.planTypeInference']?.[account.id]?.undone) continue;
    const type = inferPlanType(account);
    if (!type) continue;
    plans[account.id] = type;
    planRows.push({ table: 'accounts', id: account.id, fileId: account.fileId ?? null });
  }
  if (planRows.length) candidates['accounts.planTypeInferred'] = sourceFact(data, plans, 'Retirement plan type inferred from the account name, institution and kind', planRows);
  const defaults = [];
  const addDefault = (key, value, undoKey, evidence, path = []) => {
    const flag = values[undoKey];
    if (path.length ? flag?.[path[0]]?.undone : flag === true) return;
    const rows = [{ table: 'facts', id: key === 'business.cashBasis' ? 'business.entities' : key === 'accounts.va529' ? 'accounts.va529' : 'household.birthYears' }];
    if (key !== 'accounts.va529') candidates[key] = sourceFact(data, value, evidence, rows, true);
    defaults.push({ key, path, value: path.reduce((v, p) => v?.[p], value), undoKey, evidence });
  };
  if (values['household.filingStatus'] === undefined && spousePresent(values)) addDefault('household.filingStatus', 'mfj', 'household.filingStatusDefault', 'Assumption: filing jointly because a spouse is present.');
  if (values['business.cashBasis'] === undefined && entities.some(e => e.classified)) addDefault('business.cashBasis', true, 'business.cashBasisDefault', 'Assumption: the business uses cash-basis books.');
  const payroll = payrollRecords(data, entities, values);
  const other = candidates['retirement.otherPlanDeferrals']?.value || {};
  const zeroPeople = {};
  const people = new Set(entities.filter(e => e.classified).map(e => e.owner));
  if (spousePresent(values)) { people.add('owner'); people.add('spouse'); }
  for (const person of people) {
    if (values['retirement.otherPlanDeferrals']?.[person] !== undefined) continue;
    const mine = payroll.records.filter(r => r.person === person);
    const outside = mine.some(r => !r.household)
      || (values['retirement.contributions'] || []).some(c => c.person === person && c.plan === 'outside-401k');
    const unknown = payroll.blocks.some(b => !b.person || b.person === person);
    if (outside || unknown) continue;
    if (values['retirement.otherPlanDeferralsDefault']?.[person]?.undone) { delete other[person]; continue; }
    zeroPeople[person] = { deferral: 0, catchUp: 0 };
    delete other[person];
    defaults.push({ key: 'retirement.otherPlanDeferrals', path: [person], value: zeroPeople[person], undoKey: 'retirement.otherPlanDeferralsDefault',
      evidence: `Assumption: ${person === 'spouse' ? 'your spouse has' : 'you have'} no deferrals to other workplace plans because none are on file.` });
  }
  if (Object.keys(zeroPeople).length) candidates['retirement.otherPlanDeferralsInferred'] = sourceFact(data, zeroPeople,
    'Assumption: no deferrals to other workplace plans because none are on file',
    [{ table: 'facts', id: entities.length ? 'business.entities' : 'household.birthYears' }], true);
  if (candidates['retirement.otherPlanDeferrals'] && !Object.keys(other).length) delete candidates['retirement.otherPlanDeferrals'];
  const college = structuredClone(values['accounts.va529'] || {});
  const carryDefaults = {};
  for (const a of (data.accounts || []).filter(isCollegeAccount)) {
    const entry = college[a.id] || {};
    if ((entry.virginiaPlan === true || activeInference(a, values)?.value === true) && entry.carryforward === undefined && !values['accounts.va529CarryforwardDefault']?.[a.id]?.undone) {
      college[a.id] = { ...entry, carryforward: 0 };
      carryDefaults[a.id] = 0;
      addDefault('accounts.va529', college, 'accounts.va529CarryforwardDefault', 'Assumption: no unused Virginia deduction carries forward.', [a.id, 'carryforward']);
    }
  }
  if (Object.keys(carryDefaults).length) candidates['accounts.va529Carryforward'] = sourceFact(data, carryDefaults, 'Assumption: no unused Virginia deduction carries forward.', Object.keys(carryDefaults).map(id => ({ table: 'accounts', id })), true);
  if (Object.keys(carryDefaults).length) values['accounts.va529'] = college;
  const writes = [];
  for (const [key, candidate] of Object.entries(candidates)) {
    const row = stored[key];
    if (row && !automatic(row)) continue;
    values[key] = candidate.value;
    writes.push({ key, ...candidate });
  }
  const deletes = Object.entries(stored).filter(([key, r]) => automatic(r) && !candidates[key]).map(([key]) => key);
  withInferredRecFacts(values);
  const assumptions = defaults.filter(a => a.path.length ? !values[a.undoKey]?.[a.path[0]]?.undone : values[a.undoKey] !== true);
  for (const [id, type] of Object.entries(plans)) assumptions.push({
    key: 'accounts.planType', path: [id], value: type, undoKey: 'accounts.planTypeInference',
    evidence: `Inferred ${PLAN_LABELS[type]} from the account name and institution for ${(data.accounts || []).find(a => a.id === id)?.name || 'this account'}.`,
  });
  for (const entity of entityInference.value.filter(e => e?.inferred)) assumptions.push({
    key: 'business.entities', path: [entity.name], value: entity.type, undoKey: 'business.entityInference',
    evidence: `${entity.name}: inferred ${entity.type === 'personal' ? 'personal spending and income summary' : entity.type === 'income_history' ? 'past client income history' : entity.type === 'inactive' ? 'inactive past business' : entity.type === null ? 'household business with tax type pending' : 'S corp'} from stored ${entity.inferenceKind === 'household_payroll' ? 'household employer and payroll evidence' : 'ledger activity'}.${entity.type === 'personal' ? entity.owner ? ` Attributed to ${entity.owner === 'spouse' ? 'your spouse' : 'you'}.` : ' Tell Fathom who this summary belongs to.' : ''}${(entity.evidence?.otherIncome || []).map(a => ` ${a.stated}.`).join('')} Not right? Tell Fathom which one is the S corp or correct this summary's person.`,
  });
  return { values, assumptions, writes, deletes, mortgage, async write(db) {
    let changed = 0;
    if (entityInference.changed) {
      const src = `inferred:entities:${data.clock}`;
      await db.prepare('INSERT OR IGNORE INTO sources (id,label,as_of,kind,note) VALUES (?,?,?,?,?)')
        .run(src, 'Entity classifications inferred from ledger line counts and kinds', data.clock, 'derived', '');
      if ((await upsertFact(db, { key: 'business.entities', value: entityInference.value, src, asOf: data.clock,
        confirmed: !!stored['business.entities']?.confirmed, provenance: { parser: 'entity-inference', locator: { rule: 'entity_classification', rows: entityInference.rows } } })).changed) changed++;
    }
    for (const key of deletes) changed += (await db.prepare("DELETE FROM facts WHERE key = ? AND src LIKE 'derived:%' AND confirmed = 0").run(key)).changes;
    if (writes.length) await db.prepare('INSERT OR IGNORE INTO sources (id, label, as_of, kind, note) VALUES (?, ?, ?, ?, ?)')
      .run(`derived:${data.clock}`, 'Derived from stored data and stated assumptions', data.clock, 'derived', '');
    for (const w of writes) if ((await upsertFact(db, { ...w, confirmed: false })).changed) changed++;
    return changed;
  } };
}

export async function undoDefault(db, key, value) {
  if (key === 'business.entityInference') {
    const row = await db.prepare("SELECT value FROM facts WHERE key='business.entities'").get();
    const prior = parseJson(row?.value, []);
    if (Array.isArray(prior)) {
      const names = new Set(Object.entries(value).filter(([, flag]) => flag.undone).map(([name]) => name.trim().toLowerCase()));
      await db.prepare("UPDATE facts SET value=? WHERE key='business.entities'").run(JSON.stringify(prior.flatMap(e => !e?.inferred || !names.has(e.name.trim().toLowerCase()) ? [e]
        : e.nameSource === 'owner' ? [ownerEntityIdentity(e)] : [])));
    }
    return;
  }
  if (key === 'accounts.planTypeInference' || key === 'retirement.otherPlanDeferralsDefault') {
    const target = DEFAULT_UNDO[key];
    const row = await db.prepare('SELECT * FROM facts WHERE key = ?').get(target);
    if (!row || row.confirmed || row.parser !== 'derive') return;
    const prior = parseJson(row.value, {});
    for (const [id, flag] of Object.entries(value)) if (flag?.undone) delete prior[id];
    if (Object.keys(prior).length) await db.prepare('UPDATE facts SET value = ? WHERE key = ?').run(JSON.stringify(prior), target);
    else await db.prepare('DELETE FROM facts WHERE key = ?').run(target);
    return;
  }
  const target = DEFAULT_UNDO[key];
  if (!target || (target !== 'accounts.va529' && value !== true)) return;
  if (target === 'accounts.va529') {
    const row = await db.prepare('SELECT * FROM facts WHERE key = ?').get(target);
    if (!row || row.confirmed || !String(row.src).startsWith('derived:')) return;
    const prior = parseJson(row.value, {});
    for (const id of Object.keys(value)) if (value[id]?.undone === true && prior[id]) delete prior[id].carryforward;
    await db.prepare('UPDATE facts SET value = ? WHERE key = ?').run(JSON.stringify(prior), target);
  } else await db.prepare("DELETE FROM facts WHERE key = ? AND src LIKE 'derived:%' AND confirmed = 0").run(target);
}
