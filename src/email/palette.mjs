// The one email palette and dark document shell. Every HTML email (brief, deadline alert, auth
// emails, test email) takes its colors and its outer HTML from here, so each renders dark in
// every mail client whatever the client's or device's own theme. Rules:
// 1. Colors are the Horizon dark tokens of web/horizon/design.css. Nothing here or in a caller
//    uses white or a light surface.
// 2. The shell declares dark only: both color-scheme metas, `color-scheme: dark` on the root, a
//    dark body (bgcolor attribute and inline) and a full width dark wrapper table so no light
//    gutter shows. Callers set every surface on their own tables and cells the same two ways and
//    put the text color inline on every element, since Gmail drops much of head CSS.
// 3. No scenario, store, config or auth imports: the invite CLI loads this through auth/mail.mjs
//    and stays light.

export const C = Object.freeze({
  page: '#0a0c0d', card: '#101315', tile: '#15191b', line: '#1c2124', line2: '#283033',
  text: '#e6eaeb', sec: '#c2c9cb', muted: '#8f999c', accent: '#3fcfae', ink: '#04120e',
  soon: '#f08a5d', soonBg: '#2b1a12', later: '#e8c05a', laterBg: '#2a2410', info: '#8f999c', infoBg: '#1c2124',
});

export const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
export const MONO = "Menlo,Consolas,'Courier New',monospace";

// Every text and background pair the emails draw, with its label. The palette test holds each to
// WCAG AA (4.5:1). Body copy, muted text, links and buttons are all here.
export const TEXT_PAIRS = Object.freeze([
  [C.text, C.page, 'text on page'],
  [C.text, C.card, 'text on card'],
  [C.text, C.tile, 'text on tile'],
  [C.sec, C.page, 'secondary on page'],
  [C.sec, C.card, 'secondary on card'],
  [C.sec, C.tile, 'secondary on tile'],
  [C.muted, C.page, 'muted on page'],
  [C.muted, C.card, 'muted on card'],
  [C.muted, C.tile, 'muted on tile'],
  [C.accent, C.page, 'link on page'],
  [C.accent, C.card, 'link on card'],
  [C.accent, C.tile, 'link on tile'],
  [C.ink, C.accent, 'button label on accent'],
  [C.soon, C.soonBg, 'soon chip'],
  [C.later, C.laterBg, 'later chip'],
  [C.info, C.infoBg, 'info chip'],
  [C.soon, C.card, 'soon marker on card'],
  [C.later, C.card, 'later marker on card'],
].map(Object.freeze));

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The whole document. `rows` are the <tr> elements of the centered content column, which is
// `maxWidth` wide on a wide screen and the full width on a narrow one. `css` adds rules to the
// one head style (mobile tweaks); `preheader` is the hidden preview line (already escaped).
export function darkDocument({ title, rows, maxWidth = 600, preheader = '', css = '' }) {
  const hidden = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${C.muted};background-color:${C.page}">${preheader}</div>`
    : '';
  return [
    `<!doctype html><html lang="en" style="color-scheme:dark;background-color:${C.page}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">',
    `<title>${esc(title)}</title>`,
    `<style>:root{color-scheme:dark;supported-color-schemes:dark}body{margin:0;padding:0;background-color:${C.page}}@media (max-width:480px){.fa-gutter{padding:12px 8px !important}}${css}</style>`,
    `</head><body bgcolor="${C.page}" style="margin:0;padding:0;background-color:${C.page};color:${C.text}">`,
    hidden,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="width:100%;background-color:${C.page};border-collapse:collapse"><tr>`
      + `<td align="center" bgcolor="${C.page}" class="fa-gutter" style="background-color:${C.page};padding:16px;font-family:${FONT};color:${C.text}">`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="width:100%;max-width:${maxWidth}px;margin:0 auto;background-color:${C.page};border-collapse:separate">${rows}</table>`
      + '</td></tr></table>',
    '</body></html>',
  ].join('\n');
}

// A plain message (the test email): a wordmark, then paragraphs in one card.
export function simpleDarkEmail({ title, paragraphs }) {
  const cell = (bg, style, inner) => `<td bgcolor="${bg}" style="background-color:${bg};font-family:${FONT};color:${C.text};${style}">${inner}</td>`;
  const paras = paragraphs.map((p) => `<p style="margin:0 0 12px;color:${C.sec};font-size:15px;line-height:1.55">${esc(p)}</p>`).join('');
  const card = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background-color:${C.card};border-collapse:separate;border-radius:14px"><tr>`
    + cell(C.card, 'padding:24px 22px 12px', `<p style="margin:0 0 12px;color:${C.accent};font-size:13px;font-weight:700;letter-spacing:.18em">FATHOM</p>${paras}`)
    + '</tr></table>';
  return darkDocument({ title, rows: `<tr>${cell(C.page, 'padding:0', card)}</tr>` });
}
