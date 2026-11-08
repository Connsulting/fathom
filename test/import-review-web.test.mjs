// Conversational import review in Horizon: every waiting status renders its label, plain cause and
// one live control; deltas and summaries read in plain words from server values; and the server's
// waiting rows carry what the review needs. The screen module is plain ESM, so node renders it
// with the same helper shapes design.js passes in. Every value is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WAITING } from '../src/ingest/pipeline.mjs';
import { ingestScreens, PROPOSAL_STATES, proposalControl, proposalCause, proposalStatus, deltaText, proposalSummary } from '../web/horizon/screens/ingest.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const settle = () => new Promise((resolve) => setImmediate(resolve));
const STATUSES = [...WAITING, 'needs_mapping', 'needs_extraction'];

const importProposal = (status, patch = {}) => ({
  id: 'p-synthetic', version: 2, status, reasonCode: null, kind: 'import', receiptId: null,
  summary: { rows: 2, amount: -10, totalStatus: 'totals_match', totalMessage: 'Totals match the sheet' },
  counts: { rows: { transaction: 2 }, duplicates: 0 }, delta: [], errors: [], question: null, actions: [], notes: 0, permission: null,
  columns: [{ ordinal: 1, label: 'account', field: 'accountId' }, { ordinal: 2, label: 'memo', field: null }], ...patch,
});
const waitingFile = (status, proposal) => ({ id: 'f-synthetic', name: 'synthetic.csv', status, ...(proposal ? { proposal } : {}) });

function harness(waiting, { engineOn = false, uploadResult = null } = {}) {
  const calls = [];
  const api = {
    s: {}, route: { name: 'add' }, go() {}, engineOn: () => engineOn,
    ingest: () => ({ pending: 0, items: [], decided: [], files: [], waiting, sources: [], accounts: {}, staleNotes: [], formats: [] }),
    reviewImport: (...args) => { calls.push(['reviewImport', ...args]); return Promise.resolve(args[2] === 'approve' ? { status: 'imported', counts: { rows: { transaction: 2 } }, receipt: { id: 'r-approve' } } : { status: 'queued' }); },
    retryFile: (id) => { calls.push(['retryFile', id]); return Promise.resolve({}); },
    actionUndo: (id) => { calls.push(['actionUndo', id]); return Promise.resolve({ ok: true }); },
    upload: (files) => { calls.push(['upload', files.length]); return Promise.resolve(uploadResult); },
  };
  const h = {
    api, esc, draw() {}, getUi: () => ({}), addBtn: () => '', icon: () => '',
    shell: (inner) => inner,
    section: (title, body) => `<section><h2>${title}</h2>${body}</section>`,
    pageHead: (k, t) => `<h1>${t}</h1>`,
    btn: (label, attrs, cls = '') => `<button type="button" class="h-btn ${cls}" ${attrs}>${label}</button>`,
  };
  return { screens: ingestScreens(h), calls };
}
const click = (screens, dataset, extra = {}) => screens.handleClick({ target: { closest: () => ({ tagName: 'BUTTON', dataset, ...extra }) }, preventDefault() {} });
const typeDraft = (screens, id, value) => screens.handleChange({ type: 'input', target: { matches: (sel) => sel === 'textarea[data-proposal-text]', dataset: { proposalText: id }, value } });

