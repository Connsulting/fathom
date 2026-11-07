// Whether a 529 account is Virginia's own program, inferred from its institution so the owner is
// asked only when the institution is unknown. Virginia deducts contributions only to its own
// program (Invest529, run by Virginia529); another institution is another state's plan or a
// private one. Shared by the server and the browser (served at /shared/va529-plan.mjs). Pure.

export const VIRGINIA_PLAN_QUESTION = "Is this Virginia's own 529 program (Invest529), which is the only kind Virginia deducts?";
export const INFERENCE_KEY = 'accounts.va529Inference';

// {value, evidence} from the account's institution, or null when it has none.
export function inferVirginiaPlan(account) {
  const inst = String(account?.inst ?? '').replace(/\s+/g, ' ').trim();
  if (!inst) return null;
  const squashed = inst.toLowerCase().replace(/[^a-z0-9]/g, '');
  return squashed.includes('invest529') || squashed.includes('virginia529')
    ? { value: true, evidence: `The institution is ${inst}, Virginia's own 529 program.` }
    : { value: false, evidence: `The institution is ${inst}, not Virginia's own 529 program (Invest529).` };
}

// Whether the owner undid the inference for an account (facts: the stored household facts).
export const inferenceUndone = (facts, accountId) => facts?.[INFERENCE_KEY]?.[accountId]?.undone === true;

// The inference to apply to an account that has no stored plan answer, or null.
export function activeInference(account, facts) {
  return inferenceUndone(facts, account.id) ? null : inferVirginiaPlan(account);
}
