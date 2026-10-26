import { parse as parseStream } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import { build as buildHistogram } from 'hdr-histogram-js';
import { pipeline } from 'node:stream/promises';

const MAX_TRACKED_RESPONSE_MS = 7 * 24 * 60 * 60 * 1000;

function createAggregate() {
  return {
    samples: 0,
    failures: 0,
    responseTimeSum: 0,
    responseTimeCount: 0,
    maxResponseMs: null,
    zeroResponseTimes: 0,
    histogram: buildHistogram({
      lowestDiscernibleValue: 1,
      highestTrackableValue: MAX_TRACKED_RESPONSE_MS,
      numberOfSignificantValueDigits: 2
    })
  };
}

function recordSample(aggregate, row) {
  aggregate.samples++;
  if (String(row.success).toLowerCase() === 'false') aggregate.failures++;
  const responseTime = Number(row.elapsed);
  if (!Number.isFinite(responseTime) || responseTime < 0) return;

  aggregate.responseTimeCount++;
  aggregate.responseTimeSum += responseTime;
  aggregate.maxResponseMs = aggregate.maxResponseMs === null
    ? responseTime
    : Math.max(aggregate.maxResponseMs, responseTime);
  if (responseTime === 0) {
    aggregate.zeroResponseTimes++;
    return;
  }
  aggregate.histogram.recordValue(Math.min(responseTime, MAX_TRACKED_RESPONSE_MS));
}

function percentile(aggregate, percent) {
  if (!aggregate.responseTimeCount) return null;
  const rank = Math.ceil((percent / 100) * aggregate.responseTimeCount);
  if (rank <= aggregate.zeroResponseTimes) return 0;
  const positiveCount = aggregate.responseTimeCount - aggregate.zeroResponseTimes;
  const positiveRank = rank - aggregate.zeroResponseTimes;
  const positivePercentile = (positiveRank / positiveCount) * 100;
  return aggregate.histogram.getValueAtPercentile(positivePercentile);
}

function summarizeAggregate(aggregate) {
  return {
    samples: aggregate.samples,
    failures: aggregate.failures,
    errorRatePercent: aggregate.samples ? (aggregate.failures / aggregate.samples) * 100 : 0,
    averageResponseMs: aggregate.responseTimeCount
      ? aggregate.responseTimeSum / aggregate.responseTimeCount
      : null,
    p95ResponseMs: percentile(aggregate, 95),
    p99ResponseMs: percentile(aggregate, 99),
    maxResponseMs: aggregate.maxResponseMs
  };
}

function createCollector() {
  const overall = createAggregate();
  const transactions = new Map();
  return {
    add(row) {
      recordSample(overall, row);
      const label = row.label || '(unlabelled)';
      if (!transactions.has(label)) transactions.set(label, createAggregate());
      recordSample(transactions.get(label), row);
    },
    finish() {
      const total = summarizeAggregate(overall);
      return {
        ...total,
        successful: total.samples - total.failures,
        transactions: Object.fromEntries([...transactions].map(([label, aggregate]) => [
          label,
          summarizeAggregate(aggregate)
        ]))
      };
    }
  };
}

export function summarizeJtl(csvText) {
  const collector = createCollector();
  for (const row of parseSync(csvText, { columns: true, skip_empty_lines: true, bom: true })) {
    if (row.elapsed !== undefined && row.success !== undefined) collector.add(row);
  }
  return collector.finish();
}

export async function summarizeJtlStream(readable) {
  const collector = createCollector();
  const parser = parseStream({ columns: true, skip_empty_lines: true, bom: true });
  try {
    const consume = (async () => {
      for await (const row of parser) {
        if (row.elapsed !== undefined && row.success !== undefined) collector.add(row);
      }
    })();
    await Promise.all([pipeline(readable, parser), consume]);
  } catch (error) {
    readable.destroy();
    parser.destroy();
    throw error;
  }
  return collector.finish();
}