test('every waiting status has a label, a plain cause and one live control', async () => {
  for (const status of STATUSES) {
    const row = PROPOSAL_STATES[status];
    assert.ok(row && row.label && row.cause && row.control, status);
    assert.doesNotMatch(row.cause, new RegExp('\\u2014'), 'no em dash');
    for (const engineOn of [false, true]) {
      const proposal = ['needs_confirmation', 'needs_clarification'].includes(status) ? importProposal(status) : null;
      const { screens, calls } = harness([waitingFile(status, proposal)], { engineOn });
      const html = screens.addFiles('add');
      const plain = text(html);
      const control = proposalControl(status, { engineOn });
      const where = `${status} engineOn=${engineOn}`;
      assert.ok(plain.includes(row.label), where);
      assert.ok(plain.includes(row.cause), where);
      assert.match(html, /data-proposal-file="f-synthetic"/, where);
      if (control === 'approve') {
        assert.match(html, /data-proposal-approve="p-synthetic" data-version="2"/, where);
        assert.match(html, /<textarea data-proposal-text="p-synthetic"/, where);
        assert.ok(plain.includes('2 transactions, -$10 in total. Totals match the sheet.'), where);
        click(screens, { proposalApprove: 'p-synthetic', version: '2' });
        assert.deepEqual(calls.at(-1), ['reviewImport', 'p-synthetic', 2, 'approve', 'Looks right'], where);
        await settle();
        const after = screens.addFiles('add');
        assert.match(after, /data-review-note/, where);
        assert.ok(text(after).includes('Imported 2 transactions.'), where);
        assert.match(after, /data-review-undo="r-approve"/, where);
        click(screens, { reviewUndo: 'r-approve' });
        assert.deepEqual(calls.at(-1), ['actionUndo', 'r-approve'], where);
        await settle();
        assert.ok(text(screens.addFiles('add')).includes('Undone.'), where);
      } else if (control === 'answer') {
        assert.match(html, /data-proposal-text="p-synthetic"/, where);
        assert.match(html, /data-proposal-correct="p-synthetic"/, where);
        assert.doesNotMatch(html, /data-proposal-approve/, where);
        assert.ok(plain.includes('The file did not check out against its interpretation. Say what the columns mean.'), where);
        click(screens, { proposalCorrect: 'p-synthetic', version: '2' });
        assert.equal(calls.length, 0, 'an empty correction is not sent');
        assert.equal(typeDraft(screens, 'p-synthetic', '  Column B is the spouse income  '), true);
        click(screens, { proposalCorrect: 'p-synthetic', version: '2' });
        assert.deepEqual(calls.at(-1), ['reviewImport', 'p-synthetic', 2, 'correct', 'Column B is the spouse income'], where);
        await settle();
        const after = screens.addFiles('add');
        assert.ok(text(after).includes('Correction saved. Fathom reads the file again with it when the engine runs.'), where);
        assert.doesNotMatch(after, /spouse income/, 'the draft clears after a saved correction');
      } else if (control === 'engine') {
        assert.match(html, /href="#\/engine" data-go="engine" data-proposal-engine/, where);
        assert.ok(plain.includes(status === 'budget_exhausted' ? 'Check the engine budget' : 'Turn on the engine'), where);
      } else if (control === 'retry') {
        assert.match(html, /data-retry="f-synthetic"/, where);
        click(screens, { retry: 'f-synthetic' });
        assert.deepEqual(calls.at(-1), ['retryFile', 'f-synthetic'], where);
      } else if (control === 'upload') {
        const row = /<li class="needs_source_text"[\s\S]*?<\/li>/.exec(html)[0];
        assert.match(row, /data-upload-open="1"/, where);
        assert.match(row, /<input type="file" multiple data-upload="1" hidden/, where);
        let opened = 0;
        click(screens, { uploadOpen: '1' }, { parentElement: { querySelector: (sel) => (sel === 'input[type=file][data-upload]' ? { click: () => { opened += 1; } } : null) } });
        assert.equal(opened, 1, where);
      } else assert.fail(`unexpected control ${control}`);
      assert.doesNotMatch(html, /<select|<input(?![^>]*type="file")/, 'no per-column inputs');
    }
  }
});

