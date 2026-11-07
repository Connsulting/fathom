import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { callTool } from '../src/tools/index.mjs';
import { accountFreshness, freshnessOf } from '../src/ingest/freshness.mjs';
import { categoryCoverage } from '../src/categories/store.mjs';
import { yearendChecklist } from '../src/yearend/expected.mjs';
import { planningYear } from '../src/jobs/planner/data.mjs';
import { tempDb } from './helpers/server.mjs';

const CLOCK = '2026-11-05';

let t;
before(async () => {
  t = await tempDb();
  seedDemo(t.db);
});
after(() => t && t.close());

const health = (args = {}) => callTool('data_health', args, { db: t.db, clock: CLOCK });

function yearendShape(db) {
  const year = planningYear(CLOCK);
  const list = yearendChecklist(db, { year, clock: CLOCK });
  return {
    year,
    items: list.items.map(item => ({
      key: item.key,
      form: item.form,
      issuer: item.files[0]?.issuer || '',
      status: item.status === 'have' ? 'received' : item.status === 'skipped' ? 'marked' : item.status,
    })),
  };
}

test('account freshness matches accountFreshness for every demo account', async () => {
  const result = await health();
  const rows = t.db.prepare('SELECT id FROM accounts ORDER BY id').all();
  assert.equal(result.accounts.length, rows.length);
  for (const { id } of rows) {
    const got = result.accounts.find(a => a.id === id);
    const fresh = accountFreshness(t.db, id, { clock: CLOCK });
    const source = fresh.sourceId
      ? t.db.prepare('SELECT kind FROM sources WHERE id = ?').get(fresh.sourceId)
      : null;
    const age = fresh.asOf && source?.kind ? freshnessOf({ kind: source.kind, asOf: fresh.asOf }, CLOCK).ageDays : null;
    assert.equal(got.lastData, fresh.asOf);
    assert.equal(got.freshness, fresh.fresh);
    assert.equal(got.ageDays, age);
    assert.equal(got.source, fresh.sourceId);
  }
});

test('category counts match categoryCoverage and year-end items match the checklist', async () => {
  const result = await health();
  const coverage = categoryCoverage(t.db);
  assert.equal(result.categories.rows.value, coverage.rows);
  assert.equal(result.categories.uncategorized.value, coverage.uncategorized);
  assert.equal(result.categories.guessed.value, coverage.layers.guess);
  assert.equal(result.categories.corrected.value, coverage.layers.correction);
  assert.equal(result.categories.queueSize.value, coverage.queueSize);
  for (const figure of Object.values(result.categories)) assert.equal(figure.unit, 'count');
  assert.deepEqual(result.yearend, yearendShape(t.db));
});

test('an account with no rows has empty lastData and an account_no_history gap', async () => {
  t.db.prepare(`INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note)
                VALUES ('ing:empty', 'Empty feed', '2026-10-01', 'bank_csv', '2026-10-01T00:00:00Z', '')`).run();
  t.db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, note, fig_key, file_id, parser, locator, source_id)
                VALUES ('acct_empty', 'Empty Bank', '0000', 'Empty checking', 'Household', 'checking', 'manual', '', NULL, NULL, 'test', 'row 0', 'ing:empty')`).run();
  const result = await health({ accounts: ['acct_empty'] });
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].lastData, '');
  assert.ok(result.gaps.some(g => g.code === 'account_no_history'));
});
