// `node scripts/reconcile-spend.mjs --household <id> --round <id> --cost-usd <amount> --receipt-ref <id>`:
// settle a held model round at the actual cost the operator read from the provider receipt
// (src/platform/model-budget.mjs reconcileRound). The cost is a finite nonnegative decimal; the
// receipt reference is a short identifier, stored on the round and never in the audit row. Settles
// idempotently and releases the unused reservation; a cost above the round's reservation keeps the
// household's accounting hold as reservation_bound_exceeded with the debt recorded. Never enables
// a paused engine. Touches only platform.sqlite. Prints one fixed line: `reconcile-spend:
// settled|unchanged` (exit 0) or `reconcile-spend: <code>` on stderr (exit 1).

import { openOperatorPlatform } from '../src/platform/ready.mjs';
import { reconcileRound } from '../src/platform/model-budget.mjs';

const FLAGS = ['--household', '--round', '--cost-usd', '--receipt-ref'];
const fail = code => Object.assign(new Error(code), { code });
const codeOf = e => (e && typeof e.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.code) ? e.code : 'reconcile_failed');

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!FLAGS.includes(argv[i]) || Object.hasOwn(args, argv[i]) || argv[i + 1] === undefined) throw fail('usage');
    args[argv[i]] = argv[i + 1];
  }
  if (!FLAGS.every(f => Object.hasOwn(args, f)) || !args['--household'] || !args['--round']) throw fail('usage');
  const text = args['--cost-usd'];
  const costUsd = /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  const platform = openOperatorPlatform();
  try {
    return reconcileRound(platform, { householdId: args['--household'], roundId: args['--round'], costUsd, receiptRef: args['--receipt-ref'] });
  } finally {
    platform.close();
  }
}

try {
  console.log(`reconcile-spend: ${main(process.argv.slice(2))}`);
} catch (e) {
  console.error(`reconcile-spend: ${codeOf(e)}`);
  process.exitCode = 1;
}
