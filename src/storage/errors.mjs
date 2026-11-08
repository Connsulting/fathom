export function storageError(code = 'storage_invalid') {
  return Object.assign(new Error(code), { code });
}

export function sqliteError(error) {
  const code = error?.errcode;
  if ([1555, 2067, 2579].includes(code)) return storageError('constraint_unique');
  if (code === 787) return storageError('constraint_foreign_key');
  if ([275, 1299].includes(code)) return storageError('constraint_check');
  if ([5, 6].includes(code & 255)) return storageError('storage_busy');
  if ([8, 10, 11, 13, 14, 26].includes(code & 255)) return storageError('storage_unavailable');
  return storageError();
}
