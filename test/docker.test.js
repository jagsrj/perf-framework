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

test('splits users across load generators as evenly as possible', async () => {
  const { splitUsers } = await import('../cli/docker.js');
  assert.deepEqual(splitUsers(10, 3), [4, 3, 3]);
  assert.deepEqual(splitUsers(9, 3), [3, 3, 3]);
  assert.deepEqual(splitUsers(7, 1), [7]);
  assert.deepEqual(splitUsers(2, 2), [1, 1]);
  assert.throws(() => splitUsers(2, 3), /Cannot split/);
  assert.throws(() => splitUsers(5, 0), /positive/);
});

test('gives each load generator its own label, result file and log', async () => {
  const { jmeterRunArgs } = await import('../cli/docker.js');
  const args = jmeterRunArgs({
    runId: 'run-1',
    jmxPath: '/tmp/s/test.jmx',
    influxdbUrl: 'http://influxdb:8086/write?db=jmeter',
    testName: 'checkout',
    threads: 4,
    duration: 60,
    rampup: 5,
    resultsDir: '/tmp/results/run-1',
    generator: 2,
    env: {}
  });
  assert.ok(args.includes('perf-framework.generator=2'));
  assert.ok(args.includes('/results/results-2.jtl'));
  assert.ok(args.includes('/results/jmeter-2.log'));
  assert.ok(args.includes('-Jthreads=4'));
  assert.ok(args.includes('-Jgenerator=2'));
  // The single-container CLI form keeps the original file names.
  const single = jmeterRunArgs({ runId: 'r', jmxPath: '/a/b.jmx', resultsDir: '/r', threads: 1, env: {} });
  assert.ok(single.includes('/results/results.jtl'));
  assert.ok(!single.some((arg) => arg.startsWith('-Jgenerator')));
});

test('runs JMeter as the host user on Linux and as the image user elsewhere', async () => {
  const { containerUser, jmeterRunArgs } = await import('../cli/docker.js');
  const ids = { getuid: () => 1001, getgid: () => 1002 };
  assert.equal(containerUser({}, 'linux', ids), '1001:1002');
  assert.equal(containerUser({}, 'darwin', ids), null);
  assert.equal(containerUser({ JMETER_DOCKER_USER: '1000:1000' }, 'darwin', ids), '1000:1000');
  assert.equal(containerUser({ JMETER_DOCKER_USER: 'image' }, 'linux', ids), null);

  const args = jmeterRunArgs({ runId: 'r', jmxPath: '/a/b.jmx', resultsDir: '/r', threads: 1, env: {}, user: '5:6' });
  assert.deepEqual(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2), ['--user', '5:6']);
  assert.ok(args.includes('no-new-privileges'));
  // Docker options must come before the image name.
  assert.ok(args.indexOf('--user') < args.indexOf('perf-framework-jmeter:5.6.3'));
});
