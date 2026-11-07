// Deploy smoke for /mcp. Base URL is FATHOM_SMOKE_URL (origin, or an URL already ending in /mcp).
// The bearer key is the file named by FATHOM_SMOKE_KEY_FILE. Neither value is read from argv.
//
// Calls initialize, tools/list, then every listed read tool whose schema requires no arguments.
// Also calls set_recommendation_status (write scope) and requires the permission-denied result.
// Prints one line per check: "<name> <pass|fail> <byte size>". Never prints result contents or the key.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const WRITE_TOOL = 'set_recommendation_status';
const WRITE_ARGS = { id: 'smoke', status: 'doing' };

function line(name, ok, bytes) {
  process.stdout.write(`${name} ${ok ? 'pass' : 'fail'} ${bytes}\n`);
}

function sizeOf(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
}

function textOf(result) {
  const parts = Array.isArray(result && result.content) ? result.content : [];
  return parts.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
}

function needsNoArgs(tool) {
  const required = tool.inputSchema && tool.inputSchema.required;
  return !Array.isArray(required) || required.length === 0;
}

function endpoint(base) {
  const url = new URL(base);
  if (!url.pathname.endsWith('/mcp')) url.pathname = `${url.pathname.replace(/\/$/, '')}/mcp`;
  return url;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length) {
    console.error('mcp-smoke: takes no arguments');
    return 1;
  }
  const base = env.FATHOM_SMOKE_URL;
  const keyFile = env.FATHOM_SMOKE_KEY_FILE;
  if (!base || !keyFile) {
    console.error('mcp-smoke: set FATHOM_SMOKE_URL and FATHOM_SMOKE_KEY_FILE');
    return 1;
  }
  let key;
  try {
    key = readFileSync(keyFile, 'utf8').trim();
  } catch {
    console.error('mcp-smoke: missing key file');
    return 1;
  }
  if (!key) {
    console.error('mcp-smoke: empty key file');
    return 1;
  }

  let url;
  try {
    url = endpoint(base);
  } catch {
    console.error('mcp-smoke: FATHOM_SMOKE_URL is not a URL');
    return 1;
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'fathom-mcp-smoke', version: '1.0.0' });
  let failed = false;
  try {
    try {
      await client.connect(transport);
    } catch (err) {
      line('initialize', false, sizeOf(err && err.message ? err.message : 'error'));
      return 1;
    }

    let tools;
    try {
      tools = (await client.listTools()).tools || [];
    } catch (err) {
      line('tools/list', false, sizeOf(err && err.message ? err.message : 'error'));
      return 1;
    }
    if (tools.length < 1) {
      line('tools/list', false, sizeOf(tools));
      return 1;
    }
    line('tools/list', true, sizeOf(tools.map(t => t.name)));

    for (const tool of tools) {
      if (tool.name === WRITE_TOOL || !needsNoArgs(tool)) continue;
      if (tool.annotations && tool.annotations.readOnlyHint === false) continue;
      try {
        const result = await client.callTool({ name: tool.name, arguments: {} });
        const ok = result && result.isError !== true;
        if (!ok) failed = true;
        line(tool.name, ok, sizeOf(result));
      } catch (err) {
        failed = true;
        line(tool.name, false, sizeOf(err && err.message ? err.message : 'error'));
      }
    }

    try {
      const denied = await client.callTool({ name: WRITE_TOOL, arguments: WRITE_ARGS });
      const text = textOf(denied);
      const ok = denied && denied.isError === true && text.startsWith('Permission denied:');
      if (!ok) failed = true;
      line(WRITE_TOOL, ok, sizeOf({ isError: denied && denied.isError, bytes: Buffer.byteLength(text) }));
    } catch (err) {
      failed = true;
      line(WRITE_TOOL, false, sizeOf(err && err.message ? err.message : 'error'));
    }
  } finally {
    try { await client.close(); } catch { /* already closed */ }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
