-- Remote load generators (agents), shared-drive scripts and plugins, and live SLO aborts.

-- Machines running the perf-framework agent. They register themselves and send heartbeats.
CREATE TABLE load_generators (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  hostname TEXT,
  agent_version TEXT,
  jmeter_version TEXT,
  max_threads INTEGER CHECK (max_threads IS NULL OR max_threads > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where a scenario's script comes from, which plugins it needs and where it runs.
ALTER TABLE scenarios
  ADD COLUMN script_source TEXT NOT NULL DEFAULT 'upload' CHECK (script_source IN ('upload', 'shared')),
  ADD COLUMN shared_script TEXT,
  ADD COLUMN plugins TEXT[] NOT NULL DEFAULT '{}',
  -- Empty = run in local Docker containers; otherwise the selected remote load generators.
  ADD COLUMN load_generator_ids UUID[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT scenarios_shared_script_set CHECK (script_source <> 'shared' OR shared_script IS NOT NULL);

ALTER TABLE test_runs
  ADD COLUMN execution TEXT NOT NULL DEFAULT 'local' CHECK (execution IN ('local', 'agents')),
  -- Who stopped an aborted run: 'user' or 'slo' (live SLO breach).
  ADD COLUMN aborted_by TEXT CHECK (aborted_by IS NULL OR aborted_by IN ('user', 'slo')),
  ADD COLUMN script_source TEXT,
  ADD COLUMN plugins TEXT[] NOT NULL DEFAULT '{}',
  -- Prepared JMX path inside results/<run-id>/bundle, which load generators download.
  ADD COLUMN bundle_jmx TEXT;

-- One row per load generator taking part in a remote run.
CREATE TABLE run_assignments (
  id UUID PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES test_runs(run_id) ON DELETE CASCADE,
  generator_index INTEGER NOT NULL CHECK (generator_index > 0),
  load_generator_id UUID NOT NULL REFERENCES load_generators(id),
  threads INTEGER NOT NULL CHECK (threads > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'finished', 'lost')),
  stop_requested BOOLEAN NOT NULL DEFAULT false,
  exit_code INTEGER,
  error TEXT,
  jtl_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (run_id, generator_index)
);

CREATE INDEX run_assignments_active_idx ON run_assignments (load_generator_id) WHERE status IN ('pending', 'running');
