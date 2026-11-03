// Web app settings, read once from environment variables. See docs/CONFIGURATION.md.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const port = Number(env.WEB_PORT || 4000);
  const databasePassword = env.POSTGRES_PASSWORD || 'local-dev-only';
  return {
    port,
    publicDir: path.join(projectRoot, 'web', 'public'),
    uploadRoot: env.PERF_UPLOAD_DIR || path.join(projectRoot, 'data', 'scripts'),
    resultsRoot: env.PERF_RESULTS_DIR || path.join(projectRoot, 'results'),
    influxdbUrl: env.INFLUXDB_URL || 'http://influxdb:8086/write?db=jmeter',
    grafanaBaseUrl: env.GRAFANA_BASE_URL || 'http://localhost:3000',
    databaseUrl:
      env.DATABASE_URL ||
      `postgres://perf_framework:${encodeURIComponent(databasePassword)}@localhost:5433/perf_framework`
  };
}
