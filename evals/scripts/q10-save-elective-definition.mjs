export async function script({ turn }) {
  return [
    { toolCalls: [{ name: 'update_preferences', args: { operation: 'save_definition', definitionId: 'elective_spending', name: 'Elective spending',
      def: { exclude: { classes: ['housing', 'debt_service', 'childcare', 'healthcare', 'taxes'] } }, evidence: turn.question, propose: true } }], costUsd: 0 },
    { text: 'Save your elective spending definition and its linked preference? Confirm below.', costUsd: 0 },
  ];
}
