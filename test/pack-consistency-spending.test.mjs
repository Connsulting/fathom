import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CATEGORY_TABLES } from '../src/categories/resolve.mjs';
import { CATEGORY_CLASSES, classOf, BUILTIN_DEFINITIONS, OBLIGATION_RULES } from '../src/calc/classes.mjs';
import { loadPacks, getEntry, activePacks } from '../src/packs/index.mjs';

const root = fileURLToPath(new URL('../packs/', import.meta.url));
const packs = loadPacks([root]);
const CLASSES = ['housing', 'debt_service', 'healthcare', 'childcare', 'essential_other', 'discretionary',
  'unclassified', 'savings', 'taxes', 'business', 'income', 'transfer', 'excluded'];

function entryBody(ref) {
  assert.equal(typeof ref?.pack, 'string');
  assert.equal(typeof ref?.entry, 'string');
  const entry = getEntry(packs, ref.pack, ref.entry);
  assert.ok(entry, `${ref.pack}/${ref.entry}`);
  return entry.body;
}

test('every shipped category name has one class', () => {
  const seen = new Set();
  for (const table of Object.values(CATEGORY_TABLES)) {
    for (const name of Object.keys(table)) {
      seen.add(name);
      assert.equal(Object.hasOwn(CATEGORY_CLASSES, name), true, name);
      const row = CATEGORY_CLASSES[name];
      assert.ok(CLASSES.includes(row.class), `${name} -> ${row.class}`);
      assert.equal(classOf(name, table[name]), row.class, name);
    }
  }
  assert.deepEqual(Object.keys(CATEGORY_CLASSES).sort(), [...seen].sort());
  assert.equal(classOf('not-a-category', 'tax'), 'taxes');
  assert.equal(classOf('not-a-category', 'saving'), 'savings');
  assert.equal(classOf('not-a-category', 'business'), 'business');
  assert.equal(classOf('not-a-category', 'income'), 'income');
  assert.equal(classOf('not-a-category', 'transfer'), 'transfer');
  assert.equal(classOf('not-a-category', 'excluded'), 'excluded');
  assert.equal(classOf('not-a-category', 'household'), 'unclassified');
  assert.equal(classOf('not-a-category', null), null);
});

test('built-in definitions and obligation rules cite the spending pack', () => {
  assert.deepEqual(BUILTIN_DEFINITIONS.household_spending.def, {});
  assert.deepEqual(BUILTIN_DEFINITIONS.essential.def, {
    include: { classes: ['housing', 'debt_service', 'healthcare', 'childcare', 'essential_other'] },
  });
  assert.deepEqual(BUILTIN_DEFINITIONS.discretionary.def, { include: { classes: ['discretionary'] } });
  assert.deepEqual(BUILTIN_DEFINITIONS.core_living.def, {
    exclude: { classes: ['debt_service'], buckets: ['tax'] },
  });
  for (const id of ['household_spending', 'essential', 'discretionary', 'core_living']) {
    entryBody(BUILTIN_DEFINITIONS[id].packRef);
  }
  assert.equal(OBLIGATION_RULES.childcare.schoolEntryAge, 5);
  assert.equal(OBLIGATION_RULES.childcare.afterCareEndAge, 13);
  assert.equal(OBLIGATION_RULES.plan529.collegeAge, 18);
  assert.equal(OBLIGATION_RULES.mortgage.escrowContinues, true);
});

test('the spending pack is always active and its prose states the encoded rules', () => {
  const pack = packs.find((item) => item.id === 'spending-and-obligations');
  assert.ok(pack);
  assert.deepEqual(pack.appliesWhen, { all: [] });
  assert.equal(pack.entries.length, 6);
  assert.equal(activePacks(packs, {}).find((item) => item.pack.id === 'spending-and-obligations').status, 'active');
  for (const [name, row] of Object.entries(CATEGORY_CLASSES)) {
    const body = entryBody(row.packRef);
    assert.ok(body.includes(row.class), `${name} class ${row.class}`);
    assert.ok(body.includes(name), name);
  }
  const care = entryBody(OBLIGATION_RULES.childcare.packRef);
  assert.match(care, /\bage 5\b/);
  assert.match(care, /\bage 13\b/);
  const college = entryBody(OBLIGATION_RULES.plan529.packRef);
  assert.match(college, /\bage 18\b/);
  const mortgage = entryBody(OBLIGATION_RULES.mortgage.packRef);
  assert.match(mortgage, /escrow/i);
  assert.match(mortgage, /continues/);
});
