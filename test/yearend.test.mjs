// Year end: expected documents per fact combination, matching received documents, not-needed
// marks, the packet zip (index plus documents only, temp directory removed) and provenance in its
// index, and the HTTP routes behind the session gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { serveAppFixture, tempInstance } from './helpers/server.mjs';
import { randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { openDb, migrate, setSetting } from '../src/store/db.mjs';
import { upsertFact } from '../src/store/facts.mjs';
import { storeFile } from '../src/ingest/vault.mjs';
import { expectedItems, matchDocuments, yearendChecklist, setMark, taxYearFor, buildYearend } from '../src/yearend/expected.mjs';
import { buildPacket, streamPacket, TEMP_PREFIX } from '../src/yearend/packet.mjs';
import { readZip, writeZip } from '../src/yearend/zip.mjs';
import { seedDemo } from '../demo/seed.mjs';

const keys = (items) => items.map((i) => i.key);
const none = () => false;
const base = { accounts: [], year: 2026, active: none, deposits: none };

test('taxYearFor: the prior year through April 15, else the clock year', () => {
  assert.equal(taxYearFor('2027-01-05'), 2026);
  assert.equal(taxYearFor('2027-04-15'), 2026);
  assert.equal(taxYearFor('2027-04-16'), 2027);
  assert.equal(taxYearFor('2026-11-05'), 2026);
});

test('expectedItems: no facts and no accounts expect nothing', () => {
  assert.deepEqual(expectedItems({ ...base, facts: {} }), []);
});

test('expectedItems: a W-2 per employer, or one generic W-2 without employer names', () => {
  const employerNames = new Map([['acme', 'Acme'], ['northwind', 'Northwind']]);
  assert.deepEqual(keys(expectedItems({ ...base, facts: { 'income.w2': true }, employerNames })), ['w2:acme', 'w2:northwind']);
  assert.deepEqual(keys(expectedItems({ ...base, facts: { 'income.w2': true } })), ['w2:any']);
  assert.deepEqual(keys(expectedItems({ ...base, facts: { 'income.w2': false }, employerNames })), []);
});

test('expectedItems: accounts with activity expect their forms; inactive accounts expect none', () => {
  const accounts = [
    { id: 'b1', inst: 'Keel', name: 'Individual', kind: 'taxable' },
    { id: 'c1', inst: 'Harbor', name: 'Checking', kind: 'checking' },
    { id: 'l1', inst: 'Harbor', name: 'Mortgage', kind: 'loan' },
    { id: 'i1', inst: 'Keel', name: 'Roth IRA', kind: 'roth' },
    { id: 'p1', inst: 'PayCo', name: 'Payroll', kind: 'business' },
    { id: 'x1', inst: 'Idle', name: 'Old brokerage', kind: 'taxable' },
  ];
  const active = (id) => id !== 'x1';
  const items = expectedItems({ ...base, facts: {}, accounts, active, deposits: (id) => id === 'i1' });
  assert.deepEqual(keys(items), ['1099-composite:b1', '1099-int:c1', '1098:l1', '5498:i1']);
  assert.deepEqual(items[0].forms, ['1099-b', '1099-div', '1099-int']);
  // An IRA with no contributions this year expects no 5498.
  assert.ok(!keys(expectedItems({ ...base, facts: {}, accounts, active })).includes('5498:i1'));
});

test('expectedItems: mortgage payments, IRAs, partnerships, self-employment, HSA and S corp facts', () => {
  assert.deepEqual(keys(expectedItems({ ...base, facts: {}, mortgagePaid: true })), ['1098:mortgage']);
  assert.deepEqual(keys(expectedItems({ ...base, facts: { 'retirement.ira': true } })), ['5498:ira']);
  assert.deepEqual(keys(expectedItems({ ...base, facts: { 'income.partnership': true } })), ['k1:partnership']);
  assert.deepEqual(keys(expectedItems({ ...base, facts: { 'income.selfEmployed': true } })), ['1099-nec', '1099-k']);
  assert.deepEqual(keys(expectedItems({ ...base, facts: { 'benefits.hsa': true } })), ['hsa:1099-sa', 'hsa:5498-sa']);
  assert.deepEqual(keys(expectedItems({ ...base, facts: { 'income.sCorp': true } })), ['scorp:payroll', 'scorp:1120s', 'pnl:business']);
  assert.deepEqual(keys(expectedItems({ ...base, facts: { 'income.sCorp': true }, pnlEntities: ['Acme LLC'] })), ['scorp:payroll', 'scorp:1120s', 'pnl:acmellc']);
});

test('matchDocuments: by issuer name, else the only item of that form; ambiguous or unknown stay unmatched', () => {
  const items = expectedItems({ ...base, facts: { 'income.w2': true, 'income.partnership': true }, employerNames: new Map([['acme', 'Acme'], ['northwind', 'Northwind']]) });
  const doc = (id, doc_type, fields) => ({ id, doc_type, fields });
  const { matched, unmatched } = matchDocuments(items, [
    doc(1, 'w2', { employerName: 'Northwind Inc' }),
    doc(2, 'w2', { employerName: 'Someone else' }),
    doc(3, 'k1', {}),
    doc(4, 'other', { issuer: 'County' }),
  ]);
  assert.deepEqual(matched.get('w2:northwind').map((d) => d.id), [1]);
  assert.deepEqual(matched.get('w2:acme'), []);
  assert.deepEqual(matched.get('k1:partnership').map((d) => d.id), [3]);
  assert.deepEqual(unmatched.map((d) => d.id), [2, 4]);
});

function realStore() {
  const db = openDb(':memory:');
  migrate(db);
  setSetting(db, 'mode', 'real');
  return db;
}

function addDoc(db, { id, name, type, year = 2026, fields = {}, storedPath = null, at = '2027-01-20T10:00:00.000Z' }) {
  db.prepare("INSERT INTO files (id, name, mime, size, uploaded_at, stored_path, status) VALUES (?, ?, 'application/pdf', 1, ?, ?, 'parsed')").run(id, name, at, storedPath);
  db.prepare("INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator) VALUES (?, ?, ?, ?, 'pdf-extract', '{\"document\":\"w2\"}')").run(type, year, JSON.stringify(fields), id);
}

test('yearendChecklist: received links the stored file; missing after the usual date, expected before', () => {
  const db = realStore();
  upsertFact(db, { key: 'income.w2', value: true, confirmed: true });
  upsertFact(db, { key: 'income.partnership', value: true, confirmed: true });
  addDoc(db, { id: 'f1', name: 'acme-w2.pdf', type: 'w2', fields: { employerName: 'Acme' } });
  const jan = yearendChecklist(db, { year: 2026, clock: '2027-02-01' });
  const w2 = jan.items.find((i) => i.key === 'w2:acme');
  assert.equal(w2.status, 'have');
  assert.deepEqual(w2.files.map((f) => [f.id, f.name, f.date]), [['f1', 'acme-w2.pdf', '2027-01-20']]);
  assert.equal(jan.items.find((i) => i.key === 'k1:partnership').status, 'expected');
  const apr = yearendChecklist(db, { year: 2026, clock: '2027-04-01' });
  const k1 = apr.items.find((i) => i.key === 'k1:partnership');
  assert.equal(k1.status, 'missing');
  assert.match(k1.src, /partnership/);
  assert.match(k1.note, /March/);
});

test('marks: not needed persists with its reason, clears again, and a received document still wins', () => {
  const db = realStore();
  upsertFact(db, { key: 'income.selfEmployed', value: true, confirmed: true });
  setMark(db, { year: 2026, key: '1099-k', reason: 'No card processor this year', now: '2026-12-01T00:00:00.000Z' });
  let item = yearendChecklist(db, { year: 2026, clock: '2027-03-01' }).items.find((i) => i.key === '1099-k');
  assert.equal(item.status, 'skipped');
  assert.deepEqual(item.skip, { reason: 'No card processor this year', at: '2026-12-01T00:00:00.000Z' });
  // Another year is unaffected.
  assert.equal(yearendChecklist(db, { year: 2027, clock: '2028-03-01' }).items.find((i) => i.key === '1099-k').status, 'missing');
  setMark(db, { year: 2026, key: '1099-k', reason: null });
  item = yearendChecklist(db, { year: 2026, clock: '2027-03-01' }).items.find((i) => i.key === '1099-k');
  assert.equal(item.status, 'missing');
  setMark(db, { year: 2026, key: '1099-nec', reason: 'none' });
  addDoc(db, { id: 'n1', name: 'nec.pdf', type: '1099-nec', fields: { payerName: 'Client' } });
  assert.equal(yearendChecklist(db, { year: 2026, clock: '2027-03-01' }).items.find((i) => i.key === '1099-nec').status, 'have');
});

test('unmatched: received tax documents that fit no expected item are listed; paystubs are not', () => {
  const db = realStore();
  addDoc(db, { id: 'o1', name: 'receipt.pdf', type: 'other', fields: { issuer: 'County' } });
  addDoc(db, { id: 'p1', name: 'stub.pdf', type: 'paystub', fields: { employerName: 'Acme' } });
  addDoc(db, { id: 'o2', name: 'old.pdf', type: 'other', year: 2025 });
  const c = yearendChecklist(db, { year: 2026, clock: '2027-03-01' });
  assert.deepEqual(c.unmatched.map((u) => u.id), ['o1']);
  assert.equal(c.unmatched[0].t, 'Document from County');
});

test('zip: write then read round-trips names and bytes', async () => {
  const chunks = [];
  await writeZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/b.bin', data: randomBytes(5000) }], async (b) => { chunks.push(b); });
  const out = readZip(Buffer.concat(chunks));
  assert.deepEqual(out.map((e) => e.name), ['a.txt', 'dir/b.bin']);
  assert.equal(out[0].data.toString(), 'hello');
});

// A real instance (createInstance layout) whose household vault holds two stored uploads. The packet
// builds its intermediates under the household's work directory (tmpRoot, <root>/work).
async function packetStore() {
  const inst = await tempInstance({ mode: 'real' });
  const household = await inst.household();
  const vault = await household.vault();
  const db = inst.db;
  const dataDir = inst.dataDir;
  const tmpRoot = join(inst.root, 'work');
  upsertFact(db, { key: 'income.w2', value: true, confirmed: true });
  upsertFact(db, { key: 'income.partnership', value: true, confirmed: true });
  upsertFact(db, { key: 'household.filingStatus', value: 'mfj', confirmed: true });
  const w2 = Buffer.from('%PDF-1.4 synthetic w2');
  const other = Buffer.from('synthetic receipt');
  assert.equal(await storeFile({ vault, id: 'fw2', bytes: w2, purpose: 'upload' }), 'files/fw2.bin');
  assert.equal(await storeFile({ vault, id: 'fot', bytes: other, purpose: 'upload' }), 'files/fot.bin');
  addDoc(db, { id: 'fw2', name: 'scan 0001.pdf', type: 'w2', fields: { employerName: 'Acme Corp' }, storedPath: 'files/fw2.bin' });
  addDoc(db, { id: 'fot', name: 'receipt.txt', type: 'other', fields: { issuer: 'County' }, storedPath: 'files/fot.bin' });
  addDoc(db, { id: 'gone', name: 'lost.pdf', type: '1099-int', fields: { payerName: 'Bank' }, storedPath: 'files/gone.bin' });
  db.prepare("INSERT INTO files (id, name, uploaded_at, status) VALUES ('wb', 'taxes-2026.xlsx', '2026-10-01T00:00:00Z', 'parsed')").run();
  db.prepare("INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind, file_id, parser, locator) VALUES ('federal', 2026, '2026-04-15', 1234.5, 'estimate', 'wb', 'tax-workbook', 'Sheet 2026!C4')").run();
  db.prepare("INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind, file_id, parser, locator) VALUES ('federal', 2025, '2026-01-15', 999, 'estimate', 'wb', 'tax-workbook', 'Sheet 2025!C9')").run();
  db.prepare("INSERT INTO sources (id, label, as_of) VALUES ('bank', 'Bank export', 'Oct 31')").run();
  db.prepare("INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at) VALUES ('cash_now', 4321, 'bank', 'a', 'Cash on hand', 'wb', 'tax-workbook', 'Sheet 2026!B2', '2026-10-01')").run();
  return {
    db, dataDir, tmpRoot, vault, w2, other,
    async cleanup() { await household.close(); inst.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

function fakeRes() {
  const res = new PassThrough();
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.body = () => Buffer.concat(chunks);
  return res;
}

test('packet: index plus every received document and nothing else, temp directory removed, generation recorded', async () => {
  const s = await packetStore();
  try {
    const packet = await buildPacket(s.db, { year: 2026, clock: '2027-02-20', vault: s.vault, now: '2027-02-20T09:30:00.000Z' });
    assert.ok((await readdir(s.tmpRoot)).every((n) => n.startsWith(TEMP_PREFIX)));
    const res = fakeRes();
    await streamPacket(res, packet);
    assert.deepEqual(await readdir(s.tmpRoot), [], 'temp directory removed');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'application/zip');
    const entries = readZip(res.body());
    assert.deepEqual(entries.map((e) => e.name), ['index.html', 'documents/01-W-2-Acme-Corp-2026.pdf', 'documents/02-Document-County-2026.txt']);
    assert.deepEqual(entries[1].data, s.w2);
    assert.deepEqual(entries[2].data, s.other);
    const html = entries[0].data.toString('utf8');
    assert.match(html, /lost\.pdf: the stored copy could not be read/);
    const row = s.db.prepare('SELECT * FROM yearend_packets').get();
    assert.equal(row.tax_year, 2026);
    assert.equal(row.generated_at, '2027-02-20T09:30:00.000Z');
    const counts = JSON.parse(row.counts);
    assert.equal(counts.files, 2);
    assert.equal(counts.unreadable, 1);
    assert.equal(counts.payments, 1);
    assert.equal(buildYearend(s.db, { clock: '2027-02-20', recs: [], decisions: [] }).packets[0].counts.files, 2);
  } finally { await s.cleanup(); }
});

test('packet index: tax payments, totals and figures carry their provenance; other years are left out', async () => {
  const s = await packetStore();
  try {
    const packet = await buildPacket(s.db, { year: 2026, clock: '2027-02-20', vault: s.vault });
    const res = fakeRes();
    await streamPacket(res, packet);
    const html = readZip(res.body())[0].data.toString('utf8');
    assert.match(html, /<td>2026-04-15<\/td><td>federal<\/td><td>estimate<\/td><td class="r">\$1,234\.50<\/td><td><small>taxes-2026\.xlsx, tax-workbook, Sheet 2026!C4<\/small>/);
    assert.ok(!html.includes('Sheet 2025!C9'), 'a payment for another tax year is not listed');
    assert.match(html, /Total federal<\/td><td class="r">\$1,234\.50<\/td><td><small>Sum of 1 payments listed above/);
    assert.match(html, /Cash on hand<\/td><td class="r">\$4,321\.00<\/td><td><small>Bank export, Oct 31; taxes-2026\.xlsx, tax-workbook, Sheet 2026!B2/);
    assert.match(html, /household\.filingStatus<\/td><td>mfj<\/td><td><small>Confirmed by the owner/);
    assert.match(html, /K-1 from each partnership: not yet due/);
    assert.match(html, /<a href="documents\/01-W-2-Acme-Corp-2026\.pdf">/);
    assert.ok(!/<script/i.test(html), 'the index is static');
  } finally { await s.cleanup(); }
});

test('packet: a failure while building removes the temp directory', async () => {
  const s = await packetStore();
  try {
    s.db.exec('DROP TABLE yearend_packets');
    await assert.rejects(buildPacket(s.db, { year: 2026, clock: '2027-02-20', vault: s.vault }));
    assert.deepEqual(await readdir(s.tmpRoot), []);
  } finally { await s.cleanup(); }
});

test('packet: imported text is escaped in the index', async () => {
  const s = await packetStore();
  try {
    s.db.prepare("UPDATE files SET name = '<img src=x onerror=alert(1)>.pdf' WHERE id = 'fot'").run();
    const res = fakeRes();
    await streamPacket(res, await buildPacket(s.db, { year: 2026, clock: '2027-02-20', vault: s.vault }));
    const html = readZip(res.body())[0].data.toString('utf8');
    assert.ok(!html.includes('<img'), html);
  } finally { await s.cleanup(); }
});

async function serve(db, config) {
  return serveAppFixture({ authenticated: true, db, config, answerer: null });
}

test('API: marks validate input; the packet streams behind the session gate in a real store', async () => {
  const s = await packetStore();
  setSetting(s.db, 'clock', '2027-02-20');
  const srv = await serve(s.db, { dataDir: s.dataDir });
  const sessionHeaders = srv.headers;
  const post = (body, headers = sessionHeaders) => fetch(`${srv.baseUrl}/api/yearend/marks`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${srv.baseUrl}/api/yearend/packet`)).status, 401, 'no identity, no packet');
    assert.equal((await post({ key: 'k1:partnership', reason: 'x' }, {})).status, 401);
    assert.equal((await post({ key: 'k1:partnership', reason: '' })).status, 400);
    assert.equal((await post({ key: 'k1:partnership', reason: 'x'.repeat(301) })).status, 400);
    assert.equal((await post({ key: 'nope', reason: 'x' })).status, 404);
    assert.equal((await post({ key: 'k1:partnership', reason: 'x', year: 'soon' })).status, 400);
    const ok = await post({ key: 'k1:partnership', reason: 'Partnership closed last year' });
    assert.equal(ok.status, 200);
    const sc = (await ok.json()).scenario;
    assert.equal(sc.yearend.year, 2026);
    assert.deepEqual(sc.yearend.docs.find((d) => d.key === 'k1:partnership').skip.reason, 'Partnership closed last year');
    const res = await fetch(`${srv.baseUrl}/api/yearend/packet?year=2026`, { headers: sessionHeaders });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="tax-packet-2026\.zip"/);
    const entries = readZip(Buffer.from(await res.arrayBuffer()));
    assert.equal(entries[0].name, 'index.html');
    assert.match(entries[0].data.toString(), /K-1 from each partnership<\/td><td>Not needed<\/td><td>Not needed: Partnership closed last year/);
    assert.equal((await fetch(`${srv.baseUrl}/api/yearend/packet?year=19`, { headers: sessionHeaders })).status, 400);
  } finally { await srv.close(); await s.cleanup(); }
});

test('demo: the seeded store builds the year-end section through the same tables and downloads a packet', async () => {
  // A demo instance seeded as the server seeds one; the packet route uses its household vault.
  const inst = await tempInstance({ mode: 'demo', init: seedDemo });
  const { db, dataDir } = inst;
  const srv = await serve(db, { dataDir });
  try {
    const sc = await (await fetch(`${srv.baseUrl}/api/scenario`)).json();
    const ye = sc.yearend;
    assert.equal(ye.year, 2026);
    assert.ok(ye.docs.find((d) => d.key === 'w2:brightline'));
    assert.equal(ye.docs.find((d) => d.key === '1098:mortgage').status, 'have');
    assert.deepEqual(ye.unmatched.map((u) => u.name), ['property-tax-receipt-2026.pdf']);
    assert.ok(ye.docs.every((d) => !/\{[a-z]+:/.test(d.t)), 'demo tokens are resolved to plain text');
    assert.ok(ye.decisions.some((d) => d.kind === 'decision') && ye.decisions.some((d) => d.kind === 'rec'));
    const res = await fetch(`${srv.baseUrl}/api/yearend/packet`);
    assert.equal(res.status, 200);
    const names = readZip(Buffer.from(await res.arrayBuffer())).map((e) => e.name);
    assert.deepEqual(names, ['index.html', 'documents/01-1098-Harbor-Bank-2026.txt', 'documents/02-Document-County-treasurer-2026.txt']);
  } finally { await srv.close(); inst.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('review fix: a client gone before streaming starts still removes the temp directory', async () => {
  const s = await packetStore();
  try {
    const packet = await buildPacket(s.db, { year: 2026, clock: '2027-02-20', vault: s.vault });
    assert.equal((await readdir(s.tmpRoot)).length, 1);
    const res = fakeRes();
    res.destroy();
    await streamPacket(res, packet);
    assert.deepEqual(await readdir(s.tmpRoot), []);
    assert.equal(res.status, undefined, 'nothing was sent');
  } finally { await s.cleanup(); }
});

test('review fix: payments a pending withholding conflict names, or an unreconciled W-2 and paystub slot, are not totaled', async () => {
  const s = await packetStore();
  try {
    const ins = s.db.prepare("INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind, file_id, parser, locator, source_slot, payer) VALUES (?, 2026, '2026-12-31', ?, 'withholding', 'wb', 'w2', 'box2', ?, ?)");
    const a = Number(ins.run('federal', 12000, 'wh:acme:2026:federal:owner', 'w2:acme:2026:1').lastInsertRowid);
    const b = Number(ins.run('federal', 13000, 'wh:acme:2026:federal:owner', 'w2:acme:2026:2').lastInsertRowid);
    s.db.prepare("INSERT INTO confirm_items (kind, subject, question, options, context, status, created_at) VALUES ('withholding_conflict', 'x', 'Which?', '[]', ?, 'pending', '2027-02-01')")
      .run(JSON.stringify({ first: { id: a }, second: { id: b } }));
    ins.run('ny', 500, 'wh:north:2026:ny:owner', 'w2:north:2026:1');
    ins.run('ny', 40, 'wh:north:2026:ny:owner', 'paystub:north:2026-06-30:1');
    const res = fakeRes();
    await streamPacket(res, await buildPacket(s.db, { year: 2026, clock: '2027-02-20', vault: s.vault }));
    const html = readZip(res.body())[0].data.toString('utf8');
    assert.ok(!html.includes('$26,234.50') && !html.includes('$25,000.00'), 'no total includes the disputed rows');
    assert.match(html, /Total federal<\/td><td class="r">Not totaled<\/td><td><small>2 of 3 payments wait on a question/);
    assert.match(html, /Total ny<\/td><td class="r">Not totaled/);
    assert.ok(!html.includes('$540.00'));
    assert.match(html, /federal payment of 2026-12-31 is not counted yet: two documents disagree/);
    assert.match(html, /ny payment of 2026-12-31 is not counted yet: W-2 and paystubs from one employer not yet reconciled/);
    // Once answered, the conflict no longer holds the federal total back.
    s.db.prepare("UPDATE confirm_items SET status = 'answered'").run();
    s.db.prepare('DELETE FROM tax_payments WHERE id = ?').run(a);
    const res2 = fakeRes();
    await streamPacket(res2, await buildPacket(s.db, { year: 2026, clock: '2027-02-20', vault: s.vault }));
    assert.match(readZip(res2.body())[0].data.toString('utf8'), /Total federal<\/td><td class="r">\$14,234\.50<\/td><td><small>Sum of 2 payments/);
  } finally { await s.cleanup(); }
});
