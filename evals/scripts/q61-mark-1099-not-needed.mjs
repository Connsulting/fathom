import { yearendChecklist, taxYearFor } from '../../src/yearend/expected.mjs';

export async function script({ db, clock }) {
  const year = taxYearFor(clock);
  const checklist = yearendChecklist(db, { year, clock });
  const item = checklist.items.find(i => i.form === '1099-int' && /credit union/i.test(i.t))
    ?? checklist.items.find(i => i.form === '1099-int');
  if (!item) throw new Error('The synthetic household needs an expected interest document.');
  return [
    { toolCalls: [{ name: 'household', args: { operation: 'health' } },
      { name: 'answer', args: { operation: 'yearend_mark', year, itemKey: item.key, reason: 'we closed that account', propose: true } }], costUsd: 0 },
    { text: 'The document mark is ready for you to confirm.', costUsd: 0 },
  ];
}
