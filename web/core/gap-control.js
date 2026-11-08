export function gapControl(action, esc, cls = 'h-btn sm') {
  if (!action || !['ask', 'upload'].includes(action.screen)) return '';
  return `<button type="button" class="${cls}" data-tax-gap-fix="${esc(JSON.stringify(action))}">${esc(action.label)}</button>`;
}
