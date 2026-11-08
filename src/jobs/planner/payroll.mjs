// Payroll records read from ingest's W-2 and paystub documents (plan Revision 6, R6-1 and R6-5).
// Pure: everything comes from loadPlanningData. Field names are exactly ingest's extraction shape
// (src/ingest/extract.mjs SCHEMAS.w2 and SCHEMAS.paystub); who a document belongs to comes from
// ingest's withholding rows and its confirm answers (employer_recipient, document_recipient,
// employer_relation, withholding_conflict), never from a guessed default.
//
// payrollRecords(data, entities, owner) -> {records, blocks, ask}
//   records: [{docId, docIds, fileId, person, employer, key, kind, wages, ytdWages, medicare, comp,
//     deferral, catchUp, roth, pretax, hsa, deferral457, elective402g, deferralKnown, corp, household, projected}]
//   blocks:  [{code, employer, person}] precision gaps and the assumptions or exclusions they need
//   ask:     [{employerKey, employer, payer, fileId}] recipient questions to raise through ingest (D9)
// employerKeyOf(name) -> ingest's employer key
// sameEmployer(data, a, b) -> normalized names equal, after mapping entity aliases
// matchEntity(data, entities, name) -> the household entity an employer name is, or null
// docRecipient(data, doc) -> {person} | {blocked: code} | {unknown: true}
// docPayer(doc) -> the payer identity ingest gives the document's withholding rows

import { nameKey } from '../../ingest/extract.mjs';
import { normalizeName } from '../../ingest/confirm.mjs';
import { TAX_2026 } from '../../calc/index.mjs';
import { cents } from '../../store/db.mjs';
import { monthOf, yearOf, sum } from './data.mjs';

export const employerKeyOf = name => nameKey(name);

const aliasOf = (data, name) => {
  const n = normalizeName(name);
  const hit = (data.aliases || []).find(a => a.alias === n);
  return hit ? normalizeName(hit.entity) : n;
};

export function sameEmployer(data, a, b) {
  const x = aliasOf(data, a);
  return x !== '' && x === aliasOf(data, b);
}

export function matchEntity(data, entities, name) {
  if (!String(name ?? '').trim()) return null;
  return entities.find(e => sameEmployer(data, e.name, name)) || null;
}

const isAmount = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
// ingest's payer identity amount: whole cents, or 'na' when the amount was not read.
const centsOf = v => (Number.isFinite(v) ? String(Math.round(v * 100)) : 'na');

export function docPayer(doc) {
  const fl = doc.fields;
  const key = nameKey(fl.employerName);
  return doc.docType === 'w2' ? `w2:${key}:${fl.taxYear}:${centsOf(fl.wages)}` : `paystub:${key}:${fl.payDate}:${centsOf(fl.gross)}`;
}
const startsPayer = (payer, identity) => payer === identity || String(payer ?? '').startsWith(`${identity}:`);

const answered = (data, kind, subject) => (data.confirm || []).find(i => i.kind === kind && i.subject === subject && i.status === 'answered');
const pendingItem = (data, kind, subject) => (data.confirm || []).find(i => i.kind === kind && i.subject === subject && i.status === 'pending');

// R6-1 item 2.2: the active withholding rows of the document decide; else the answers; else unknown.
export function docRecipient(data, doc) {
  const rows = (data.withholding || []).filter(r => r.file_id === doc.fileId && String(r.payer).startsWith(`${doc.docType}:${nameKey(doc.fields.employerName)}:`));
  const known = [...new Set(rows.map(r => r.recipient).filter(r => r === 'owner' || r === 'spouse'))];
  if (known.length > 1) return { blocked: 'payroll_recipient_conflict' };
  if (known.length === 1) return { person: known[0] };
  const byEmployer = answered(data, 'employer_recipient', nameKey(doc.fields.employerName));
  if (byEmployer && (byEmployer.answer === 'owner' || byEmployer.answer === 'spouse')) return { person: byEmployer.answer };
  if (byEmployer && byEmployer.answer === 'both') {
    const byDoc = (data.confirm || []).find(i => i.kind === 'document_recipient' && i.status === 'answered' && String(i.subject).endsWith(`:doc:${doc.fileId}`));
    if (byDoc && (byDoc.answer === 'owner' || byDoc.answer === 'spouse')) return { person: byDoc.answer };
  }
  return { unknown: true };
}

