// H3: why a war game could not be built (or is kept only for reference) and the one control that
// unlocks it. Its own module so the planner's war-game builder does not import the missing-data
// trigger (that trigger imports common.mjs, which loads the planner).

import { TAX_GAP_RULES } from '../../shared/tax-gaps.mjs';
import { fixForCode } from '../triggers/missing-data.mjs';

// Why a war game could not be built, in plain language with no figures, and the one control that
// unlocks it (H3): `fix` opens the specific answer in Ask (an answer.fact shape) or the upload kind,
// in TAX1's fix shape; `unlock` ('answers' or 'files') follows it. brief.mjs stores one per game that
// has no model and no kept history under content wargame.notBuilt (Decide shows it), and the same
// reason and fix for a game kept only for reference. Tax codes a household run blocks on pass
// through fixForCode. inputs_changed is left only for a game no plan has explained yet.
const GAME_NAME = Object.freeze({ salary: 'Salary war game', deferral: 'Invoice deferral war game' });
const ask = (key, label, prompt) => ({ screen: 'ask', key, label, prompt });
const upload = (kind, label) => ({ screen: 'upload', kind, label });
const PNL = upload('pnl', 'Upload the business profit and loss');
const CONTRIBUTIONS = { ...TAX_GAP_RULES.retirement_contribution_over_limit.fix };
const CLASSIFY = ask('business.entities', 'Classify the businesses', 'Record how my imported businesses are taxed. Ask me for the missing classifications, preserving existing entries and account links.');
export const WARGAME_UNLOCKS = Object.freeze({
  salary: Object.freeze({
    inputs_changed: ['needs an S corp with profit on file.', upload('pnl', 'Upload the S corp profit and loss')],
    scorp_missing: ['needs an S corp with profit on file.', upload('pnl', 'Upload the S corp profit and loss')],
    scorp_profit_missing: ['needs a profit and loss that shows profit for your S corp this year.', upload('pnl', 'Upload the latest S corp profit and loss')],
    'business.salaryRange': ["needs your advisor's reasonable salary range.", ask('business.salaryRange', 'Enter salary range',
      'Record the annual salary range my advisor considers reasonable. Ask me for its minimum and maximum.')],
    salary_points_unavailable: ['needs a salary range your business profit can pay, with room for payroll tax at two or more salaries.', ask('business.salaryRange', 'Correct the salary range',
      'Record the annual salary range my advisor considers reasonable. Ask me for its minimum and maximum.')],
    'household.birthYears': ['needs your birth year to size catch-up room.', ask('household.birthYears', 'Enter birth years', 'Record the years my spouse and I were born. Ask me for them.')],
    'retirement.otherPlanDeferrals': ['needs your deferrals to other workplace plans this year.', { ...TAX_GAP_RULES.deferral_split_unknown.fix }],
    'retirement.priorYearFicaWages': ["needs last year's Social Security wages from your business.", ask('retirement.priorYearFicaWages', "Enter last year's Social Security wages",
      "Record last year's Social Security wages my business paid me, from last year's W-2. Ask me for the amount.")],
    w2_plan_compensation_unknown: ['needs the deferrals from the wage form your business issued.', upload('taxforms', 'Upload a clearer tax form')],
    wargame_salary_contribution_over_limit: ['needs retirement contributions within the plan limits at your current salary.', CONTRIBUTIONS],
    scorp_identity_missing: ['needs you to identify the S corp among the imported ledgers.', ask('business.entities', 'Identify the S corp', CLASSIFY.prompt)],
  }),
  deferral: Object.freeze({
    inputs_changed: ['needs a business with income and its business bank account on file.', PNL],
    business_income_missing: ['needs a business with income this year on file.', PNL],
    'business.cashBasis': ['needs to know whether your business uses cash basis accounting.', ask('business.cashBasis', 'Answer the accounting method',
      'Record whether my business keeps its books on a cash basis.')],
    accrual_basis: ['applies only to cash basis books, and your answer says the business uses accrual.', ask('business.cashBasis', 'Correct the accounting method',
      'Record whether my business keeps its books on a cash basis.')],
    business_account_missing: ['needs a current balance for the business bank account.', upload('bank', 'Upload the business bank statement')],
    business_account_unlinked: ['needs to know which bank account belongs to the business.', ask('accounts.businessEntity', 'Link the business account',
      'Record which business each business bank account belongs to. Ask me for the business name for each account.')],
    wargame_contribution_over_limit: ['needs retirement contributions within the plan limits at the incomes it compares.', CONTRIBUTIONS],
  }),
});

const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);
const unlockOf = fix => (fix.screen === 'upload' ? 'files' : 'answers');
const reason = (code, text, fix) => ({ code, text, unlock: unlockOf(fix), fix: { ...fix } });

export function notBuiltReason(name, code, entities = []) {
  code = String(code);
  const game = GAME_NAME[name] || 'This war game';
  if (code.startsWith('entity_unclassified:')) {
    const entity = entities.find(e => e.slug === code.slice('entity_unclassified:'.length));
    if (entity?.needsName) return reason(code, `${game} needs the business name for ${entity.displayName}.`,
      ask('accounts.businessEntity', 'Enter the business name', `Record the business name for ${entity.displayName}. Ask me for it.`));
    return reason(code, `${game} needs you to classify ${entity?.displayName || entity?.name || 'the imported business'} as an S corp, sole proprietorship, partnership, personal spending, or not yours.`, CLASSIFY);
  }
  if (name === 'salary' && code === 'scorp_identity_missing') {
    const names = [...new Set(entities.map(e => e.displayName || e.name).filter(Boolean))];
    if (names.length) return reason(code, `Salary war game needs you to identify the S corp among ${names.join(', ')}.`, WARGAME_UNLOCKS.salary.scorp_identity_missing[1]);
  }
  const known = (WARGAME_UNLOCKS[name] || {})[code];
  if (known) return reason(code, `${game} ${known[0]}`, known[1]);
  // A tax code the household run blocked on: TAX1's fix for it, named in the sentence.
  let fix;
  try { fix = fixForCode(code); } catch { fix = null; }
  if (fix) return reason(code, `${game} is on hold until you ${lowerFirst(fix.label)}.`, fix);
  const [text, fallback] = WARGAME_UNLOCKS[name]?.inputs_changed || WARGAME_UNLOCKS.salary.inputs_changed;
  return reason(code, `${game} ${text}`, fallback);
}

