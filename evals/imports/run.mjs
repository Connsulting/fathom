import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { generateCases, manifestOf, SEED } from './generate.mjs';
import { cappedEngine, admitLive } from './live-cap.mjs';
import { fixture } from '../../test/helpers/model-import.mjs';
import { serveAppFixture } from '../../test/helpers/server.mjs';
import { createRuntimeEngine } from '../../src/engine/runtime.mjs';
import { createAuthStore } from '../../src/auth/store.mjs';
import { indexSource, resolveField } from '../../src/ingest/model-source.mjs';
import { selectionFor } from '../../src/models/config.mjs';
import { loadConfig } from '../../src/config.mjs';
import { openCliHousehold } from '../../src/platform/cli.mjs';
import { setSetting } from '../../src/store/db.mjs';
import { flatMapSeries, mapSeries } from '../../src/shared/series.mjs';

const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export function scoreRows(expected, actual) {
  const counts = new Map();
  for (const row of expected) { const key = stable(row); counts.set(key, (counts.get(key) ?? 0) + 1); }
  let matched = 0;
  for (const row of actual) { const key = stable(row); if (counts.get(key)) { matched++; counts.set(key, counts.get(key) - 1); } }
  return { expected: expected.length, actual: actual.length, matched, f1: expected.length + actual.length ? 2 * matched / (expected.length + actual.length) : 1 };
}
const coordinate = ref => ref.sheet ? `s${ref.sheet.index}:${ref.cell}` : `line:${ref.line}`;
const typedRows = c => c.oracle.expected.filter(row => row.target !== 'note');
const attributes = row => Object.fromEntries(['target', 'purpose', 'basis', 'datePrecision', 'kind', 'status', 'direction'].filter(k => k in row && !(row.target === 'account_metadata' && k === 'kind') && !(k === 'basis' && row.target === 'pnl') && !(k === 'status' && row.status === 'needs_clarification')).map(k => [k, row[k]]));
const mappedFamilies = new Set(['pnl_ledgers_refunds', 'month_end_balances', 'account_aliases']);

function scripted(c, envelope, injectUnsafe) {
  const find = id => envelope.values.find(value => coordinate(value.sheet ? { sheet: { index: Number(value.sheet.slice(1)) }, cell: value.cell } : value) === id)?.id;
  const field = value => value === null ? null : { ...value, refs: value.refs.map(find) };
  const rows = typedRows(c).map(row => ({ ...attributes(row), fields: Object.fromEntries(Object.entries(row.fields).map(([key, value]) => [key, field(value)])) }));
  const used = new Set(rows.flatMap(row => Object.values(row.fields).flatMap(value => value?.refs ?? [])));
  const controls = c.oracle.coverage.filter(region => region.disposition === 'control_total').map(region => ({ field: { refs: region.refs.map(find), transform: { op: 'identity' } }, rows: rows.map((_, i) => i), precision: 'cent' }));
  const controlled = new Set(controls.flatMap(control => control.field.refs));
  const coverage = envelope.regions.map(region => {
    const values = region.refs.map(id => envelope.values.find(value => value.id === id));
    const first = values[0];
    let disposition = controlled.size && region.refs.some(id => controlled.has(id)) ? 'control_total' : region.refs.some(id => used.has(id)) ? 'imported_detail' : 'explanatory_text';
    if (c.family === 'summary_forecast' && first.sheet === 's1' && first.row > 1) disposition = first.row === 2 ? 'duplicate_summary' : 'forecast';
    if (['empty', 'error', 'uncached_formula'].includes(region.disposition)) disposition = region.disposition;
    const reasonId = values.find(value => value.type === 'text')?.id ?? envelope.values.find(value => value.sheet === first.sheet && value.row === first.row && value.type === 'text')?.id;
    return { regionId: region.regionId, refs: region.refs, disposition, ...(!['imported_detail', 'control_total'].includes(disposition) ? { reason: { refs: [reasonId], transform: { op: 'trim' } } } : {}) };
  });
  const response = { rows, coverage, controls, completeness: 'complete' };
  if (mappedFamilies.has(c.family)) {
    const sample = rows[0];
    response.layout = { schemaVersion: 1, currency: 'USD', tables: [{ sheet: 0, headerRow: 1, target: sample.target,
      fields: Object.fromEntries(Object.entries(sample.fields).map(([key, value]) => [key, { columns: value.refs.map(id => envelope.values.find(v => v.id === id).column), transform: value.transform }])),
      attributes: Object.fromEntries(Object.entries(attributes(sample)).filter(([key]) => key !== 'target')), roles: [] }] };
    response.coverage = coverage.map(region => {
      const first = envelope.values.find(v => v.id === region.refs[0]);
      return { regionId: region.regionId, refs: region.refs, disposition: first.row === 1 ? 'explanatory_text' : 'imported_detail', ...(first.row === 1 ? { reason: { refs: [region.refs[0]], transform: { op: 'identity' } } } : {}) };
    });
  }
  if (injectUnsafe) {
    delete response.layout;
    if (injectUnsafe === 'literal') response.rows[0].fields.amount = 999;
    if (injectUnsafe === 'reference') response.rows[0].fields.amount.refs = ['missing-reference'];
    if (injectUnsafe === 'account') response.rows[0].fields.accountId = structuredClone(response.rows[1].fields.accountId);
    if (injectUnsafe === 'instruction') response.rows[0].fields.amount.transform = { op: 'execute', code: 'untrusted' };
    if (injectUnsafe === 'exclusion') response.coverage[0].disposition = 'forecast';
    if (injectUnsafe === 'total') {
      const id = response.rows[0].fields.amount.refs[0];
      response.coverage.find(region => region.refs.includes(id)).disposition = 'control_total';
      response.controls = [{ field: { refs: [id], transform: { op: 'identity' } }, rows: response.rows.map((_, i) => i), precision: 'cent' }];
    }
  }
  if (c.family === 'january_tax_year') { response.rows = []; response.completeness = 'incomplete'; response.coverage = coverage.map(region => ({ regionId: region.regionId, refs: region.refs, disposition: 'unresolved' })); }
  return response;
}

