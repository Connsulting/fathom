// Auth email: three link emails (invite, recovery, add-passkey) and two security notices (passkey
// added, account recovered), all through one layout. Rules:
// 1. Email safe: tables with role="presentation" and inline styles, 560px max width, no image,
//    SVG, script, remote font or tracking. Every cell carries its surface both as a bgcolor
//    attribute and as inline background-color, so no text sits on a transparent surface when a
//    client inverts colors.
// 2. The light palette (STYLE in src/email/brief.mjs) is the default. Clients that honor
//    prefers-color-scheme get the Horizon dark surfaces (C in brief.mjs) through the classes below.
// 3. A link email carries exactly one URL, the link: once as the button href and once as plain
//    fallback text. Notices carry no URL at all, so the layout emits none without a button.
// 4. Every interpolated value is escaped in HTML; the plain-text part prints it verbatim.

import { validatePublicUrl } from '../config.mjs';
import { esc } from '../shared/tokens.mjs';

const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const L = Object.freeze({
  page: '#f4f5f7', card: '#ffffff', text: '#1d2329', sec: '#3a434c', muted: '#5b6570', line: '#e3e6e9',
  accent: '#3fcfae', ink: '#04120e',
});
const D = Object.freeze({ page: '#0a0c0d', card: '#101315', text: '#e6eaeb', sec: '#c2c9cb', muted: '#8f999c', line: '#1c2124' });

const EXPIRY = 'This link works once and expires in 20 minutes.';
const FALLBACK = 'Button not working? Paste this address into your browser:';
const IGNORE = 'If you did not ask for this, ignore this email. Nothing changes until the link is used.';

const LINKS = Object.freeze({
  invite: {
    subject: 'Your Fathom invitation',
    heading: 'Create your Fathom passkey',
    lede: 'You have been invited to a Fathom household. This link sets up the passkey you sign in with.',
    label: 'Create your passkey',
    footer: IGNORE,
  },
  recovery: {
    subject: 'Your Fathom recovery link',
    heading: 'Recover your Fathom account',
    lede: 'This link sets up a new passkey for your Fathom account. Once the new passkey is saved, your old passkeys and every signed-in session stop working.',
    label: 'Set up a new passkey',
    footer: `${IGNORE} Anyone can ask for a recovery link for an address, and your current passkeys keep working unless a new one is saved from this link.`,
  },
  'add-passkey': {
    subject: 'Add a Fathom passkey on another device',
    heading: 'Add a passkey on another device',
    lede: 'Open this link on the phone, tablet or computer that should hold the new passkey. Your existing passkeys keep working.',
    label: 'Add a passkey',
    footer: `${IGNORE} This link was asked for from a signed-in Fathom session, so if it was not you, sign in, check your passkeys on Account and ask a household admin for help.`,
  },
});

const DARK_CSS = [
  ':root{color-scheme:light dark;supported-color-schemes:light dark}',
  `body{margin:0;padding:0;background-color:${L.page}}`,
  '@media (prefers-color-scheme: dark){',
  `.fa-page{background-color:${D.page} !important;color:${D.text} !important}`,
  `.fa-card{background-color:${D.card} !important;color:${D.text} !important;border-color:${D.line} !important}`,
  `.fa-text{color:${D.text} !important}`,
  `.fa-sec{color:${D.sec} !important}`,
  `.fa-muted{color:${D.muted} !important}`,
  `.fa-rule{border-color:${D.line} !important}`,
  '}',
  '@media (max-width:600px){.fa-gutter{padding:16px 8px !important}.fa-inner{padding:24px 20px !important}}',
].join('');

// A cell with its surface set twice (bgcolor and inline), the font stack and a text color.
const td = (bg, cls, style, inner, attrs = '') =>
  `<td bgcolor="${bg}" class="${cls}" style="background-color:${bg};font-family:${FONT};${style}"${attrs ? ` ${attrs}` : ''}>${inner}</td>`;
const table = (bg, cls, style, inner, attrs = '') =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" class="${cls}" style="background-color:${bg};border-collapse:separate;${style}"${attrs ? ` ${attrs}` : ''}>${inner}</table>`;
const row = inner => `<tr>${inner}</tr>`;

