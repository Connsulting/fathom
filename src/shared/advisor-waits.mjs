// What a recommendation waiting on the advisor needs, in plain words, and the control that records
// the answer the advisor gave: Ask, prefilled, which saves it through answer.fact with a receipt
// and Undo. One entry per advisor key (src/facts/derive.mjs ADVISOR_KEYS).

const ask = (key, label, prompt) => ({ screen: 'ask', key, label, prompt });

const WAITS = Object.freeze({
  'retirement.planTermsConfirmed': {
    text: 'Your advisor\'s answer on whether your retirement plan terms and eligibility are confirmed.',
    fix: ask('retirement.planTermsConfirmed', 'Record the advisor answer', 'Record whether my advisor confirmed my retirement plan terms and eligibility. Ask me what they said.'),
  },
  'retirement.aggregationConfirmed': {
    text: 'Your advisor\'s answer on whether any related business shares your retirement plan limits.',
    fix: ask('retirement.aggregationConfirmed', 'Record the advisor answer', 'Record whether my advisor confirmed that no related business shares my retirement plan limits. Ask me what they said.'),
  },
  'business.salaryRange': {
    text: 'The reasonable salary range your advisor gave for your S corp.',
    fix: ask('business.salaryRange', 'Enter salary range', 'Record the annual salary range my advisor considers reasonable. Ask me for its minimum and maximum.'),
  },
});

export function advisorWait(key) {
  const w = WAITS[key];
  if (!w) throw new TypeError(`No advisor wait for ${key}`);
  return { key, text: w.text, fix: { ...w.fix } };
}
