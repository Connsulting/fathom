export function gapControl(action, esc, cls = 'h-btn sm') {
  if (action?.screen === 'confirm' && Number.isSafeInteger(action.id) && action.id > 0)
    return `<a class="${cls}" href="#/confirm/${action.id}" data-go="confirm" data-id="${action.id}">${esc(action.label)}</a>`;
  if (!action || !['ask', 'upload'].includes(action.screen)) return '';
  return `<button type="button" class="${cls}" data-tax-gap-fix="${esc(JSON.stringify(action))}">${esc(action.label)}</button>`;
}
