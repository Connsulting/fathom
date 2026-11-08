// Static async call graph over the repository's modules. Seeds are the storage port's Promise
// returning calls (query descriptors, transactions, savepoints, scope close); every function that
// reaches a seed is asynchronous, and every call of one must be consumed as a Promise. The
// architecture test uses it to reject un-awaited storage, auth and admission calls.

import { Parser } from 'acorn';

// Parses `await` in any function, so a module mid-conversion (an await already written inside a
// function not yet marked async) still yields a tree; the architecture test checks async-ness itself.
class AwaitAnywhere extends Parser {
  get canAwait() { return true; }
}
const parse = (src, options) => AwaitAnywhere.parse(src, options);
import { fullAncestor } from 'acorn-walk';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const QUERY = new Set(['get', 'all', 'run']);
const PORT_METHODS = new Set(['transaction', 'savepoint', 'capture']);
// Storage metadata and lifecycle operations (always Promise valued).
export const STORAGE_OPS = new Set(['columns', 'tables', 'migrate', 'checkpoint', 'hasTable', 'sizeBytes', 'backupTo', 'applySchema', 'integrityCheck', 'foreignKeyCheck']);
// Method names too generic to resolve by name alone.
const GENERIC = new Set([
  'get', 'all', 'run', 'set', 'has', 'add', 'delete', 'clear', 'map', 'filter', 'find', 'forEach',
  'some', 'every', 'reduce', 'push', 'pop', 'shift', 'then', 'catch', 'finally', 'call', 'apply',
  'bind', 'toString', 'valueOf', 'next', 'close', 'end', 'write', 'read', 'send', 'json', 'emit',
  'on', 'once', 'off', 'start', 'stop', 'open', 'list', 'update', 'remove', 'create', 'load',
  'save', 'handle', 'handler', 'execute', 'exec', 'prepare', 'test', 'match', 'replace', 'split',
  'join', 'slice', 'sort', 'keys', 'values', 'entries', 'includes', 'indexOf', 'resolve', 'reject',
  'transaction', 'savepoint', 'capture', 'flatMap', 'concat', 'trim', 'parse', 'stringify', 'log',
  'error', 'warn', 'info', 'debug', 'abort', 'destroy', 'pipe', 'setHeader', 'writeHead', 'listen',
]);
export const ARRAY_CALLBACKS = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'flatMap', 'reduce']);
// Callees that consume a Promise returned by their callback.
const PROMISE_AWARE = new Set(['test', 'it', 'describe', 'before', 'after', 'beforeEach', 'afterEach', 'then', 'catch', 'finally', 'step', 'all', 'allSettled', 'race', 'any', 'waitFor', 'run', 'withResolvers', 'route', 'expect', 'poll', 'mock']);
const DB_NAME = /(^|_)(db|platform|control|staged|source|target|household|store|scope|storage)$|Db$|Platform$|Store$|Scope$|Storage$/;

const isFunction = n => n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

function propName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'PrivateIdentifier') return node.name;
  return null;
}

function patternNames(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') for (const q of p.properties) patternNames(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const q of p.elements) patternNames(q, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  return out;
}

export function loadModule(file) {
  const src = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
  return { file, src, ast };
}

