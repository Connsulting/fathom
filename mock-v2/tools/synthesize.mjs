#!/usr/bin/env node
// Turns the private scenario into the tracked synthetic one.
//   node tools/synthesize.mjs [in.js] [out.js]
// Default in:  mock-v2/private/scenario.js   (gitignored, real)
// Default out: mock-v2/scenario/example.js   (tracked, synthetic)
//
// What it does: aliases the names, scales the money, then refuses to write if a real name or a
// literal dollar amount survives anywhere. It never prints a real name, only counts and paths.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const here = import.meta.dirname;
const inPath = path.resolve(process.argv[2] || path.join(here, '..', 'private', 'scenario.js'));
const outPath = path.resolve(process.argv[3] || path.join(here, '..', 'scenario', 'example.js'));
const SCALE = 0.83;

const ALIAS = {
  me: 'Alex',
  spouse: 'Sam',
  kid: 'Theo',
  biz: 'Northbeam Labs',
  spouseBiz: 'Field and Fern',
  w2: 'Brightline',
  bank: 'Harbor Bank',
  broker: 'Keel Brokerage',
  payroll: 'PayrollCo',
  hsa: 'CareFund HSA',
};
const HOUSEHOLD_ALIAS = 'Alex and Sam';

function fail(msg) {
  console.error('synthesize: ' + msg);
  console.error('synthesize: nothing written.');
  process.exit(1);
}

// ---------------------------------------------------------------- load

if (!fs.existsSync(inPath)) fail('input not found: ' + path.relative(process.cwd(), inPath));
const sandbox = {};
sandbox.window = sandbox;
sandbox.self = sandbox;
try {
  vm.runInNewContext(fs.readFileSync(inPath, 'utf8'), sandbox, { filename: 'scenario.js', timeout: 5000 });
} catch (e) {
  fail('could not evaluate the scenario: ' + e.message);
}
if (!sandbox.FATHOM_SCENARIO || typeof sandbox.FATHOM_SCENARIO !== 'object') fail('scenario did not set window.FATHOM_SCENARIO');
const sc = JSON.parse(JSON.stringify(sandbox.FATHOM_SCENARIO));

// ---------------------------------------------------------------- names

const names = sc.names || {};
const originals = {};           // key -> real string (kept in memory only)
for (const k of Object.keys(ALIAS)) {
  if (typeof names[k] === 'string' && names[k].trim()) originals[k] = names[k];
}
const lookup = new Map();       // real string -> { key, alias }
for (const [k, v] of Object.entries(originals)) lookup.set(v, { key: k, alias: ALIAS[k] });
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reals = Array.from(lookup.keys()).sort((a, b) => b.length - a.length);
const nameRe = reals.length
  ? new RegExp('(?<![A-Za-z0-9_])(' + reals.map(reEscape).join('|') + ')(?![A-Za-z0-9_])', 'g')
  : null;
const nameCounts = {};          // alias key -> replacements
const household = sc.meta && typeof sc.meta.household === 'string' ? sc.meta.household : null;

function aliasString(s) {
  if (!nameRe) return s;
  return s.replace(nameRe, m => {
    const hit = lookup.get(m);
    nameCounts[hit.key] = (nameCounts[hit.key] || 0) + 1;
    return hit.alias;
  });
}

function mapStrings(v) {
  if (typeof v === 'string') return aliasString(v);
  if (Array.isArray(v)) return v.map(mapStrings);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = mapStrings(v[k]);
    return o;
  }
  return v;
}

const out = mapStrings(sc);
out.names = Object.assign({}, out.names);
for (const k of Object.keys(originals)) out.names[k] = ALIAS[k];
if (household !== null) {
  out.meta = Object.assign({}, out.meta, { household: HOUSEHOLD_ALIAS });
}

// ---------------------------------------------------------------- money

function scaleNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return n;
  const x = n * SCALE;
  const a = Math.abs(x);
  const step = a < 10000 ? 10 : a < 1000000 ? 100 : 1000;
  let r = Math.round(a / step) * step;
  if (r === 0) r = Math.max(1, Math.round(a));
  return x < 0 ? -r : r;
}
const scaled = { fig: 0, series: 0, salary: 0, deferral: 0 };

