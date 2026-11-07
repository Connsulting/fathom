// Rec links, shared by the server (planner, store, API, tools) and the browser (served at
// /shared/rec-links.mjs). Pure: no store, no DOM.
//
// Every rec has an action owner and either serves at least one open goal or is housekeeping.
// The owner is one of OWNERS. Goal links are stored as goal kinds (the TOPIC_LABEL topics in
// goals.mjs) and resolved to goal ids at read time; housekeeping means no open goal matched.

export const OWNERS = Object.freeze(['you', 'spouse', 'both', 'advisor', 'automatic']);
export const OWNER_LABEL = Object.freeze({ you: 'You', spouse: 'Spouse', both: 'Both', advisor: 'Advisor', automatic: 'Automatic' });

export const isOwner = v => typeof v === 'string' && OWNERS.includes(v);

// A household person ('owner' | 'spouse') as an action owner.
export const personOwner = person => (person === 'spouse' ? 'spouse' : 'you');

// null when the rec has a known owner and exactly one of (serves a goal, housekeeping); else why not.
export function recLinkError(rec) {
  if (!rec || typeof rec !== 'object') return 'not a rec';
  if (!isOwner(rec.owner)) return `owner must be one of ${OWNERS.join(', ')}`;
  if (typeof rec.housekeeping !== 'boolean') return 'housekeeping must be true or false';
  if (!Array.isArray(rec.serves)) return 'serves must be a list of goals';
  const serves = rec.serves.length > 0;
  if (serves && rec.housekeeping) return 'a rec that serves a goal is not housekeeping';
  if (!serves && !rec.housekeeping) return 'a rec must serve a goal or be housekeeping';
  return null;
}
