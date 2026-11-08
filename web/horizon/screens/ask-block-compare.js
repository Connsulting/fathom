/* Horizon Ask blocks: the compare renderer (docs/plans/rich-ask-answers.md section 2, Compare).
   Each option is a group (<section role="group">) headed by its label from the snapshot, listing
   every field's label and figure. With at most 4 options the block sits options side by side once
   it is at least 560px wide (a container query in ask.css); otherwise, and always with more
   options, the options are stacked cards. Renderer-bound war-game actions (Pick this, Decide) and
   the picked state arrive with B6. */

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

function cellHtml(c, ctx) {
  if (!isObj(c)) return '<span class="h-blk-na">Unavailable</span>';
  if (c.t === 'text') return ctx.esc(c.text);
  if (c.t === 'fig' || c.t === 'row' || (c.t === 'none' && c.fig)) return ctx.fig(c);
  return '<span class="h-blk-na">Unavailable</span>';
}

export function render(snapshot, ctx) {
  const { esc } = ctx;
  const fields = arr(snapshot.fields).filter(isObj);
  const options = arr(snapshot.options).filter(isObj);
  const base = `h-blk-o-${ctx.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const cards = options.map((o, i) => {
    const hid = `${base}-${i}`;
    const rows = fields.map((f, j) => `<div class="h-blk-cf"><dt>${esc(f.label)}</dt><dd>${cellHtml(arr(o.cells)[j], ctx)}</dd></div>`).join('');
    return `<section class="h-blk-opt" role="group" aria-labelledby="${esc(hid)}"><h4 id="${esc(hid)}">${esc(o.label)}</h4><dl>${rows}</dl></section>`;
  }).join('');
  return `<div class="h-blk-cmp${options.length <= 4 ? ' cols' : ''}">${cards}</div>`;
}

export function bind() {}
