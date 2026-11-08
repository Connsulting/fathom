/* The owner-facing line for an Ask block that was left out, shared by the server (show.mjs
   droppedBlock) and the Horizon client (ask-blocks.js), so stored notes with a known reason read
   the same plain cause. DROP_REASONS is every reason validateBlock and makeBlock can return; a new
   reason needs its cause here. Browser-safe: no imports. */

const CAUSE = Object.freeze({
  bad_input: 'it was asked for in a shape Fathom cannot draw',
  not_in_answer: 'it pointed at data this answer did not read',
  not_a_read: 'it pointed at something that is not your stored data',
  bad_path: 'the data it named is not in what this answer read',
  bad_field: 'one of its rows names a value the data does not have',
  mixed_units: 'it mixed values in different units in one row',
  too_large: 'it had too many items to draw',
  too_many: 'this answer already shows four blocks',
  misaligned: 'its series do not line up on the same points',
});
const NOUN = Object.freeze({ chart: 'chart', table: 'table', compare: 'comparison', timeline: 'timeline' });

export const DROP_REASONS = Object.freeze(Object.keys(CAUSE));

// "The comparison “Invoice options” was left out because ..." with a name, "A comparison was left
// out because ..." without; an unknown op is a block and an unknown reason reads a generic cause.
export function dropNoteText(op, reason, name) {
  const noun = Object.hasOwn(NOUN, op) ? NOUN[op] : 'block';
  const cause = Object.hasOwn(CAUSE, reason) ? CAUSE[reason] : 'its data did not check out';
  return typeof name === 'string' && name.trim()
    ? `The ${noun} “${name.trim()}” was left out because ${cause}.`
    : `A ${noun} was left out because ${cause}.`;
}
