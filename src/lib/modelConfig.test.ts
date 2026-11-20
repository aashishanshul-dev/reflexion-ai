import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_MODEL_IDS,
  defaultStageConfig,
  GEMINI_MODELS,
  isKnownModel,
  sanitizeModelTuning,
} from './modelConfig';
import { resolveStageModelConfig } from './promptBuilder';
import { createInitialSeedState } from './seedData';

test('stage defaults: smallest model that does the job, and a different model as backup', () => {
  const expected = {
    meditate: [GEMINI_MODELS.balanced, GEMINI_MODELS.fast],
    planner: [GEMINI_MODELS.balanced, GEMINI_MODELS.fast],
    intent: [GEMINI_MODELS.fast, GEMINI_MODELS.balanced],
    bufferEvaluation: [GEMINI_MODELS.fast, GEMINI_MODELS.balanced],
    message: [GEMINI_MODELS.fast, GEMINI_MODELS.balanced],
  } as const;
  for (const stage of Object.keys(expected) as Array<keyof typeof expected>) {
    const cfg = defaultStageConfig(stage);
    assert.ok(isKnownModel(cfg.model), `${stage}.model`);
    assert.ok(isKnownModel(cfg.fallbackModel), `${stage}.fallbackModel`);
    assert.deepEqual([cfg.model, cfg.fallbackModel], [...expected[stage]], stage);
    assert.notEqual(cfg.model, cfg.fallbackModel, `${stage}: backup must be a different model`);
  }
  assert.equal(new Set(ALL_MODEL_IDS).size, ALL_MODEL_IDS.length);
});

test('seed data model tuning matches the shared defaults', () => {
  const tuning = createInitialSeedState().model_tuning;
  assert.deepEqual(tuning.intent, defaultStageConfig('intent'));
  assert.deepEqual(tuning.planner, defaultStageConfig('planner'));
  assert.deepEqual(tuning.meditate, defaultStageConfig('meditate'));
  assert.deepEqual(tuning.bufferEvaluation, defaultStageConfig('bufferEvaluation'));
  assert.deepEqual(tuning.message, defaultStageConfig('message'));
});

test('sanitizeModelTuning replaces retired models, keeps owner choices, and preserves other fields', () => {
  const saved = {
    modelDefaultsVersion: 2,
    maxRecentConversationTurns: 6,
    meditate: { model: 'gemini-2.5-flash', fallbackModel: 'gemini-2.5-pro', temperature: 0.4, maxOutputTokens: 3000 },
    intent: { model: GEMINI_MODELS.fast, fallbackModel: 'gemini-2.5-flash', temperature: 0.1, maxOutputTokens: 1024 },
    planner: { model: GEMINI_MODELS.strong, fallbackModel: GEMINI_MODELS.balanced, temperature: 0.2, maxOutputTokens: 4096 },
    bufferEvaluation: { model: 'gemini-flash-latest', fallbackModel: 'gemini-2.5-flash', temperature: 0.1, maxOutputTokens: 2048 },
  };
  const { tuning, changed } = sanitizeModelTuning(saved);
  assert.equal(changed, true);
  // Retired names go to the stage defaults; other fields are kept.
  assert.equal(tuning.meditate.model, defaultStageConfig('meditate').model);
  assert.equal(tuning.meditate.fallbackModel, defaultStageConfig('meditate').fallbackModel);
  assert.equal(tuning.meditate.temperature, 0.4);
  assert.equal(tuning.meditate.maxOutputTokens, 8192); // v5: planner limits below 8192 are raised for thinking models
  assert.equal(tuning.intent.model, GEMINI_MODELS.fast); // owner's own choice, not the free-tier pair
  assert.equal(tuning.intent.fallbackModel, defaultStageConfig('intent').fallbackModel);
  // Owner-chosen known models are kept (Flash is no longer migrated away now billing is on).
  assert.equal(tuning.planner.model, GEMINI_MODELS.strong);
  assert.equal(tuning.planner.fallbackModel, GEMINI_MODELS.balanced);
  assert.equal(tuning.bufferEvaluation.model, GEMINI_MODELS.balanced);
  assert.equal(tuning.bufferEvaluation.fallbackModel, defaultStageConfig('bufferEvaluation').fallbackModel);
  assert.equal(tuning.maxRecentConversationTurns, 6);
  assert.equal(tuning.modelDefaultsVersion, 6);
  // Input is not mutated.
  assert.equal(saved.meditate.model, 'gemini-2.5-flash');

  const clean = sanitizeModelTuning(tuning);
  assert.equal(clean.changed, false);
});

