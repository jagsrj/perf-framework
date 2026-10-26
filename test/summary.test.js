import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import { summarizeJtl, summarizeJtlStream } from '../web/summary.js';

test('summarizes JTL totals and per-label latency distributions', async () => {
  const jtl = [
    'timeStamp,elapsed,label,responseCode,success',
    '1000,10,GET home,200,true',
    '2000,20,GET home,500,false',
    '3000,30,GET search,200,true'
  ].join('\n');

  const expected = {
    samples: 3,
    failures: 1,
    errorRatePercent: 1 / 3 * 100,
    averageResponseMs: 20,
    p95ResponseMs: 30,
    p99ResponseMs: 30,
    maxResponseMs: 30,
    successful: 2,
    transactions: {
      'GET home': {
        samples: 2,
        failures: 1,
        errorRatePercent: 50,
        averageResponseMs: 15,
        p95ResponseMs: 20,
        p99ResponseMs: 20,
        maxResponseMs: 20
      },
      'GET search': {
        samples: 1,
        failures: 0,
        errorRatePercent: 0,
        averageResponseMs: 30,
        p95ResponseMs: 30,
        p99ResponseMs: 30,
        maxResponseMs: 30
      }
    }
  };
  assert.deepEqual(summarizeJtl(jtl), expected);
  assert.deepEqual(await summarizeJtlStream(Readable.from([jtl])), expected);
});

test('summarizes empty JTL data without inventing latency values', async () => {
  const summary = summarizeJtl('timeStamp,elapsed,label,success\n');
  assert.equal(summary.samples, 0);
  assert.equal(summary.averageResponseMs, null);
  assert.equal(summary.p95ResponseMs, null);
  assert.deepEqual(summary.transactions, {});
  assert.deepEqual(await summarizeJtlStream(Readable.from(['timeStamp,elapsed,label,success\n'])), summary);
});

test('surfaces source stream errors without an unhandled stream exception', async () => {
  await assert.rejects(
    summarizeJtlStream(createReadStream('/path/that/does/not/exist/results.jtl')),
    /ENOENT/
  );
});
