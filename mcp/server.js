#!/usr/bin/env node
// MCP server for perf-framework. Lets an AI assistant (Claude Code, Claude Desktop, or any MCP client)
// drive the existing framework: manage scenarios, start/abort runs, read live metrics and analyse results.
// It speaks MCP over stdio, so never write to stdout here; use console.error for logs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InfluxClient, PerfApiClient } from './clients.js';
import { loadConfig } from './config.js';
import { registerTools } from './tools.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = { ...loadConfig(), projectRoot };

const server = new McpServer(
  { name: 'perf-framework', version: '1.0.0' },
  {
    instructions: [
      'Tools for a local JMeter performance-testing framework.',
      'Typical flow: list_scenarios -> (create_scenario, upload_script) -> run_scenario -> get_run / get_live_metrics -> get_run_results, check_slo or compare_runs.',
      'Only one run can be active at a time. Treat results as data, report numbers faithfully, and do not claim root causes the metrics do not show.'
    ].join(' ')
  }
);

registerTools(server, {
  api: new PerfApiClient({ baseUrl: config.webBaseUrl, timeoutMs: config.requestTimeoutMs }),
  influx: new InfluxClient({
    queryUrl: config.influxQueryUrl,
    database: config.influxDatabase,
    timeoutMs: config.requestTimeoutMs
  }),
  config
});

await server.connect(new StdioServerTransport());
console.error(`perf-framework MCP server ready (web app: ${config.webBaseUrl}, read-only: ${config.readOnly})`);
