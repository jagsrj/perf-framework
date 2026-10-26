import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWithOllama } from '../web/ai-analysis.js';

test('sends only supported numeric summary metrics to Ollama', async () => {
  let requestBody;
  const result = await analyzeWithOllama(
    {
      samples: 100,
      successful: 98,
      failures: 2,
      errorRatePercent: 2,
      averageResponseMs: 120,
      p95ResponseMs: 210,
      p99ResponseMs: 280,
      maxResponseMs: 350,
      transactions: { 'private endpoint': { samples: 100 } }
    },
    { samples: 90, failures: 0, errorRatePercent: 0, averageResponseMs: 100 },
    {
      baseUrl: 'http://ollama.test/',
      model: 'test-model',
      fetchImpl: async (url, options) => {
        assert.equal(url, 'http://ollama.test/api/chat');
        requestBody = JSON.parse(options.body);
        return Response.json({ message: { content: 'The error rate increased.' } });
      }
    }
  );

  const userPrompt = requestBody.messages.find(({ role }) => role === 'user').content;
  assert.equal(requestBody.model, 'test-model');
  assert.equal(requestBody.stream, false);
  assert.match(userPrompt, /"p95ResponseMs":210/);
  assert.match(userPrompt, /"errorRatePercent":0/);
  assert.doesNotMatch(userPrompt, /private endpoint/);
  assert.deepEqual(result, { analysis: 'The error rate increased.', model: 'test-model' });
});

test('returns a clear unavailable error when Ollama cannot be reached', async () => {
  await assert.rejects(
    analyzeWithOllama({ samples: 1 }, null, {
      fetchImpl: async () => { throw new Error('connection refused'); }
    }),
    { statusCode: 503, message: 'Could not connect to Ollama. Check that the Docker service is running.' }
  );
});

test('surfaces errors returned by Ollama', async () => {
  await assert.rejects(
    analyzeWithOllama({ samples: 1 }, null, {
      fetchImpl: async () => Response.json({ error: 'model not found' }, { status: 404 })
    }),
    { statusCode: 502, message: 'Ollama error: model not found' }
  );
});

test('reports a timeout when Ollama does not respond in time', async () => {
  await assert.rejects(
    analyzeWithOllama({ samples: 1 }, null, {
      timeoutMs: 1,
      fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      })
    }),
    { statusCode: 504, message: 'Ollama did not respond before the 1-second timeout.' }
  );
});