// Build the analysis. `files` are absolute paths. Returns the graph with `asyncFns`, `calls`.
export function analyze(files, { roots = () => false, root = null } = {}) {
  const modules = new Map(files.map(f => [f, loadModule(f)]));
  const fns = [];            // FunctionInfo
  const fnOf = new Map();    // node -> FunctionInfo
  const methods = new Map(); // method name -> [FunctionInfo]
  const calls = [];          // { mod, node, ancestors }
  const refs = [];           // identifier references to functions as values
  const awaits = [];         // await expressions, whose functions must be async
  const valueProps = [];     // `{ name }` and `{ key: name }` properties naming functions

  for (const mod of modules.values()) {
    mod.imports = new Map();
    mod.exports = new Map();
    mod.scopes = new Map();
    for (const st of mod.ast.body) {
      if (st.type === 'ImportDeclaration' && st.source.value.startsWith('.')) {
        const from = resolve(dirname(mod.file), st.source.value);
        for (const s of st.specifiers) {
          mod.imports.set(s.local.name, { from, name: s.type === 'ImportNamespaceSpecifier' ? '*' : s.type === 'ImportDefaultSpecifier' ? 'default' : propName(s.imported) });
        }
      } else if (st.type === 'ExportNamedDeclaration') {
        if (st.declaration) {
          const d = st.declaration;
          if (d.id) mod.exports.set(d.id.name, { local: d.id.name });
          if (d.declarations) for (const v of d.declarations) for (const n of patternNames(v.id)) mod.exports.set(n, { local: n });
        }
        for (const s of st.specifiers || []) {
          if (st.source) mod.exports.set(propName(s.exported), { from: resolve(dirname(mod.file), st.source.value), name: propName(s.local) });
          else mod.exports.set(propName(s.exported), { local: propName(s.local) });
        }
      } else if (st.type === 'ExportDefaultDeclaration') {
        if (st.declaration.id) mod.exports.set('default', { local: st.declaration.id.name });
        else mod.exports.set('default', { node: st.declaration });
      } else if (st.type === 'ExportAllDeclaration' && !st.exported) {
        (mod.star ??= []).push(resolve(dirname(mod.file), st.source.value));
      }
    }
    fullAncestor(mod.ast, (node, _state, ancestors) => {
      if (isFunction(node)) {
        const parent = ancestors[ancestors.length - 2];
        const names = [];
        let method = null;
        if (node.id) names.push(node.id.name);
        if (parent?.type === 'VariableDeclarator' && parent.init === node) names.push(...patternNames(parent.id));
        if (parent?.type === 'Property' && parent.value === node) { method = propName(parent.key); }
        if (parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') method = propName(parent.key);
        if (parent?.type === 'AssignmentExpression' && parent.right === node) {
          if (parent.left.type === 'Identifier') names.push(parent.left.name);
          else if (parent.left.type === 'MemberExpression') method = propName(parent.left.property);
        }
        const info = { mod, node, parent, names, method, wasAsync: node.async, async: node.async, generator: node.generator };
        if (parent?.type === 'Property' && (parent.kind === 'get' || parent.kind === 'set')) info.accessor = true;
        if (parent?.type === 'MethodDefinition' && parent.kind !== 'method') info.accessor = true;
        info.handle = names.some(n => /^open[A-Z]\w*$|^openDb$|StoreFile$|^create\w*(Db|Store|Platform)$/.test(n));
        fns.push(info);
        fnOf.set(node, info);
        if (method) { if (!methods.has(method)) methods.set(method, []); methods.get(method).push(info); }
      } else if (node.type === 'CallExpression') {
        calls.push({ mod, node, ancestors: ancestors.slice(0, -1) });
      } else if (node.type === 'Property' && node.value.type === 'Identifier' && !node.computed) {
        valueProps.push({ mod, node, ancestors: ancestors.slice(0, -1) });
      } else if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) {
        awaits.push({ mod, node, ancestors: ancestors.slice(0, -1) });
      } else if (node.type === 'Identifier') {
        refs.push({ mod, node, ancestors: ancestors.slice(0, -1) });
      }
    });
  }

  // The module a dynamic import (`await import('./x.mjs')` or the test helper `await src('src/x.mjs')`) loads.
  function dynamicImport(mod, init) {
    const n = init?.type === 'AwaitExpression' ? init.argument : null;
    if (!n) return null;
    if (n.type === 'ImportExpression' && n.source.type === 'Literal' && String(n.source.value).startsWith('.')) return resolve(dirname(mod.file), n.source.value);
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'src' && root && n.arguments[0]?.type === 'Literal') return resolve(root, n.arguments[0].value);
    return null;
  }

  // Declarations a scope node introduces.
  function scopeNames(mod, node) {
    if (mod.scopes.has(node)) return mod.scopes.get(node);
    const map = new Map();
    const declare = (name, binding) => { if (!map.has(name)) map.set(name, binding); };
    const statements = node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock' ? node.body
      : node.type === 'SwitchCase' ? node.consequent : null;
    if (isFunction(node)) {
      for (const p of node.params) for (const n of patternNames(p)) declare(n, { kind: 'param' });
      if (node.type === 'FunctionExpression' && node.id) declare(node.id.name, { kind: 'fn', info: fnOf.get(node) });
      if (node.body.type === 'BlockStatement') for (const [k, v] of scopeNames(mod, node.body)) declare(k, v);
    }
    if (statements) {
      for (let st of statements) {
        if (st.type === 'ExportNamedDeclaration' && st.declaration) st = st.declaration;
        if (st.type === 'ExportDefaultDeclaration' && st.declaration.id) st = st.declaration;
        if (st.type === 'FunctionDeclaration') declare(st.id.name, { kind: 'fn', info: fnOf.get(st) });
        else if (st.type === 'ClassDeclaration') declare(st.id.name, { kind: 'class' });
        else if (st.type === 'VariableDeclaration') {
          for (const d of st.declarations) {
            const dyn = dynamicImport(mod, d.init);
            if (dyn && d.id.type === 'ObjectPattern') {
              for (const q of d.id.properties) {
                if (q.type !== 'Property') continue;
                for (const n of patternNames(q.value)) declare(n, { kind: 'import', from: dyn, name: propName(q.key) });
              }
              continue;
            }
            if (dyn && d.id.type === 'Identifier') { declare(d.id.name, { kind: 'import', from: dyn, name: '*' }); continue; }
            if (d.id.type === 'ObjectPattern' && d.init) {
              for (const q of d.id.properties) {
                if (q.type !== 'Property') continue;
                const target = q.value.type === 'AssignmentPattern' ? q.value.left : q.value;
                if (target.type === 'Identifier') declare(target.name, { kind: 'value', init: d.init, prop: propName(q.key) });
                else for (const n of patternNames(target)) declare(n, { kind: 'value', init: null });
              }
              continue;
            }
            for (const n of patternNames(d.id)) {
              if (d.id.type === 'Identifier' && isFunction(d.init)) declare(n, { kind: 'fn', info: fnOf.get(d.init) });
              else declare(n, { kind: 'value', init: d.id.type === 'Identifier' ? d.init : null, decl: d });
            }
          }
        } else if (st.type === 'ImportDeclaration') {
          for (const s of st.specifiers) declare(s.local.name, { kind: 'import', ...(mod.imports.get(s.local.name) || { external: true }) });
        }
      }
    }
    if ((node.type === 'ForStatement' && node.init?.type === 'VariableDeclaration') || ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && node.left.type === 'VariableDeclaration')) {
      const decl = node.type === 'ForStatement' ? node.init : node.left;
      for (const d of decl.declarations) for (const n of patternNames(d.id)) declare(n, { kind: 'value', init: node.type === 'ForStatement' ? d.init : null });
    }
    if (node.type === 'CatchClause' && node.param) for (const n of patternNames(node.param)) declare(n, { kind: 'param' });
    mod.scopes.set(node, map);
    return map;
  }

  function lookup(mod, name, ancestors) {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const b = scopeNames(mod, ancestors[i]).get(name);
      if (b) return b;
    }
    return null;
  }

  function exported(path, name, seen = new Set()) {
    const mod = modules.get(path) || modules.get(path + '.mjs');
    if (!mod || seen.has(mod.file + name)) return null;
    seen.add(mod.file + name);
    const e = mod.exports.get(name);
    if (e) {
      if (e.from) return exported(e.from, e.name, seen);
      if (e.node) return isFunction(e.node) ? { kind: 'fn', info: fnOf.get(e.node) } : null;
      const b = scopeNames(mod, mod.ast).get(e.local);
      if (b?.kind === 'import' && !b.external) return b.name === '*' ? { kind: 'ns', from: b.from } : exported(b.from, b.name, seen);
      return b ? { ...b, mod } : null;
    }
    for (const star of mod.star || []) { const r = exported(star, name, seen); if (r) return r; }
    return null;
  }

  function bindingOf(mod, name, ancestors) {
    const b = lookup(mod, name, ancestors);
    if (b?.kind === 'import' && !b.external) {
      if (b.name === '*') return { kind: 'ns', from: b.from };
      return exported(b.from, b.name) || { kind: 'unknown' };
    }
    return b;
  }

  // The value a binding's initializer produces, looking through await.
  const unwrap = n => (n?.type === 'AwaitExpression' ? n.argument : n?.type === 'ChainExpression' ? n.expression : n);
  const isPrepare = n => { n = unwrap(n); return n?.type === 'CallExpression' && n.callee.type === 'MemberExpression' && propName(n.callee.property) === 'prepare'; };

  // Object-literal properties that name a function are methods of that name too.
  for (const v of valueProps) {
    const b = bindingOf(v.mod, v.node.value.name, v.ancestors);
    if (b?.kind !== 'fn' || !b.info) continue;
    const name = propName(v.node.key);
    if (!methods.has(name)) methods.set(name, []);
    if (!methods.get(name).includes(b.info)) methods.get(name).push(b.info);
  }

  // The methods of the object a factory function returns (`return { a, b() {} }`, `=> ({ ... })`,
  // optionally wrapped in Object.freeze).
  const returned = new Map();
  function returnedMethods(info) {
    if (returned.has(info)) return returned.get(info);
    const out = new Map();
    returned.set(info, out);
    const objects = [];
    const take = n => {
      n = unwrap(n);
      if (n?.type === 'CallExpression' && n.callee.type === 'MemberExpression' && propName(n.callee.property) === 'freeze') n = n.arguments[0];
      if (n?.type === 'ObjectExpression') objects.push(n);
    };
    if (info.node.body.type !== 'BlockStatement') take(info.node.body);
    else fullAncestor(info.node.body, (n, _s, anc) => {
      if (n.type !== 'ReturnStatement') return;
      if (anc.some(a => isFunction(a))) return;
      take(n.argument);
    });
    for (const o of objects) {
      for (const p of o.properties) {
        if (p.type !== 'Property') continue;
        const name = propName(p.key);
        if (!name) continue;
        if (isFunction(p.value)) out.set(name, fnOf.get(p.value));
        else if (p.value.type === 'Identifier') {
          const b = lookup(info.mod, p.value.name, [info.mod.ast, info.node, info.node.body]);
          if (b?.kind === 'fn' && b.info) out.set(name, b.info);
        }
      }
    }
    return out;
  }

  // Which functions a call may invoke, and whether it is itself a port seed.
  function classify(call, depth = 0) {
    const { mod, node, ancestors } = call;
    const callee = node.callee.type === 'ChainExpression' ? node.callee.expression : node.callee;
    if (callee.type === 'Identifier') {
      const b = bindingOf(mod, callee.name, ancestors);
      if (b?.kind === 'fn' && b.info) return { targets: [b.info] };
      // Destructured from a factory call: `const { invite } = await fixture()`.
      const init = b?.kind === 'value' && b.prop ? unwrap(b.init) : null;
      if (init?.type === 'CallExpression' && depth < 3) {
        const made = classify({ mod, node: init, ancestors }, depth + 1).targets;
        const found = made.map(f => returnedMethods(f).get(b.prop)).filter(Boolean);
        if (found.length) return { targets: found };
      }
      return { targets: [] };
    }
    if (callee.type !== 'MemberExpression') return { targets: [] };
    const name = propName(callee.property);
    const obj = callee.object.type === 'ChainExpression' ? callee.object.expression : callee.object;
    if (QUERY.has(name)) {
      if (isPrepare(obj)) return { seed: 'query', targets: [] };
      if (obj.type === 'Identifier') {
        const b = lookup(mod, obj.name, ancestors);
        if (b?.kind === 'value' && isPrepare(b.init)) return { seed: 'query', targets: [] };
        if (b?.kind === 'value' && b.init?.type === 'ConditionalExpression' && isPrepare(b.init.consequent) && isPrepare(b.init.alternate)) return { seed: 'query', targets: [] };
      }
      if (obj.type === 'MemberExpression' && mod.statementProps?.has(propName(obj.property))) return { seed: 'query', targets: [] };
    }
    if (PORT_METHODS.has(name) && node.arguments.length >= 1 && (isFunction(node.arguments[0])
      || (node.arguments[0].type === 'Identifier' && DB_NAME.test(obj.type === 'Identifier' ? obj.name : obj.type === 'MemberExpression' ? propName(obj.property) ?? '' : '')))) return { seed: 'port', targets: [] };
    if (STORAGE_OPS.has(name)) return { seed: 'op', targets: [] };
    if (name === 'close' && node.arguments.length === 0) {
      const root = obj.type === 'MemberExpression' ? propName(obj.property) : obj.type === 'Identifier' ? obj.name : null;
      if (root && DB_NAME.test(root)) return { seed: 'close', targets: [] };
      if (obj.type === 'Identifier') {
        const b = lookup(mod, obj.name, ancestors);
        const init = unwrap(b?.init);
        if (init?.type === 'CallExpression') {
          const t = classify({ mod, node: init, ancestors }, depth + 1);
          if (t.targets.some(f => f.handle)) return { seed: 'close', targets: [] };
        }
      }
    }
    if (obj.type === 'Identifier') {
      const b = bindingOf(mod, obj.name, ancestors);
      if (b?.kind === 'ns') {
        const e = exported(b.from, name);
        return { targets: e?.kind === 'fn' && e.info ? [e.info] : [] };
      }
      // A receiver made by a factory call: the factory's returned method of that name.
      const init = b?.kind === 'value' ? unwrap(b.init) : null;
      if (init?.type === 'CallExpression' && depth < 3) {
        const made = classify({ mod, node: init, ancestors }, depth + 1).targets;
        const found = made.map(f => returnedMethods(f).get(name)).filter(Boolean);
        if (found.length) return { targets: found };
      }
    }
    if (name && !GENERIC.has(name) && methods.has(name)) return { targets: methods.get(name), byName: true };
    return { targets: [] };
  }

  // Property names assigned prepared statements (`{ insert: db.prepare(...) }`, `this.x = db.prepare(...)`).
  for (const mod of modules.values()) {
    mod.statementProps = new Set();
    fullAncestor(mod.ast, node => {
      if (node.type === 'Property' && isPrepare(node.value)) mod.statementProps.add(propName(node.key));
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && isPrepare(node.right)) mod.statementProps.add(propName(node.left.property));
    });
  }

  for (const c of calls) Object.assign(c, classify(c));
  const callersOf = new Map();
  for (const c of calls) for (const t of c.targets) {
    if (!callersOf.has(t)) callersOf.set(t, []);
    callersOf.get(t).push(c);
  }

  const enclosing = ancestors => {
    for (let i = ancestors.length - 1; i >= 0; i--) if (isFunction(ancestors[i])) return fnOf.get(ancestors[i]);
    return null;
  };

  // R: the functions that reach the port. A call reaches it when it is a seed, or when it resolves
  // to a function in R (every candidate, for calls resolved by method name alone).
  const reaches = c => {
    if (c.seed) return true;
    if (!c.targets.length) return false;
    return c.byName ? c.targets.every(t => t.reaches) : c.targets.some(t => t.reaches);
  };
  const work = calls.filter(c => c.seed);
  const done = new Set();
  const mark = fn => {
    if (fn.reaches) return;
    fn.reaches = true;
    if (!fn.async) fn.async = true;
    for (const c of callersOf.get(fn) || []) if (!done.has(c) && reaches(c)) work.push(c);
    // An async callback makes an array iteration call asynchronous too.
    const p = fn.parent;
    if (p?.type === 'CallExpression' && p.arguments.includes(fn.node)) {
      const pc = callNode.get(p);
      const name = p.callee.type === 'MemberExpression' ? propName(p.callee.property) : null;
      if (pc && !pc.seed && name && ARRAY_CALLBACKS.has(name)) { pc.seed = 'series'; pc.series = name; work.push(pc); }
    }
  };
  const callNode = new Map(calls.map(c => [c.node, c]));
  const drain = () => {
    while (work.length) {
      const c = work.pop();
      if (done.has(c)) continue;
      done.add(c);
      c.reaches = true;
      const fn = enclosing(c.ancestors);
      if (fn) mark(fn);
    }
  };
  for (const fn of fns) if (roots(fn)) mark(fn);
  for (const a of awaits) { const fn = enclosing(a.ancestors); if (fn && !fn.wasAsync) mark(fn); }
  drain();
  for (let changed = true; changed;) {
    changed = false;
    for (const c of calls) if (!done.has(c) && c.byName && reaches(c)) { work.push(c); changed = true; }
    drain();
  }

  // Function values that became asynchronous and escape as values (not called directly).
  const escapes = [];
  for (const r of refs) {
    const p = r.ancestors[r.ancestors.length - 1];
    if (!p) continue;
    if (p.type === 'CallExpression' && p.callee === r.node) continue;
    if (p.type === 'MemberExpression' && p.property === r.node && !p.computed) continue;
    if (p.type === 'Property' && p.key === r.node && !p.shorthand) continue;
    if (/^(ImportSpecifier|ImportDefaultSpecifier|ImportNamespaceSpecifier|ExportSpecifier|FunctionDeclaration|MethodDefinition|PropertyDefinition|LabeledStatement|BreakStatement|ContinueStatement)$/.test(p.type)) continue;
    if (p.type === 'VariableDeclarator' && p.id === r.node) continue;
    if (isFunction(p) && (p.id === r.node || p.params.includes(r.node))) continue;
    const b = bindingOf(r.mod, r.node.name, r.ancestors);
    if (b?.kind === 'fn' && b.info?.reaches) escapes.push({ ...r, info: b.info, parent: p });
  }

  return { modules, fns, calls, escapes, enclosing, isFunction, propName, unwrap };
}

