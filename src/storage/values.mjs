import { storageError } from './errors.mjs';

function scalar(value) {
  if (value === null) return value;
  if (typeof value === 'string' && !value.includes('\0')) return value;
  if (typeof value === 'number' && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw storageError();
}

export function bindings(values) {
  return values.map(scalar);
}

export function safeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw storageError();
  return number;
}

export function row(value) {
  if (value === undefined) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, typeof item === 'bigint' ? safeInteger(item) : scalar(item),
  ]));
}
