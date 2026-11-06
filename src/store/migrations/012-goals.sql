-- Item 20: goals become owner-editable data. origin is 'seed' (the demo seed, def text may carry
-- scenario tokens) or 'owner' (typed by the owner: plain text, never token-resolved).
-- archived_at hides a goal from the plan and the planner without deleting it. created_at and
-- updated_at are app clock ISO strings. The owner goal def is
-- {id, title, note, horizon, target, targetDate, track}; see docs/architecture.md, Goals.
-- Tradeoff curve positions live in settings ('curve.positions', {axisId: 0..1}).

ALTER TABLE goals ADD COLUMN origin TEXT NOT NULL DEFAULT 'seed';
ALTER TABLE goals ADD COLUMN archived_at TEXT;
ALTER TABLE goals ADD COLUMN created_at TEXT;
ALTER TABLE goals ADD COLUMN updated_at TEXT;
