// AC1: POST /api/files takes a multipart upload of many files, imports each, and answers with
// per-file results and the fresh scenario. Uploads are guarded (content type, origin, size),
// real mode needs a data key file, nothing from the files reaches the logs, and scripts/dump.mjs
// pushes a directory through the same route printing statuses only.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { src, spawnServer, request, postJson, runCommand, tempDir, freePort, SERVER_TIMEOUT } from '../helpers/server.mjs';
import { fixturePath, aggregatorCsv } from '../helpers/ingest.mjs';

const T = { timeout: SERVER_TIMEOUT * 2 };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Distinctive synthetic values that must never appear in server logs or script output.
const CANARY_DESC = 'ZEPHYR-CANARY-DESC-7731';
const CANARY_AMOUNT = '8642.97';
const CANARY_ACCOUNT = '4455667788';
const CANARY_MEMO = 'QUOKKA-CANARY-MEMO';
const canaryCsv = () => aggregatorCsv([{ date: '2032-03-09', amount: CANARY_AMOUNT, description: CANARY_DESC, number: CANARY_ACCOUNT, account: 'Canary checking' }]);
const novelCsv = () => `when,memo,value\n2032-03-02,${CANARY_MEMO},-3.33\n2032-03-03,${CANARY_MEMO} B,-4.44\n`;
const CANARIES = [CANARY_DESC, CANARY_AMOUNT, CANARY_ACCOUNT, CANARY_MEMO, 'EXAMPLE SHOP', 'Example Fund', '9911227766'];

const fx = (name) => readFileSync(fixturePath(name));

