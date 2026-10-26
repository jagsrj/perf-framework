import assert from 'node:assert/strict';
import test from 'node:test';
import { createDockerArgs, createStopDockerArgs } from '../cli/docker.js';

test('builds an argument-safe, labelled Docker invocation', () => {
  const args = createDockerArgs(
    'run-123',
    '/tmp/jmx folder/test-influx.jmx',
    'http://influxdb:8086/write?db=jmeter',
    'smoke test',
    10,
    600,
    10,
    '/tmp/results/run-123'
  );
  assert.ok(args.includes('--label'));
  assert.ok(args.includes('perf-framework.run-id=run-123'));
  assert.ok(args.includes('perf-framework-jmeter:5.6.3'));
  assert.ok(args.includes('/tmp/jmx folder:/scripts:ro'));
  assert.ok(args.includes('-Japplication=smoke test'));
  assert.ok(args.includes('-Jduration=600'));
});

test('builds a graceful stop command for a JMeter container', () => {
  assert.deepEqual(createStopDockerArgs('container-123'), ['stop', '--time', '10', 'container-123']);
});
