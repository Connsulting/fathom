import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_TREATMENT, ACCESS_RULES, rmdStartAge } from '../src/calc/treatment.mjs';
import { loadPacks, getEntry, activePacks } from '../src/packs/index.mjs';

const root = fileURLToPath(new URL('../packs/', import.meta.url));
const packs = loadPacks([root]);

function entryBody(ref) {
  const entry = getEntry(packs, ref.pack, ref.entry);
  assert.ok(entry, `${ref.pack}/${ref.entry}`);
  return entry.body;
}

test('the treatment pack is always active and has six entries', () => {
  const pack = packs.find((item) => item.id === 'account-tax-treatment');
  assert.ok(pack);
  assert.deepEqual(pack.appliesWhen, { all: [] });
  assert.equal(pack.entries.length, 6);
  assert.equal(activePacks(packs, {}).find((item) => item.pack.id === 'account-tax-treatment').status, 'active');
});

test('cited entries state the encoded access ages, the five-year rule and the HSA additional tax', () => {
  const bodies = [
    entryBody(ACCESS_RULES.penaltyFreeAge.packRef),
    entryBody(ACCESS_RULES.ruleOf55.packRef),
    entryBody(ACCESS_RULES.fiveYear.packRef),
    entryBody(ACCESS_RULES.hsaAnyUse.packRef),
    entryBody(ACCESS_RULES.hsaAdditionalTax.packRef),
    entryBody(rmdStartAge.packRef),
  ].join('\n');
  assert.match(bodies, /59 and a half/);
  assert.match(bodies, /\b55\b/);
  assert.match(bodies, /\b65\b/);
  assert.match(bodies, /five-year/);
  assert.match(bodies, /20 percent/);
  const rmd = entryBody(rmdStartAge.packRef);
  assert.match(rmd, /72/);
  assert.match(rmd, /1950/);
  assert.match(rmd, /73/);
  assert.match(rmd, /1951/);
  assert.match(rmd, /1959/);
  assert.match(rmd, /75/);
  assert.match(rmd, /1960/);
  for (const table of [ACCOUNT_TREATMENT.byKind, ACCOUNT_TREATMENT.byPlanType]) {
    for (const row of Object.values(table)) entryBody(row.packRef);
  }
});