// R6-1 item 2.3: household when the employer is a household entity (by name or alias); otherwise the
// employer_relation answer decides, and an employer ingest asked about and nobody answered blocks.
function docKind(data, entities, doc, owner) {
  const named = Object.entries(owner['business.employerEntity'] || {}).find(([name]) => sameEmployer(data, name, doc.fields.employerName))?.[1];
  const entity = matchEntity(data, entities, named || doc.fields.employerName);
  if (entity) return { household: true, entity };
  const stated = Object.entries(owner['income.employerRelation'] || {}).find(([name]) => sameEmployer(data, name, doc.fields.employerName))?.[1];
  const relation = stated ? { status: 'answered', answer: stated } : (data.confirm || []).find(i => i.kind === 'employer_relation' && i.subject === nameKey(doc.fields.employerName));
  if (relation && relation.status === 'answered' && relation.answer === 'household') {
    if (entities.length === 1 && entities[0].classified && owner['business.entitiesDefault'] !== true && owner['business.employerEntityDefault'] !== true) return { household: true, entity: entities[0] };
    return { blocked: 'household_employer_unmatched' };
  }
  if (relation && relation.status === 'answered' && relation.answer === 'outside') return { household: false };
  if (relation && relation.status === 'pending') return { blocked: 'employer_relation_pending' };
  return { household: false };
}

// Box 12 (Form W-2 instructions): D, E, F, G and S are excluded from box 1; D, E, F, S, AA and BB
// are IRC 402(g)(3) elective deferrals (402A(c)(2) for the Roth ones); G and EE are 457(b)
// deferrals under the separate 457(c) limit; W is employer and cafeteria-plan HSA money.
// Box 12 not read at all (the field is absent) leaves the deferrals unknown, never zero.
function box12Of(fields) {
  if (fields.box12 == null) return { pretax: 0, elective402g: 0, deferral457: 0, roth: 0, hsa: 0, unread: true };
  const list = fields.box12;
  if (!Array.isArray(list)) return null;
  const by = {};
  for (const b of list) {
    if (!b || typeof b !== 'object' || !isAmount(b.amount)) return null;
    const code = String(b.code ?? '').trim().toUpperCase();
    by[code] = cents((by[code] || 0) + b.amount);
  }
  const c = k => by[k] || 0;
  return {
    pretax: cents(c('D') + c('E') + c('F') + c('G') + c('S')),
    elective402g: cents(c('D') + c('E') + c('F') + c('S') + c('AA') + c('BB')),
    deferral457: cents(c('G') + c('EE')),
    roth: cents(c('AA') + c('BB') + c('EE')),
    hsa: c('W'),
  };
}

// R6-5: which W-2 documents a withholding_conflict answer dropped, and which pairs nothing settled.
function corrections(data, w2s) {
  const blocks = [];
  const dropped = new Set();
  const byFile = new Map(w2s.map(d => [d.fileId, d]));
  const sameSlot = (a, b) => a && b && a.id !== b.id && nameKey(a.fields.employerName) === nameKey(b.fields.employerName) && Number(a.taxYear) === Number(b.taxYear);
  // Every archived conflict row names the file it dropped and the file that was kept.
  const drops = [];
  for (const a of data.conflictArchive || []) {
    const doc = byFile.get(a.fileId);
    const kept = byFile.get(a.supersededBy);
    if (!doc || !sameSlot(doc, kept) || !startsPayer(a.row.payer, docPayer(doc))) continue;
    drops.push({ drop: doc, keep: kept });
  }
  for (const d of drops) {
    if (drops.some(o => o.drop.id === d.keep.id && o.keep.id === d.drop.id)) {
      blocks.push({ code: 'w2_correction_conflicting', employer: d.drop.fields.employerName, docs: [d.drop.id, d.keep.id] });
    } else dropped.add(d.drop.id);
  }
  for (const b of blocks) for (const id of b.docs) dropped.delete(id);
  const items = (data.confirm || []).filter(i => i.kind === 'withholding_conflict');
  const filesOf = i => [i.context && i.context.first && i.context.first.fileId, i.context && i.context.second && i.context.second.fileId];
  for (const i of items.filter(x => x.status === 'pending')) {
    const docs = filesOf(i).map(f => byFile.get(f)).filter(Boolean);
    if (docs.length) blocks.push({ code: 'w2_correction_pending', employer: docs[0].fields.employerName, docs: docs.map(d => d.id) });
  }
  const settled = (a, b) => items.some(i => i.status === 'answered' && ['first', 'second', 'both'].includes(i.answer)
    && filesOf(i).includes(a.fileId) && filesOf(i).includes(b.fileId));
  return { dropped, blocks, settled };
}

