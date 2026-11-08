const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

function cellHtml(c, ctx) {
  if (!isObj(c)) return '<span class="h-blk-na">Unavailable</span>';
  // A transaction description shows its readable name, with the raw bank text on hover.
  if (c.t === 'text') return typeof c.name === 'string' && c.name && c.name !== c.text
    ? `<span title="${ctx.esc(c.text)}">${ctx.esc(c.name)}</span>` : ctx.esc(c.text);
  if (c.t === 'fig' || c.t === 'row' || (c.t === 'none' && c.fig)) return ctx.fig(c);
  return '<span class="h-blk-na">Unavailable</span>';
}

export function render(snapshot, ctx) {
  const { esc } = ctx;
  const fields = arr(snapshot.fields).filter(isObj);
  const options = arr(snapshot.options).filter(isObj);
  const base = `h-blk-o-${ctx.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const api = typeof window !== 'undefined' ? window.Fathom?.api : null;
  const action = snapshot.action;
  const game = action?.kind === 'wargame' ? api?.s?.wargame?.[action.name] : null;
  const liveOptions = arr(game?.points || game?.options);
  const picked = liveOptions[api?.s?.live?.picks?.[action?.name]]?.id;
  const canPick = ['open', 'upcoming'].includes(game?.status);
  const decision = arr(api?.s?.decisions).find(d => d.id === action?.decisionId);
  const pickedOption = options.find(o => o.id === picked);
  const cards = options.map((o, i) => {
    const hid = `${base}-${i}`;
    const rows = fields.map((f, j) => `<div class="h-blk-cf"><dt>${esc(f.label)}</dt><dd>${cellHtml(arr(o.cells)[j], ctx)}</dd></div>`).join('');
    return `<section class="h-blk-opt" role="group" aria-labelledby="${esc(hid)}"><h4 id="${esc(hid)}">${esc(o.label)}</h4>${picked === o.id ? '<p>Picked</p>' : ''}<dl>${rows}</dl>${canPick ? `<button type="button" class="h-btn" data-block-pick="${i}" data-blk-ctl="${esc(ctx.ctl('pick-' + i))}" aria-label="Pick this: ${esc(o.label)}">Pick this</button>` : ''}</section>`;
  }).join('');
  return `<div class="h-blk-cmp${options.length <= 4 ? ' cols' : ''}">${cards}</div>${canPick ? `<p class="h-mute">Picking marks your choice. Deciding saves it as your plan’s assumption.</p>` : ''}${game?.status === 'open' && decision?.status === 'open' && pickedOption ? `<button type="button" class="h-btn" data-block-decide data-blk-ctl="${esc(ctx.ctl('decide'))}">Decide on ${esc(pickedOption.label)}</button>` : ''}`;
}

export function bind(root) {
  root.addEventListener('click', e => {
    const button = e.target.closest('[data-block-pick],[data-block-decide]');
    if (!button || !root.contains(button)) return;
    e.preventDefault();
    const api = window.Fathom?.api;
    const [messageId, blockId] = root.dataset.blk.split(':');
    const key = Object.keys(api?.s?.live?.conversations || {}).find(k => k.startsWith('ask:') && api.s.live.conversations[k].some(m => m.id === messageId));
    if (!key || !api.blockAct) return;
    const ctl = button.dataset.blkCtl;
    button.disabled = true;
    const body = button.hasAttribute('data-block-pick') ? { action: 'pick', option: Number(button.dataset.blockPick) } : { action: 'decide' };
    Promise.resolve(api.blockAct(key.slice(4), messageId, blockId, body)).finally(() => {
      if (button.isConnected) button.disabled = false;
      document.querySelector(`[data-blk-ctl="${CSS.escape(ctl)}"]`)?.focus({ preventScroll: true });
    });
  });
}
