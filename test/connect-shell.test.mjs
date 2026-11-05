// The Claude Code command on the Connect screen is pasted into a shell, so the MCP URL must reach
// the shell as one literal argument whatever characters the public URL holds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { shellArg } from '../web/horizon/screens/connect.js';

const viaShell = arg => execFileSync('sh', ['-c', `printf %s ${arg}`], { encoding: 'utf8' });

test('a plain URL is left bare', () => {
  assert.equal(shellArg('https://fathom.example.test/mcp'), 'https://fathom.example.test/mcp');
  assert.equal(shellArg('http://127.0.0.1:8080/mcp'), 'http://127.0.0.1:8080/mcp');
});

test('URLs with shell metacharacters reach the shell as one literal argument', () => {
  const urls = [
    'https://fathom.example.test/finance(v2)/mcp',
    'https://fathom.example.test/$(echo pwned)/mcp',
    'https://fathom.example.test/`echo pwned`/mcp',
    'https://fathom.example.test/a b;echo pwned/mcp',
    "https://fathom.example.test/it's/mcp",
    'https://fathom.example.test/a&b|c>d/mcp',
  ];
  for (const url of urls) assert.equal(viaShell(shellArg(url)), url, url);
});

test('liveness: a safe URL still round-trips through the shell unchanged', () => {
  const url = 'https://fathom.example.test/base/mcp';
  assert.equal(viaShell(shellArg(url)), url);
});
