import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiTimeoutError } from './geminiErrors';
import {
  callWithBusyRetry,
  INTERACTIVE_BUSY_RETRY_DELAYS_MS,
  isGeminiBusyError,
  isGeminiDailyQuotaError,
  isGeminiQuotaError,
  type BusyRetryEvent,
} from './geminiRetry';

const busy503 = Object.assign(
  new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'),
  { status: 503 }
);
const notFound = Object.assign(new Error('{"error":{"code":404,"message":"model not found"}}'), { status: 404 });
const dailyQuota429 = Object.assign(
  new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED",' +
      '"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}'
  ),
  { status: 429 }
);
const perMinute429 = Object.assign(
  new Error(
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED",' +
      '"details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}]}}'
  ),
  { status: 429 }
);
const noSleep = async () => {};

test('isGeminiBusyError: busy and timeout errors are retryable', () => {
  assert.equal(isGeminiBusyError(busy503), true);
  assert.equal(isGeminiBusyError(new Error('{"error":{"code":503}}')), true);
  assert.equal(isGeminiBusyError(Object.assign(new Error('rate'), { status: 429 })), true);
  assert.equal(isGeminiBusyError(new GeminiTimeoutError('m', 45_000)), true);
  assert.equal(isGeminiBusyError(new Error('fetch failed')), true);
});

test('isGeminiBusyError: other errors are not retryable', () => {
  assert.equal(isGeminiBusyError(notFound), false);
  assert.equal(isGeminiBusyError(Object.assign(new Error('API key not valid'), { status: 400 })), false);
  assert.equal(isGeminiBusyError(new SyntaxError('Unexpected token')), false);
});

test('callWithBusyRetry returns the first success without retrying', async () => {
  const out = await callWithBusyRetry({ models: ['a', 'b'], call: async (m) => `ok:${m}`, sleep: noSleep });
  assert.deepEqual(out, { result: 'ok:a', modelUsed: 'a', attempts: 1, usedBackupModel: false });
});

test('callWithBusyRetry waits and retries the same model when busy', async () => {
  let calls = 0;
  const waits: number[] = [];
  const out = await callWithBusyRetry({
    models: ['a', 'b'],
    retryDelaysMs: [10, 20, 30],
    sleep: async (ms) => { waits.push(ms); },
    call: async (m) => {
      calls++;
      if (calls < 3) throw busy503;
      return m;
    },
  });
  assert.equal(out.modelUsed, 'a');
  assert.equal(out.attempts, 3);
  assert.equal(out.usedBackupModel, false);
  assert.deepEqual(waits, [10, 20]);
});

test('callWithBusyRetry moves to the backup model after the primary stays busy', async () => {
  const tried: string[] = [];
  const events: BusyRetryEvent[] = [];
  const out = await callWithBusyRetry({
    models: ['a', 'b'],
    retryDelaysMs: [1, 1],
    sleep: noSleep,
    onRetry: (e) => events.push(e),
    call: async (m) => {
      tried.push(m);
      if (m === 'a') throw busy503;
      return m;
    },
  });
  assert.deepEqual(tried, ['a', 'a', 'a', 'b']);
  assert.equal(out.modelUsed, 'b');
  assert.equal(out.usedBackupModel, true);
  assert.equal(out.attempts, 4);
  assert.equal(events.at(-1)?.nextDelayMs, null);
});

test('callWithBusyRetry throws a non-busy error at once', async () => {
  let calls = 0;
  await assert.rejects(
    callWithBusyRetry({ models: ['a', 'b'], sleep: noSleep, call: async () => { calls++; throw notFound; } }),
    (err) => err === notFound
  );
  assert.equal(calls, 1);
});

test('callWithBusyRetry throws the last busy error when every model stays busy', async () => {
  let calls = 0;
  await assert.rejects(
    callWithBusyRetry({ models: ['a', 'b'], retryDelaysMs: [1], sleep: noSleep, call: async () => { calls++; throw busy503; } }),
    (err) => err === busy503
  );
  assert.equal(calls, 4);
});

test('callWithBusyRetry skips empty and duplicate model names', async () => {
  const tried: string[] = [];
  await assert.rejects(
    callWithBusyRetry({
      models: ['a', undefined, ' a ', ''],
      retryDelaysMs: [],
      sleep: noSleep,
      call: async (m) => { tried.push(m); throw busy503; },
    })
  );
  assert.deepEqual(tried, ['a']);
  await assert.rejects(callWithBusyRetry({ models: [undefined], call: async () => 1 }));
});

test('isGeminiDailyQuotaError: only per-day 429s count', () => {
  assert.equal(isGeminiDailyQuotaError(dailyQuota429), true);
  assert.equal(isGeminiDailyQuotaError(new Error('RESOURCE_EXHAUSTED: GenerateRequestsPerDay quota')), true);
  assert.equal(isGeminiDailyQuotaError(perMinute429), false);
  assert.equal(isGeminiDailyQuotaError(busy503), false);
  assert.equal(isGeminiDailyQuotaError(new GeminiTimeoutError('m', 45_000)), false);
  assert.equal(isGeminiDailyQuotaError(notFound), false);
});

test('callWithBusyRetry switches to the backup model at once on a daily-quota 429', async () => {
  const tried: string[] = [];
  const waits: number[] = [];
  const events: BusyRetryEvent[] = [];
  const out = await callWithBusyRetry({
    models: ['a', 'b'],
    retryDelaysMs: [10, 20, 30],
    sleep: async (ms) => { waits.push(ms); },
    onRetry: (e) => events.push(e),
    call: async (m) => {
      tried.push(m);
      if (m === 'a') throw dailyQuota429;
      return m;
    },
  });
  assert.deepEqual(tried, ['a', 'b']);
  assert.deepEqual(waits, []);
  assert.equal(out.modelUsed, 'b');
  assert.equal(out.attempts, 2);
  assert.equal(out.usedBackupModel, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].nextDelayMs, null);
});