export function payrollRecords(data, entities, owner = {}) {
  const TY = data.taxYear;
  const R = TAX_2026.retirement;
  const blocks = [];
  const ask = [];
  const docs = data.documents.filter(d => (d.docType === 'w2' && Number(d.taxYear) === TY)
    || (d.docType === 'paystub' && typeof d.fields.payDate === 'string' && yearOf(d.fields.payDate) === TY && d.fields.payDate <= data.clock));
  const fix = corrections(data, docs.filter(d => d.docType === 'w2'));
  blocks.push(...fix.blocks);
  

  const groups = new Map();
  for (const d of docs) {
    if (fix.dropped.has(d.id)) continue;
    const employer = String(d.fields.employerName ?? '').trim();
    const statedPerson = Object.entries(owner['income.payrollRecipient'] || {}).find(([name]) => sameEmployer(data, name, employer))?.[1];
    const who = ['owner', 'spouse'].includes(statedPerson) ? { person: statedPerson } : docRecipient(data, d);
    if (who.blocked) { blocks.push({ code: who.blocked, employer }); continue; }
    if (who.unknown) {
      blocks.push({ code: 'w2_recipient_unknown', employer });
      ask.push({ employerKey: nameKey(employer), employer, payer: `${docPayer(d)}:doc:${d.fileId}`, fileId: d.fileId });
      continue;
    }
    let kind = docKind(data, entities, d, owner);
    if (kind.blocked === 'employer_relation_pending') { blocks.push({ code: kind.blocked, employer, person: who.person }); kind = { household: false }; }
    if (kind.blocked) { blocks.push({ code: kind.blocked, employer, person: who.person }); continue; }
    const key = `${who.person}|${nameKey(employer)}`;
    if (!groups.has(key)) groups.set(key, { person: who.person, employer, key: nameKey(employer), kind, docs: [] });
    groups.get(key).docs.push(d);
  }

  const records = [];
  for (const g of groups.values()) {
    let w2s = g.docs.filter(d => d.docType === 'w2');
    let r;
    if (w2s.length) {
      if (fix.blocks.some(b => b.docs?.some(id => w2s.some(d => d.id === id)))) w2s = [w2s.reduce((a, b) => a.id > b.id ? a : b)];
      // R6-5 item 5: two W-2s of one employer, year and person that no answer reconciled.
      const pair = w2s.find((a, i) => w2s.slice(i + 1).some(b => !fix.settled(a, b)));
      if (pair) {
        if (!fix.blocks.some(b => b.docs?.some(id => w2s.some(d => d.id === id)))) blocks.push({ code: 'w2_duplicate_unresolved', employer: g.employer, person: g.person });
        w2s = [w2s.reduce((a, b) => a.id > b.id ? a : b)];
      }
      const parts = w2s.map(d => {
        let box = box12Of(d.fields);
        if (!box || box.unread) {
          blocks.push({ code: 'w2_box12_unreadable', employer: g.employer, person: g.person });
          box = { pretax: 0, elective402g: 0, deferral457: 0, roth: 0, hsa: 0 };
        }
        return { d, box, wages: d.fields.wages };
      });
      if (parts.some(p => !isAmount(p.wages))) { blocks.push({ code: 'w2_wages_missing', employer: g.employer, person: g.person }); continue; }
      // An unread Medicare base uses taxable wages as a labeled estimate.
      if (parts.some(p => !isAmount(p.d.fields.medicareWages))) blocks.push({ code: 'w2_medicare_wages_missing', employer: g.employer, person: g.person });
      const total = k => cents(sum(parts.map(p => p.box[k])));
      const wages = cents(sum(parts.map(p => p.wages)));
      // E1, E5: each base is read on its own. Box 1 is income tax wages (already net of pretax
      // deferrals); box 5 is Medicare wages (Form 8959); plan compensation is box 1 plus the elective
      // deferrals box 1 leaves out (IRC 415(c)(3), Pub 560).
      r = {
        kind: 'w2', docIds: w2s.map(d => d.id), fileId: w2s[0].fileId, wages, ytdWages: wages, pretax: total('pretax'),
        // E6: box 12 unread leaves the deferrals, and so the compensation, unknown (null), never zero.
        medicare: cents(sum(parts.map(p => isAmount(p.d.fields.medicareWages) ? p.d.fields.medicareWages : p.wages))), comp: parts.some(p => p.box.unread) ? null : cents(wages + total('pretax')),
        elective402g: total('elective402g'), deferral457: total('deferral457'), roth: total('roth'), hsa: total('hsa'),
        deferralKnown: !parts.some(p => p.box.unread), projected: false,
      };
    } else {
      // Prefer the latest readable YTD for this person and employer, then project per-period gross.
      const stubs = [...g.docs].sort((a, b) => String(a.fields.payDate).localeCompare(String(b.fields.payDate)) || a.id - b.id);
      const input = paystubIncome(data, g, stubs, owner);
      if (!input) { blocks.push({ code: 'paystub_ytd_missing', employer: g.employer, person: g.person }); continue; }
      const { last, ytdGross, projectedGross, provenance } = input;
      if (provenance.assumption) blocks.push({ code: 'paystub_gross_assumed', employer: g.employer, person: g.person, message: provenance.note });
      const deferring = stubs.some(s => Number(s.fields.retirementDeferral) > 0 || Number(s.fields.hsaDeferral) > 0);
      let pretax = 0;
      if (deferring) {
        // E2: a stated deferral belongs to the employer it names; one naming no employer only to the
        // person's single outside employer. Another employer's answer never applies here.
        const entries = Array.isArray(owner['retirement.contributions']) ? owner['retirement.contributions'] : [];
        const named = c => typeof c.employer === 'string' && c.employer.trim();
        const soleOutside = [...groups.values()].filter(x => x.person === g.person && !x.kind.household).length === 1;
        const stated = entries.filter(c => c && c.person === g.person && c.plan === 'outside-401k' && c.type === 'deferral' && isAmount(Number(c.amount))
          && (named(c) ? sameEmployer(data, c.employer, g.employer) : soleOutside));
        if (g.kind.household || !stated.length) blocks.push({ code: 'paystub_deferrals_unknown', employer: g.employer, person: g.person });
        pretax = cents(sum(stated.filter(c => c.roth !== true).map(c => Number(c.amount))));
      }
      r = {
        // Gross pay keeps 401(k) deferrals in it, so it is the Medicare wage and the plan compensation.
        kind: 'paystub', docIds: [last.id], fileId: last.fileId, wages: Math.max(0, cents(projectedGross - pretax)), ytdWages: cents(ytdGross), payrollProvenance: provenance,
        medicare: projectedGross, comp: projectedGross, pretax, elective402g: 0, deferral457: 0, roth: 0, hsa: 0, deferralKnown: !deferring, projected: true, section125Unknown: !deferring,
      };
    }
    const corp = g.kind.household && g.kind.entity.classified && g.kind.entity.type === 's_corp' ? g.kind.entity : null;
    records.push({
      ...r, docId: r.docIds[0], person: g.person, employer: g.employer, key: g.key, deferral: 0, catchUp: 0,
      corp: corp ? corp.slug : null, household: !!g.kind.household,
    });
  }

  // R6-1 item 2.5 (Reg. 1.414(v)-1(b)(1)): deferrals above the 402(g) limit are catch-ups. Per plan
  // the split is only known when one plan holds them all, or the owner states the other plans'.
  for (const p of ['owner', 'spouse']) {
    const mine = records.filter(r => r.person === p && r.elective402g > 0);
    const total = cents(sum(mine.map(r => r.elective402g)));
    const over = cents(total - R.employeeDeferral);
    const fill = (list, regularRoom) => {
      let room = Math.max(0, regularRoom);
      for (const r of list) {
        r.deferral = cents(Math.min(r.elective402g, room));
        r.catchUp = cents(r.elective402g - r.deferral);
        room = cents(room - r.deferral);
      }
    };
    if (!(over > 0)) { fill(mine, R.employeeDeferral); continue; }
    const household = mine.filter(r => r.household);
    const other = mine.filter(r => !r.household);
    const planIds = new Set(household.map(r => r.corp || `household:${r.key}`));
    if (household.length && (other.length || planIds.size > 1)) {
      const stated = owner['retirement.otherPlanDeferrals'];
      const of = stated && typeof stated === 'object' && !Array.isArray(stated) ? stated[p] : null;
      if (planIds.size === 1 && of && typeof of === 'object' && isAmount(of.deferral)) {
        fill(household, cents(R.employeeDeferral - of.deferral));
        fill(other, cents(R.employeeDeferral - sum(household.map(r => r.deferral))));
      } else {
        blocks.push({ code: 'deferral_split_unknown', employer: household[0].employer, person: p });
        fill(mine, R.employeeDeferral);
      }
      continue;
    }
    fill(mine, R.employeeDeferral);
  }
  return { records, blocks, ask };
}

