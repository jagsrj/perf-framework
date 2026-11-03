-- Initial schema. Written to be idempotent so that databases created before versioned
-- migrations existed (when web/server.js ran this SQL on every start) are adopted as-is.

CREATE TABLE IF NOT EXISTS scenarios (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  script_name TEXT NOT NULL,
  script_path TEXT,
  original_filename TEXT,
  script_version INTEGER NOT NULL DEFAULT 0,
  users INTEGER NOT NULL CHECK (users > 0),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  rampup_seconds INTEGER NOT NULL CHECK (rampup_seconds >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS test_runs (
  run_id TEXT PRIMARY KEY,
  scenario_id UUID NOT NULL REFERENCES scenarios(id),
  scenario_name TEXT NOT NULL,
  script_name TEXT,
  script_sha256 TEXT,
  script_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'completed', 'failed', 'aborted')),
  users INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  rampup_seconds INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  exit_code INTEGER,
  error TEXT,
  summary JSONB,
  container_id TEXT,
  results_dir TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenario_script_versions (
  scenario_id UUID NOT NULL REFERENCES scenarios(id),
  version INTEGER NOT NULL CHECK (version > 0),
  original_filename TEXT NOT NULL,
  script_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, version)
);

CREATE INDEX IF NOT EXISTS test_runs_scenario_started_idx
  ON test_runs (scenario_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_test_run_idx
  ON test_runs ((1)) WHERE status IN ('starting', 'running');

ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS script_name TEXT;
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS script_sha256 TEXT;
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS script_version INTEGER;
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS container_id TEXT;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS script_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS slo JSONB;
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS slo JSONB;
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS slo_result JSONB;
ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS test_runs_status_check;
ALTER TABLE test_runs ADD CONSTRAINT test_runs_status_check
  CHECK (status IN ('starting', 'running', 'completed', 'failed', 'aborted'));
