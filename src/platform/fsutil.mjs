// Durable file helpers for the offline platform tools. Errors carry no path or content.

import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// fsync the directory holding `file` so a rename or link into it is durable.
export function fsyncDir(file) {
  const fd = openSync(dirname(file), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function fsyncFile(file) {
  const fd = openSync(file, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Write `data` to `file` through a temporary sibling: write, fsync, rename, fsync the directory.
export function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeAll(fd, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(file);
}

// Write all of `buf` to an open descriptor.
export function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}
