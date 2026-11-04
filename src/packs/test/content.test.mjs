import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPacks, activePacks } from '../index.mjs';

const root = fileURLToPath(new URL('../../../packs/', import.meta.url));
const ids = ['s-corp-owner', 'self-employed-partnership', 'w2-benefits', 'virginia-resident',
  'kids-dependents', 'advanced-retirement', 'charitable-giving'].sort();
const domains = new Set(['irs.gov', 'www.irs.gov', 'tax.virginia.gov', 'www.tax.virginia.gov',
  'law.lis.virginia.gov', 'budget.lis.virginia.gov', 'virginia529.com', 'www.virginia529.com', 'invest529.com', 'www.invest529.com']);
const frozenKeys = new Set(['household.state', 'household.filingStatus', 'household.dependents',
  'household.expectingChild', 'household.dependentAges', 'income.w2', 'income.sCorp', 'income.selfEmployed',
  'income.partnership', 'income.agiEstimate', 'benefits.hsa', 'benefits.employer401k', 'retirement.solo401k',
  'retirement.ira', 'retirement.backdoorRothCandidate', 'accounts.has529', 'giving.charitable', 'giving.annualEstimate']);
function checkRule(condition) {
  if ('fact' in condition) assert.ok(frozenKeys.has(condition.fact), condition.fact);
  if (condition.all) condition.all.forEach(checkRule);
  if (condition.any) condition.any.forEach(checkRule);
  if (condition.not) checkRule(condition.not);
}
function realDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

test('seven public packs have substantive entry counts and complete sourced editorial metadata', () => {
  const packs = loadPacks([root]);
  assert.deepEqual(packs.map((p) => p.id).sort(), ids);
  for (const pack of packs) {
    assert.ok(pack.entries.length >= 6 && pack.entries.length <= 15, pack.id);
    for (const field of ['name', 'version', 'curator']) assert.ok(pack[field].trim(), `${pack.id}: ${field}`);
    assert.equal(pack.taxYear, 2026);
    assert.ok(realDate(pack.reviewed));
    assert.ok(pack.reviewed <= new Date().toISOString().slice(0, 10));
    assert.ok(pack.covers.length > 0);
    assert.ok(pack.whatIf.prompt.trim());
    checkRule(pack.appliesWhen);
    checkRule(pack.suggestWhen);
    for (const entry of pack.entries) {
      assert.match(entry.body, /Tax year:\s*2026\b/);
      const reviewed = entry.body.match(/Reviewed:\s*(\d{4}-\d{2}-\d{2})/);
      assert.ok(reviewed && realDate(reviewed[1]), `${pack.id}/${entry.id}: reviewed`);
      assert.ok(reviewed[1] <= new Date().toISOString().slice(0, 10));
      assert.ok(entry.cites.length > 0);
      for (const citation of entry.cites) {
        assert.ok(citation.label.trim());
        const url = new URL(citation.url);
        assert.ok(['http:', 'https:'].includes(url.protocol));
        assert.ok(domains.has(url.hostname), citation.url);
        assert.ok(entry.body.includes(citation.url), `${pack.id}/${entry.id}: inline citation`);
      }
    }
  }
});

test('public entries cover the frozen required subjects without imposing file stems', () => {
  const packs = Object.fromEntries(loadPacks([root]).map((p) => [p.id, p]));
  const body = (id) => packs[id].entries.map((e) => `${e.title}\n${e.body}`).join('\n');
  for (const pattern of [/self.employ/i, /partnership/i, /(?:solo|single.member).*LLC|LLC.*(?:solo|single.member)/i]) {
    assert.match(body('self-employed-partnership'), pattern);
  }
  assert.match(body('virginia-resident'), /529/);
  assert.match(body('virginia-resident'), /deduct/i);
  for (const pattern of [/backdoor Roth/i, /pro.rata/i, /solo\s*401\s*\(?k\)?/i, /\bSEP\b/, /mega.?backdoor/i]) {
    assert.match(body('advanced-retirement'), pattern);
  }
  for (const pattern of [/bunch/i, /donor.advised|\bDAFs?\b/i, /qualified charitable distribution|\bQCDs?\b/i, /appreciated stock/i]) {
    assert.match(body('charitable-giving'), pattern);
  }
});

test('frozen synthetic facts activate relevant packs and suggest giving for high AGI without giving', () => {
  const facts = { 'household.state': 'VA', 'household.filingStatus': 'mfj', 'household.dependents': 1,
    'household.expectingChild': true, 'household.dependentAges': [4], 'income.w2': true, 'income.sCorp': true,
    'income.selfEmployed': true, 'income.partnership': true, 'income.agiEstimate': 400000,
    'benefits.hsa': true, 'benefits.employer401k': true, 'retirement.solo401k': true, 'retirement.ira': true,
    'retirement.backdoorRothCandidate': true, 'accounts.has529': true, 'giving.charitable': false, 'giving.annualEstimate': 0 };
  const activation = activePacks(loadPacks([root]), facts);
  assert.equal(activation.find((a) => a.pack.id === 'charitable-giving').status, 'suggested');
  for (const item of activation.filter((a) => a.pack.id !== 'charitable-giving')) assert.equal(item.status, 'active', item.pack.id);
});

test('README explains format, lookup, activation, missing facts and synchronous return shapes', () => {
  const readme = readFileSync(new URL('../../../packs/README.md', import.meta.url), 'utf8');
  for (const pattern of [/manifest\.json/, /getEntry/, /file.*stem|stem.*file/i, /loadPacks/, /activePacks/,
    /packContext/, /synchron/i, /missing/i, /active/, /suggested/, /available/, /add(?:ing)?\s+(?:a\s+)?pack/i]) assert.match(readme, pattern);
});
