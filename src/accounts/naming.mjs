// Holder and household context for account labels. Every surface that names an account reads
// through here, so a known kind does not keep a legal name on one screen and drop it on another.

import { parseJson } from '../store/db.mjs';
import { accountLabel, sourceLabel, trendLabel } from '../shared/account-label.mjs';

export function accountNaming(db) {
  const householdNames = parseJson(db.prepare("SELECT value FROM facts WHERE key = 'household.names'").get()?.value, {}) || {};
  const holders = new Map(db.prepare('SELECT account_id, holder FROM account_holders').all().map((r) => [r.account_id, r.holder]));
  const byId = new Map();
  for (const a of db.prepare('SELECT * FROM accounts').all()) {
    byId.set(a.id, { ...a, householdNames, holder: holders.get(a.id) || null });
  }
  return { householdNames, holders, byId };
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