test('v4: stages left on the free-tier pair (Flash-Lite + Flash-Lite) move to the new defaults once', () => {
  const pair = { model: GEMINI_MODELS.fast, fallbackModel: GEMINI_MODELS.fast, temperature: 0.1, maxOutputTokens: 1024 };
  const saved = { modelDefaultsVersion: 3, intent: { ...pair }, planner: { ...pair, temperature: 0.3 }, message: { ...pair } };
  const { tuning, changed } = sanitizeModelTuning(saved);
  assert.equal(changed, true);
  assert.deepEqual([tuning.intent.model, tuning.intent.fallbackModel], [GEMINI_MODELS.fast, GEMINI_MODELS.balanced]);
  assert.deepEqual([tuning.planner.model, tuning.planner.fallbackModel], [GEMINI_MODELS.balanced, GEMINI_MODELS.fast]);
  assert.equal(tuning.planner.temperature, 0.3);
  assert.deepEqual([tuning.message.model, tuning.message.fallbackModel], [GEMINI_MODELS.fast, GEMINI_MODELS.balanced]);
  // After the migration, an owner who picks Flash-Lite for both again is left alone.
  const later = sanitizeModelTuning({ ...tuning, intent: { ...pair } });
  assert.deepEqual([later.tuning.intent.model, later.tuning.intent.fallbackModel], [GEMINI_MODELS.fast, GEMINI_MODELS.fast]);
});


test('resolveStageModelConfig never sends a retired model name to the API', () => {
  const cfg = resolveStageModelConfig(
    'PLANNER',
    {
      planner: { model: 'gemini-2.5-pro', fallbackModel: 'gemini-2.5-pro', temperature: 0.3, maxOutputTokens: 4096 },
    },
    { model: 'gemini-1.5-pro' }
  );
  assert.equal(cfg.model, defaultStageConfig('planner').model);
  assert.equal(cfg.fallbackModel, defaultStageConfig('planner').fallbackModel);
  assert.equal(cfg.temperature, 0.3);
});

test('v5: planner stages saved with 4096 tokens and no thinking cap get 8192 and the cap', () => {
  const saved = {
    modelDefaultsVersion: 4,
    planner: { model: GEMINI_MODELS.balanced, fallbackModel: GEMINI_MODELS.strong, temperature: 0.2, maxOutputTokens: 4096 },
    intent: { model: GEMINI_MODELS.fast, fallbackModel: GEMINI_MODELS.balanced, temperature: 0.1, maxOutputTokens: 1024 },
  };
  const { tuning, changed } = sanitizeModelTuning(saved);
  assert.equal(changed, true);
  assert.equal(tuning.planner.maxOutputTokens, 8192);
  assert.equal((tuning.planner as { thinkingBudget?: number }).thinkingBudget, 1024);
  assert.equal(tuning.intent.maxOutputTokens, 1024);
  assert.equal((tuning.intent as { thinkingBudget?: number }).thinkingBudget, undefined);
  assert.equal(resolveStageModelConfig('PLANNER', tuning).thinkingBudget, 1024);
  assert.equal(resolveStageModelConfig('INTENT', tuning).thinkingBudget, undefined);
});
