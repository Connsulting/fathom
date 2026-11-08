export function script({ db }) {
  const decision = db.prepare("SELECT rec_id FROM decisions WHERE wargame = 'salary' AND rec_id IS NOT NULL ORDER BY sort LIMIT 1").get();
  if (!decision) throw new Error('The salary fixture needs a recommendation');
  return [
    { toolCalls: [
      { name: 'recommendations', args: { operation: 'list' } },
      { name: 'advisor_review', args: { operation: 'send', recId: decision.rec_id, propose: true } },
    ], costUsd: 0 },
    { text: 'I can mark the salary recommendation for advisor review in Fathom. Confirm this change.', costUsd: 0 },
  ];
}
