import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeminiFailureMessage,
  describeGeminiError,
  GEMINI_CALL_TIMEOUT_MS,
  GeminiTimeoutError,
  withGeminiTimeout,
  isCompleteJsonText,
} from './geminiErrors';
import { buildFallbackMeditateResponse } from './meditateFallback';
import type { AiModelTuningConfig } from '../types/ops';
import { GEMINI_MODELS, MODEL_DEFAULTS_VERSION, sanitizeModelTuning, defaultStageConfig } from './modelConfig';

test('every Gemini call is limited to about 45 seconds', () => {
  assert.equal(GEMINI_CALL_TIMEOUT_MS, 45_000);
});

test('withGeminiTimeout rejects a hung call and aborts it', async () => {
  let aborted = false;
  const hung = (signal: AbortSignal) =>
    new Promise<string>(() => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
    });
  const started = Date.now();
  await assert.rejects(withGeminiTimeout('gemini-flash-latest', hung, 50), (err: unknown) => {
    assert.ok(err instanceof GeminiTimeoutError);
    assert.equal((err as GeminiTimeoutError).model, 'gemini-flash-latest');
    return true;
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal(aborted, true, 'the underlying request must be aborted');
});

test('withGeminiTimeout returns the result of a call that finishes in time', async () => {
  const result = await withGeminiTimeout('m', async () => 'OK', 1000);
  assert.equal(result, 'OK');
});

test('Gemini errors are described in simple words', () => {
  assert.match(
    describeGeminiError(new GeminiTimeoutError('gemini-flash-latest', 45_000), 'gemini-flash-latest'),
    /did not reply within 45 seconds/
  );
  assert.match(
    describeGeminiError(new Error('Gemini API error (429): {"error":{"status":"RESOURCE_EXHAUSTED"}}'), 'gemini-pro-latest'),
    /usage limit/
  );
  assert.match(
    describeGeminiError(new Error('Gemini API error (404): models/gemini-2.5-pro is no longer available'), 'gemini-2.5-pro'),
    /not available/
  );
  assert.match(describeGeminiError(new Error('Gemini API error (503): overloaded'), 'm'), /overloaded/);
  const abortErr = new Error('This operation was aborted');
  abortErr.name = 'AbortError';
  assert.match(describeGeminiError(abortErr, 'm'), /did not reply in time/);
});

test('failure message names both models and contains no raw JSON', () => {
  const msg = buildGeminiFailureMessage(
    { model: 'gemini-flash-latest', error: new GeminiTimeoutError('gemini-flash-latest', 45_000) },
    { model: 'gemini-pro-latest', error: new Error('Gemini API error (429): {"error":{"code":429}}') }
  );
  assert.match(msg, /gemini-flash-latest did not reply within 45 seconds/);
  assert.match(msg, /backup model gemini-pro-latest is over your Gemini usage limit/);
  assert.ok(!msg.includes('{'), 'no raw JSON in the message shown to the owner');

  const reply = buildFallbackMeditateResponse({ fallbackReason: 'raw', userMessage: msg });
  assert.equal(reply.chatReplyToBoss, msg);
  assert.deepEqual(reply.draftedTasks, []);
});

test('saved settings with Pro as the planner fallback are migrated once', () => {
  const saved: Partial<AiModelTuningConfig> = {
    maxRecentConversationTurns: 8,
    meditate: { ...defaultStageConfig('meditate'), fallbackModel: GEMINI_MODELS.strong },
    planner: { ...defaultStageConfig('planner'), fallbackModel: GEMINI_MODELS.strong },
    intent: defaultStageConfig('intent'),
    bufferEvaluation: defaultStageConfig('bufferEvaluation'),
  };
  const { tuning, changed } = sanitizeModelTuning(saved);
  assert.equal(changed, true);
  assert.equal(tuning.modelDefaultsVersion, MODEL_DEFAULTS_VERSION);
  assert.equal(tuning.planner?.fallbackModel, defaultStageConfig('planner').fallbackModel);
  assert.equal(tuning.meditate?.fallbackModel, defaultStageConfig('meditate').fallbackModel);

  // After migration, a deliberate Pro choice is kept.
  const chosen = {
    ...tuning,
    planner: { ...tuning.planner!, fallbackModel: GEMINI_MODELS.strong },
  };
  const again = sanitizeModelTuning(chosen);
  assert.equal(again.changed, false);
  assert.equal(again.tuning.planner?.fallbackModel, GEMINI_MODELS.strong);
});

test('isCompleteJsonText: a cut-off JSON answer is not complete', () => {
  assert.equal(isCompleteJsonText('{"lane":"PROJECT","draftedTasks":[]}'), true);
  assert.equal(isCompleteJsonText('  {"a": 1}  '), true);
  assert.equal(isCompleteJsonText('{"lane":"PROJECT","chatReplyToBoss":"Sharma ji ki shaadi ke li'), false);
  assert.equal(isCompleteJsonText(''), false);
  assert.equal(isCompleteJsonText(undefined), false);
});

test('fallback reply for a cut-off answer says it was incomplete, not that the key is wrong', () => {
  const res = buildFallbackMeditateResponse({
    brainDump: 'Kal shaadi hai',
    fallbackReason: 'Unterminated string in JSON at position 553 (line 5 column 10)',
  });
  assert.match(res.chatReplyToBoss || '', /came back incomplete, so nothing was changed/);
  assert.doesNotMatch(res.chatReplyToBoss || '', /GEMINI_API_KEY/);
  assert.deepEqual(res.draftedTasks, []);
});
