-- Scheduled maintenance evidence; no external deliveries or workflow execution.
CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  jobName TEXT NOT NULL,
  completedAt TEXT NOT NULL
);