// How a Promise-valued call is consumed: 'await', 'return', 'void', 'chain', 'all', 'value', or a
// problem kind ('floating', 'condition', 'operand', 'member', 'argument').
export function consumption(call) {
  let child = call.node;
  for (let i = call.ancestors.length - 1; i >= 0; i--) {
    const p = call.ancestors[i];
    switch (p.type) {
      case 'AwaitExpression': return 'await';
      case 'ChainExpression':
      case 'ParenthesizedExpression': child = p; continue;
      case 'ReturnStatement': return 'return';
      case 'ArrowFunctionExpression': return p.body === child ? 'return' : 'value';
      case 'UnaryExpression': return p.operator === 'void' ? 'void' : 'condition';
      case 'ExpressionStatement': return 'floating';
      case 'MemberExpression': {
        if (p.object !== child) return 'value';
        const m = p.property.type === 'Identifier' ? p.property.name : null;
        if (['then', 'catch', 'finally'].includes(m)) return 'chain';
        return 'member';
      }
      case 'CallExpression':
      case 'NewExpression': {
        if (p.callee === child) return 'member';
        const callee = p.callee.type === 'MemberExpression' ? p.callee.property.name : p.callee.name;
        if (['all', 'allSettled', 'race', 'any', 'resolve', 'push', 'add', 'set', 'track', 'waitUntil', 'rejects', 'doesNotReject'].includes(callee)) return 'all';
        return 'argument';
      }
      case 'IfStatement': case 'WhileStatement': case 'DoWhileStatement': case 'ForStatement':
        return p.test === child ? 'condition' : 'value';
      case 'ConditionalExpression':
        if (p.test === child) return 'condition';
        child = p; continue;
      case 'LogicalExpression':
        if (p.left === child) return 'condition';
        child = p; continue;
      case 'BinaryExpression': return 'operand';
      case 'TemplateLiteral': return 'operand';
      case 'SequenceExpression': child = p; continue;
      case 'SpreadElement': return 'operand';
      case 'ForOfStatement': return p.await ? 'value' : 'operand';
      case 'VariableDeclarator': case 'AssignmentExpression': case 'Property': case 'ArrayExpression':
      case 'PropertyDefinition': case 'AssignmentPattern':
        return 'value';
      default: return 'value';
    }
  }
  return 'value';
}