function paystubIncome(data, group, stubs, owner) {
  const stated = Object.entries(owner['income.payrollYtd'] || {}).find(([employer, v]) => sameEmployer(data, employer, group.employer)
    && v.person === group.person && isAmount(v.ytdGross) && typeof v.asOf === 'string'
    && yearOf(v.asOf) === data.taxYear && v.asOf <= data.clock)?.[1];
  const observed = stubs.filter(d => isAmount(d.fields.ytdGross)).at(-1);
  if (stated && (!observed || stated.asOf >= observed.fields.payDate)) return {
    last: stubs.at(-1), ytdGross: stated.ytdGross, projectedGross: cents(stated.ytdGross * 12 / monthOf(stated.asOf)),
    provenance: { method: 'owner_ytd', fact: 'income.payrollYtd', employer: group.employer, person: group.person, asOf: stated.asOf, ytdGross: stated.ytdGross },
  };
  if (observed) return { last: observed, ytdGross: observed.fields.ytdGross,
    projectedGross: cents(observed.fields.ytdGross * 12 / monthOf(observed.fields.payDate)),
    provenance: { method: 'document_ytd', asOf: observed.fields.payDate, docId: observed.id, ytdGross: observed.fields.ytdGross },
  };
  const last = stubs.filter(d => isAmount(d.fields.gross)).at(-1);
  if (!last) return null;
  const fl = last.fields;
  const day = date => Date.parse(`${date}T00:00:00Z`);
  const length = (day(fl.periodEnd) - day(fl.periodStart)) / 86400000 + 1;
  const endDay = Number(fl.periodEnd?.slice(8));
  const startDay = Number(fl.periodStart?.slice(8));
  let periods = 12, toDate = monthOf(fl.payDate), frequency = 'monthly (assumed)';
  if (length === 7 || length === 14) {
    periods = length === 7 ? 52 : 26;
    toDate = Math.max(1, Math.floor(((day(fl.payDate) - day(`${data.taxYear}-01-01`)) / 86400000 + 1) / length));
    frequency = length === 7 ? 'weekly' : 'every other week';
  } else if ((startDay === 1 && endDay === 15) || (startDay === 16 && endDay >= 28)) {
    periods = 24; toDate = (monthOf(fl.payDate) - 1) * 2 + (Number(fl.payDate.slice(8)) >= 16 ? 2 : 1); frequency = 'twice monthly';
  } else if (startDay === 1 && endDay >= 28) frequency = 'monthly';
  const ytdGross = cents(fl.gross * toDate);
  return { last, ytdGross, projectedGross: cents(fl.gross * periods), provenance: {
    method: 'period_gross', assumption: true, asOf: fl.payDate, docId: last.id, gross: fl.gross, periodsPerYear: periods, periodsToDate: toDate,
    note: `Projected wages from ${group.employer} using gross pay times pay periods; assumed ${frequency} pay and unchanged gross throughout the year.`,
  } };
}