test('callWithBusyRetry switches straight to backup on any 429 quota error with zero retries', async () => {
  const tried: string[] = [];
  const waits: number[] = [];
  const out = await callWithBusyRetry({
    models: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
    retryDelaysMs: INTERACTIVE_BUSY_RETRY_DELAYS_MS,
    sleep: async (ms) => { waits.push(ms); },
    call: async (m) => {
      tried.push(m);
      if (m === 'gemini-flash-latest') throw perMinute429;
      return `ok:${m}`;
    },
  });
  assert.deepEqual(tried, ['gemini-flash-latest', 'gemini-flash-lite-latest']);
  assert.deepEqual(waits, []);
  assert.equal(out.modelUsed, 'gemini-flash-lite-latest');
  assert.equal(out.usedBackupModel, true);
  assert.equal(isGeminiQuotaError(perMinute429), true);
});

test('503-then-success retries primary with 1s, 2s, 4s backoff before succeeding', async () => {
  let calls = 0;
  const waits: number[] = [];
  const out = await callWithBusyRetry({
    models: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
    retryDelaysMs: INTERACTIVE_BUSY_RETRY_DELAYS_MS,
    sleep: async (ms) => { waits.push(ms); },
    call: async (m) => {
      calls++;
      if (calls <= 3) throw busy503;
      return `ok:${m}`;
    },
  });
  assert.equal(out.modelUsed, 'gemini-flash-latest');
  assert.equal(out.usedBackupModel, false);
  assert.equal(out.attempts, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
});

test('both-busy fails cleanly and respects the 45s totalTimeoutMs cap', async () => {
  let nowMs = 0;
  const tried: string[] = [];
  const waits: number[] = [];
  await assert.rejects(
    callWithBusyRetry({
      models: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
      retryDelaysMs: INTERACTIVE_BUSY_RETRY_DELAYS_MS,
      finalPrimaryRetryDelayMs: 1_500,
      totalTimeoutMs: 45_000,
      now: () => nowMs,
      sleep: async (ms) => {
        waits.push(ms);
        nowMs += ms;
      },
      call: async (m) => {
        tried.push(m);
        const remaining = 45_000 - nowMs;
        nowMs += Math.min(4_000, Math.max(0, remaining));
        throw busy503;
      },
    }),
    (err) => err === busy503
  );
  // Total elapsed time must stay within the 45s cap.
  assert.ok(nowMs <= 45_000, `expected elapsed <= 45000ms, got ${nowMs}`);
  assert.ok(tried.includes('gemini-flash-latest'));
  assert.ok(tried.includes('gemini-flash-lite-latest'));
  assert.ok(waits.length > 0);
});

test('callWithBusyRetry throws the daily-quota error when the backup is also out of quota', async () => {
  const tried: string[] = [];
  await assert.rejects(
    callWithBusyRetry({
      models: ['a', 'b'],
      sleep: async () => { throw new Error('should not wait'); },
      call: async (m) => { tried.push(m); throw dailyQuota429; },
    }),
    (err) => err === dailyQuota429
  );
  assert.deepEqual(tried, ['a', 'b']);
});

test('503-then-success retries even when primary and backup are the same model', async () => {
  let calls = 0;
  const waits: number[] = [];
  const out = await callWithBusyRetry({
    models: ['gemini-flash-lite-latest', 'gemini-flash-lite-latest'],
    retryDelaysMs: [1_000, 2_000, 4_000],
    sleep: async (ms) => { waits.push(ms); },
    call: async (m) => {
      calls++;
      if (calls < 3) throw busy503;
      return `ok:${m}`;
    },
  });
  assert.equal(out.result, 'ok:gemini-flash-lite-latest');
  assert.equal(out.attempts, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test('when both distinct models are busy, finalPrimaryRetryDelayMs tries primary once more before failing', async () => {
  const tried: string[] = [];
  const waits: number[] = [];
  await assert.rejects(
    callWithBusyRetry({
      models: ['primary', 'backup'],
      retryDelaysMs: [10],
      finalPrimaryRetryDelayMs: 50,
      sleep: async (ms) => { waits.push(ms); },
      call: async (m) => {
        tried.push(m);
        throw busy503;
      },
    }),
    (err) => err === busy503
  );
  assert.deepEqual(tried, ['primary', 'primary', 'backup', 'backup', 'primary']);
  assert.deepEqual(waits, [10, 10, 50]);
});

test('GeminiTimeoutError does not re-wait 45s on the same model when shouldRetrySameModel excludes timeouts', async () => {
  const tried: string[] = [];
  const timeoutErr = new GeminiTimeoutError('primary', 45_000);
  const out = await callWithBusyRetry({
    models: ['primary', 'backup'],
    retryDelaysMs: [1_000, 2_000],
    finalPrimaryRetryDelayMs: 1_000,
    shouldRetrySameModel: (err) => !(err instanceof GeminiTimeoutError) && !isGeminiDailyQuotaError(err),
    sleep: async () => { throw new Error('should not wait on timeout'); },
    call: async (m) => {
      tried.push(m);
      if (m === 'primary') throw timeoutErr;
      return `ok:${m}`;
    },
  });
  assert.deepEqual(tried, ['primary', 'backup']);
  assert.equal(out.modelUsed, 'backup');
});
