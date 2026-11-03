-- Distributed load: a scenario's users can be split across several JMeter containers ("load generators").

ALTER TABLE scenarios
  ADD COLUMN generators INTEGER NOT NULL DEFAULT 1 CHECK (generators BETWEEN 1 AND 100);

ALTER TABLE test_runs
  ADD COLUMN generators INTEGER NOT NULL DEFAULT 1 CHECK (generators >= 1),
  ADD COLUMN container_ids TEXT[] NOT NULL DEFAULT '{}';

UPDATE test_runs SET container_ids = ARRAY[container_id] WHERE container_id IS NOT NULL;

ALTER TABLE test_runs DROP COLUMN container_id;

ALTER TABLE scenarios
  ADD CONSTRAINT scenarios_generators_le_users CHECK (generators <= users);
