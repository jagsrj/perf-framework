// This module is responsible for preparing the JMX file for execution.
// It copies the original JMX file to a results directory, injects the InfluxDB Backend Listener if necessary,
// and ensures that the JMX file is parameterized correctly.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseStringPromise } from 'xml2js';

function findTestPlanChildrenTreeClose(xml) {
  const testPlan = /<TestPlan\b[^>]*>[\s\S]*?<\/TestPlan\s*>/i.exec(xml);
  if (!testPlan) {
    throw new Error('JMX has no TestPlan element.');
  }

  const afterTestPlan = testPlan.index + testPlan[0].length;
  const treeMatch = /<hashTree\b[^>]*>/i.exec(xml.slice(afterTestPlan));

  if (!treeMatch) {
    throw new Error('JMX TestPlan has no following child hashTree.');
  }

  const treeStart = afterTestPlan + treeMatch.index;
  const between = xml.slice(afterTestPlan, treeStart)
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  if (between) {
    throw new Error('Unexpected XML between TestPlan and its child hashTree.');
  }

  const tags = /<\/?hashTree\b[^>]*>/gi;
  tags.lastIndex = treeStart;

  let depth = 0;
  let match;

  while ((match = tags.exec(xml))) {
    const tag = match[0];

    if (tag.startsWith('</')) {
      depth--;
      if (depth === 0) return match.index;
    } else if (!/\/\s*>$/.test(tag)) {
      depth++;
    }
  }

  throw new Error('Could not find the end of the TestPlan child hashTree.');
}

function createBackendListenerXml() {
  const properties = [
    ['influxdbMetricsSender', 'org.apache.jmeter.visualizers.backend.influxdb.HttpMetricsSender'],
    ['influxdbUrl', '${__P(influxdbUrl,http://influxdb:8086/write?db=jmeter)}'],
    ['application', '${__P(application,perf-test)}'],
    ['measurement', 'jmeter'],
    ['summaryOnly', 'false'],
    ['samplersRegex', '.*'],
    ['percentiles', '90;95;99'],
    ['testTitle', '${__P(application,perf-test)}'],
    ['eventTags', 'runId=${__P(runId,unknown)}'],
    ['TAG_runId', '${__P(runId,unknown)}']
  ];

  const argumentsXml = properties.map(([name, value]) => `
            <elementProp name="${name}" elementType="Argument">
              <stringProp name="Argument.name">${name}</stringProp>
              <stringProp name="Argument.value">${value}</stringProp>
              <stringProp name="Argument.metadata">=</stringProp>
            </elementProp>`).join('');

  return `
      <BackendListener guiclass="BackendListenerGui" testclass="BackendListener" testname="InfluxDB Backend Listener" enabled="true">
        <elementProp name="arguments" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" enabled="true">
          <collectionProp name="Arguments.arguments">${argumentsXml}
          </collectionProp>
        </elementProp>
        <stringProp name="classname">org.apache.jmeter.visualizers.backend.influxdb.InfluxdbBackendListenerClient</stringProp>
      </BackendListener>
      <hashTree/>`;
}

function ensureRunIdMetricTag(xml) {
  const runIdArgument = `
            <elementProp name="TAG_runId" elementType="Argument">
              <stringProp name="Argument.name">TAG_runId</stringProp>
              <stringProp name="Argument.value">\${__P(runId,unknown)}</stringProp>
              <stringProp name="Argument.metadata">=</stringProp>
            </elementProp>`;

  return xml.replace(/<BackendListener\b[^>]*>[\s\S]*?<\/BackendListener\s*>/gi, (listenerXml) => {
    const existingTag = /<elementProp\b[^>]*name="TAG_runId"[^>]*>[\s\S]*?<\/elementProp>/;
    if (existingTag.test(listenerXml)) return listenerXml.replace(existingTag, runIdArgument);
    const argumentsStart = listenerXml.indexOf('<collectionProp name="Arguments.arguments">');
    if (argumentsStart === -1) {
      throw new Error('Existing JMX BackendListener has no arguments collection for the run ID metric tag.');
    }
    const argumentsEnd = listenerXml.indexOf('</collectionProp>', argumentsStart);
    if (argumentsEnd === -1) {
      throw new Error('Could not locate the end of the BackendListener arguments collection.');
    }
    return `${listenerXml.slice(0, argumentsEnd)}${runIdArgument}\n          ${listenerXml.slice(argumentsEnd)}`;
  });
}

export async function prepareJMX(originalJMXPath, runId, testName, resultsDir) {
  // runId, testName, and resultsDir stay in the signature for compatibility;
  // runtime values are supplied to JMeter as -J properties.
  void runId;
  void testName;
  void resultsDir;

  const sourcePath = path.resolve(originalJMXPath);
  const parsedPath = path.parse(sourcePath);
  const outputPath = parsedPath.name.endsWith('-influx')
    ? sourcePath
    : path.join(parsedPath.dir, `${parsedPath.name}-influx${parsedPath.ext}`);

  let xml = await fs.readFile(sourcePath, 'utf8');

  try {
    await parseStringPromise(xml);
  } catch (error) {
    throw new Error(`Invalid JMX XML in "${sourcePath}": ${error.message}`);
  }

  // Avoid adding duplicate listeners when this function is run again.
  if (!/<BackendListener\b/i.test(xml)) {
    const insertionPoint = findTestPlanChildrenTreeClose(xml);
    xml = `${xml.slice(0, insertionPoint)}${createBackendListenerXml()}\n    ${xml.slice(insertionPoint)}`;
  } else {
    xml = ensureRunIdMetricTag(xml);
  }

  // Validate the result, but do not parse/rebuild it: rebuilding can reorder
  // JMeter's element/hashTree pairs.
  try {
    await parseStringPromise(xml);
  } catch (error) {
    throw new Error(`Could not prepare JMX XML: ${error.message}`);
  }

  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, xml, 'utf8');
  await fs.rename(temporaryPath, outputPath);

  return outputPath;
}