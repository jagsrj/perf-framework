// This file handles the execution of JMeter within a Docker container. 
// It manages the Docker CLI commands, including running the JMeter image and streaming output.

import { spawn } from 'node:child_process';
import path from 'node:path';

export function createDockerArgs(
  runId,
  jmxPath,
  influxdbUrl,
  testName,
  threads,
  duration,
  rampup,
  resultsDir
) {
  const scriptDir = path.dirname(path.resolve(jmxPath));
  const resultsPath = path.resolve(resultsDir);
  const image = process.env.JMETER_IMAGE || 'perf-framework-jmeter:5.6.3';
  const dockerNetwork = process.env.JMETER_DOCKER_NETWORK || 'infra_jmeter-network';

  const args = [
    'run',
    '--label', `perf-framework.run-id=${runId}`,
    `--network=${dockerNetwork}`,
    '-v', `${scriptDir}:/scripts:ro`,
    '-v', `${resultsPath}:/results`,
    image,
    '-n',
    '-t', `/scripts/${path.basename(jmxPath)}`,
    '-l', '/results/results.jtl',
    '-j', '/results/jmeter.log',
    `-Jthreads=${threads}`,
    `-Jduration=${duration}`,
    `-Jrampup=${rampup}`,
    `-JinfluxdbUrl=${influxdbUrl}`,
    `-Japplication=${testName}`,
    `-JrunId=${runId}`
  ];

  return args;
}

function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
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

export async function startJMeterInDocker(runId, jmxPath, influxdbUrl, testName, threads, duration, rampup, resultsDir) {
  const args = createDockerArgs(runId, jmxPath, influxdbUrl, testName, threads, duration, rampup, resultsDir);
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

export async function findJMeterContainer(runId) {
  const output = await runDocker([
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=perf-framework.run-id=${runId}`
  ]);
  return output.split(/\s+/).find(Boolean) || null;
}

export async function runJMeterInDocker(
  runId,
  jmxPath,
  influxdbUrl,
  testName,
  threads,
  duration,
  rampup,
  resultsDir
) {
  const args = createDockerArgs(runId, jmxPath, influxdbUrl, testName, threads, duration, rampup, resultsDir);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit' });

    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}