/**
 * Single source of truth for Gemini model names.
 *
 * To switch models, change the ids in GEMINI_MODELS below — everything else
 * (server defaults, seed data, the "AI Brain & Setup" dropdowns, and the
 * saved-settings check) reads from here.
 *
 * Run `npm run models:check` to see which models your API key can use.
 */
import type { AiModelTuningConfig, StageModelConfig } from '../types/ops.ts';

export const GEMINI_MODELS = {
  /** Smallest and fastest: deciding what a message is, reading staff replies, writing WhatsApp messages. */
  fast: 'gemini-flash-lite-latest',
  /** Better judgment: planning tasks; backup for the Flash-Lite stages. */
  balanced: 'gemini-flash-latest',
  /** Strongest: the planner's backup, "a stronger second opinion for hard plans". Needs billing. */
  strong: 'gemini-pro-latest',
} as const;

/** Text-to-speech for task briefs sent as voice notes (Batch 3). */
export const GEMINI_TTS_MODELS = {
  primary: 'gemini-3.8-flash-lite-tts',
  fallback: 'gemini-3.8-flash-tts',
  voiceName: 'Kore',
} as const;

/** Every model id the app offers in its dropdowns, in display order. */
export const ALL_MODEL_IDS: readonly string[] = [
  GEMINI_MODELS.fast,
  GEMINI_MODELS.balanced,
  GEMINI_MODELS.strong,
];

/** Bump when saved settings need a one-time migration in sanitizeModelTuning. */
export const MODEL_DEFAULTS_VERSION = 5;

export type ModelTuningStageKey = 'meditate' | 'intent' | 'planner' | 'bufferEvaluation' | 'message';

/**
 * Default per-stage settings (needs Gemini billing: the free tier allows about 20
 * Flash requests a day and no Pro). Each stage uses the smallest model that does the
 * job, with a different model as backup so a busy or hung model has somewhere to go.
 * Returns fresh objects so callers can mutate safely.
 */
export function defaultStageConfig(stage: ModelTuningStageKey): StageModelConfig {
  switch (stage) {
    case 'meditate':
    case 'planner':
      return {
        model: GEMINI_MODELS.balanced,
        fallbackModel: GEMINI_MODELS.strong,
        temperature: 0.2,
        // Flash and Pro think before answering and that counts against this limit;
        // 4096 cut a three-task plan off mid-JSON in a live check.
        maxOutputTokens: 8192,
        // Uncapped, Flash sometimes thought past the 45 s limit; 1024 keeps plans ~3x faster.
        thinkingBudget: 1024,
      };
    case 'intent':
      // Flash-Lite judged "is this a task, and is something missing?" more consistently
      // than Flash in the live eval (27/28 vs 25/28); Flash is its backup.
      return {
        model: GEMINI_MODELS.fast,
        fallbackModel: GEMINI_MODELS.balanced,
        temperature: 0.1,
        maxOutputTokens: 1024,
      };
    case 'bufferEvaluation':
      return {
        model: GEMINI_MODELS.fast,
        fallbackModel: GEMINI_MODELS.balanced,
        temperature: 0.1,
        maxOutputTokens: 2048,
      };
    case 'message':
      return {
        model: GEMINI_MODELS.fast,
        fallbackModel: GEMINI_MODELS.balanced,
        temperature: 0.65,
        maxOutputTokens: 512,
      };
  }
}

export function isKnownModel(model: unknown): model is string {
  return typeof model === 'string' && ALL_MODEL_IDS.includes(model.trim());
}

/**
 * Replaces any model / fallbackModel that isn't in ALL_MODEL_IDS with that
 * stage's default, and runs one-time versioned migrations when defaults change.
 * Returns the same object if nothing needed changing.
 */
export function sanitizeModelTuning<T extends Partial<AiModelTuningConfig> | undefined>(
  tuning: T
): { tuning: T; changed: boolean } {
  if (!tuning) return { tuning, changed: false };
  let changed = false;
  const next: Partial<AiModelTuningConfig> = { ...tuning };
  // One-time migration (v2): an old default briefly made Pro the planner's fallback.
  const needsV2Migration = (tuning.modelDefaultsVersion ?? 0) < 2;
  // One-time migration (v4, billing active): stages still on the free-tier workaround
  // (Flash-Lite as both primary and backup, the v3 default) move to the new defaults.
  // A stage the owner set to anything else is kept.
  const needsV4Migration = (tuning.modelDefaultsVersion ?? 0) < 4;
  // One-time migration (v5): planner stages saved with the old 4096-token limit and no
  // thinking cap get 8192 tokens and the capped thinking budget (a plan was cut off mid-JSON).
  const needsV5Migration = (tuning.modelDefaultsVersion ?? 0) < 5;
  if (needsV5Migration) {
    next.modelDefaultsVersion = MODEL_DEFAULTS_VERSION;
    changed = true;
  }
  const stages: ModelTuningStageKey[] = ['meditate', 'intent', 'planner', 'bufferEvaluation', 'message'];
  for (const stage of stages) {
    const cfg = tuning[stage];
    if (!cfg) continue;
    const defaults = defaultStageConfig(stage);
    const onFreeTierPair =
      needsV4Migration &&
      String(cfg.model || '').trim() === GEMINI_MODELS.fast &&
      String(cfg.fallbackModel || '').trim() === GEMINI_MODELS.fast;
    const model = !onFreeTierPair && isKnownModel(cfg.model) ? cfg.model.trim() : defaults.model;
    const fallbackModel =
      !onFreeTierPair &&
      isKnownModel(cfg.fallbackModel) &&
      !(needsV2Migration && cfg.fallbackModel.trim() === GEMINI_MODELS.strong)
        ? cfg.fallbackModel.trim()
        : defaults.fallbackModel;
    const plannerStage = stage === 'planner' || stage === 'meditate';
    const raiseTokens = needsV5Migration && plannerStage && (cfg.maxOutputTokens ?? 0) < (defaults.maxOutputTokens ?? 0);
    const addBudget = needsV5Migration && plannerStage && cfg.thinkingBudget === undefined && defaults.thinkingBudget !== undefined;
    if (model !== cfg.model || fallbackModel !== cfg.fallbackModel || raiseTokens || addBudget) {
      changed = true;
      next[stage] = {
        ...cfg,
        model,
        fallbackModel,
        ...(raiseTokens ? { maxOutputTokens: defaults.maxOutputTokens } : {}),
        ...(addBudget ? { thinkingBudget: defaults.thinkingBudget } : {}),
      };
    }
  }
  return { tuning: (changed ? next : tuning) as T, changed };
}
