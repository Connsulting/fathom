import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore } from '../helpers/ingest.mjs';
import { importProposedRows } from '../helpers/import-proposal-fixture.mjs';
import { buildScenario } from '../../src/scenario/build.mjs';
import { planRun } from '../helpers/plan.mjs';
import { setSetting } from '../../src/store/db.mjs';
import { upsertFact } from '../../src/store/facts.mjs';
import { autoResolve } from '../../src/ingest/auto.mjs';
import { resolvePending } from '../../src/resolve/index.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { JEV_MODEL } from '../../src/categories/jev.mjs';
import { categoryOptions, loadCategoryInputs, setTransactionCategory } from '../../src/categories/store.mjs';
import { KINDS, KIND_OPTIONS, EMPLOYER_OPTIONS, EMPLOYER_RECIPIENT_OPTIONS, DOCUMENT_RECIPIENT_OPTIONS,
  FACT_CHECK_OPTIONS, ask, getItem, pendingItems, autoInfo, answerItem, reopenItem, recordFact } from '../../src/ingest/confirm.mjs';
import { ANSWER_SHAPES } from '../../src/jobs/triggers/common.mjs';
import { saveConfirmAnswers, saveConfirmReopen } from '../../src/api/ingest-handlers.mjs';
import { nameKey, SCHEMAS } from '../../src/ingest/extract.mjs';
import { mapSeries } from '../../src/shared/series.mjs';

const NOW = '2026-11-05T12:00:00.000Z';
const names = { me: 'Avery Example', spouse: 'Blair Example' };
const fact = async (db, key, value) => await upsertFact(db, { key, value, src: 'you', confirmed: true, now: NOW });
async function store(t) {
  const s = await realStore();
  t.after(async () => await s.close());
  await setSetting(s.db, 'clock', NOW.slice(0, 10));
  return s;
}
const question = async (db, kind, subject, options, context = {}) => (await ask(db, { kind, subject, options, context,
  question: 'Which answer is right?', now: NOW })).id;
async function account(db, id, name) {
  await db.prepare('INSERT INTO accounts (id,name,inst,owner) VALUES (?,?,?,?)').run(id, name, 'Example Bank', 'You');
  return await question(db, 'account_kind', id, KIND_OPTIONS);
}
async function transaction(db, description, category = null) {
  const id = Number((await db.prepare("INSERT INTO transactions (account_id,date,amount,description,category,parser) VALUES ('cash','2026-10-15',-150,?,?, 'simplefin') RETURNING id")
    .get(description, category)).id);
  await db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?)').run(id, JSON.stringify({ category: 'Shopping', confidence: 0.85 }), JEV_MODEL, NOW);
  const item = await question(db, 'transaction_category', String(id), categoryOptions(await loadCategoryInputs(db)), { transactionId: id, merchant: description });
  return { id, item };
}
async function assertAuto(db, id, option) {
  assert.equal((await getItem(db, id)).answer, option);
  assert.ok((await autoInfo(db, id))?.evidence.text);
  assert.ok(await db.prepare('SELECT 1 FROM confirm_undo WHERE item_id=?').get(id));
}

