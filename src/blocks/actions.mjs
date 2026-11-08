import { findCall } from './paths.mjs';

export const BLOCK_ACTIONS = Object.freeze({
  salary: 'salary.points', deferral: 'deferral.options',
});

export function blockAction(spec, results) {
  const ref = spec.source;
  if (spec.options || ref?.tool !== 'recommendations' || ref.args?.operation !== 'wargame' ||
    !Object.hasOwn(BLOCK_ACTIONS, ref.args.name) || ref.path !== BLOCK_ACTIONS[ref.args.name]) return null;
  const result = findCall(ref, results)?.result;
  if (!result || !['open', 'upcoming'].includes(result.status)) return null;
  return { kind: 'wargame', name: result.name, ...(result.decision ? { decisionId: result.decision.id } : {}), status: result.status };
}