test('controls and causes follow the proposal over the file', () => {
  assert.equal(proposalControl('waiting_for_engine', { engineOn: false }), 'engine');
  assert.equal(proposalControl('waiting_for_engine', { engineOn: true }), 'retry');
  assert.equal(proposalControl('budget_exhausted', { engineOn: true }), 'engine');
  assert.equal(proposalControl('something_else'), 'retry');
  const corrected = waitingFile('needs_confirmation', importProposal('waiting_for_engine', { reasonCode: 'owner_correction' }));
  assert.equal(proposalStatus(corrected), 'waiting_for_engine');
  assert.equal(proposalCause(corrected), 'Your correction is saved. Waiting for the engine to read the file again.');
  const note = waitingFile('waiting_for_engine', importProposal('needs_confirmation'));
  assert.equal(proposalStatus(note), 'needs_confirmation');
  assert.equal(proposalStatus(waitingFile('needs_source_text')), 'needs_source_text');
  assert.equal(proposalCause(waitingFile('budget_exhausted')), 'File saved. Interpretation stopped at the budget limit.');
});

test('deltaText names each change once in plain words', () => {
  assert.equal(deltaText([]), '');
  assert.equal(deltaText(undefined), '');
  assert.equal(deltaText([{ field: 'headers.0.columns.4', after: { ordinal: 5, label: 'reference' } }, { field: 'structure.0.columns.4', after: 5 }]),
    'a new column appeared: reference');
  assert.equal(deltaText([{ field: 'headers.0.columns.3', before: { ordinal: 4, label: 'description' } }]), 'the description column is gone');
  assert.equal(deltaText([{ field: 'headers.0.columns.2.label', before: 'amount', after: 'amount usd' }]), 'the amount column is now amount usd');
  assert.equal(deltaText([{ field: 'layout', reason: 'no_unique_approved_layout' }]), 'more than one saved layout fits this file');
  assert.equal(deltaText([{ field: 'bindings.0', before: 'a', after: 'b' }, { field: 'bindings.1', before: 'c', after: null }]), 'an account in the file changed');
  assert.equal(deltaText([{ field: 'structure.0.columns.5', after: 6 }]), 'the file has a new filled area');
  assert.equal(deltaText([{ field: 'headers.0.columns.4', after: { ordinal: 5, label: 'credit' } }, { field: 'bindings.0', before: 'a', after: 'b' }]),
    'a new column appeared: credit; an account in the file changed');
});

test('proposalSummary reads only server values', () => {
  assert.equal(proposalSummary(waitingFile('needs_confirmation', importProposal('needs_confirmation'))), '2 transactions, -$10 in total. Totals match the sheet.');
  assert.equal(proposalSummary(waitingFile('needs_confirmation', importProposal('needs_confirmation', {
    summary: { rows: 3, amount: null, totalStatus: 'no_sheet_total', totalMessage: 'No sheet total to check' }, counts: { rows: { transaction: 3 }, duplicates: 1 },
  }))), '3 transactions, 1 duplicate skipped. No sheet total to check.');
  const note = (actions, notes = 0) => waitingFile('waiting_for_engine', { id: 'p-note', version: 1, status: 'needs_confirmation', kind: 'actions', actions, notes, summary: null, counts: null });
  assert.equal(proposalSummary(note([{ label: 'Recommendation step 1', subject: null, dueDate: null, amount: null },
    { label: 'Expected payment', subject: 'payroll provider', dueDate: '2032-03-09', amount: null }], 1)),
  'From your note: Recommendation step 1; expected payment from payroll provider on Mar 9, 2032, amount unknown. 1 line kept as a note.');
  assert.equal(proposalSummary(note([{ label: 'Expected payment', subject: 'synthetic client', dueDate: '2032-04-01', amount: 1250.5 }])),
    'From your note: expected payment from synthetic client on Apr 1, 2032, $1,250.50.');
  assert.equal(proposalSummary(note([])), '');
  assert.equal(proposalSummary(waitingFile('needs_mapping')), '');
  assert.equal(proposalSummary(waitingFile('needs_confirmation', importProposal('needs_confirmation', { summary: null }))), '');
});