function form(files, extra = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('files', new Blob([f.bytes], { type: f.type || 'application/octet-stream' }), f.name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

async function upload(baseUrl, files, extra) {
  const res = await fetch(`${baseUrl}/api/files`, { method: 'POST', body: form(files, extra) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

// A multipart body built by hand, so file names and sizes are exactly what the test says.
function multipart(parts, boundary = 'fathom-test-boundary-0123') {
  const chunks = [];
  for (const p of parts) {
    const disp = p.filename == null ? `form-data; name="${p.field}"` : `form-data; name="${p.field}"; filename="${p.filename}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n`));
    chunks.push(Buffer.from(p.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// A request-like readable stream with headers, for readMultipart and guardUpload.
function fakeReq(body, contentType, { declared = true, headers = {} } = {}) {
  const pieces = [];
  for (let i = 0; i < body.length; i += 1024) pieces.push(body.subarray(i, i + 1024));
  const req = Readable.from(pieces);
  req.headers = { 'content-type': contentType, host: '127.0.0.1:8080', ...(declared ? { 'content-length': String(body.length) } : {}), ...headers };
  req.method = 'POST';
  return req;
}

const status = (code, notIncluded = []) => (err) => {
  assert.equal(err && err.status, code, `status ${code}, got ${err && err.status}: ${err && err.message}`);
  for (const s of notIncluded) assert.ok(!String(err.message).includes(s), 'error message carries no file contents');
  return true;
};

describe('readMultipart and guardUpload', () => {
  let U;
  before(async () => { U = await src('src/api/upload.mjs'); });

  test('limits are 50 MB per file and 200 MB per request', () => {
    assert.equal(U.UPLOAD_FILE_LIMIT, 50 * 1024 * 1024);
    assert.equal(U.UPLOAD_REQUEST_LIMIT, 200 * 1024 * 1024);
  });

  test('returns the file parts with base names, types and bytes; text fields are ignored', async () => {
    const a = randomBytes(700);
    const { body, contentType } = multipart([
      { field: 'files', filename: 'dir/sub/first.csv', type: 'text/csv', data: a },
      { field: 'note', data: 'not a file' },
      { field: 'files', filename: 'C:\\exports\\second.xlsx', type: XLSX, data: 'second' },
    ]);
    const parts = await U.readMultipart(fakeReq(body, contentType), { fileLimit: 1024, requestLimit: 4096 });
    assert.equal(parts.length, 2);
    assert.deepEqual(parts.map((p) => [p.field, p.name, p.mime]), [['files', 'first.csv', 'text/csv'], ['files', 'second.xlsx', XLSX]]);
    assert.ok(Buffer.from(parts[0].bytes).equals(a));
    assert.equal(Buffer.from(parts[1].bytes).toString(), 'second');
  });

  test('a long file name is cut to 255 characters', async () => {
    const { body, contentType } = multipart([{ field: 'files', filename: `${'n'.repeat(300)}.csv`, type: 'text/csv', data: 'x' }]);
    const [part] = await U.readMultipart(fakeReq(body, contentType), { fileLimit: 1024, requestLimit: 4096 });
    assert.ok(part.name.length > 0 && part.name.length <= 255);
  });

  test('a file over the file limit is 413 and the message names no contents; under the limit passes', async () => {
    const big = Buffer.from('SECRET-CELL-'.repeat(200));
    const over = multipart([{ field: 'files', filename: 'big.csv', type: 'text/csv', data: big }]);
    await assert.rejects(async () => U.readMultipart(fakeReq(over.body, over.contentType), { fileLimit: 1024, requestLimit: 1024 * 1024 }), status(413, ['SECRET-CELL']));
    const under = multipart([{ field: 'files', filename: 'small.csv', type: 'text/csv', data: big.subarray(0, 1000) }]);
    assert.equal((await U.readMultipart(fakeReq(under.body, under.contentType), { fileLimit: 1024, requestLimit: 1024 * 1024 })).length, 1);
  });

  test('a request over the request limit is 413, declared or streamed', async () => {
    const { body, contentType } = multipart([
      { field: 'files', filename: 'a.csv', type: 'text/csv', data: randomBytes(900) },
      { field: 'files', filename: 'b.csv', type: 'text/csv', data: randomBytes(900) },
    ]);
    await assert.rejects(async () => U.readMultipart(fakeReq(body, contentType), { fileLimit: 1024, requestLimit: 1500 }), status(413));
    await assert.rejects(async () => U.readMultipart(fakeReq(body, contentType, { declared: false }), { fileLimit: 1024, requestLimit: 1500 }), status(413));
    assert.equal((await U.readMultipart(fakeReq(body, contentType, { declared: false }), { fileLimit: 1024, requestLimit: 4096 })).length, 2);
  });

  test('a malformed body or a body with no files is 400', async () => {
    await assert.rejects(async () => U.readMultipart(fakeReq(Buffer.from('this is not multipart at all'), 'multipart/form-data; boundary=fathom-test-boundary-0123'), { fileLimit: 1024, requestLimit: 4096 }), status(400));
    const noFiles = multipart([{ field: 'note', data: 'only a field' }]);
    await assert.rejects(async () => U.readMultipart(fakeReq(noFiles.body, noFiles.contentType), { fileLimit: 1024, requestLimit: 4096 }), status(400));
  });

  test('guardUpload: multipart with a boundary and same or no origin passes; otherwise 415 or 403', () => {
    const ok = 'multipart/form-data; boundary=abc';
    assert.doesNotThrow(() => U.guardUpload(fakeReq(Buffer.alloc(0), ok)));
    assert.doesNotThrow(() => U.guardUpload(fakeReq(Buffer.alloc(0), ok, { headers: { origin: 'http://127.0.0.1:8080' } })));
    assert.throws(() => U.guardUpload(fakeReq(Buffer.alloc(0), 'application/json')), status(415));
    assert.throws(() => U.guardUpload(fakeReq(Buffer.alloc(0), 'multipart/form-data')), status(415));
    assert.throws(() => U.guardUpload(fakeReq(Buffer.alloc(0), ok, { headers: { origin: 'http://evil.example' } })), status(403));
  });
});

// POST with a declared Content-Length over the request cap, sending only a few bytes: the server
// must answer 413 from the headers alone.
function declaredOver(baseUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    let answered = false;
    const req = http.request({
      host: url.hostname, port: url.port, method: 'POST', path: '/api/files',
      headers: { 'content-type': 'multipart/form-data; boundary=fathom-big', 'content-length': String(200 * 1024 * 1024 + 1) },
    }, (res) => {
      answered = true;
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, text }); });
    });
    const timer = setTimeout(() => { req.destroy(); if (!answered) reject(new Error('no response to an oversized declared upload')); }, 10000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (e) => { if (!answered) reject(e); });
    req.write('--fathom-big\r\n');
  });
}

describe('POST /api/files on a demo server', () => {
  let s;
  before(async () => { s = await spawnServer({ env: { FATHOM_DEMO: '1', FATHOM_ENGINE: 'fake' } }); }, T);
  after(async () => {
    if (!s) return;
    await s.stop();
    rmSync(s.dataDir, { recursive: true, force: true });
  });

  test('several fixtures in one request: per-file results, pending count and the scenario', T, async () => {
    const files = [
      { name: 'aggregator.csv', bytes: fx('aggregator.csv'), type: 'text/csv' },
      { name: 'positions.csv', bytes: fx('positions.csv'), type: 'text/csv' },
      { name: 'business-pnl.xlsx', bytes: fx('business-pnl.xlsx'), type: XLSX },
      { name: 'tax-payments.xlsx', bytes: fx('tax-payments.xlsx'), type: XLSX },
    ];
    const r = await upload(s.baseUrl, files);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual(r.json.files.map((f) => [f.name, f.status, f.parser]), [
      ['aggregator.csv', 'imported', 'aggregator'],
      ['positions.csv', 'imported', 'brokerage-positions'],
      ['business-pnl.xlsx', 'imported', 'pnl-workbook'],
      ['tax-payments.xlsx', 'imported', 'tax-payments'],
    ]);
    assert.equal(r.json.files[0].counts.rows.transaction, 2);
    assert.equal(r.json.files[1].counts.rows.position, 2);
    assert.equal(r.json.files[2].counts.rows.pnl_line, 3);
    assert.equal(r.json.files[3].counts.rows.tax_payment, 10);
    assert.ok(r.json.scenario && r.json.scenario.meta, 'carries the scenario');
    assert.equal(r.json.pending, r.json.scenario.live.ingest.pending);
    assert.ok(r.json.pending >= 3, 'owner, kind and tax-year questions');
    const manual = r.json.scenario.accounts.filter((a) => a.mirror === 'manual' && ['7766', '5544'].includes(a.mask));
    assert.equal(manual.length, 2);

    for (const f of r.json.files) {
      const bin = join(s.dataDir, 'files', `${f.fileId}.bin`);
      assert.ok(existsSync(bin), `${f.name} stored`);
    }
    assert.ok(!readFileSync(join(s.dataDir, 'files', `${r.json.files[0].fileId}.bin`)).includes(Buffer.from('EXAMPLE SHOP')));
    assert.equal(statSync(join(s.dataDir, 'files', 'demo.key')).mode & 0o777, 0o600);

    const list = await request(s.baseUrl, { path: '/api/files' });
    assert.equal(list.status, 200);
    const listed = list.json.files.find((f) => f.id === r.json.files[0].fileId);
    assert.ok(listed);
    assert.equal(listed.name, 'aggregator.csv');
    assert.equal(listed.status, 'imported');
    assert.equal(listed.sourceKind, 'aggregator_csv');
    assert.equal(listed.parser, 'aggregator');
    assert.equal(listed.counts.rows.transaction, 2);
    assert.equal(typeof listed.uploadedAt, 'string');
  });

  test('same bytes twice in one request: second is a duplicate; same name, other bytes: both stored', T, async () => {
    const a = { name: 'canary.csv', bytes: Buffer.from(canaryCsv()), type: 'text/csv' };
    const b = { name: 'canary.csv', bytes: Buffer.from(aggregatorCsv([{ date: '2032-03-11', amount: '1.11', description: 'Synthetic other', number: '1212343456' }])), type: 'text/csv' };
    const r = await upload(s.baseUrl, [a, a, b]);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual(r.json.files.map((f) => f.status), ['imported', 'duplicate', 'imported']);
    assert.equal(r.json.files[1].duplicateOf, r.json.files[0].fileId);
    assert.notEqual(r.json.files[2].fileId, r.json.files[0].fileId);
  });

  test('an unknown CSV waits for a mapping; retry answers for waiting files only', T, async () => {
    const r = await upload(s.baseUrl, [{ name: 'novel.csv', bytes: Buffer.from(novelCsv()), type: 'text/csv' }]);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const f = r.json.files[0];
    assert.equal(f.status, 'needs_mapping');
    const retry = await postJson(s.baseUrl, `/api/files/${f.fileId}/retry`, {});
    assert.equal(retry.status, 200, retry.text.slice(0, 300));
    assert.equal(retry.json.file.fileId, f.fileId);
    assert.ok(retry.json.scenario);
    const list = await request(s.baseUrl, { path: '/api/files' });
    const imported = list.json.files.find((x) => x.status === 'imported');
    assert.equal((await postJson(s.baseUrl, `/api/files/${imported.id}/retry`, {})).status, 409);
    assert.equal((await postJson(s.baseUrl, '/api/files/f-000000000000000000000000/retry', {})).status, 404);
  });

  test('an empty upload is 400; a zero-byte file and a corrupt workbook are unsupported', T, async () => {
    const empty = await upload(s.baseUrl, [], { note: 'no files here' });
    assert.equal(empty.status, 400);
    const r = await upload(s.baseUrl, [
      { name: 'zero.csv', bytes: Buffer.alloc(0), type: 'text/csv' },
      { name: 'corrupt-archive.xlsx', bytes: fx('corrupt-archive.xlsx'), type: XLSX },
    ]);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual(r.json.files.map((f) => f.status), ['unsupported', 'unsupported']);
  });

  test('wrong content type is 415; cross-origin is 403; same-origin passes', T, async () => {
    const json = await postJson(s.baseUrl, '/api/files', { files: [] });
    assert.equal(json.status, 415);
    const { body, contentType } = multipart([{ field: 'files', filename: 'origin.csv', type: 'text/csv', data: aggregatorCsv([{ date: '2032-03-12', amount: '2.22', description: 'Synthetic origin row', number: '9090909090' }]) }]);
    const plain = await request(s.baseUrl, { method: 'POST', path: '/api/files', headers: { 'content-type': 'text/plain' }, body });
    assert.equal(plain.status, 415);
    const cross = await request(s.baseUrl, { method: 'POST', path: '/api/files', headers: { 'content-type': contentType, origin: 'http://evil.example' }, body });
    assert.equal(cross.status, 403);
    const same = await request(s.baseUrl, { method: 'POST', path: '/api/files', headers: { 'content-type': contentType, origin: s.baseUrl }, body });
    assert.equal(same.status, 200, same.text.slice(0, 300));
    assert.equal(same.json.files[0].status, 'imported');
  });

  test('a declared body over 200 MB is refused with 413 before it is read', T, async () => {
    const r = await declaredOver(s.baseUrl);
    assert.equal(r.status, 413);
    assert.equal((await request(s.baseUrl, { path: '/healthz' })).status, 200, 'server still healthy');
  });

  test('JSON routes keep the 64 KiB cap', T, async () => {
    const big = await postJson(s.baseUrl, '/api/engine', JSON.stringify({ on: true, pad: 'x'.repeat(64 * 1024) }));
    assert.equal(big.status, 413);
    assert.equal((await postJson(s.baseUrl, '/api/engine', { on: true })).status, 200);
  });

  test('scripts/dump.mjs uploads a directory, skips dotfiles and prints statuses only', T, async () => {
    const dir = await tempDir('fathom-dump-');
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'first-dump.csv'), aggregatorCsv([{ date: '2032-03-14', amount: '6420.13', description: 'DUMP-CANARY-ONE', number: '7070707070' }]));
      writeFileSync(join(dir, 'nested', 'second-dump.csv'), aggregatorCsv([{ date: '2032-03-15', amount: '5310.24', description: 'DUMP-CANARY-TWO', number: '6060606060' }]));
      writeFileSync(join(dir, '.hidden-dump.csv'), aggregatorCsv([{ date: '2032-03-16', amount: '4200.35', description: 'DUMP-CANARY-HIDDEN', number: '5050505050' }]));
      const out = await runCommand(process.execPath, ['scripts/dump.mjs', s.baseUrl, dir]);
      assert.equal(out.code, 0, out.stderr);
      const lines = out.stdout.split('\n').filter(Boolean);
      for (const name of ['first-dump.csv', 'second-dump.csv']) {
        const line = lines.find((l) => l.includes(name));
        assert.ok(line, `${name} reported`);
        assert.match(line, /\bimported\b/);
        assert.match(line, /dup=\d+/);
        assert.match(line, /warn=\d+/);
      }
      const all = out.stdout + out.stderr;
      assert.ok(!all.includes('.hidden-dump.csv'), 'dotfiles skipped');
      for (const v of ['DUMP-CANARY', '6420.13', '5310.24', '7070707070', '6060606060']) assert.ok(!all.includes(v), `${v} not printed`);
      const list = await request(s.baseUrl, { path: '/api/files' });
      const names = list.json.files.map((f) => f.name);
      assert.ok(names.includes('first-dump.csv') && names.includes('second-dump.csv'));
      assert.ok(!names.includes('.hidden-dump.csv'));

      const closed = await freePort();
      const fail = await runCommand(process.execPath, ['scripts/dump.mjs', `http://127.0.0.1:${closed}`, dir]);
      assert.equal(fail.code, 1, 'a failed request exits 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('server logs carry no cell values or file contents', () => {
    const log = s.output();
    for (const v of CANARIES) assert.ok(!log.includes(v), `${v} not in server output`);
    assert.ok(!log.includes('DUMP-CANARY'));
  });
});

