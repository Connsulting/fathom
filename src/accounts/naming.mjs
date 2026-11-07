// Holder and household context for account labels. Every surface that names an account reads
// through here, so a known kind does not keep a legal name on one screen and drop it on another.

import { parseJson } from '../store/db.mjs';
import { accountLabel, duplicateMasks, sourceLabel, trendLabel } from '../shared/account-label.mjs';
import { lastFour } from '../ingest/account-match.mjs';

export function accountNaming(db) {
  const householdNames = parseJson(db.prepare("SELECT value FROM facts WHERE key = 'household.names'").get()?.value, {}) || {};
  const holders = new Map(db.prepare('SELECT account_id, holder FROM account_holders').all().map((r) => [r.account_id, r.holder]));
  // A connected account's mask is shown only when the bridge is sure of it (or its name ends with
  // the same digits), the rule detectAccountPairs uses; otherwise labels leave it out.
  const unsure = new Set();
  for (const r of db.prepare(`SELECT m.account_id, a.mask, s.snapshot FROM simplefin_accounts m JOIN simplefin_snapshots s ON s.sf_key = m.sf_key
      JOIN accounts a ON a.id = m.account_id WHERE m.status = 'mapped' AND a.identity LIKE 'simplefin:%'`).all()) {
    const snap = parseJson(r.snapshot, {}) || {};
    const shown = r.mask;
    if (!(snap.maskSure === true && snap.mask === shown) && lastFour(snap.name) !== shown) unsure.add(r.account_id);
  }
  const byId = new Map();
  for (const a of db.prepare('SELECT * FROM accounts').all()) {
    byId.set(a.id, { ...a, householdNames, holder: holders.get(a.id) || null, ...(unsure.has(a.id) ? { maskSure: false } : {}) });
  }
  // An account shows its last 4 only when another account of the household has the same name.
  for (const [id, labelMask] of duplicateMasks([...byId.values()])) byId.get(id).labelMask = labelMask;
  // What a row from another query needs to be named like the rest of the household.
  const hint = (id) => {
    const a = byId.get(id);
    return a ? { ...(a.maskSure === false ? { maskSure: false } : {}), ...(a.labelMask ? { labelMask: a.labelMask } : {}) } : {};
  };
  return { householdNames, holders, byId, hint, label: (row) => accountLabel({ ...row, ...hint(row?.id) }) };
}

// Account rows from any query, carrying the hints that keep their label the household's label.
export function withLabelHints(db, rows) {
  const naming = accountNaming(db);
  return rows.map((a) => ({ ...a, ...naming.hint(a.id) }));
}

const seriesKeyOf = (id) => {
  const safe = String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
  return safe.startsWith('acct-') ? safe : `acct-${safe}`;
};

// Rewrite labels that were stored at plan time. The figure value is unchanged.
export function relabelStoredFigure(naming, row) {
  const out = { ...row };
  const bal = /^bal\.(.+)$/.exec(String(row.key || ''));
  if (bal && naming.byId.has(bal[1])) out.label = `Balance, ${accountLabel(naming.byId.get(bal[1]))}`;
  const series = /^series\.(.+)\.\d+$/.exec(String(row.key || ''));
  if (series) {
    const account = [...naming.byId.values()].find((a) => seriesKeyOf(a.id) === series[1]);
    if (account) {
      const tail = String(row.label || '').split(', ').slice(1).join(', ');
      const head = trendLabel(account);
      out.label = tail ? `${head}, ${tail}` : head;
    }
  }
  const srcId = String(row.src || '');
  if (srcId.startsWith('acct:') && naming.byId.has(srcId.slice(5))) out.src_label = sourceLabel(naming.byId.get(srcId.slice(5)));
  return out;
}

export function applyNaming(db, { series, src, fig } = {}) {
  const naming = accountNaming(db);
  for (const row of naming.byId.values()) {
    const key = seriesKeyOf(row.id);
    if (series && series[key] && typeof series[key] === 'object') series[key].label = trendLabel(row);
    if (src && src[`acct:${row.id}`]) src[`acct:${row.id}`].label = sourceLabel(row);
    if (fig && fig[`bal.${row.id}`]) fig[`bal.${row.id}`].label = `Balance, ${accountLabel(row)}`;
  }
  if (fig) {
    for (const [key, value] of Object.entries(fig)) {
      if (!value || typeof value !== 'object') continue;
      const next = relabelStoredFigure(naming, { key, label: value.label, src: value.src, src_label: value.src });
      if (next.label && next.label !== value.label) value.label = next.label;
    }
  }
  return naming;
}