test('AC1: business aliases, exact payroll names and clear account kinds answer with evidence and Undo', async t => {
  const s = await store(t), db = s.db;
  await fact(db, 'household.names', names);
  await fact(db, 'business.entities', [{ name: 'Example Studio', type: 's_corp', owner: 'owner' }]);
  await db.prepare('INSERT INTO entity_aliases VALUES (?,?,?)').run('examplestudiopayroll', 'Example Studio', NOW);
  const relation = await question(db, 'employer_relation', 'examplestudiopayroll', EMPLOYER_OPTIONS, { employer: 'Example Studio Payroll' });
  const checking = await account(db, 'cash', 'Everyday Checking');
  const savings = await account(db, 'reserve', 'Emergency Savings');
  const ambiguous = await account(db, 'other', 'Flexible Account');
  await importProposedRows(s, [{ target: 'document', docType: 'w2', fields: {
    taxYear: 2026, employerName: 'Example Outside One', employeeName: names.me, wages: 70000, federalWithheld: 5000, confidence: 1,
  } }], { name: 'synthetic-owner-w2.xlsx', now: NOW });
  await importProposedRows(s, [{ target: 'document', docType: 'w2', fields: {
    taxYear: 2026, employerName: 'Example Outside Two', employeeName: names.spouse, wages: 65000, federalWithheld: 4500, confidence: 1,
  } }], { name: 'synthetic-spouse-w2.xlsx', now: NOW });
  await autoResolve(db, { now: NOW });
  await assertAuto(db, relation, 'household');
  await assertAuto(db, checking, 'cash');
  await assertAuto(db, savings, 'cash');
  await reopenItem(db, relation, { now: NOW });
  assert.equal((await getItem(db, relation)).status, 'pending');
  for (const [employer, person] of [['exampleoutsideone', 'owner'], ['exampleoutsidetwo', 'spouse']]) {
    const item = await db.prepare("SELECT id FROM confirm_items WHERE kind='employer_recipient' AND subject=?").get(nameKey(employer));
    assert.ok(item, 'payroll import queued a recipient');
    await assertAuto(db, item.id, person);
    await reopenItem(db, item.id, { now: NOW });
    assert.equal((await getItem(db, item.id)).status, 'pending');
  }
  assert.equal((await getItem(db, ambiguous)).status, 'pending');
  await reopenItem(db, checking, { now: NOW });
  await autoResolve(db, { now: NOW });
  assert.equal((await getItem(db, checking)).status, 'pending');
  assert.equal((await db.prepare("SELECT kind FROM accounts WHERE id='cash'").get()).kind, null);
  assert.ok(SCHEMAS.w2.properties.employeeName);
  assert.ok(SCHEMAS.paystub.properties.employeeName);
});

test('AC1: missing or conflicting recipients stay pending and owner answers survive', async t => {
  const { db } = await store(t);
  await fact(db, 'household.names', names);
  const id = await question(db, 'employer_recipient', nameKey('Example Both'), EMPLOYER_RECIPIENT_OPTIONS, { employer: 'Example Both' });
  for (const employeeName of [names.me, names.spouse]) await db.prepare('INSERT INTO documents (doc_type,tax_year,fields) VALUES (?,?,?)')
    .run('w2', 2026, JSON.stringify({ employerName: 'Example Both', employeeName, taxYear: 2026, wages: 60000 }));
  const unknown = await question(db, 'employer_relation', nameKey('Example Unknown Employer'), EMPLOYER_OPTIONS, { employer: 'Example Unknown Employer' });
  const missing = await question(db, 'document_recipient', 'w2:unknown:2026:0:doc:missing', DOCUMENT_RECIPIENT_OPTIONS);
  await autoResolve(db, { now: NOW });
  assert.equal((await getItem(db, id)).status, 'pending');
  assert.equal((await getItem(db, missing)).status, 'pending');
  assert.equal((await getItem(db, unknown)).status, 'pending');
  await answerItem(db, id, 'spouse', { now: NOW });
  await autoResolve(db, { now: NOW });
  assert.equal((await getItem(db, id)).answer, 'spouse');
  assert.equal(await autoInfo(db, id), null);
});

test('AC2: model mappings need at least 0.90 confidence and remain undoable', async t => {
  const { db } = await store(t);
  await account(db, 'cash', 'Flexible Account');
  const ids = await mapSeries([0.92, 0.85], async (confidence, i) => {
    await transaction(db, 'Example Mapping ' + i, 'Custom source ' + i);
    return { confidence, category: 'Custom source ' + i };
  });
  let calls = 0;
  const engine = { isOn: () => true, async call(req) {
    calls++;
    const payload = JSON.parse(req.messages[0].content);
    return { text: JSON.stringify({ answers: payload.items.filter(i => i.kind === 'category_mapping').map(i => ({
      item: i.id, option: 'household', confidence: ids.find(r => r.category === i.context.category).confidence,
      basis: 'imported_values', refs: payload.rows.filter(r => r.ref.startsWith('transactions:')).map(r => r.ref),
    })) }), costUsd: 0 };
  } };
  await resolvePending(db, engine, { now: NOW, packDirs: [] });
  assert.equal(calls, 1);
  const mappings = await db.prepare("SELECT id,context FROM confirm_items WHERE kind='category_mapping' ORDER BY id").all();
  const high = mappings.find(i => JSON.parse(i.context).category === ids[0].category);
  const low = mappings.find(i => JSON.parse(i.context).category === ids[1].category);
  await assertAuto(db, high.id, 'household');
  assert.equal((await getItem(db, low.id)).status, 'pending');
  await reopenItem(db, high.id, { now: NOW });
  assert.equal((await db.prepare('SELECT count(*) n FROM category_source_rules').get()).n, 0);
  await resolvePending(db, engine, { now: NOW, packDirs: [] });
  assert.equal((await getItem(db, high.id)).status, 'pending');
});

