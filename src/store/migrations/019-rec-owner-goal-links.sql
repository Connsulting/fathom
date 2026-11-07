-- 019 rec owner and goal links: every rec gets an action owner and the goal kinds it serves.
-- Additive only (ALTER TABLE ADD COLUMN with constant defaults and CHECKs), so no table rebuild.
-- 018 is reserved for the in-flight auth migration; a store at 017 applies 019 now and 018 when it
-- lands (migrations apply by id, each once).
--
-- owner: who acts on the rec (you, spouse, both, advisor, automatic). owner_override: 1 once the
-- owner set it in the app or through the MCP tool; the planner never changes an overridden owner.
-- goal_kinds: JSON array of goal topics (src/shared/goals.mjs TOPIC_LABEL). They are resolved to
-- open goals at read time, so adding or archiving a goal relinks without a re-plan; a rec that
-- matches no open goal is housekeeping (derived, not stored).
--
-- Backfill, deterministic:
--   planner recs (in planner_recs) take their trigger's static goalKinds and owner (the exports of
--   src/jobs/triggers/*.mjs). SQL cannot run the household model behind a trigger's ownerFor, so a
--   contextual owner (for example the spouse's solo plan) settles at the next planning run, which
--   applies it because owner_override stays 0. No owner choice is lost.
--   demo seed recs (parser 'demo-seed', not planner) take the demo scenario's goalKinds and owner.
--   anything else keeps the defaults: no goal kinds (housekeeping) and owner 'you'.
-- Statuses, defs, tasks, rec_events, planner_recs and advisor rows are not touched.
-- test/store-rec-owner-migration.test.mjs checks both CASEs against the trigger modules and the
-- demo scenario, so the SQL and the JS cannot drift.

ALTER TABLE recs ADD COLUMN owner TEXT NOT NULL DEFAULT 'you'
  CHECK (owner IN ('you', 'spouse', 'both', 'advisor', 'automatic'));
ALTER TABLE recs ADD COLUMN owner_override INTEGER NOT NULL DEFAULT 0 CHECK (owner_override IN (0, 1));
ALTER TABLE recs ADD COLUMN goal_kinds TEXT NOT NULL DEFAULT '[]';

UPDATE recs SET
  goal_kinds = CASE (SELECT trigger_id FROM planner_recs WHERE rec_id = recs.id)
    WHEN 'fed-q4-estimate' THEN '["tax"]'
    WHEN 'va-q4-estimate' THEN '["tax"]'
    WHEN 'year-end-retirement' THEN '["retirement","tax"]'
    WHEN 'solo401k-setup' THEN '["retirement"]'
    WHEN 'scorp-salary' THEN '["tax","retirement"]'
    WHEN 'invoice-deferral' THEN '["tax"]'
    WHEN 'hsa-room' THEN '["health","retirement","tax"]'
    WHEN 'va529' THEN '["education","tax"]'
    WHEN 'charitable-bunching' THEN '["giving","tax"]'
    WHEN 'backdoor-roth' THEN '["retirement"]'
    WHEN 'dependent-care-fsa' THEN '["tax","cash"]'
    WHEN 'new-child' THEN '["cash","health"]'
    ELSE '[]' END,
  owner = CASE (SELECT trigger_id FROM planner_recs WHERE rec_id = recs.id)
    WHEN 'va529' THEN 'both'
    WHEN 'charitable-bunching' THEN 'both'
    WHEN 'dependent-care-fsa' THEN 'both'
    WHEN 'new-child' THEN 'both'
    ELSE 'you' END
WHERE id IN (SELECT rec_id FROM planner_recs);

UPDATE recs SET
  goal_kinds = CASE id
    WHEN 'offcycle' THEN '["retirement","tax"]'
    WHEN 'deferral' THEN '["tax","cash"]'
    WHEN 'dcfsa' THEN '["tax"]'
    WHEN 'va529' THEN '["education","tax"]'
    WHEN 'vaq4' THEN '["tax"]'
    WHEN 'reserve' THEN '["cash","tax"]'
    WHEN 'spsep' THEN '["retirement","tax"]'
    WHEN 'hsa' THEN '["health","retirement","tax"]'
    WHEN 'backdoor' THEN '["retirement"]'
    WHEN 'spouseentity' THEN '["tax"]'
    WHEN 'babyprep' THEN '["cash","health"]'
    WHEN 'mortgage' THEN '["home"]'
    WHEN 'compmemo' THEN '["tax"]'
    WHEN 'q3' THEN '["tax"]'
    WHEN 'megabackdoor' THEN '["retirement"]'
    WHEN 'daf' THEN '["giving","tax"]'
    ELSE '[]' END,
  owner = CASE id
    WHEN 'offcycle' THEN 'you'
    WHEN 'deferral' THEN 'you'
    WHEN 'dcfsa' THEN 'both'
    WHEN 'va529' THEN 'both'
    WHEN 'vaq4' THEN 'you'
    WHEN 'reserve' THEN 'automatic'
    WHEN 'spsep' THEN 'spouse'
    WHEN 'hsa' THEN 'you'
    WHEN 'backdoor' THEN 'you'
    WHEN 'spouseentity' THEN 'spouse'
    WHEN 'babyprep' THEN 'both'
    WHEN 'umbrella' THEN 'both'
    WHEN 'compmemo' THEN 'advisor'
    WHEN 'filingplan' THEN 'both'
    WHEN 'mortgage' THEN 'both'
    WHEN 'q3' THEN 'automatic'
    WHEN 'megabackdoor' THEN 'advisor'
    WHEN 'daf' THEN 'both'
    ELSE 'you' END
WHERE parser = 'demo-seed' AND id NOT IN (SELECT rec_id FROM planner_recs);
