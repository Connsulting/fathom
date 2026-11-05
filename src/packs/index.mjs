import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const operators = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'exists']);
const numeric = new Set(['gt', 'gte', 'lt', 'lte']);
const manifestFields = [
  'id', 'name', 'version', 'taxYear', 'reviewed', 'curator', 'covers',
  'appliesWhen', 'suggestWhen', 'whatIf', 'entries',
];

function invalid(at, message) {
  throw new Error(`${at}: ${message}`);
}

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fields(value, allowed, required, at) {
  if (!record(value)) invalid(at, 'must be an object');
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.includes(key)) invalid(`${at}.${String(key)}`, 'unsupported field');
  }
  for (const key of required) {
    if (!own(value, key)) invalid(`${at}.${key}`, 'is required');
  }
}

function text(value, at) {
  if (typeof value !== 'string' || value.trim() === '') invalid(at, 'must be a nonempty string');
}

function jsonValue(value, at, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !record(value)) invalid(at, 'must be a JSON value');
  if (ancestors.has(value)) invalid(at, 'must not contain a cycle');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!own(value, index)) invalid(`${at}[${index}]`, 'must be a JSON value');
      jsonValue(value[index], `${at}[${index}]`, ancestors);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') invalid(at, 'JSON object keys must be strings');
      jsonValue(value[key], `${at}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function validateRule(rule, at = 'rule', ancestors = new Set()) {
  if (!record(rule)) invalid(at, 'must be a rule object');
  if (ancestors.has(rule)) invalid(at, 'must not contain a cycle');
  ancestors.add(rule);
  const tag = ['all', 'any', 'not'].find((key) => own(rule, key));
  if (tag) {
    fields(rule, [tag], [tag], at);
    if (tag === 'not') validateRule(rule.not, `${at}.not`, ancestors);
    else {
      if (!Array.isArray(rule[tag])) invalid(`${at}.${tag}`, 'must be an array');
      for (let index = 0; index < rule[tag].length; index += 1) {
        validateRule(rule[tag][index], `${at}.${tag}[${index}]`, ancestors);
      }
    }
  } else {
    fields(rule, ['fact', 'op', 'value'], ['fact', 'op'], at);
    text(rule.fact, `${at}.fact`);
    if (!operators.has(rule.op)) invalid(`${at}.op`, 'unsupported operator');
    if (rule.op === 'exists') {
      if (own(rule, 'value')) invalid(`${at}.value`, 'is forbidden for exists');
    } else {
      if (!own(rule, 'value')) invalid(`${at}.value`, 'is required');
      jsonValue(rule.value, `${at}.value`);
      if (numeric.has(rule.op) && typeof rule.value !== 'number') {
        invalid(`${at}.value`, 'must be a finite number for a numeric comparison');
      }
      if (rule.op === 'in' && !Array.isArray(rule.value)) {
        invalid(`${at}.value`, 'must be an array for in');
      }
    }
  }
  ancestors.delete(rule);
}

function sameJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => own(b, key) && sameJson(a[key], b[key]));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const pairs = Object.keys(value).sort(compare)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

function factsObject(facts) {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    invalid('facts', 'must be an object of flat fact keys');
  }
}

function resolveRule(rule, facts) {
  if (own(rule, 'not')) {
    const child = resolveRule(rule.not, facts);
    return {
      match: child.match === null ? null : !child.match,
      evidence: child.evidence.length ? [`Negated condition; observed ${child.evidence.join('; ')}`] : [],
    };
  }
  const tag = own(rule, 'all') ? 'all' : own(rule, 'any') ? 'any' : undefined;
  if (tag) {
    const children = rule[tag].map((child) => resolveRule(child, facts));
    const decisive = tag === 'any';
    const matches = children.filter((child) => child.match === decisive);
    if (matches.length) return { match: decisive, evidence: matches.flatMap((child) => child.evidence) };
    if (children.some((child) => child.match === null)) return { match: null, evidence: [] };
    return { match: !decisive, evidence: children.flatMap((child) => child.evidence) };
  }
  const present = own(facts, rule.fact);
  if (rule.op === 'exists') {
    const detail = present ? `is present with value ${stableJson(facts[rule.fact])}` : 'is absent';
    return { match: present, evidence: [`${rule.fact} ${detail}`] };
  }
  if (!present) return { match: null, evidence: [] };
  const value = facts[rule.fact];
  try {
    jsonValue(value, `facts.${rule.fact}`);
  } catch {
    return { match: null, evidence: [] };
  }
  let match;
  switch (rule.op) {
    case 'eq': match = sameJson(value, rule.value); break;
    case 'ne': match = !sameJson(value, rule.value); break;
    case 'in': match = rule.value.some((candidate) => sameJson(value, candidate)); break;
    default:
      if (typeof value !== 'number') match = false;
      else if (rule.op === 'gt') match = value > rule.value;
      else if (rule.op === 'gte') match = value >= rule.value;
      else if (rule.op === 'lt') match = value < rule.value;
      else match = value <= rule.value;
  }
  const observed = stableJson(value);
  const expected = stableJson(rule.value);
  return { match, evidence: [`${rule.fact} is ${observed} (${rule.op} ${expected}: ${match})`] };
}

export function evaluate(rule, facts) {
  validateRule(rule);
  factsObject(facts);
  return resolveRule(rule, facts).match === true;
}

function io(path, field, operation) {
  try {
    return operation();
  } catch (error) {
    throw new Error(`${path}: ${field}: ${error.message}`, { cause: error });
  }
}

function manifestExists(directory) {
  const path = resolve(directory, 'manifest.json');
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    invalid(`${path}: manifest`, error.message);
  }
}

function confined(directory, target) {
  const path = relative(directory, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function reviewedDate(value, at) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    invalid(at, 'must be an ISO date in YYYY-MM-DD format');
  }
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid(at, 'must be a real calendar date');
}

function citationOrder(a, b) {
  return compare(a.label, b.label) || compare(a.url, b.url);
}

function validateEntry(entry, at) {
  fields(entry, ['file', 'title', 'cites'], ['file', 'title', 'cites'], at);
  text(entry.file, `${at}.file`);
  const parts = entry.file.split('/');
  if (isAbsolute(entry.file) || win32.isAbsolute(entry.file) || /^[A-Za-z]:/.test(entry.file)
    || entry.file.includes('\\') || entry.file.includes('\0') || !entry.file.endsWith('.md')
    || parts.some((part) => part === '' || part === '.' || part === '..')
    || basename(entry.file, '.md') === '') {
    invalid(`${at}.file`, 'must be a safe relative .md path');
  }
  text(entry.title, `${at}.title`);
  if (!Array.isArray(entry.cites) || entry.cites.length === 0) invalid(`${at}.cites`, 'must be a nonempty array');
  entry.cites.forEach((cite, index) => {
    const location = `${at}.cites[${index}]`;
    fields(cite, ['label', 'url'], ['label', 'url'], location);
    text(cite.label, `${location}.label`);
    text(cite.url, `${location}.url`);
    let url;
    try {
      url = new URL(cite.url);
    } catch {
      invalid(`${location}.url`, 'must be an absolute HTTP(S) URL');
    }
    if (!/^https?:\/\//i.test(cite.url) || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      invalid(`${location}.url`, 'must be an absolute HTTP(S) URL');
    }
  });
}

function validateManifest(manifest, path) {
  fields(manifest, manifestFields, manifestFields.filter((key) => key !== 'suggestWhen'), path);
  if (typeof manifest.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id)) {
    invalid(`${path}.id`, 'must be a lowercase slug');
  }
  for (const key of ['name', 'version', 'curator']) text(manifest[key], `${path}.${key}`);
  if (!Number.isInteger(manifest.taxYear)) invalid(`${path}.taxYear`, 'must be an integer');
  reviewedDate(manifest.reviewed, `${path}.reviewed`);
  if (!Array.isArray(manifest.covers) || manifest.covers.length === 0) invalid(`${path}.covers`, 'must be a nonempty array');
  manifest.covers.forEach((cover, index) => text(cover, `${path}.covers[${index}]`));
  validateRule(manifest.appliesWhen, `${path}.appliesWhen`);
  if (own(manifest, 'suggestWhen')) validateRule(manifest.suggestWhen, `${path}.suggestWhen`);
  fields(manifest.whatIf, ['prompt'], ['prompt'], `${path}.whatIf`);
  text(manifest.whatIf.prompt, `${path}.whatIf.prompt`);
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) invalid(`${path}.entries`, 'must be a nonempty array');
  const ids = new Set();
  manifest.entries.forEach((entry, index) => {
    const at = `${path}.entries[${index}]`;
    validateEntry(entry, at);
    const id = basename(entry.file, '.md');
    if (ids.has(id)) invalid(`${at}.file`, `duplicate entry ID ${id}`);
    ids.add(id);
  });
}

function loadPack(directory) {
  const path = resolve(directory, 'manifest.json');
  const boundary = io(path, 'directory', () => realpathSync(directory));
  const realManifest = io(path, 'manifest', () => realpathSync(path));
  if (!confined(boundary, realManifest)) invalid(`${path}: manifest`, 'symlink escapes the pack directory');
  const manifest = io(path, 'JSON', () => JSON.parse(readFileSync(path, 'utf8')));
  validateManifest(manifest, path);
  const entries = manifest.entries.map((entry, index) => {
    const field = `entries[${index}].file`;
    const file = resolve(directory, entry.file);
    const realFile = io(path, field, () => realpathSync(file));
    if (!confined(boundary, realFile)) invalid(`${path}.${field}`, 'symlink escapes the pack directory');
    if (!io(path, field, () => statSync(realFile).isFile())) invalid(`${path}.${field}`, 'must reference a file');
    const body = io(path, field, () => readFileSync(realFile, 'utf8'));
    if (body.trim() === '') invalid(`${path}.${field}`, 'markdown must not be empty');
    return { ...entry, cites: [...entry.cites].sort(citationOrder), id: basename(entry.file, '.md'), body };
  }).sort((a, b) => compare(a.id, b.id));
  return { ...manifest, covers: [...manifest.covers].sort(compare), entries, directory: boundary };
}

export function loadPacks(dirs) {
  if (!Array.isArray(dirs)) invalid('dirs', 'must be an array of directory strings');
  const packs = [];
  const ids = new Map();
  for (const [index, supplied] of dirs.entries()) {
    text(supplied, `dirs[${index}]`);
    const directory = resolve(supplied);
    if (!io(directory, 'directory', () => statSync(directory).isDirectory())) invalid(directory, 'must be a directory');
    const candidates = manifestExists(directory) ? [directory]
      : io(directory, 'children', () => readdirSync(directory, { withFileTypes: true }))
        .filter((child) => child.isDirectory())
        .map((child) => resolve(directory, child.name)).sort(compare).filter(manifestExists);
    for (const candidate of candidates) {
      const pack = loadPack(candidate);
      if (ids.has(pack.id)) {
        invalid(`${candidate}/manifest.json.id`, `duplicate pack ID ${pack.id}; also declared in ${ids.get(pack.id)}`);
      }
      ids.set(pack.id, resolve(candidate, 'manifest.json'));
      packs.push(pack);
    }
  }
  return packs.sort((a, b) => compare(a.id, b.id));
}

export function activePacks(packs, facts) {
  if (!Array.isArray(packs)) invalid('packs', 'must be an array');
  factsObject(facts);
  return [...packs].sort((a, b) => compare(a.id, b.id)).map((pack) => {
    validateRule(pack.appliesWhen, `${pack.id}.appliesWhen`);
    if (own(pack, 'suggestWhen')) validateRule(pack.suggestWhen, `${pack.id}.suggestWhen`);
    const active = resolveRule(pack.appliesWhen, facts);
    const suggested = own(pack, 'suggestWhen') ? resolveRule(pack.suggestWhen, facts) : { match: false };
    const status = active.match === true ? 'active' : suggested.match === true ? 'suggested' : 'available';
    const evidence = status === 'active' ? active.evidence : suggested.evidence;
    let why = status === 'available' ? 'No matching activation or suggestion rule.'
      : evidence.length ? `Matching ${status === 'active' ? 'activation' : 'suggestion'} rule: ${evidence.join('; ')}.`
        : `Matching ${status === 'active' ? 'activation' : 'suggestion'} rule without fact conditions.`;
    if (status === 'suggested' && pack.id === 'w2-benefits'
      && facts['income.sCorp'] === true && facts['income.w2'] !== true) {
      why += ' S corp owner wages and shareholder benefit rules differ from outside-employer benefits.';
    }
    return { pack, status, why };
  });
}

export function packContext(activation) {
  if (!Array.isArray(activation)) invalid('activation', 'must be an array');
  const packs = activation.filter((item) => item.status === 'active').map(({ pack }) => {
    const metadata = Object.fromEntries(manifestFields
      .filter((key) => key !== 'entries' && own(pack, key)).map((key) => [key, pack[key]]));
    return {
      ...metadata,
      covers: [...pack.covers].sort(compare),
      entries: pack.entries.map((entry) => ({
        id: entry.id, file: entry.file, title: entry.title, body: entry.body,
        cites: [...entry.cites].sort(citationOrder),
      })).sort((a, b) => compare(a.id, b.id)),
    };
  }).sort((a, b) => compare(a.id, b.id));
  return stableJson({ version: 1, packs });
}

export function getEntry(packs, packId, entryId) {
  return packs.find((pack) => pack.id === packId)?.entries.find((entry) => entry.id === entryId);
}

// The manifest id a packs_state row stands for: def.manifest when it is a non-empty string (demo
// rows), else the row's own id (real stores use manifest ids as row ids).
export function manifestIdOf(rowId, def) {
  return def && typeof def === 'object' && typeof def.manifest === 'string' && def.manifest ? def.manifest : rowId;
}
