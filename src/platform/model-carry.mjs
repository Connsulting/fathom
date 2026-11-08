// The instance-wide carry of pre-MT-05 model spend into the platform ledger.
//
// carryAllHouseholds(platform, { dataDir, now }) records, for the funding month of `now`, the carry
// row (ensureCarry) of every non-deleted household with a storage root (active, suspended and
// provisioning alike), so the instance cap sees every household's pre-MT-05 spend before any live
// admission or budget change, whichever process (server, CLI, operator command) opens the instance
// first. A household's pre-MT-05 spend is the month's spend_ledger rows with no round_id, read from
// its store opened read-only (never migrated or written) after the household-root containment
// check and a store identity check. A zero carry is left to the first reserve. A store that cannot
// be read refuses with code household_store_unavailable; carries already recorded stay (each is
// idempotent). Writes only platform.sqlite.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../store/db.mjs';
import { codeError, storeIdentity } from './db.mjs';
import { checkHouseholdRoot } from './runtime.mjs';
import { ensureCarry, fundingMonth } from './model-budget.mjs';

const unavailable = () => codeError('household_store_unavailable');

// The month's pre-MT-05 spend in a household store, opened read-only.
function legacySpendUsd(dataDir, householdId, storageRoot, month) {
  const file = join(checkHouseholdRoot(dataDir, storageRoot), DB_FILE);
  if (!existsSync(file)) throw unavailable();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA query_only = ON');
    if (storeIdentity(db)?.householdId !== householdId) throw unavailable();
    // A store not yet migrated to round_id holds only pre-MT-05 rows.
    const mirrored = db.prepare('PRAGMA table_info(spend_ledger)').all().some(c => c.name === 'round_id');
    const s = Number(db.prepare(`SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE yyyymm = ?${mirrored ? ' AND round_id IS NULL' : ''}`)
      .get(month).s);
    if (!Number.isFinite(s) || s < 0) throw unavailable();
    return s;
  } finally {
    db.close();
  }
}

export function carryAllHouseholds(platform, { dataDir, now = Date.now() } = {}) {
  if (!platform || typeof dataDir !== 'string' || !dataDir || !Number.isFinite(now)) throw new TypeError('Invalid carry');
  const month = fundingMonth(now);
  const rows = platform.prepare("SELECT id, storage_root FROM households WHERE status != 'deleted' AND storage_root IS NOT NULL ORDER BY created_at, id").all();
  for (const { id, storage_root: storageRoot } of rows) {
    let legacy;
    try {
      legacy = legacySpendUsd(dataDir, id, storageRoot, month);
    } catch {
      throw unavailable();
    }
    if (legacy > 0) ensureCarry(platform, { householdId: id, month, legacySpendUsd: legacy, now });
  }
}
