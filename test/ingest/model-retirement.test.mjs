import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parserLabel } from '../../src/ingest/context.mjs';

test('only standard institution parser modules remain and production has no retired dispatch', () => {
  const root = new URL('../../src/ingest/', import.meta.url);
  assert.deepEqual(readdirSync(new URL('parsers/', root)).sort(), ['aggregator.mjs', 'brokerage-positions.mjs', 'chase-activity.mjs']);
  for (const path of readdirSync(new URL('../../src/', import.meta.url), { recursive: true }).filter(p => p.endsWith('.mjs') && !p.includes('/test/'))) {
    const code = readFileSync(new URL('../../src/' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /parsers\/(?:pnl-workbook|tax-payments|account-map|balances|notes)\.mjs/, path);
    assert.doesNotMatch(code, /(?:ledgerHeader|taxHeader|entityOf|extractDocument|mapTabular)\s*\(/, path);
  }
});
test('historical source labels render independently of executable parsers', () => {
  for (const id of ['pnl-workbook', 'tax-payments', 'account-map', 'balances', 'notes', 'mapped', 'extract-w2', 'model-import', 'unrecognized-historical']) assert.ok(parserLabel(id), id);
});
