import { text, result, empty, LimitError } from '../format.mjs';

export const id = 'notes';
export const label = 'Markdown notes';
export const sourceKind = 'notes';
export function sniff(file) {
  try {
    const body = text(file);
    return (/\.(md|markdown)$/i.test(file.name ?? '') || /^(text\/markdown|text\/x-markdown)$/i.test(file.mime ?? '')) && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(body) && !body.startsWith('%PDF-') ? 0.9 : 0;
  } catch (e) { if (e instanceof LimitError) throw e; return 0; }
}
export const parse = (file) => sniff(file) ? result([{ kind: 'document', docType: 'notes', fields: { text: text(file) }, locator: { row: 1 } }]) : empty();