test('AC3: a merchant answer covers pending siblings, protects owner labels, and has one Undo', async t => {
  const s = await store(t), db = s.db;
  const ctx = { db, config: { clock: NOW.slice(0, 10) }, household: s.household };
  await account(db, 'cash', 'Flexible Account');
  await db.prepare("UPDATE accounts SET kind='cash' WHERE id='cash'").run();
  const a = await transaction(db, 'Example Merchant'), b = await transaction(db, 'EXAMPLE MERCHANT'),
    labeled = await transaction(db, 'Example Merchant'), other = await transaction(db, 'Different Merchant');
  await setTransactionCategory(db, labeled.id, 'Business', { now: NOW });
  await saveConfirmAnswers(ctx, [{ id: a.item, answer: 'always:Shopping' }]);
  assert.equal((await getItem(db, b.item)).status, 'answered');
  assert.equal((await getItem(db, other.item)).status, 'pending');
  assert.equal((await db.prepare('SELECT category FROM transaction_category_corrections WHERE transaction_id=?').get(labeled.id)).category, 'Business');
  assert.equal((await db.prepare('SELECT category FROM transaction_category_corrections WHERE transaction_id=?').get(b.id)).category, 'Shopping');
  await saveConfirmReopen(ctx, [a.item]);
  for (const id of [a.item, b.item]) {
    assert.equal((await getItem(db, id)).status, 'pending');
    assert.ok(await db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(id));
  }
  assert.equal((await db.prepare('SELECT count(*) n FROM transaction_category_corrections').get()).n, 1);
  assert.equal((await db.prepare('SELECT count(*) n FROM category_merchant_rules').get()).n, 0);
});

test('AC4: every Confirm kind uses a plain question and fact questions use answer labels', async t => {
  const { db } = await store(t);
  const key = 'retirement.planOffersRoth';
  const questions = {
    account_owner: 'Whose account is Everyday Checking?',
    account_kind: 'What kind of account is Flexible Account?',
    entity_alias: 'Is Example Alias the same business as one of these, or separate?',
    tax_year: 'Does the 2026 sheet list payments for tax year 2026, or payments made during 2026?',
    fact_check: `An import says ${key} is true. Is that right?`,
    near_duplicate: 'Are these the same transaction?',
    employer_relation: 'Is Example Employer an outside employer or your own business?',
    employer_recipient: 'Who is paid by Example Employer?',
    document_recipient: 'Whose 2026 W-2 from Example Employer is this?',
    withholding_conflict: 'Two W-2s from one payer report different federal withholding for 2026. Which should count?',
    account_match: 'Are these the same account?',
    transaction_category: 'Check this transaction category',
    transaction_payment: 'Is this connected-account payment an estimated tax payment?',
    category_mapping: 'Treat Example Essentials as ...',
    resolver_fact: key,
    stated_value: 'Your note says "My salary range from the advisor is 90k to 120k." Use it?',
  };
  assert.deepEqual(Object.keys(questions).sort(), [...KINDS].sort());
  for (const [kind, questionText] of Object.entries(questions)) {
    const context = { key, value: true };
    const id = (await ask(db, { kind, subject: 'synthetic:' + kind, question: questionText,
      options: FACT_CHECK_OPTIONS, context, now: NOW })).id;
    const text = (await getItem(db, id)).question;
    assert.doesNotMatch(text, /[a-z]+[._:][a-zA-Z]|s_corp|mfj/);
    if (['fact_check', 'resolver_fact'].includes(kind)) assert.ok(text.includes(ANSWER_SHAPES[key].label.replace(/\?$/, '')));
  }
  await recordFact(db, { key: 'household.filingStatus', value: 'mfj', confidence: 0.5, now: NOW });
  const item = (await pendingItems(db)).find(i => i.context.key === 'household.filingStatus');
  assert.match(item.question, /Married filing jointly/);
  assert.doesNotMatch(item.question, /mfj|household[.]filingStatus/);
});

