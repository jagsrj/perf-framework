#!/usr/bin/env node
// Stand-in for the jmeter launcher in tests. It behaves like `jmeter -n -t <jmx> -l <jtl> -J...`:
// checks the plan and data files are where JMeter would look, writes JTL rows over time, and
// exits with FAKE_JMETER_EXIT (default 0). SIGTERM stops it like a JMeter shutdown.
//   FAKE_JMETER_ROWS_PER_USER  samples per user (default 5)
//   FAKE_JMETER_ELAPSED        response time in ms (default 100)
//   FAKE_JMETER_BATCH_MS       delay between batches (default 100)
//   FAKE_JMETER_BATCHES        number of batches (default 3)
//   FAKE_JMETER_REQUIRE        comma-separated files that must exist next to the JMX
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('5.6.3 (fake)');
  process.exit(0);
}
const value = (flag) => args[args.indexOf(flag) + 1];
const prop = (name) => args.find((arg) => arg.startsWith(`-J${name}=`))?.slice(name.length + 3);
const jmx = value('-t');
const jtl = value('-l');
if (!existsSync(jmx)) {
  console.error(`fake-jmeter: test plan ${jmx} not found`);
  process.exit(2);
}
for (const required of (process.env.FAKE_JMETER_REQUIRE || '').split(',').filter(Boolean)) {
  if (!existsSync(path.join(path.dirname(jmx), required))) {
    console.error(`fake-jmeter: required file ${required} missing next to the plan`);
    process.exit(3);
  }
}
writeFileSync(path.join(path.dirname(jtl), 'fake-jmeter-args.json'), JSON.stringify({ args, cwd: process.cwd() }));

const threads = Number(prop('threads'));
const perUser = Number(process.env.FAKE_JMETER_ROWS_PER_USER || 5);
const elapsed = Number(process.env.FAKE_JMETER_ELAPSED || 100);
const batches = Number(process.env.FAKE_JMETER_BATCHES || 3);
const batchMs = Number(process.env.FAKE_JMETER_BATCH_MS || 100);
const total = threads * perUser;
writeFileSync(jtl, 'timeStamp,elapsed,label,responseCode,success,threadName\n');
let written = 0;
let batch = 0;
process.on('SIGTERM', () => process.exit(143));
const timer = setInterval(() => {
  batch++;
  const count = batch === batches ? total - written : Math.floor(total / batches);
  let rows = '';
  for (let i = 0; i < count; i++)
    rows += `${Date.now()},${elapsed},login,200,true,"gen ${prop('generator')}, thread ${i}"\n`;
  appendFileSync(jtl, rows);
  written += count;
  if (batch >= batches) {
    clearInterval(timer);
    process.exit(Number(process.env.FAKE_JMETER_EXIT || 0));
  }
}, batchMs);