export function inferHouseholdEmployer(data, facts, entities) {
  if (facts['business.entitiesDefault'] === true || facts['business.employerEntityDefault'] === true || entities.length > 1) return null;
  const docs = data.documents.filter(d => (d.docType === 'w2' && Number(d.taxYear) === data.taxYear)
    || (d.docType === 'paystub' && yearOf(d.fields.payDate) === data.taxYear && d.fields.payDate <= data.clock));
  const household = docs.filter(d => answered(data, 'employer_relation', nameKey(d.fields.employerName))?.answer === 'household');
  if (entities.length === 1) {
    const entity = entities[0];
    const unmatched = household.filter(d => !matchEntity(data, entities, d.fields.employerName));
    if (!entity.classified || !unmatched.length || facts['business.employerEntity'] !== undefined) return null;
    return { key: 'business.employerEntity', undoKey: 'business.employerEntityDefault',
      value: Object.fromEntries(unmatched.map(d => [d.fields.employerName.trim(), entity.name])),
      evidence: `Inferred the household employer names as ${entity.name}, the only household business on file.`,
      rows: unmatched.map(d => ({ table: 'documents', id: d.id, fileId: d.fileId })),
    };
  }
  if (facts['income.sCorp'] !== true) return null;
  const names = [...new Set(household.map(d => nameKey(d.fields.employerName)))];
  if (names.length !== 1) return null;
  const people = [...new Set(household.map(d => docRecipient(data, d).person))];
  if (people.length !== 1 || !people[0]) return null;
  const doc = household[0];
  return { key: 'business.entities', undoKey: 'business.entitiesDefault', value: [{ name: doc.fields.employerName.trim(), type: 's_corp', owner: people[0] }],
    evidence: `Inferred ${doc.fields.employerName} as the household S corporation from your employer answer and S corporation fact.`,
    rows: household.map(d => ({ table: 'documents', id: d.id, fileId: d.fileId })),
  };
}
