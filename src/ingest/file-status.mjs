// File statuses, by whether the owner or Fathom still has something to do. No imports: pipeline.mjs,
// freshness.mjs and service-status.mjs all read these lists.
// needs_mapping and needs_extraction are legacy: no current path writes them, stored rows still carry them.
export const UNRESOLVED = Object.freeze([
  'pending', 'failed', 'unsupported', 'too_large', 'needs_mapping', 'needs_extraction',
  'waiting_for_engine', 'budget_exhausted', 'needs_confirmation', 'needs_clarification', 'needs_source_text',
]);
export const RESOLVED = Object.freeze(['imported', 'duplicate']);
