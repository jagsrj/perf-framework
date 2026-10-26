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

program.parse(process.argv);