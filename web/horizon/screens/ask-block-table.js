/* Horizon Ask blocks: the table renderer (docs/plans/rich-ask-answers.md section 2, Tables).
   A native <table> inside a focusable, labelled container that scrolls sideways on its own, the
   first column sticky. Column headers are the snapshot's labels, each a sort button inside
   <th scope="col"> with aria-sort. Tables with more than 8 rows get a labelled search filter;
   more than 20 rows show 20 and "Show all N rows". Numbers are right aligned figures.
   Sorting: a figure or row-number column by value, a text column alphabetically; unavailable
   values last in both directions; ties keep the snapshot order. The first press on a column sorts
   ascending, the next one flips it. The snapshot's sort is the starting order. */

const FILTER_AT = 8;
const PAGE = 20;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

function sortKey(cell) {
  if (!isObj(cell)) return null;
  if (cell.t === 'fig') return isObj(cell.fig) && cell.fig.value != null ? cell.fig.value : null;
  if (cell.t === 'row') return cell.value ?? null;
  // A text cell may carry its own sort key (a chart's x order, a timeline's ISO date).
  if (cell.t === 'text') return cell.sort ?? (typeof cell.text === 'string' ? cell.text : null);
  return null;
}

function compareKeys(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// The rows in display order for a sort { column, dir } (null: snapshot order).
export function sortRows(rows, sort) {
  const list = rows.map((r, i) => ({ r, i }));
  if (!sort || !Number.isInteger(sort.column)) return list.map((x) => x.r);
  const sign = sort.dir === 'desc' ? -1 : 1;
  list.sort((x, y) => {
    const a = sortKey(arr(x.r.cells)[sort.column]);
    const b = sortKey(arr(y.r.cells)[sort.column]);
    if (a === null || b === null) return (a === null) - (b === null) || x.i - y.i;
    return sign * compareKeys(a, b) || x.i - y.i;
  });
  return list.map((x) => x.r);
}

// The text a filter matches: text cells and a row number's description and account.
function rowText(r) {
  return arr(r.cells).map((c) => (!isObj(c) ? '' : c.t === 'text' ? c.text : c.t === 'row' && isObj(c.row) ? `${c.row.description || ''} ${c.row.account || ''}` : ''))
    .join(' ').toLowerCase();
}

export function filterRows(rows, filter) {
  const q = String(filter || '').trim().toLowerCase();
  return q ? rows.filter((r) => rowText(r).includes(q)) : rows;
}

const sortOf = (snapshot, state) => state.sort || (isObj(snapshot.sort) && Number.isInteger(snapshot.sort.column) ? snapshot.sort : null);

function cellHtml(c, ctx) {
  if (!isObj(c)) return '';
  if (c.t === 'text') return ctx.esc(c.text);
  if (c.t === 'fig' || c.t === 'row' || (c.t === 'none' && c.fig)) return ctx.fig(c);
  if (c.t === 'none') return '<span class="h-blk-na">Unavailable</span>';
  return '';
}

export function render(snapshot, ctx) {
  const { esc, state } = ctx;
  const cols = arr(snapshot.columns);
  const all = arr(snapshot.rows).filter(isObj);
  const sort = sortOf(snapshot, state);
  const shown = filterRows(sortRows(all, sort), state.filter);
  const rows = state.all ? shown : shown.slice(0, PAGE);
  const fid = `h-blk-f-${ctx.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const filter = all.length > FILTER_AT
    ? `<div class="h-blk-filter"><label for="${esc(fid)}">Filter rows</label><input type="search" id="${esc(fid)}" autocomplete="off" value="${esc(state.filter || '')}" data-blk-ctl="${esc(ctx.ctl('filter'))}"></div>`
    : '';
  const head = cols.map((c, i) => {
    const on = sort && sort.column === i;
    const aria = on ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none';
    const num = c.type !== 'text';
    return `<th scope="col" aria-sort="${aria}"${num ? ' class="n"' : ''}><button type="button" class="h-blk-sort" data-blk-ctl="${esc(ctx.ctl(`sort-${i}`))}">${esc(c.label)}<i aria-hidden="true">${on ? (sort.dir === 'desc' ? '↓' : '↑') : ''}</i></button></th>`;
  }).join('');
  const body = rows.map((r) => `<tr>${cols.map((c, i) => {
    const num = c.type !== 'text';
    return `<td${num ? ' class="n"' : ''}>${cellHtml(arr(r.cells)[i], ctx)}</td>`;
  }).join('')}</tr>`).join('');
  const empty = !rows.length ? `<p class="h-blk-empty">No rows match.</p>` : '';
  const more = !state.all && shown.length > PAGE
    ? `<button type="button" class="h-btn ghost h-blk-more" data-blk-ctl="${esc(ctx.ctl('all'))}">Show all ${shown.length} rows</button>`
    : '';
  return `${filter}<div class="h-blk-tw" tabindex="0" role="region" aria-label="${esc(snapshot.title || '')}">`
    + `<table class="h-blk-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${empty}${more}`;
}

export function bind(root, snapshot, ctx) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button[data-blk-ctl]');
    if (!b || !root.contains(b)) return;
    const name = b.getAttribute('data-blk-ctl').split(':').pop();
    const st = ctx.state;
    if (name === 'all') {
      st.all = true;
    } else if (name.startsWith('sort-')) {
      const column = Number(name.slice(5));
      const cur = sortOf(snapshot, st);
      st.sort = { column, dir: cur && cur.column === column && cur.dir === 'asc' ? 'desc' : 'asc' };
    } else return;
    e.preventDefault();
    ctx.redraw();
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches('input[type="search"][data-blk-ctl]')) return;
    ctx.state.filter = t.value;
    ctx.redraw();
  });
}
