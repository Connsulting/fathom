import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPacks, activePacks } from '../index.mjs';

const root = fileURLToPath(new URL('../../../packs/', import.meta.url));
const ids = ['s-corp-owner', 'self-employed-partnership', 'w2-benefits', 'virginia-resident',
  'kids-dependents', 'advanced-retirement', 'charitable-giving', 'spending-and-obligations'].sort();
const domains = new Set(['irs.gov', 'www.irs.gov', 'tax.virginia.gov', 'www.tax.virginia.gov',
  'law.lis.virginia.gov', 'budget.lis.virginia.gov', 'virginia529.com', 'www.virginia529.com', 'invest529.com', 'www.invest529.com', 'uscode.house.gov']);
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

test('eight public packs have substantive entry counts and complete sourced editorial metadata', () => {
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
  for (const pattern of [/debt_service/, /essential_other/, /age 5/, /age 13/, /age 18/, /escrow/i]) {
    assert.match(body('spending-and-obligations'), pattern);
  }
  assert.match(body('kids-dependents'), /care cost by age/i);
  assert.match(body('w2-benefits'), /premiums through payroll/i);
  assert.match(body('self-employed-partnership'), /premiums paid by the business/i);
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


test('high AGI suggests charitable giving for missing or false giving facts', () => {
  const packs = loadPacks([root]);
  const giving = (facts) => activePacks(packs, facts).find((item) => item.pack.id === 'charitable-giving');
  for (const extra of [{}, { 'giving.charitable': false }]) {
    const result = giving({ 'income.agiEstimate': 350000, ...extra });
    assert.equal(result.status, 'suggested');
    assert.match(result.why, /income\.agiEstimate.*350000/);
    assert.match(result.why, /giving\.charitable/);
  }
  assert.match(giving({ 'income.agiEstimate': 350000 }).why, /absent/);
  assert.doesNotMatch(giving({ 'income.agiEstimate': 350000 }).why, /not \(giving\.charitable is absent\)/);
  assert.equal(giving({ 'income.agiEstimate': 350000, 'giving.charitable': true }).status, 'active');
  for (const facts of [{}, { 'income.agiEstimate': 150000 }, { 'giving.charitable': false },
    { 'income.agiEstimate': 350000, 'giving.charitable': null }]) {
    assert.equal(giving(facts).status, 'available');
  }
});

test('outside-employer W-2 wages activate benefits while S corp wages only suggest them', () => {
  const packs = loadPacks([root]);
  const benefits = (facts) => activePacks(packs, facts).find((item) => item.pack.id === 'w2-benefits');
  for (const extra of [{}, { 'income.w2': false }, { 'income.w2': null }]) {
    const result = benefits({ 'income.sCorp': true, ...extra });
    assert.equal(result.status, 'suggested');
    assert.match(result.why, /income\.sCorp.*true/);
    assert.match(result.why, /S corp owner wages and shareholder benefit rules differ/);
  }
  const both = benefits({ 'income.sCorp': true, 'income.w2': true });
  assert.equal(both.status, 'active');
  assert.match(both.why, /income\.w2.*true/);
  assert.doesNotMatch(both.why, /S corp owner wages/);
  assert.equal(benefits({}).status, 'available');
  assert.equal(benefits({ 'income.sCorp': false, 'income.w2': false }).status, 'available');
  assert.equal(benefits({ 'benefits.hsa': true }).status, 'suggested');
  assert.equal(benefits({ 'benefits.employer401k': true }).status, 'suggested');
  const readme = readFileSync(new URL('../../../packs/README.md', import.meta.url), 'utf8');
  assert.match(readme, /income\.w2.*outside employer/i);
});

test('business income activates retirement planning before a plan has been selected', () => {
  const packs = loadPacks([root]);
  const retirement = (facts) => activePacks(packs, facts).find((item) => item.pack.id === 'advanced-retirement');
  const household = retirement({ 'income.sCorp': true, 'income.selfEmployed': true });
  assert.equal(household.status, 'active');
  assert.match(household.why, /income\.sCorp.*true/);
  assert.match(household.why, /income\.selfEmployed.*true/);
  for (const fact of ['income.sCorp', 'income.selfEmployed', 'retirement.solo401k',
    'retirement.ira', 'retirement.backdoorRothCandidate']) {
    assert.equal(retirement({ [fact]: true }).status, 'active', fact);
  }
  assert.equal(retirement({ 'income.partnership': true }).status, 'suggested');
  assert.equal(retirement({}).status, 'available');
});


test('expanded tax coverage retains verified figures, exact limit definitions and primary citations', () => {
  const packs = Object.fromEntries(loadPacks([root]).map((pack) => [pack.id, pack]));
  for (const id of ['charitable-giving', 'w2-benefits', 'advanced-retirement', 'virginia-resident']) {
    assert.equal(packs[id].version, '1.1.0', id);
  }
  const entry = (pack, file) => packs[pack].entries.find((item) => item.file === file).body;
  const bunching = entry('charitable-giving', 'bunching.md');
  for (const amount of ['$32,200', '$24,150', '$16,100']) assert.ok(bunching.includes(amount));
  assert.match(bunching, /https:\/\/www\.irs\.gov\/pub\/irs-drop\/rp-25-32\.pdf/);
  const salt = entry('charitable-giving', 'salt-cap-2026.md');
  for (const amount of ['$40,400', '$20,200', '$505,000', '$252,500', '$10,000', '$5,000']) assert.ok(salt.includes(amount));
  assert.match(salt, /reduced by 30%/);
  assert.match(salt, /https:\/\/uscode\.house\.gov\/us\/usc\/t26\/s164\//);
  assert.match(entry('charitable-giving', 'charitable-rules-2026.md'), /cash gifts to public charities.*60% of AGI/);
  const itemized = entry('charitable-giving', 'itemized-deduction-limit.md');
  assert.match(itemized, /2\/37 of the lesser/);
  assert.match(itemized, /without section 68 and then increased by those itemized deductions/);
  assert.match(itemized, /after other limits/);
  assert.match(itemized, /https:\/\/uscode\.house\.gov\/us\/usc\/t26\/s68\//);
  const rates = entry('virginia-resident', 'income-tax-rates.md');
  for (const rate of ['2%', '3%', '5%', '5.75%']) assert.ok(rates.includes(rate));
  for (const amount of ['$3,000', '$5,000', '$17,000']) assert.ok(rates.includes(amount));
  assert.match(rates, /section58\.1-320/);
  const estimates = entry('virginia-resident', 'estimated-tax.md');
  assert.match(estimates, /lesser of 90% of current-year tax liability or 100% of prior-year liability/);
  assert.match(estimates, /no federal-style 110% high-income tier/);
  assert.match(estimates, /760es-2026\.pdf/);
  const conformity = entry('virginia-resident', 'state-conformity.md');
  assert.match(conformity, /Virginia conforms.*IRC 163\(j\)/);
  assert.match(conformity, /50% to 20% of business interest disallowed on the federal return/);
});
