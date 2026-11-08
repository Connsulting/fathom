// AB1: a dropped Ask block's note says which block was left out and why, in plain words. The text
// comes from one browser-safe table (web/core/block-notes.js) that the server (show.mjs
// droppedBlock) and the client (ask-blocks.js) share, so an old stored note with a known reason
// also gains its plain cause. Names and titles here are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DROP_REASONS, dropNoteText } from '../web/core/block-notes.js';
import { droppedBlock } from '../src/tools/catalog/show.mjs';
import { sourceLabel, validTitle } from '../src/blocks/labels.mjs';
import { esc, money } from '../src/shared/tokens.mjs';
import { useKit, messageBodyHtml } from '../web/horizon/screens/ask-blocks.js';

useKit({ esc, money });

const CAUSE = {
  bad_input: 'it was asked for in a shape Fathom cannot draw',
  not_in_answer: 'it pointed at data this answer did not read',
  not_a_read: 'it pointed at something that is not your stored data',
  bad_path: 'the data it named is not in what this answer read',
  bad_field: 'one of its rows names a value the data does not have',
  mixed_units: 'it mixed values in different units in one row',
  too_large: 'it had too many items to draw',
  too_many: 'this answer already shows four blocks',
  misaligned: 'its series do not line up on the same points',
};
const NOUN = { chart: 'chart', table: 'table', compare: 'comparison', timeline: 'timeline' };
const FALLBACK = 'its data did not check out';

test('every reason maps to its plain cause, for every op, with and without a name', () => {
  for (const [reason, cause] of Object.entries(CAUSE)) for (const [op, noun] of Object.entries(NOUN)) {
    assert.equal(dropNoteText(op, reason), `A ${noun} was left out because ${cause}.`, `${op} ${reason}`);
    assert.equal(dropNoteText(op, reason, 'Invoice options'), `The ${noun} “Invoice options” was left out because ${cause}.`, `${op} ${reason} named`);
  }
});

test('DROP_REASONS is exactly the reasons with a cause, so a new reason without text fails', () => {
  assert.deepEqual([...DROP_REASONS].sort(), Object.keys(CAUSE).sort());
});

test('an unknown reason or op falls back to plain words', () => {
  assert.equal(dropNoteText('compare', 'something_new'), `A comparison was left out because ${FALLBACK}.`);
  assert.equal(dropNoteText('compare', undefined), `A comparison was left out because ${FALLBACK}.`);
  assert.equal(dropNoteText('sparkline', 'mixed_units'), `A block was left out because ${CAUSE.mixed_units}.`);
  assert.equal(dropNoteText('sparkline', 'mixed_units', 'Invoice options'), `The block “Invoice options” was left out because ${CAUSE.mixed_units}.`);
  for (const reason of [...Object.keys(CAUSE), 'something_new']) assert.doesNotMatch(dropNoteText('chart', reason), /_|\{/);
});

const ARGS = { operation: 'wargame', name: 'deferral' };
const SOURCE = { tool: 'recommendations', args: ARGS, path: 'deferral.options' };
const RESULTS = [{ name: 'recommendations', args: ARGS, isError: false, result: { title: 'Invoice deferral war game', deferral: { options: [] } } }];

test('droppedBlock names the block by its valid title', () => {
  const note = droppedBlock('compare', 'mixed_units', { spec: { title: 'Invoice options', source: SOURCE, fields: ['figures.amount'] }, results: [] });
  assert.equal(note.op, 'compare');
  assert.equal(note.reason, 'mixed_units');
  assert.equal(note.name, 'Invoice options');
  assert.equal(note.text, dropNoteText('compare', 'mixed_units', 'Invoice options'));
});

test('droppedBlock never uses an invalid title: it falls back to the result title, then the source label', () => {
  const bad = 'Options for 2027';
  assert.equal(validTitle(bad), false);
  const fromResult = droppedBlock('compare', 'too_large', { spec: { title: bad, source: SOURCE, fields: ['figures.amount'] }, results: RESULTS });
  assert.equal(fromResult.name, 'Invoice deferral war game');
  assert.equal(fromResult.text, dropNoteText('compare', 'too_large', 'Invoice deferral war game'));
  assert.doesNotMatch(fromResult.text, /2027/);

  const fromOptions = droppedBlock('compare', 'bad_field', { spec: { options: [{ source: { ...SOURCE, path: 'deferral.options.0' } }], fields: ['figures.amount'] }, results: RESULTS });
  assert.equal(fromOptions.name, 'Invoice deferral war game');

  const fromLabel = droppedBlock('table', 'not_in_answer', { spec: { title: bad, source: SOURCE, columns: ['figures.amount'] }, results: [] });
  assert.equal(fromLabel.name, sourceLabel(SOURCE));
  assert.equal(fromLabel.text, dropNoteText('table', 'not_in_answer', sourceLabel(SOURCE)));
  assert.doesNotMatch(fromLabel.text, /2027/);

  const unnamed = droppedBlock('chart', 'bad_input', { spec: { title: bad }, results: [] });
  assert.equal(Object.hasOwn(unnamed, 'name'), false);
  assert.equal(unnamed.text, dropNoteText('chart', 'bad_input'));
});

test('every reason validateBlock and makeBlock can return is in DROP_REASONS', () => {
  const validate = readFileSync(new URL('../src/blocks/validate.mjs', import.meta.url), 'utf8');
  const show = readFileSync(new URL('../src/tools/catalog/show.mjs', import.meta.url), 'utf8');
  const reasons = new Set([...validate.matchAll(/fail\('([a-z_]+)'\)/g)].map(x => x[1]));
  assert.ok(reasons.size >= 8, `found ${[...reasons].join(', ')}`);
  for (const x of show.matchAll(/reason: '([a-z_]+)'/g)) reasons.add(x[1]);
  assert.ok(reasons.has('too_large'));
  for (const reason of reasons) assert.ok(DROP_REASONS.includes(reason), `${reason} has a cause`);
});

test('a stored note with a known reason renders the plain cause; an unknown reason keeps its stored text', () => {
  const old = 'A comparison was left out because its data did not check out.';
  const legacy = 'A chart was left out for a stored reason.';
  const html = messageBodyHtml({ id: 'n1', role: 'fathom', html: '<p>x</p>', provenance: { blocks: [], blockNotes: [
    { op: 'compare', reason: 'mixed_units', text: old },
    { op: 'table', reason: 'too_large', name: 'Invoice options', text: 'A table was left out because its data did not check out.' },
    { op: 'chart', reason: 'legacy_reason', text: legacy },
  ] } });
  assert.ok(html.includes(esc(dropNoteText('compare', 'mixed_units'))), 'old compare note gains its cause');
  assert.ok(!html.includes(esc(old)), 'the old fixed wording is gone');
  assert.ok(html.includes(esc(dropNoteText('table', 'too_large', 'Invoice options'))), 'named note');
  assert.ok(html.includes(esc(legacy)), 'unknown reason keeps its stored text');
});