const orderedRoles = entries => [...new Map(entries)].sort(([a], [b]) => a.localeCompare(b));
const expectedContext = c => ({ dispositions: orderedRoles(Object.entries(c.oracle.dispositions)), completeness: c.family === 'january_tax_year' ? 'incomplete' : 'complete', reconciliation: c.oracle.reconciliation ?? 'no_sheet_total' });
const observedContext = (proposal, source, errors) => ({ dispositions: orderedRoles(proposal.coverage.flatMap(region => region.refs.map(id => [coordinate(source.refs[id]), region.disposition]))), completeness: proposal.completeness, reconciliation: proposal.controls?.length ? errors.includes('total_mismatch') ? 'conflict' : 'match' : 'no_sheet_total' });

function expectedRows(c) {
  const refs = new Map(c.oracle.source.refs.map(ref => [ref.id, ref]));
  if (c.family === 'january_tax_year') return [];
  return typedRows(c).map(row => ({ ...attributes(row), context: expectedContext(c), fields: Object.fromEntries(Object.entries(row.fields).map(([key, value]) => [key, value === null ? null : {
    ...value, references: value.refs.map(id => { const { id: refId, value: raw, ...ref } = refs.get(id); return ref; }), value: key === 'dueDate' ? refs.get(value.refs[0]).value.trim() : key === 'statement' ? refs.get(value.refs[0]).value.trim() : key === 'actor' ? 'owner' : row[key] ?? refs.get(value.refs[0])?.value,
  }])) }));
}
async function observedRows(c, x, file) {
  const record = await x.db.prepare('SELECT proposal,review_state FROM import_proposals WHERE file_id=? ORDER BY version DESC LIMIT 1').get(file.fileId);
  if (!record) return [];
  const source = await indexSource({ fileId: file.fileId, bytes: c.bytes, format: c.format });
  const proposal = JSON.parse(record.proposal), errors = JSON.parse(record.review_state).presentation?.errors ?? [];
  return proposal.rows.map(row => ({ ...attributes(row), context: observedContext(proposal, source, errors), fields: Object.fromEntries(Object.entries(row.fields).map(([key, value]) => [key, value === null ? null : {
    ...value, refs: value.refs.map(id => coordinate(source.refs[id])), references: value.refs.map(id => source.refs[id]), value: resolveField(source, value),
  }])) }));
}
async function contextMatches(c, x, file) {
  const record = await x.db.prepare('SELECT proposal,review_state FROM import_proposals WHERE file_id=? ORDER BY version DESC LIMIT 1').get(file.fileId);
  if (!record) return false;
  const proposal = JSON.parse(record.proposal), source = await indexSource({ fileId: file.fileId, bytes: c.bytes, format: c.format });
  return isDeepStrictEqual(expectedContext(c), observedContext(proposal, source, JSON.parse(record.review_state).presentation?.errors ?? []));
}
const tables = ['transactions', 'balances', 'pnl_lines', 'tax_payments', 'positions', 'facts', 'expected_transactions', 'accounts'];
const snapshot = async x => stable(await mapSeries(tables, async table => await x.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
async function persistedScore(c, x, file) {
  const target = { transaction: ['transactions', ['account_id', 'date', 'amount', 'description']], balance: ['balances', ['account_id', 'date', 'amount']], pnl: ['pnl_lines', ['entity', 'period', 'category', 'amount']] };
  const expected = new Map();
  for (const row of typedRows(c)) {
    if (!target[row.target]) continue;
    const values = row.target === 'transaction' ? [row.accountId, row.postedDate, row.amount, row.description] : row.target === 'balance' ? [row.accountId, row.asOf, row.amount] : [row.entity, row.period, row.category, row.amount];
    const key = row.target === 'pnl' ? stable(values.slice(0, 3)) : String(expected.size);
    const item = { target: row.target, values, refs: row.fields.amount.refs };
    if (expected.has(key)) { const prior = expected.get(key); prior.values[3] = (Math.round(prior.values[3] * 100) + Math.round(row.amount * 100)) / 100; prior.refs.push(...item.refs); }
    else expected.set(key, structuredClone(item));
  }
  const source = await indexSource({ fileId: file.fileId, bytes: c.bytes, format: c.format });
  const actual = await flatMapSeries(Object.entries(target), async ([kind, [table, columns]]) => (await x.db.prepare(`SELECT * FROM ${table} WHERE file_id=?`).all(file.fileId)).map(row => {
    const locator = JSON.parse(row.locator);
    return { target: kind, values: columns.map(key => row[key]), refs: locator.fields.amount.refs.map(id => coordinate(source.refs[id])) };
  }));
  return scoreRows([...expected.values()], actual);
}
async function environment(engineFactory) {
  const x = await fixture({ engine: 'fake' });
  await createAuthStore(x.platform).setPlatformSetting('instance_model_cap_usd', 50);
  await setSetting(x.db, 'timezone', 'UTC');
  await x.db.prepare("INSERT INTO accounts(id,name,inst,kind,owner,identity) VALUES ('account-other','Other synthetic account','Example bank','cash','spouse','other-synthetic')").run();
  for (const entity of ['Synthetic Studio', 'owner', 'spouse']) await x.db.prepare('INSERT INTO entity_aliases(alias,entity,created_at) VALUES (?,?,?)').run(entity.toLowerCase().replace(/[^a-z0-9]/g, ''), entity, '2032-04-17');
  const inner = await createRuntimeEngine({ db: x.db, config: { engine: 'fake', fakeStreamMs: 0 } });
  const engine = engineFactory(inner);
  const app = await serveAppFixture({ ...x, engine, authenticated: true });
  return { ...x, app, engine, async close() { await app.household.scheduler.stop(); await app.close(); x.close(); } };
}
async function upload(x, c) {
  const form = new FormData(); form.append('files', new Blob([c.bytes]), `synthetic.${c.format === 'text' ? 'txt' : c.format}`);
  const response = await fetch(x.app.baseUrl + '/api/files', { method: 'POST', headers: x.app.headers, body: form });
  if (response.status !== 200) throw new Error('upload_failed');
  return (await response.json()).files[0];
}
const review = (x, file) => x.app.postJson(`/api/import-proposals/${file.proposalId}/review`, { version: file.version, decision: 'approve', evidence: 'yes' });

export async function runEvaluation({ offline = false, seed = SEED, caseIds, injectUnsafe, liveEngine, liveOptions } = {}) {
  if (!offline && !liveEngine) throw new Error('live_engine_required');
  const fixtures = generateCases(seed);
  if (seed === SEED && !isDeepStrictEqual(manifestOf(fixtures), JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url))))) throw new Error('fixture_checksum_mismatch');
  const cases = fixtures.filter(c => (offline || c.variant === 'base') && (!caseIds || caseIds.includes(c.id)));
  if (!cases.length) throw new Error('no_cases');
  const report = { mode: offline ? 'offline' : 'live', seed, passed: 0, failed: 0, unrun: 0, cases: [], safety: { unsafeAccepted: 0, lostDuplicates: 0, unsupportedFigures: 0, crossHouseholdWrites: 0 }, lifecycle: { approvals: 0, retries: 0, undos: 0, foreignRefusals: 0, zeroCallRepeats: 0, changedApprovals: 0 } };
  const gate = offline ? null : cappedEngine(liveEngine, liveOptions);
  let contextErrors = 0;
  let current, calls = 0, expectedCount = 0, actualCount = 0, matchedCount = 0;
  const factory = inner => offline ? { ...inner, call(request) {
    if (request.purpose !== 'extract') return inner.call({ ...request, fake: [{ text: '{}', costUsd: 0 }] });
    calls++;
    const response = scripted(current, JSON.parse(request.messages[0].content), injectUnsafe);
    return inner.call({ ...request, fake: [{ text: JSON.stringify(response), costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 40 } }] });
  } } : gate;
  let x, foreign;
  try {
    foreign = await environment(factory);
    let group;
    for (const c of cases) {
      if (gate?.report().stopReason) { expectedCount += expectedRows(c).length; report.unrun++; report.cases.push({ id: c.id, status: 'unrun', errors: ['evaluation_cap'] }); continue; }
      if (group !== c.baseId) { await x?.close(); await foreign.close(); x = await environment(factory); foreign = await environment(factory); group = c.baseId; current = c; if (offline) await upload(foreign, c); }
      current = c;
      expectedCount += expectedRows(c).length;
      const errors = [], before = await snapshot(x), other = await snapshot(foreign), beforeCalls = calls, beforeLiveCalls = gate?.report().calls;
      try {
        let file = await upload(x, c);
        if (gate?.report().stopReason && gate.report().calls === beforeLiveCalls) { report.unrun++; report.cases.push({ id: c.id, status: 'unrun', errors: ['evaluation_cap'] }); continue; }
        if (offline && c.variant === 'changed' && mappedFamilies.has(c.family)) {
          if (!file.delta?.length) errors.push('missing_layout_delta'); else report.lifecycle.changedApprovals++;
          const corrected = await x.app.postJson(`/api/import-proposals/${file.proposalId}/review`, { version: file.version, decision: 'correct', evidence: 'Use the added annotation column and keep the other bindings.' });
          file = { ...file, ...corrected.json };
        }
        const auto = offline && ['repeat', 'overlap'].includes(c.variant) && mappedFamilies.has(c.family);
        if (file.status !== (auto ? 'imported' : c.oracle.outcome)) errors.push('unexpected_status');
        if (!auto && await snapshot(x) !== before) { errors.push('writes_before_approval'); report.safety.unsafeAccepted++; }
        const scored = scoreRows(expectedRows(c), await observedRows(c, x, file));
        actualCount += scored.actual; matchedCount += scored.matched;
        if (scored.f1 !== 1) errors.push('typed_rows_or_references');
        if (!await contextMatches(c, x, file)) { errors.push('coverage_or_exclusions'); contextErrors++; }
        if (file.fileId !== c.oracle.source.fileId || (await x.db.prepare('SELECT sha256 FROM files WHERE id=?').get(file.fileId))?.sha256 !== c.oracle.source.sha256) errors.push('source_identity');
        if (offline) {
          const retry = await x.app.postJson(`/api/files/${file.fileId}/retry`, { mode: 'retry' });
          report.lifecycle.retries++;
          if (retry.status !== (auto ? 409 : 200) || calls !== beforeCalls + (auto ? 0 : 1)) errors.push('retry_dispatched');
        }
        if (file.status === 'needs_confirmation' && c.oracle.outcome === 'needs_clarification') { errors.push('unsafe_status'); report.safety.unsafeAccepted++; }
        if (auto) { if (calls !== beforeCalls) errors.push('repeat_dispatched'); else report.lifecycle.zeroCallRepeats++; }
        const foreignReview = await review(foreign, file);
        if (foreignReview.status !== 404) errors.push('foreign_reference_accepted'); else report.lifecycle.foreignRefusals++;
        if (await snapshot(foreign) !== other) { errors.push('household_isolation'); report.safety.crossHouseholdWrites++; }
        if (file.status === 'needs_confirmation' || auto) {
          const approved = auto ? { status: 200, json: file } : await review(x, file); if (!auto) report.lifecycle.approvals++;
          if (approved.status !== 200 || approved.json.status !== 'imported') errors.push('approval_failed');
          else if ((await persistedScore(c, x, file)).f1 !== 1) { errors.push('persisted_rows_or_references'); report.safety.unsafeAccepted++; }
          if (c.family === 'relative_notes') {
            const expected = c.oracle.expected[0], actual = await x.db.prepare('SELECT subject,direction,due_date,date_precision,amount,status FROM expected_transactions WHERE file_id=?').all(file.fileId);
            if (!isDeepStrictEqual(actual.map(row => ({ ...row })), [{ subject: expected.subject, direction: expected.direction, due_date: expected.dueDate, date_precision: expected.datePrecision, amount: null, status: 'expected' }])) { errors.push('unsupported_expectation'); report.safety.unsafeAccepted++; }
          }
          if (c.family === 'reordered_sheets') {
            const occurrences = await x.db.prepare('SELECT account_id,count(*) n FROM transactions WHERE amount=? GROUP BY account_id ORDER BY account_id').all(c.oracle.expected[0].amount);
            if (!isDeepStrictEqual(occurrences.map(r => r.n), [1, 2])) { errors.push('lost_duplicates'); report.safety.lostDuplicates++; }
          }
          if (offline && c.variant === 'overlap') {
            const undo = await x.app.postJson(`/api/actions/${approved.json.receipt?.id}/undo`, {}); report.lifecycle.undos++;
            if (undo.status !== 200 || await snapshot(x) !== before) errors.push('undo_mismatch');
          }
        } else if (file.status !== 'imported') {
          const denied = await review(x, file);
          if (denied.status === 200 || await snapshot(x) !== before) { errors.push('unsafe_approval'); report.safety.unsafeAccepted++; }
        }
        const figures = (await x.db.prepare("SELECT count(*) n FROM figures WHERE file_id IS NOT NULL AND (locator IS NULL OR locator='null')").get()).n;
        if (figures) { report.safety.unsupportedFigures += figures; errors.push('unsupported_figures'); }
      } catch (error) { errors.push('case_failed');  }
      if (errors.length) report.failed++; else report.passed++;
      report.cases.push({ id: c.id, status: errors.length ? 'failed' : 'passed', errors: [...new Set(errors)] });
    }
  } finally { await x?.close(); await foreign?.close(); }
  report.f1 = expectedCount + actualCount ? 2 * matchedCount / (expectedCount + actualCount) : 1;
  if (gate) report.spend = gate.report();
  report.ok = (offline ? report.failed === 0 : true) && report.unrun === 0 && contextErrors === 0 && report.f1 >= (offline ? 1 : 0.9) && Object.values(report.safety).every(n => n === 0);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const log = console.log;
  console.log = (...args) => console.error(...args);
  try {
    const options = { offline: false, seed: SEED };
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--offline') options.offline = true;
      else if (argv[i] === '--live') options.live = true;
      else if (argv[i] === '--seed') options.seed = Number(argv[++i]);
      else if (argv[i] === '--inject-unsafe') options.injectUnsafe = argv[++i];
      else if (argv[i] === '--max-cost-usd') options.maxCostUsd = Number(argv[++i]);
      else if (argv[i] === '--max-calls') options.maxCalls = Number(argv[++i]);
      else throw new Error('invalid_arguments');
    }
    if (!options.offline && options.injectUnsafe || options.offline === !!options.live || !Number.isInteger(options.seed) || options.injectUnsafe && !['literal', 'reference', 'account', 'total', 'instruction', 'exclusion'].includes(options.injectUnsafe)) throw new Error('invalid_arguments');
    let opened;
    let result;
    try {
      if (!options.offline) {
        const authorized = process.env.FATHOM_IMPORT_EVAL_AUTHORIZED === '1';
        admitLive({ ...options, authorized, credentials: true, funded: true });
        const config = loadConfig();
        if (config.engine !== 'live') throw new Error('live_engine_required');
        const selection = selectionFor(config.modelPorts, 'extract');
        if (!(selection.keyFile || selection.adapter === 'claude' && config.claudeCredentialFile)) throw new Error('credentials_required');
        opened = await openCliHousehold(config, ['--household', process.env.FATHOM_IMPORT_EVAL_HOUSEHOLD]);
        const engine = opened.household.engine;
        await engine.init();
        options.liveOptions = { ...options, authorized, credentials: engine.credentialStateFor('extract') === 'loaded', funded: opened.household.funded() === true };
        admitLive(options.liveOptions);
        if (!engine.isOn() || !opened.household.outbound.enabled('engine')) throw new Error('engine_unavailable');
        options.liveEngine = engine;
      }
      result = await runEvaluation(options);
    } finally { await opened?.close(); }
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.ok ? 0 : 1;
  } catch { process.stderr.write('import_evaluation_refused\n'); return 1; }
  finally { console.log = log; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