test('AC5: production-shaped planning keeps Confirm and total owner asks within recorded ceilings', async t => {
  const { db } = await store(t);
  await fact(db, 'household.names', names);
  await fact(db, 'business.entities', [{ name: 'Example Studio', type: 's_corp', owner: 'owner' }]);
  await db.prepare('INSERT INTO entity_aliases VALUES (?,?,?)').run('examplealias', 'Example Studio', NOW);
  for (const employer of ['Example Alias', 'Example Outside One', 'Example Outside Two']) {
    const id = await question(db, 'employer_relation', nameKey(employer), EMPLOYER_OPTIONS, { employer });
    if (employer.startsWith('Example Outside')) await answerItem(db, id, 'outside', { now: NOW });
  }
  await account(db, 'cash', 'Everyday Checking');
  await account(db, 'reserve', 'Emergency Savings');
  await account(db, 'ambiguous', 'Flexible Account');
  for (const [employerName, employeeName] of [['Example Outside One', names.me], ['Example Outside Two', names.spouse]]) {
    await db.prepare('INSERT INTO documents (doc_type,tax_year,fields) VALUES (?,?,?)').run('w2', 2026, JSON.stringify({ employerName, employeeName, taxYear: 2026, wages: 60000 }));
    await question(db, 'employer_recipient', nameKey(employerName), EMPLOYER_RECIPIENT_OPTIONS, { employer: employerName });
  }
  for (let i = 0; i < 7; i++) await transaction(db, 'Example Unfamiliar ' + String.fromCharCode(65 + i));
  assert.equal((await pendingItems(db)).length, 13);
  await db.prepare("INSERT INTO sources(id,label,kind,as_of) VALUES ('ing:connected','Bank connection','simplefin','2026-11-04'),('ing:old','Old CSV','bank_csv','2026-01-31'),('ing:stub','Example payroll','paystub','2026-08-01')").run();
  await db.prepare("INSERT INTO simplefin_connection(id,access_blob,connected_at) VALUES (1,'synthetic',?)").run(NOW);
  for (const id of ['cash', 'reserve', 'ambiguous']) {
    await db.prepare("UPDATE accounts SET source_id='ing:connected',mirror='connected' WHERE id=?").run(id);
    await db.prepare("INSERT INTO simplefin_accounts(sf_key,account_id,status,name,created_at) VALUES (?,?,'mapped',?,?)").run(id, id, id, NOW);
    await db.prepare("INSERT INTO balances(account_id,date,amount) VALUES (?,'2026-11-04',1000)").run(id);
  }
  await db.prepare("INSERT INTO files(id,name,status,source_id,uploaded_at) VALUES ('old-csv','History.csv','imported','ing:old',?),('old-stub','Payroll.pdf','imported','ing:stub',?)").run(NOW, NOW);
  await db.prepare("INSERT INTO balances(account_id,date,amount,file_id) VALUES ('cash','2026-01-31',800,'old-csv')").run();
  await db.prepare("INSERT INTO documents(doc_type,tax_year,fields,file_id) VALUES ('paystub',2026,?,'old-stub')").run(JSON.stringify({ employerName: 'Example Outside One', employeeName: names.me, payDate: '2026-08-01', gross: 3000, ytdGross: 24000 }));
  for (const date of ['2026-09-01', '2026-10-01', '2026-11-01']) await db.prepare("INSERT INTO transactions(account_id,date,amount,description,parser) VALUES ('cash',?,2500,'Example Outside One PAYROLL','simplefin')").run(date);
  await planRun(db, { now: NOW.slice(0, 10) });
  const RECORDED_PENDING_CEILING = 8;
  assert.ok((await pendingItems(db)).length <= RECORDED_PENDING_CEILING,
    `Confirm ceiling ${RECORDED_PENDING_CEILING}; actual ${(await pendingItems(db)).length}`);
  assert.equal((await pendingItems(db)).filter(i => i.kind === 'account_kind').length, 1);
  const recs = (await buildScenario(db)).recs.filter(r => ['proposed', 'doing', 'waiting', 'snoozed'].includes(r.status));
  const missingSteps = recs.filter(r => r.id === 'missing-data').flatMap(r => r.tasks).filter(t => !t.done && t.kind !== 'upload');
  const uploadSteps = recs.flatMap(r => r.tasks).filter(t => !t.done && t.kind === 'upload');
  const ownerAsks = (await pendingItems(db)).length + missingSteps.length + uploadSteps.length;
  const RECORDED_OWNER_ASK_CEILING = 11;
  assert.ok(ownerAsks <= RECORDED_OWNER_ASK_CEILING,
    `Owner ask ceiling ${RECORDED_OWNER_ASK_CEILING}; actual ${ownerAsks}; Confirm ${(await pendingItems(db)).length}, missing ${missingSteps.length}, uploads ${uploadSteps.length}`);

});