test('a changed layout shows only its delta before the summary, and Source lists every column', () => {
  const proposal = importProposal('needs_confirmation', { delta: [{ field: 'headers.0.columns.4', after: { ordinal: 5, label: 'reference' } }] });
  const { screens } = harness([waitingFile('needs_confirmation', proposal)]);
  const html = screens.addFiles('add');
  const delta = html.indexOf('data-proposal-delta'), summary = html.indexOf('data-proposal-summary');
  assert.ok(delta > 0 && delta < summary);
  assert.ok(text(html).includes('Only this changed since you approved this layout: a new column appeared: reference.'));
  assert.ok(text(html).includes('Column 1, account: account id'));
  assert.ok(text(html).includes('Column 2, memo: not used'));
  assert.ok(text(html).includes('From synthetic.csv. Every count and amount above comes from cells in this file.'));
  assert.doesNotMatch(html, /data-proposal-source="f-synthetic" open/);
  const summaryEl = { tagName: 'SUMMARY', parentElement: { open: false, dataset: { proposalSource: 'f-synthetic' } } };
  assert.equal(screens.handleClick({ target: { closest: () => summaryEl } }), true);
  assert.match(screens.addFiles('add'), /data-proposal-source="f-synthetic" open/);
});

test('upload results offer Undo for an imported file and point a review to Waiting files', async () => {
  const uploadResult = { files: [
    { fileId: 'f-repeat', name: 'repeat.csv', status: 'imported', counts: { rows: { transaction: 2 } }, receipt: { id: 'r-repeat' } },
    { fileId: 'f-new', name: 'new.csv', status: 'needs_confirmation', counts: {} },
  ], pending: 0 };
  const { screens, calls } = harness([], { uploadResult });
  const input = { matches: (sel) => sel === 'input[type=file][data-upload]', files: [{ name: 'repeat.csv' }, { name: 'new.csv' }], value: 'x' };
  assert.equal(screens.handleChange({ type: 'change', target: input }), true);
  await settle();
  const html = screens.addFiles('add');
  assert.match(html, /data-review-undo="r-repeat"/);
  assert.ok(text(html).includes('Review it under Waiting files.'));
  click(screens, { reviewUndo: 'r-repeat' });
  assert.deepEqual(calls.at(-1), ['actionUndo', 'r-repeat']);
  await settle();
  const after = screens.addFiles('add');
  assert.ok(text(after).includes('Undone.'));
  assert.doesNotMatch(after, /data-review-undo="r-repeat"/);
});

test('waiting rows carry the review fields, with each column bound to its layout field', async () => {
  const { setup, upload } = await import('./helpers/model-cutover.mjs');
  const { ingestState } = await import('../src/ingest/freshness.mjs');
  const x = await setup();
  try {
    const r = await upload(x, 'Account,Date,Amount USD,Description\naccount-synthetic,2032-03-02,-12.25,Synthetic purchase\naccount-synthetic,2032-03-03,2.25,Synthetic refund\nTotal,,-10.00,Control total\n');
    assert.equal(r.status, 'needs_confirmation');
    const file = ingestState(x.db).waiting.find((f) => f.id === r.fileId);
    const p = file.proposal;
    assert.equal(p.kind, 'import');
    assert.equal(p.status, 'needs_confirmation');
    assert.equal(p.summary.amount, -10);
    assert.deepEqual(p.delta, []);
    assert.deepEqual(p.actions, []);
    assert.equal(p.question, null);
    assert.equal(p.notes, 0);
    assert.deepEqual(p.columns, [
      { ordinal: 1, label: 'account', field: 'accountId' }, { ordinal: 2, label: 'date', field: 'postedDate' },
      { ordinal: 3, label: 'amount usd', field: 'amount' }, { ordinal: 4, label: 'description', field: 'description' },
    ]);
    const summary = proposalSummary(file);
    assert.ok(summary.startsWith('2 transactions'), summary);
    assert.ok(summary.includes('-$10 in total.'), summary);
    assert.ok(summary.endsWith('Totals match the sheet.'), summary);
  } finally { x.close(); }
});
