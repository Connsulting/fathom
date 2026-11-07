-- Per-user guided tour. tour_pending = 1 from the moment the user completes onboarding until they
-- finish or dismiss the tour; 0 for everyone else, so users who finished onboarding before this
-- migration are never flagged. Additive only.

ALTER TABLE users ADD COLUMN tour_pending INTEGER NOT NULL DEFAULT 0 CHECK (tour_pending IN (0, 1));
