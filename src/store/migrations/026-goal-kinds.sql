-- Goal model v2: whose goal, priority, kinds and a done state. Additive: no row is rewritten.
-- done_at (app clock ISO time) marks a goal done. Status is derived at read time: archived when
-- archived_at, else done when done_at, else open. Kind (balance, range, floor, contribution),
-- owner (whose goal: owner, spouse, joint or a dependent key), priority and the kind fields live in
-- the def JSON, validated by src/shared/goals.mjs, with read-time defaults (kind balance, owner
-- and priority unset). See docs/architecture.md, Goals.
ALTER TABLE goals ADD COLUMN done_at TEXT;
