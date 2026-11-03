// Runs JMeter in Docker: builds the `docker run` arguments, starts/stops/waits for containers
// and finds them again by label. A run can use several containers ("load generators"); each one
// writes its own results-<n>.jtl into the run's results directory.

import { spawn } from 'node:child_process';
import path from 'node:path';

export const RUN_LABEL = 'perf-framework.run-id';
export const GENERATOR_LABEL = 'perf-framework.generator';

// Splits `users` across `generators` as evenly as possible: 10 over 3 -> [4, 3, 3].
export function splitUsers(users, generators) {
  if (!Number.isSafeInteger(users) || users < 1) throw new Error('Users must be a positive whole number.');
  if (!Number.isSafeInteger(generators) || generators < 1) {
    throw new Error('Load generators must be a positive whole number.');
  }
  if (generators > users) throw new Error(`Cannot split ${users} users across ${generators} load generators.`);
  const base = Math.floor(users / generators);
  const extra = users % generators;
  return Array.from({ length: generators }, (_, index) => base + (index < extra ? 1 : 0));
}

export function jmeterRunArgs({
  runId,
  jmxPath,
  influxdbUrl,
  testName,
  threads,
  duration,
  rampup,
  resultsDir,
  generator = null,
  env = process.env
}) {
  const scriptDir = path.dirname(path.resolve(jmxPath));
  const resultsPath = path.resolve(resultsDir);
  const image = env.JMETER_IMAGE || 'perf-framework-jmeter:5.6.3';
  const dockerNetwork = env.JMETER_DOCKER_NETWORK || 'infra_jmeter-network';
  const suffix = generator === null ? '' : `-${generator}`;

  const args = ['run', '--label', `${RUN_LABEL}=${runId}`];
  if (generator !== null) args.push('--label', `${GENERATOR_LABEL}=${generator}`);
  args.push(
    `--network=${dockerNetwork}`,
    '-v',
    `${scriptDir}:/scripts:ro`,
    '-v',
    `${resultsPath}:/results`,
    image,
    '-n',
    '-t',
    `/scripts/${path.basename(jmxPath)}`,
    '-l',
    `/results/results${suffix}.jtl`,
    '-j',
    `/results/jmeter${suffix}.log`,
    `-Jthreads=${threads}`,
    `-Jduration=${duration}`,
    `-Jrampup=${rampup}`,
    `-JinfluxdbUrl=${influxdbUrl}`,
    `-Japplication=${testName}`,
    `-JrunId=${runId}`
  );
  if (generator !== null) args.push(`-Jgenerator=${generator}`);
  return args;
}

// Positional form kept for the `run` CLI command and existing callers.
export function createDockerArgs(runId, jmxPath, influxdbUrl, testName, threads, duration, rampup, resultsDir) {
  return jmeterRunArgs({ runId, jmxPath, influxdbUrl, testName, threads, duration, rampup, resultsDir });
}

function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Docker command exited with code ${code ?? 1}.`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// Starts one detached JMeter container and returns its ID.
export async function startJMeterContainer(options) {
  const args = jmeterRunArgs(options);
  args.splice(1, 0, '--detach');
  return runDocker(args);
}

export async function waitForJMeterContainer(containerId) {
  const result = await runDocker(['wait', containerId]);
  const exitCode = Number(result);
  if (!Number.isSafeInteger(exitCode)) {
    throw new Error(`Docker returned an invalid exit code for container ${containerId}.`);
  }
  return exitCode;
}

export function createStopDockerArgs(containerId) {
  return ['stop', '--time', '10', containerId];
}

export async function stopJMeterContainer(containerId) {
  await runDocker(createStopDockerArgs(containerId));
}

export async function removeJMeterContainer(containerId) {
  try {
    await runDocker(['rm', '--force', containerId]);
  } catch (error) {
    if (!/No such container/i.test(error.message)) throw error;
  }
}

// All containers (running or exited) that belong to a run.
export async function findJMeterContainers(runId) {
  const output = await runDocker(['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}=${runId}`]);
  return output.split(/\s+/).filter(Boolean);
}

// Runs a single JMeter container in the foreground (used by `node cli/index.js run`).
export async function runJMeterInDocker(runId, jmxPath, influxdbUrl, testName, threads, duration, rampup, resultsDir) {
  const args = createDockerArgs(runId, jmxPath, influxdbUrl, testName, threads, duration, rampup, resultsDir);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}