test('AC1: per-document W-2 and paystub recipients resolve after a shared employer is labeled both', async t => {
  const s = await store(t), db = s.db;
  await fact(db, 'household.names', names);
  for (const [docType, employeeName, fields] of [['w2', names.me, { taxYear: 2026, wages: 60000, federalWithheld: 3000 }],
    ['paystub', names.spouse, { payDate: '2026-10-20', gross: 2500, federalWithholding: 200 }]]) {
    await importProposedRows(s, [{ target: 'document', docType, fields: { employerName: 'Example Shared Employer', employeeName, confidence: 1, ...fields } }],
      { name: `synthetic-shared-${docType}.xlsx`, now: NOW });
  }
  const employer = await db.prepare("SELECT id FROM confirm_items WHERE kind='employer_recipient'").get();
  await autoResolve(db, { now: NOW });
  assert.equal((await getItem(db, employer.id)).status, 'pending');
  await answerItem(db, employer.id, 'both', { now: NOW });
  await autoResolve(db, { now: NOW });
  const documents = await db.prepare("SELECT id,subject FROM confirm_items WHERE kind='document_recipient' ORDER BY id").all();
  assert.equal(documents.length, 2);
  for (const item of documents) await assertAuto(db, item.id, item.subject.startsWith('w2:') ? 'owner' : 'spouse');
  await reopenItem(db, documents[0].id, { now: NOW });
  await autoResolve(db, { now: NOW });
  assert.equal((await getItem(db, documents[0].id)).status, 'pending');
  await assertAuto(db, documents[1].id, 'spouse');
});

test('AC1: employer aliases reuse an owner relation, and Undo of that basis reopens the inferred answer', async t => {
  const { db } = await store(t);
  await db.prepare('INSERT INTO entity_aliases VALUES (?,?,?)').run('examplepayroll', 'Example Employer', NOW);
  const basis = await question(db, 'employer_relation', nameKey('Example Employer'), EMPLOYER_OPTIONS, { employer: 'Example Employer' });
  await answerItem(db, basis, 'outside', { now: NOW });
  const alias = await question(db, 'employer_relation', nameKey('Example Payroll'), EMPLOYER_OPTIONS, { employer: 'Example Payroll' });
  await autoResolve(db, { now: NOW });
  await assertAuto(db, alias, 'outside');
  assert.deepEqual((await autoInfo(db, alias)).evidence.basis, [basis]);
  await reopenItem(db, basis, { now: NOW });
  assert.equal((await getItem(db, alias)).status, 'pending');
});

test('AC1: recipient matching retains source names locally while the model envelope masks them', async () => {
  const source = await indexSource({ fileId: 'synthetic-payroll', name: 'synthetic-payroll.txt', format: 'text',
    bytes: Buffer.from('Employee: ' + names.me + '\nEmployer: Example Employer') }, { householdNames: names });
  assert.ok(Object.values(source.values).some(v => String(v).includes(names.me)));
  assert.ok(!JSON.stringify(source.envelope).includes(names.me));
  assert.ok(!JSON.stringify(source.envelope).includes('Avery'));
});
