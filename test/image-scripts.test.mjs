// The production image must contain every directory a package.json script invokes with node.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function scriptRoots(scripts) {
  const roots = new Set();
  for (const command of Object.values(scripts)) {
    for (const part of command.split('&&')) {
      const match = part.match(/\bnode\s+(?:--[\w.@/-]+(?:=[^\s]+)?\s+)*([^\s]+)/);
      if (!match) continue;
      const token = match[1].replace(/^['"]|['"]$/g, '');
      if (token.startsWith('-') || token.includes('*')) continue;
      const top = token.split('/')[0];
      if (!top || top === '.' || top === '..') continue;
      if (existsSync(join(ROOT, top))) roots.add(top);
    }
  }
  return [...roots].sort();
}

test('the Dockerfile copies every directory a package.json node script needs', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const roots = scriptRoots(pkg.scripts);
  assert.ok(roots.includes('evals'));
  for (const root of roots) {
    assert.match(dockerfile, new RegExp(`^COPY ${root} \\.\\/${root}\\s*$`, 'm'), root);
  }
});

test('the server does not import or serve evals', () => {
  const server = readFileSync(join(ROOT, 'src/server.mjs'), 'utf8');
  const staticFiles = readFileSync(join(ROOT, 'src/api/static.mjs'), 'utf8');
  assert.doesNotMatch(server, /evals/);
  assert.doesNotMatch(staticFiles, /evals/);
  assert.match(staticFiles, /webDir/);
  assert.match(staticFiles, /sharedDir/);
});
