// Money formatting and scenario token resolution shared by the server and the browser
// (served at /shared/tokens.mjs). Browser safe: no node imports.
//
// Tokens: {f:key} and {fk:key} figure money, {l:key} statutory money, {p:key} percent,
// {n:key} name. resolveTokens leaves literal markup in the input alone and escapes only what a
// token resolves to. Escaped braces (&#123; &#125;) are not tokens. A figure with `unavailable`
// (kept only for reference) is marked: data-unavailable="1" in HTML, " (not current)" in plain text.

export const TOKEN = /\{(fk|f|l|p|n):([^{}\s:]+)\}/g;

export const KIND_WORDS = Object.freeze({
  a: 'Actual, from a mirrored account',
  p: 'Projected from the plan',
  e: 'Estimate',
  m: 'Model output',
  t: 'A target you set',
});

export const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const trimZeros = s => (s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const commas = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// $44,854 ; opts.k -> $45K, $2.38M ; opts.sign -> +$1,700 ; opts.cents -> $0.02, $1,234.50
export function money(n, opts) {
  const o = opts || {};
  n = Number(n);
  if (!isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  let body;
  if (o.k) {
    if (a >= 999500) body = '$' + trimZeros((a / 1e6).toFixed(2)) + 'M';
    else if (a >= 1e3) body = '$' + trimZeros((a / 1e3).toFixed(a >= 1e4 ? 0 : 1)) + 'K';
    else body = '$' + Math.round(a);
  } else if (o.cents) {
    const [w, f] = a.toFixed(2).split('.');
    body = '$' + commas(w) + '.' + f;
  } else {
    body = '$' + commas(Math.round(a));
  }
  const zero = /^\$0(\.0+)?[KM]?$/.test(body);
  const sign = n < 0 && !zero ? '-' : (o.sign && n > 0 ? '+' : '');
  return sign + body;
}

export function pct(v) {
  return trimZeros(Number(v).toFixed(2)) + '%';
}

// Resolve tokens in `input` against `scenario` ({fig, law, pct, names}). asHtml wraps figures in
// .fx-fig spans and statutory amounts in .fx-law spans; plain text otherwise. Unknown keys render
// as [?key] and call opts.onMissing(message) when given.
export function resolveTokens(scenario, input, asHtml, opts) {
  if (input == null) return '';
  const str = typeof input === 'string' ? input : String(input);
  if (str.indexOf('{') < 0) return str;
  const S = scenario || {};
  const missing = msg => { if (opts && typeof opts.onMissing === 'function') opts.onMissing(msg); };
  return str.replace(TOKEN, (m, type, key) => {
    if (type === 'f' || type === 'fk') {
      const f = S.fig ? S.fig[key] : null;
      if (!f || typeof f.v !== 'number') { missing('missing figure ' + key); return '[?' + key + ']'; }
      const text = money(f.v, { k: type === 'fk' });
      // A figure kept only for reference (f.unavailable) never reads as current.
      if (!asHtml) return f.unavailable ? text + ' (not current)' : text;
      const kind = f.kind in KIND_WORDS ? f.kind : 'e';
      return '<span class="fx-fig" data-fig="' + esc(key) + '" data-kind="' + kind + '"' + (f.unavailable ? ' data-unavailable="1"' : '') + ' tabindex="0">' + text + '</span>';
    }
    if (type === 'l') {
      const v = S.law ? S.law[key] : undefined;
      if (typeof v !== 'number') { missing('missing law ' + key); return '[?' + key + ']'; }
      const text = money(v);
      return asHtml ? '<span class="fx-law">' + text + '</span>' : text;
    }
    if (type === 'p') {
      const v = S.pct ? S.pct[key] : undefined;
      if (typeof v !== 'number') { missing('missing pct ' + key); return '[?' + key + ']'; }
      return pct(v);
    }
    const v = S.names ? S.names[key] : undefined;
    if (v == null) { missing('missing name ' + key); return '[?' + key + ']'; }
    return asHtml ? esc(v) : String(v);
  });
}

// User free text made safe to store as message HTML: escaped, and braces escaped so it can never
// carry a scenario token.
export function escapeUserText(text) {
  return esc(text).replace(/'/g, '&#39;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}
