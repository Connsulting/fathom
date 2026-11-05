-- 007 jobs and email: scheduler state on job_runs (period key, trigger, duration, error class),
-- one attempt per (job_id, period_key) through a partial unique index (rows with no period key,
-- such as the planner's own runs, may repeat), the single-row job_lock lease, the email_sends
-- history (no bodies, no addresses) and deadline_alerts dedupe by (key, threshold).
-- No foreign keys on the new tables, so the demo seed can clear jobs and job_runs freely.
ALTER TABLE job_runs ADD COLUMN period_key TEXT;
ALTER TABLE job_runs ADD COLUMN trigger TEXT;
ALTER TABLE job_runs ADD COLUMN duration_ms INTEGER;
ALTER TABLE job_runs ADD COLUMN error_class TEXT;

CREATE UNIQUE INDEX job_runs_period ON job_runs (job_id, period_key) WHERE period_key IS NOT NULL;

CREATE TABLE job_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE email_sends (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('brief', 'alert', 'test')),
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error_code TEXT,
  transport TEXT NOT NULL,
  recipients INTEGER NOT NULL,
  message_id TEXT,
  job_run_id INTEGER
);

CREATE TABLE deadline_alerts (
  key TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  deadline_date TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  send_id INTEGER,
  PRIMARY KEY (key, threshold)
);

-- Demo stores only: the demo now seeds the scheduler's own jobs, so the five retired mock jobs and
-- their runs go, leaving one jobs list. settings.value is JSON text, so demo mode is '"demo"'. A
-- real store keeps any job that happens to share one of these ids.
DELETE FROM job_runs
WHERE job_id IN ('sync', 'sweep', 'triggers', 'brief', 'packet')
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'mode' AND value = '"demo"');
DELETE FROM jobs
WHERE id IN ('sync', 'sweep', 'triggers', 'brief', 'packet')
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'mode' AND value = '"demo"');
