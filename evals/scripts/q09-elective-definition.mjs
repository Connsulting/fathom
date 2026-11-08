import { callTool } from '../../src/tools/index.mjs';
import { script as read } from './c4-read.mjs';

export async function setup({ db, clock }) {
  await callTool('update_preferences', { operation: 'save_definition', definitionId: 'elective_spending', name: 'Elective spending',
    def: { exclude: { classes: ['housing', 'debt_service', 'childcare', 'healthcare', 'taxes'] } },
    evidence: 'Remember elective spending as everything except housing, childcare, healthcare and taxes.' },
  { db, now: clock, channel: 'mcp', actorId: 'demo', conversationKey: 'ask:000000000009' });
}
export const script = read;
