import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareJMX } from '../cli/jmx.js';

test('adds the run ID metric tag to an existing BackendListener', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'perf-jmx-'));
  const source = path.join(directory, 'input.jmx');
  const xml = `<?xml version="1.0"?>
<jmeterTestPlan><hashTree><TestPlan/><hashTree>
  <BackendListener><elementProp name="arguments"><collectionProp name="Arguments.arguments">
    <elementProp name="application" elementType="Argument"/>
  </collectionProp></elementProp></BackendListener><hashTree/>
</hashTree></hashTree></jmeterTestPlan>`;

  try {
    await writeFile(source, xml);
    const output = await prepareJMX(source, 'run-123', 'test', directory);
    const result = await readFile(output, 'utf8');
    assert.match(result, /Argument\.name">TAG_runId<\/stringProp>/);
    assert.match(result, /Argument\.value">\$\{__P\(runId,unknown\)\}<\/stringProp>/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
