-- Result of the optional perf-insight regression check (see docs/PERF-INSIGHT.md).
-- NULL = not configured or not applicable; {"status":"pending"} while it runs;
-- {"status":"ok","verdict":"pass|warn|fail",...} or {"status":"error","error":"..."} when done.
ALTER TABLE test_runs ADD COLUMN insight JSONB;
