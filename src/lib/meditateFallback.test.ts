import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackMeditateResponse } from './meditateFallback';

test('Honest Fallback never invents fake tasks when Gemini API is unavailable', () => {
  const res = buildFallbackMeditateResponse({
    brainDump: 'Need to organize the team schedule for tomorrow',
  });

  assert.equal(res.intentClassification, 'NEEDS_CLARIFICATION');
  assert.deepEqual(res.draftedTasks, []);
  assert.deepEqual(res.wbsHeads, []);
  assert.deepEqual(res.suggestedMemoryRules, []);
  assert.match(res.chatReplyToBoss || '', /GEMINI_API_KEY|clarify/i);
});

test('Honest Fallback includes fallbackReason in reply when provided', () => {
  const res = buildFallbackMeditateResponse({
    brainDump: 'Assign shift checks',
    fallbackReason: 'Missing API Key',
  });

  assert.equal(res.intentClassification, 'NEEDS_CLARIFICATION');
  assert.equal(res.draftedTasks.length, 0);
  assert.equal(res.wbsHeads?.length, 0);
  assert.match(res.chatReplyToBoss || '', /Missing API Key/i);
});
