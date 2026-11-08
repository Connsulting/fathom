CREATE TABLE notification_subscriptions (
  household_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  subscribed INTEGER NOT NULL CHECK (subscribed IN (0, 1)),
  membership_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, user_id),
  FOREIGN KEY (user_id, household_id) REFERENCES household_memberships(user_id, household_id) ON DELETE CASCADE
);

CREATE TABLE notification_policy (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  initialized_at INTEGER NOT NULL
);