describe('POST /api/files in real mode', () => {
  test('without FATHOM_DATA_KEY_FILE: 409 naming the variable, and nothing stored', T, async () => {
    const s = await spawnServer({ env: { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off' } });
    try {
      const r = await upload(s.baseUrl, [{ name: 'canary.csv', bytes: Buffer.from(canaryCsv()), type: 'text/csv' }]);
      assert.equal(r.status, 409);
      assert.match(r.json.error, /FATHOM_DATA_KEY_FILE/);
      const files = join(s.dataDir, 'files');
      assert.ok(!existsSync(files) || readdirSync(files).length === 0, 'nothing under files/');
      const list = await request(s.baseUrl, { path: '/api/files' });
      assert.equal(list.status, 200);
      assert.deepEqual(list.json.files, []);
      for (const v of CANARIES) assert.ok(!s.output().includes(v));
    } finally {
      await s.stop();
      rmSync(s.dataDir, { recursive: true, force: true });
    }
  });

  test('with a 32 byte key file: the upload imports and is stored encrypted', T, async () => {
    const keyDir = await tempDir('fathom-key-');
    const keyFile = join(keyDir, 'data.key');
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const s = await spawnServer({ env: { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_DATA_KEY_FILE: keyFile } });
    try {
      const r = await upload(s.baseUrl, [{ name: 'canary.csv', bytes: Buffer.from(canaryCsv()), type: 'text/csv' }]);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(r.json.files[0].status, 'imported');
      const blob = readFileSync(join(s.dataDir, 'files', `${r.json.files[0].fileId}.bin`));
      assert.equal(blob.subarray(0, 5).toString('latin1'), 'FTHM1');
      assert.ok(!blob.includes(Buffer.from(CANARY_DESC)));
      assert.ok(!existsSync(join(s.dataDir, 'files', 'demo.key')), 'real mode never generates a key');
      for (const v of CANARIES) assert.ok(!s.output().includes(v));
    } finally {
      await s.stop();
      rmSync(s.dataDir, { recursive: true, force: true });
      rmSync(keyDir, { recursive: true, force: true });
    }
  });
});
