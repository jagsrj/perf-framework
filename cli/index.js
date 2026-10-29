import { Command } from 'commander';
import { generateRunId } from './run-id.js';
import { prepareJMX as prepareJmx } from './jmx.js';
import path from 'node:path';
import { runJMeterInDocker } from './docker.js';
import { mkdir } from 'node:fs/promises';

const program = new Command();

program
  .command('run')
  .description('Run a performance test')
  .requiredOption('--script <path.jmx>', 'Path to the JMX script')
  .requiredOption('--name <testName>', 'Name of the test')
  .option('--threads <number>', 'Number of threads', '10')
  .option('--duration <seconds>', 'Duration of the test', '60')
  .option('--rampup <seconds>', 'Ramp-up time', '10')
  .action(async (options) => {
    const runId = generateRunId();
    const { script, name, threads, duration, rampup } = options;

    try {
      const resultsDir = path.resolve('results', runId);
      await mkdir(resultsDir, { recursive: true });

      const scriptPath = path.resolve(script);
      const jmxPath = await prepareJmx(scriptPath, runId, name, resultsDir);

      console.log(`Starting test run. Run ID: ${runId}`);
      const exitCode = await runJMeterInDocker(
        runId,
        jmxPath,
        'http://influxdb:8086/write?db=jmeter',
        name,
        threads,
        duration,
        rampup,
        resultsDir
      );

      if (exitCode !== 0) {
        console.error(`JMeter failed with exit code ${exitCode}. Run ID: ${runId}`);
        process.exitCode = exitCode;
        return;
      }

      console.log(`Test run completed. Run ID: ${runId}`);
    } catch (error) {
      console.error(`Error running test: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('ci')
  .description('Run a scenario through the web app and exit non-zero if it fails or breaches its SLO (for CI pipelines)')
  .requiredOption('--scenario <nameOrId>', 'Scenario name or ID')
  .option('--url <url>', 'Web app URL', process.env.PERF_WEB_URL || 'http://localhost:4000')
  .option('--timeout <seconds>', 'Give up and abort after this many seconds (default: duration + 600)')
  .option('--poll <seconds>', 'Status polling interval', '10')
  .option('--require-slo', 'Fail if the scenario has no SLO targets', false)
  .option('--junit <path>', 'Write SLO checks as JUnit XML (for CI test reports)')
  .option('--report <path>', 'Save the HTML report to this path')
  .action(async (options) => {
    const { createClient, runGate } = await import('./ci.js');
    const result = await runGate({
      client: createClient(options.url),
      scenario: options.scenario,
      timeoutSeconds: options.timeout === undefined ? undefined : Number(options.timeout),
      pollSeconds: Number(options.poll),
      requireSlo: options.requireSlo,
      junitPath: options.junit,
      reportPath: options.report
    });
    console.log(`${result.code === 0 ? 'PASS' : 'FAIL'}: ${result.reason}`);
    process.exitCode = result.code;
  });

program.parse(process.argv);