for (const f of Object.values(out.fig || {})) {
  if (f && typeof f.v === 'number') { f.v = scaleNum(f.v); scaled.fig += 1; }
}
for (const s of Object.values(out.series || {})) {
  for (const p of (s && s.points) || []) {
    if (p && typeof p.v === 'number') { p.v = scaleNum(p.v); scaled.series += 1; }
  }
}
const wg = out.wargame || {};
for (const p of (wg.salary && wg.salary.points) || []) {
  for (const k of ['x', 'y']) {
    if (typeof p[k] === 'number') { p[k] = scaleNum(p[k]); scaled.salary += 1; }
  }
}
const DEFERRAL_FIELDS = ['amount', 'tax2026', 'tax2027', 'net', 'decCash', 'need'];
for (const o of (wg.deferral && wg.deferral.options) || []) {
  for (const k of DEFERRAL_FIELDS) {
    if (typeof o[k] === 'number') { o[k] = scaleNum(o[k]); scaled.deferral += 1; }
  }
}

// ---------------------------------------------------------------- safety checks

const text = JSON.stringify(out);

// 1. No original name may survive. Known aliases and kept (already fictional) names are masked first
//    so an alias that happens to contain a real name does not trip the check.
let masked = text;
const keep = [...Object.values(ALIAS), out.names.advisor, out.names.specialist, HOUSEHOLD_ALIAS]
  .filter(x => typeof x === 'string' && x)
  .sort((a, b) => b.length - a.length);
for (const k of keep) masked = masked.split(k).join('\u0000');
const leaked = Object.keys(originals).filter(k => masked.includes(originals[k]));
if (leaked.length) fail('an original value for names.' + leaked.join(', names.') + ' still appears in the output');

// 2. No literal dollar amounts in any string; prose must use tokens.
const dollars = [];
(function walk(v, p) {
  if (typeof v === 'string') { if (/\$\s?\d/.test(v)) dollars.push(p); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']')); return; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], p ? p + '.' + k : k);
})(out, '');
if (dollars.length) {
  fail('literal dollar amounts found in ' + dollars.length + ' string(s), first at ' + dollars.slice(0, 5).join(', ') + '. Use tokens.');
}

// 3. Style rule, reported but not fatal.
const emDashes = (text.match(/\u2014/g) || []).length;

// ---------------------------------------------------------------- write

const body =
  '// Synthetic scenario for Fathom. Generated by tools/synthesize.mjs: names aliased, money scaled. Do not edit by hand.\n' +
  'window.FATHOM_SCENARIO = ' + JSON.stringify(out, null, 2) + ';\n' +
  "window.FATHOM_SCENARIO_SOURCE = 'synthetic';\n";
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, body);

const total = Object.values(nameCounts).reduce((a, b) => a + b, 0);
console.log('synthesize: wrote ' + path.relative(process.cwd(), outPath) + ' (' + body.length + ' bytes)');
console.log('synthesize: names aliased in strings: ' + total +
  (total ? ' (' + Object.entries(nameCounts).map(([k, n]) => k + ' ' + n).join(', ') + ')' : ''));
console.log('synthesize: names with no value in the source: ' + (Object.keys(ALIAS).filter(k => !originals[k]).join(', ') || 'none'));
console.log('synthesize: household aliased: ' + (household !== null ? 'yes' : 'no (meta.household absent)'));
console.log('synthesize: numbers scaled by ' + SCALE + ': fig ' + scaled.fig + ', series points ' + scaled.series +
  ', salary x/y ' + scaled.salary + ', deferral fields ' + scaled.deferral);
console.log('synthesize: packs checked: ' + (Array.isArray(out.packs) ? out.packs.length : 0) + ' (names and dollar checks cover the whole output)');
console.log('synthesize: checks passed: no original name left, no literal dollar amount' +
  (emDashes ? '; WARNING ' + emDashes + ' em dash(es) in output' : ''));