// The one layout. `button` ({ label, url }) is optional; without it no URL appears anywhere.
function authEmail({ to, subject, preheader, heading, lede, lines = [], button = null, footer }) {
  const para = (text, cls, color, style = '') =>
    `<p class="${cls}" style="margin:0 0 16px;color:${color};font-size:15px;line-height:1.55;${style}">${text}</p>`;
  const wordmark = `<p class="fa-text" style="margin:0;font-size:13px;font-weight:700;letter-spacing:.18em;color:${L.text}">FATHOM</p>`
    + table(L.card, 'fa-card', 'margin:8px 0 24px', row(td(L.accent, '', `width:28px;height:3px;font-size:0;line-height:0;border-radius:2px`, '&nbsp;')));
  const blocks = [
    wordmark,
    `<h1 class="fa-text" style="margin:0 0 12px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:600;color:${L.text}">${heading}</h1>`,
    para(lede, 'fa-sec', L.sec),
    ...lines.map(line => para(line, 'fa-sec', L.sec)),
  ];
  if (button) {
    const href = esc(button.url);
    blocks.push(
      table(L.card, 'fa-card', 'margin:8px 0 20px', row(td(L.accent, '', 'border-radius:10px',
        `<a href="${href}" style="display:inline-block;background-color:${L.accent};color:${L.ink};text-decoration:none;font-family:${FONT};font-weight:700;font-size:15px;line-height:1.2;padding:13px 28px;border-radius:10px">${esc(button.label)}</a>`,
        `align="center"`))),
      para(esc(EXPIRY), 'fa-muted', L.muted, 'font-size:13px'),
      para(esc(FALLBACK), 'fa-muted', L.muted, 'font-size:13px;margin-bottom:6px'),
      `<p class="fa-text" style="margin:0 0 16px;color:${L.text};font-size:13px;line-height:1.5;font-family:Menlo,Consolas,monospace;word-break:break-all;overflow-wrap:anywhere">${href}</p>`,
    );
  }
  const card = table(L.card, 'fa-card', `width:100%;max-width:560px;margin:0 auto;border:1px solid ${L.line};border-radius:12px`,
    row(td(L.card, 'fa-card fa-inner', `padding:32px 36px;color:${L.text}`, blocks.join(''))))
    + table(L.page, 'fa-page', 'width:100%;max-width:560px;margin:0 auto',
      row(td(L.page, 'fa-page', `padding:20px 8px 0;color:${L.muted};font-size:12px;line-height:1.55`,
        `<p class="fa-muted" style="margin:0;color:${L.muted};font-size:12px;line-height:1.55">${footer}</p>`)));
  const hidden = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px">${preheader}</div>`;
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">',
    `<title>${esc(subject)}</title>`,
    `<style>${DARK_CSS}</style>`,
    `</head><body bgcolor="${L.page}" class="fa-page" style="margin:0;padding:0;background-color:${L.page};color:${L.text}">`,
    hidden,
    table(L.page, 'fa-page', 'width:100%', row(td(L.page, 'fa-page fa-gutter', 'padding:32px 16px', card, 'align="center"')), 'width="100%"'),
    '</body></html>',
  ].join('\n');
  return { to, subject, html };
}

// Text part: wordmark, heading, lede, any lines, the button as "label: link", expiry, footer.
function plain({ heading, lede, lines = [], button = null, footer }) {
  const out = ['FATHOM', '', heading, '', lede, ...lines.flatMap(line => ['', line])];
  if (button) out.push('', `${button.label}: ${button.url}`, '', EXPIRY);
  out.push('', footer);
  return `${out.join('\n')}\n`;
}

function build(to, subject, parts) {
  const { html } = authEmail({
    to, subject,
    preheader: esc(parts.lede),
    heading: esc(parts.heading),
    lede: esc(parts.lede),
    lines: (parts.lines || []).map(esc),
    button: parts.button,
    footer: esc(parts.footer),
  });
  return { to, subject, text: plain(parts), html };
}

export function authLinkMail(config, user, token, purpose) {
  const copy = LINKS[purpose];
  if (!copy) throw new Error('unknown auth link purpose');
  const link = `${validatePublicUrl(config.publicUrl, { required: true })}/enroll#${token}`;
  const message = build(user.email, copy.subject, {
    heading: copy.heading, lede: copy.lede, button: { label: copy.label, url: link }, footer: copy.footer,
  });
  return { link, message };
}

export function passkeyAddedMail({ to, account }) {
  return build(to, 'Fathom passkey added', {
    heading: 'A passkey was added',
    lede: `A new passkey was added to the Fathom account ${account}.`,
    lines: ['To review it, open Fathom and go to Account.'],
    footer: 'If this was not you, sign in, revoke it on Account and ask a household admin for help.',
  });
}

export function accountRecoveredMail({ to, account }) {
  return build(to, 'Fathom account recovered', {
    heading: 'Account recovered',
    lede: `Account recovery for ${account} completed and a new passkey was added. The earlier passkeys and sessions were removed.`,
    lines: ['To review the passkeys, open Fathom and go to Account.'],
    footer: 'If this was not expected, a household admin can revoke the new passkey on the Household page.',
  });
}
