import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { buildFallbackMeditateResponse } from './src/lib/meditateFallback.ts';
import { buildDateContextLine, businessTodayIso } from './src/lib/planDates.ts';
import {
  buildGeminiFailureMessage,
  describeGeminiError,
  GEMINI_CALL_TIMEOUT_MS,
  GeminiCallFailedError,
  GeminiTimeoutError,
  isCompleteJsonText,
  withGeminiTimeout,
} from './src/lib/geminiErrors.ts';
import {
  callWithBusyRetry,
  INTERACTIVE_BUSY_RETRY_DELAYS_MS,
  isGeminiQuotaError,
} from './src/lib/geminiRetry.ts';
import {
  answerQuestionFromTasksFallback,
  buildAnonymizedIntentPrompt,
  buildAnonymizedPlannerPrompt,
  buildV2NonPlannerResponse,
  hydratePlannerDefaults,
  resolveIntentConfidenceThreshold,
  resolveOwnerPreferredLanguage,
  routeMeditateV2Intent,
  assessFollowUpRelevance,
} from './src/lib/meditateV2.ts';
import {
  buildAnonymizedBufferPrompt,
  buildAnonymizedMeditatePrompt,
  buildAnonymizedMessageStagePrompt,
  buildSlotDirectory,
  createAiCallLog,
  deanonymizeAndValidateMessageStage,
  deanonymizeBufferResponse,
  deanonymizeMeditateResponse,
  MAX_CONVERSATION_TURNS_CAP,
  resolveStageModelConfig,
} from './src/lib/promptBuilder.ts';
import { appendAiLogToState } from './src/lib/opsEngine.ts';
import { BUFFER_RESPONSE_SCHEMA } from './src/lib/bufferSchema.ts';
import { buildVoiceNotePrompt, buildVoiceNoteSpeechText, isVoiceNoteTextClean } from './src/lib/voiceNotes.ts';
import { transcribeAudioClip } from './src/lib/voiceInput.ts';
import { GEMINI_MODELS, GEMINI_TTS_MODELS } from './src/lib/modelConfig.ts';
import {
  buildPlainReleaseWhatsappMessage,
  buildReleaseSettingsFromState,
  canRelease,
  runScheduledJobsTick,
} from './src/lib/releaseEngine.ts';
import { createInitialSeedState } from './src/lib/seedData.ts';
import { describeConflicts, diffRecords, recordsToState } from './src/lib/cloudRecords.ts';
import {
  addDemoLeadAdmin,
  deleteDemoLeadAdmin,
  incrementDemoLeadAiUsageAdmin,
  isCloudServerMode,
  listDemoLeadsAdmin,
  loadWorkspaceAdmin,
  saveWorkspaceChangesAdmin,
  verifyRequestUser,
} from './src/server/firebaseAdmin.ts';
import { createDemoSeedState, validateDemoLeadInput } from './src/lib/demoData.ts';
import {
  buildIntentRepairPrompt,
  buildNeutralBufferFallbackResponse,
  buildPlanRepairPrompt,
  buildValidationFailureClarification,
  type MeditateValidationContext,
  resolveMeditateEngine,
  validateIntentStageOutput,
  validateMeditatePlan,
} from './src/lib/validator.ts';
import {
  type AiCallLogEntry,
  DEFAULT_TENANT_ID,
  type MeditateIntentStageOutput,
  type MeditateV2RouteOutcome,
  type OpsDatabaseState,
  type Task,
} from './src/types/ops.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

function getConfiguredApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  if (!key || key === 'MY_GEMINI_API_KEY' || key.trim() === '') {
    return null;
  }
  return key.trim();
}

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/** Models that hit the 45s limit, with when — skipped for SKIP_HUNG_MODEL_MS. */
const recentlyTimedOutModels = new Map<string, number>();
const SKIP_HUNG_MODEL_MS = 2 * 60_000;

/** A capped thinking budget for stages that set one (keeps Flash fast and predictable). */
function thinkingConfigFor(cfg: { thinkingBudget?: number }) {
  return typeof cfg.thinkingBudget === 'number' ? { thinkingConfig: { thinkingBudget: cfg.thinkingBudget } } : {};
}

async function generateWithFallbackModel(
  ai: GoogleGenAI,
  primaryModel: string,
  fallbackModel: string,
  contents: any,
  config: any
) {
  // Every Gemini call (including retries + fallback) is capped at GEMINI_CALL_TIMEOUT_MS (45s).
  // On transient 503 / overloaded responses, retry the same model with short backoff (1s, 2s, 4s)
  // before moving to fallback. Any 429 quota error or timeout moves to fallback at once.
  const overallStartMs = Date.now();
  const callModel = async (model: string) => {
    const remainingMs = GEMINI_CALL_TIMEOUT_MS - (Date.now() - overallStartMs);
    if (remainingMs <= 0) {
      throw new GeminiTimeoutError(model, GEMINI_CALL_TIMEOUT_MS);
    }
    // A thinking budget is tuned for the primary model; the backup uses its own default.
    const { thinkingConfig, ...rest } = config || {};
    const modelConfig = model === primaryModel && thinkingConfig ? { ...rest, thinkingConfig } : rest;
    const response = await withGeminiTimeout(
      model,
      (signal) =>
        ai.models.generateContent({
          model,
          contents,
          // abortSignal cancels the HTTP request when withGeminiTimeout gives up.
          config: { ...modelConfig, abortSignal: signal },
        }),
      remainingMs
    );
    recentlyTimedOutModels.delete(model);
    return response;
  };

  // If the primary model hung recently, start with the distinct fallback instead
  // of making the owner wait another 45 seconds on the same hung model.
  const hungAt = recentlyTimedOutModels.get(primaryModel);
  const skipHungPrimary = Boolean(
    hungAt && Date.now() - hungAt < SKIP_HUNG_MODEL_MS && fallbackModel && fallbackModel !== primaryModel
  );
  if (skipHungPrimary) {
    console.info(`[gemini] ${primaryModel} timed out recently; trying ${fallbackModel} first.`);
  }
  const models = skipHungPrimary ? [fallbackModel, primaryModel] : [primaryModel, fallbackModel];
  const errorsByModel = new Map<string, unknown>();

  try {
    const outcome = await callWithBusyRetry({
      models,
      call: callModel,
      retryDelaysMs: INTERACTIVE_BUSY_RETRY_DELAYS_MS,
      finalPrimaryRetryDelayMs: 1_500,
      totalTimeoutMs: GEMINI_CALL_TIMEOUT_MS,
      shouldRetrySameModel: (err) => !(err instanceof GeminiTimeoutError) && !isGeminiQuotaError(err),
      onRetry: (event) => {
        if (!errorsByModel.has(event.model)) errorsByModel.set(event.model, event.error);
        if (event.error instanceof GeminiTimeoutError) {
          recentlyTimedOutModels.set(event.model, Date.now());
        }
        const action =
          event.nextDelayMs !== null
            ? `retrying in ${event.nextDelayMs}ms (attempt ${event.attempt})`
            : `moving to backup`;
        console.info(`[gemini] ${describeGeminiError(event.error, event.model)}; ${action}.`);
      },
    });
    // A JSON answer cut off mid-way (e.g. a thinking model using up maxOutputTokens)
    // counts as a failed call: try the distinct backup model once before giving up.
    const backupModel = [fallbackModel, primaryModel].find((m) => m && m !== outcome.modelUsed);
    if (config?.responseMimeType === 'application/json' && !isCompleteJsonText(outcome.result?.text) && backupModel) {
      console.info(`[gemini] ${outcome.modelUsed} returned incomplete JSON; trying ${backupModel}.`);
      try {
        const retry = await callModel(backupModel);
        if (isCompleteJsonText(retry?.text)) return { response: retry, modelUsed: backupModel };
      } catch (backupErr) {
        console.warn(`[gemini] ${describeGeminiError(backupErr, backupModel)}`);
      }
    }
    return { response: outcome.result, modelUsed: outcome.modelUsed };
  } catch (finalErr: any) {
    if (finalErr instanceof GeminiTimeoutError) {
      recentlyTimedOutModels.set(finalErr.model, Date.now());
    }
    const primaryErr = errorsByModel.get(primaryModel) ?? finalErr;
    const distinctFallback = fallbackModel && fallbackModel !== primaryModel ? fallbackModel : undefined;
    const fallbackErr = distinctFallback ? (errorsByModel.get(distinctFallback) ?? finalErr) : undefined;
    const userMessage = distinctFallback && errorsByModel.has(distinctFallback)
      ? buildGeminiFailureMessage(
          { model: primaryModel, error: primaryErr },
          { model: distinctFallback, error: fallbackErr }
        )
      : buildGeminiFailureMessage({ model: primaryModel, error: primaryErr });
    console.error(`[gemini] All attempts failed: ${userMessage}`);
    throw new GeminiCallFailedError(
      userMessage,
      fallbackErr ? [primaryErr, fallbackErr] : [primaryErr]
    );
  }
}

const V2_INTENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    kind: {
      type: Type.STRING,
      enum: ['TASK', 'NOTE', 'RULE', 'QUESTION', 'CASUAL'],
    },
    confidence: { type: Type.NUMBER },
    missingCritical: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    followUpForHeadId: { type: Type.STRING, nullable: true },
    replyToOwner: { type: Type.STRING },
    ruleCategory: {
      type: Type.STRING,
      enum: ['BUSINESS_RULE', 'VENDOR_FACT', 'STAFF_TRAIT', 'SOP_PREFERENCE'],
      nullable: true,
    },
  },
  required: ['kind', 'confidence', 'missingCritical', 'followUpForHeadId', 'replyToOwner'],
};

const V2_PLANNER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    lane: {
      type: Type.STRING,
      enum: ['QUICK', 'PROJECT'],
    },
    chatReplyToBoss: { type: Type.STRING },
    reasoningSummary: { type: Type.STRING },
    agendaTitle: { type: Type.STRING },
    agendaQuadrant: {
      type: Type.STRING,
      enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'],
      nullable: true,
    },
    agendaMajorOrMinor: {
      type: Type.STRING,
      enum: ['MAJOR', 'MINOR'],
      nullable: true,
    },
    suggestedMemoryRules: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: {
            type: Type.STRING,
            enum: ['BUSINESS_RULE', 'VENDOR_FACT', 'STAFF_TRAIT', 'SOP_PREFERENCE'],
          },
          fact: { type: Type.STRING },
        },
        required: ['category', 'fact'],
      },
    },
    // Owner edits the AI changed only because the owner's new message explicitly asked.
    overriddenOwnerEdits: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          tempId: { type: Type.STRING },
          field: { type: Type.STRING },
          quote: { type: Type.STRING, nullable: true },
        },
        required: ['tempId', 'field'],
      },
    },
    draftedTasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          // Existing task's tempId when refining a plan (null for a new task).
          tempId: { type: Type.STRING, nullable: true },
          title: { type: Type.STRING },
          shortTag: { type: Type.STRING, nullable: true },
          categoryId: { type: Type.STRING },
          quadrant: {
            type: Type.STRING,
            enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'],
            nullable: true,
          },
          majorOrMinor: {
            type: Type.STRING,
            enum: ['MAJOR', 'MINOR'],
            nullable: true,
          },
          taskFrequency: {
            type: Type.STRING,
            enum: ['ONE_TIME', 'RECURRING'],
            nullable: true,
          },
          recurrenceRule: {
            type: Type.STRING,
            enum: ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'],
            nullable: true,
          },
          raci: {
            type: Type.OBJECT,
            properties: {
              R: { type: Type.STRING },
              A: { type: Type.STRING, nullable: true },
              C: { type: Type.ARRAY, items: { type: Type.STRING } },
              I: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['R', 'A', 'C', 'I'],
          },
          dependsOnSubtaskIndex: { type: Type.INTEGER, nullable: true },
          triggerCondition: {
            type: Type.STRING,
            enum: ['FULL_COMPLETION', 'PARTIAL_OR_BOSS_APPROVAL'],
            nullable: true,
          },
          startDate: { type: Type.STRING, nullable: true },
          durationDays: { type: Type.NUMBER, nullable: true },
          dueDate: { type: Type.STRING, nullable: true },
          dueHint: { type: Type.STRING, nullable: true },
          isForcedDeadline: { type: Type.BOOLEAN, nullable: true },
          forcedDeadlineDate: { type: Type.STRING, nullable: true },
          wbsHeadId: { type: Type.STRING, nullable: true },
          swimlaneStage: { type: Type.STRING, nullable: true },
          microSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
          outboundWhatsappPreview: { type: Type.STRING },
        },
        required: ['title', 'categoryId', 'raci', 'microSteps', 'outboundWhatsappPreview'],
      },
    },
    wbsHeads: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          headId: { type: Type.STRING },
          title: { type: Type.STRING },
          domainCategory: { type: Type.STRING },
          contextSummary: { type: Type.STRING },
          quadrant: {
            type: Type.STRING,
            enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'],
            nullable: true,
          },
          majorOrMinor: {
            type: Type.STRING,
            enum: ['MAJOR', 'MINOR'],
            nullable: true,
          },
          tentativeDurationDays: { type: Type.NUMBER, nullable: true },
          tentativeStartDate: { type: Type.STRING, nullable: true },
          tentativeDeadline: { type: Type.STRING, nullable: true },
          dueHint: { type: Type.STRING, nullable: true },
          isForcedDeadline: { type: Type.BOOLEAN, nullable: true },
          dynamicStages: { type: Type.ARRAY, items: { type: Type.STRING } },
          involvedPhones: { type: Type.ARRAY, items: { type: Type.STRING } },
          status: {
            type: Type.STRING,
            enum: ['DRAFT_HEAD', 'SWIMLANE_READY', 'FROZEN_DISPATCHED'],
            nullable: true,
          },
        },
        required: [
          'headId',
          'title',
          'domainCategory',
          'contextSummary',
          'dynamicStages',
          'involvedPhones',
        ],
      },
    },
  },
  required: [
    'lane',
    'chatReplyToBoss',
    'reasoningSummary',
    'agendaTitle',
    'draftedTasks',
    'wbsHeads',
  ],
};

async function handleMeditateV2Request(params: {
  startMs: number;
  tenantId: string;
  brainDump: string;
  activeHead?: any;
  wbsHeads?: any[];
  confirmedIntentKind?: any;
  priorMissingCritical?: string[];
  priorFollowUpForHeadId?: string | null;
  teamMembers: any[];
  tasks: any[];
  categorySops: any[];
  systemMemory: any[];
  principalPrompts?: any;
  businessProfile?: any;
  ownerProfile?: any;
  taskSplittingRules?: any;
  sampleBrainDumps?: any[];
  conversationHistory?: any[];
  modelTuning?: any;
  rawStageOverride?: any;
}): Promise<any> {
  const {
    startMs,
    tenantId,
    brainDump,
    activeHead,
    wbsHeads = [],
    confirmedIntentKind,
    priorMissingCritical,
    priorFollowUpForHeadId,
    teamMembers,
    tasks,
    categorySops,
    systemMemory,
    principalPrompts,
    businessProfile,
    ownerProfile,
    taskSplittingRules,
    sampleBrainDumps = [],
    conversationHistory = [],
    modelTuning,
    rawStageOverride,
  } = params;

  const intentStageCfg = resolveStageModelConfig('INTENT', modelTuning);
  const plannerStageCfg = resolveStageModelConfig('PLANNER', modelTuning, rawStageOverride);
  const confidenceThreshold = resolveIntentConfidenceThreshold(
    modelTuning?.intentConfidenceThreshold
  );
  const maxRecentConversationTurns =
    modelTuning?.maxRecentConversationTurns ?? MAX_CONVERSATION_TURNS_CAP;

  const intentBuilt = buildAnonymizedIntentPrompt({
    dateContext: buildDateContextLine(businessTodayIso(businessProfile?.timezone)),
    brainDump,
    wbsHeads,
    activeHead,
    teamMembers,
    tasks,
    categorySops,
    systemMemory,
    businessProfile,
    ownerProfile,
    taskSplittingRules,
    conversationHistory,
    maxRecentConversationTurns,
  });

  const maxSteps = taskSplittingRules?.maxChecklistStepsPerTask ?? 5;
  const resolvedValidationCtx: MeditateValidationContext = {
    roster: teamMembers,
    categoryIds: categorySops.map((c: any) => c.categoryId),
    existingTasks: tasks,
    defaultAccountablePhone: intentBuilt.slotDirectory.defaultAccountablePhone,
    ownerProfile,
    maxChecklistStepsPerTask: maxSteps,
    allowResolvedPhonesInRaci: true,
  };

  // Chip confirmation fast-paths for NOTE / RULE / CASUAL (deterministic, zero LLM calls)
  if (
    confirmedIntentKind === 'NOTE' ||
    confirmedIntentKind === 'RULE' ||
    confirmedIntentKind === 'CASUAL'
  ) {
    const syntheticIntent: MeditateIntentStageOutput = {
      kind: confirmedIntentKind,
      confidence: 1,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: '',
      ruleCategory: confirmedIntentKind === 'RULE' ? 'BUSINESS_RULE' : null,
    };
  const ownerLanguage = resolveOwnerPreferredLanguage(teamMembers, ownerProfile, businessProfile);
  const routed = routeMeditateV2Intent(syntheticIntent, {
    confidenceThreshold,
    confirmedKind: confirmedIntentKind,
    ownerLanguage,
  });
    const nonPlanner = buildV2NonPlannerResponse({
      route: routed.route as Exclude<MeditateV2RouteOutcome, 'RUN_PLANNER'>,
      intent: syntheticIntent,
      replyToOwner: routed.replyToOwner,
      confirmChips: routed.confirmChips,
      rawBrainDump: brainDump,
      slotDirectory: intentBuilt.slotDirectory,
    });
    const valCheck = validateMeditatePlan(nonPlanner, resolvedValidationCtx);
    const safePayload = valCheck.valid
      ? valCheck.normalizedPlan
      : buildValidationFailureClarification(valCheck.issues, intentBuilt.slotDirectory);
    return {
      ...safePayload,
      meditateEngineUsed: 'v2' as const,
      aiLogs: [],
    };
  }

  // Chip confirmation for TASK when missingCritical is already known -> ask ONE combined question, no planning
  const cleanPriorMissing = Array.isArray(priorMissingCritical)
    ? priorMissingCritical.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  if (confirmedIntentKind === 'TASK' && cleanPriorMissing.length > 0) {
    const syntheticTaskMissing: MeditateIntentStageOutput = {
      kind: 'TASK',
      confidence: 1,
      missingCritical: cleanPriorMissing,
      followUpForHeadId: priorFollowUpForHeadId ?? null,
      replyToOwner: '',
    };
    const routed = routeMeditateV2Intent(syntheticTaskMissing, {
      confidenceThreshold,
      confirmedKind: 'TASK',
      ownerLanguage: resolveOwnerPreferredLanguage(teamMembers, ownerProfile, businessProfile),
    });
    const nonPlanner = buildV2NonPlannerResponse({
      route: 'ASK_CLARIFYING_QUESTION',
      intent: syntheticTaskMissing,
      replyToOwner: routed.replyToOwner,
      confirmChips: [],
      rawBrainDump: brainDump,
      slotDirectory: intentBuilt.slotDirectory,
    });
    const valCheck = validateMeditatePlan(nonPlanner, resolvedValidationCtx);
    const safePayload = valCheck.valid
      ? valCheck.normalizedPlan
      : buildValidationFailureClarification(valCheck.issues, intentBuilt.slotDirectory);
    return {
      ...safePayload,
      meditateEngineUsed: 'v2' as const,
      aiLogs: [],
    };
  }

  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    const activeStage = confirmedIntentKind === 'TASK' ? 'PLANNER' : 'INTENT';
    const cfg = activeStage === 'PLANNER' ? plannerStageCfg : intentStageCfg;
    const fallback = buildFallbackMeditateResponse({
      fallbackReason: 'Missing GEMINI_API_KEY',
    });
    const aiLog = createAiCallLog({
      tenantId,
      stage: activeStage,
      model: `${cfg.model} (honest-fallback)`,
      temperature: cfg.temperature,
      maxOutputTokens: cfg.maxOutputTokens,
      latencyMs: Date.now() - startMs,
      validationStatus: 'FALLBACK_USED',
      validationNote: `Missing GEMINI_API_KEY [engine=v2, stage=${activeStage}]; returned honest clarification fallback`,
      turnsSent: intentBuilt.historyCapped.recentTurnsCount,
      olderTurnsSummarized: intentBuilt.historyCapped.olderTurnsSummarizedCount,
    });
    return { ...fallback, meditateEngineUsed: 'v2' as const, aiLog, aiLogs: [aiLog] };
  }

  const ai = createGeminiClient(apiKey);
  const aiLogs: AiCallLogEntry[] = [];
  let validatedIntent: MeditateIntentStageOutput | null = null;
  let lastModelUsed = intentStageCfg.model;

  // STAGE 1: INTENT GATE (skipped only when owner already clicked "Make it a task")
  if (confirmedIntentKind !== 'TASK') {
    const intentStartMs = Date.now();
    const { response: intentResp, modelUsed: intentModel } = await generateWithFallbackModel(
      ai,
      intentStageCfg.model,
      intentStageCfg.fallbackModel,
      intentBuilt.prompt,
      {
        systemInstruction: intentBuilt.systemInstruction,
        temperature: intentStageCfg.temperature,
        maxOutputTokens: intentStageCfg.maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: V2_INTENT_SCHEMA,
      }
    );
    lastModelUsed = intentModel;
    const intentLatencyMs = Date.now() - intentStartMs;
    const rawIntentParsed = JSON.parse((intentResp.text ?? '{}').trim());

    const firstIntentVal = validateIntentStageOutput(rawIntentParsed, {
      roster: teamMembers,
      validHeadIds: intentBuilt.validHeadIds,
    });

    if (firstIntentVal.valid && firstIntentVal.normalizedIntent) {
      validatedIntent = firstIntentVal.normalizedIntent;
      aiLogs.push(
        createAiCallLog({
          tenantId,
          stage: 'INTENT',
          model: intentModel,
          temperature: intentStageCfg.temperature,
          maxOutputTokens: intentStageCfg.maxOutputTokens,
          latencyMs: intentLatencyMs,
          validationStatus: 'VALID',
          validationNote: `INTENT=${validatedIntent.kind} (conf=${validatedIntent.confidence.toFixed(
            2
          )})${intentBuilt.piiAudit.clean ? ' | Zero-PII Verified' : ''}`,
          turnsSent: intentBuilt.historyCapped.recentTurnsCount,
          olderTurnsSummarized: intentBuilt.historyCapped.olderTurnsSummarizedCount,
        })
      );
    } else {
      aiLogs.push(
        createAiCallLog({
          tenantId,
          stage: 'INTENT',
          model: intentModel,
          temperature: intentStageCfg.temperature,
          maxOutputTokens: intentStageCfg.maxOutputTokens,
          latencyMs: intentLatencyMs,
          validationStatus: 'ERROR',
          validationNote: `INTENT failed validator (${firstIntentVal.issues
            .map((i) => i.code)
            .join(', ')}); attempting 1-pass repair`,
          turnsSent: intentBuilt.historyCapped.recentTurnsCount,
          olderTurnsSummarized: intentBuilt.historyCapped.olderTurnsSummarizedCount,
        })
      );

      const repairIntentStartMs = Date.now();
      const intentRepairPrompt = buildIntentRepairPrompt(
        intentBuilt.prompt,
        rawIntentParsed,
        firstIntentVal.issues
      );
      try {
        const { response: repIntentResp, modelUsed: repIntentModel } =
          await generateWithFallbackModel(
            ai,
            intentStageCfg.model,
            intentStageCfg.fallbackModel,
            intentRepairPrompt,
            {
              systemInstruction: intentBuilt.systemInstruction,
              temperature: intentStageCfg.temperature,
              maxOutputTokens: intentStageCfg.maxOutputTokens,
              responseMimeType: 'application/json',
              responseSchema: V2_INTENT_SCHEMA,
            }
          );
        lastModelUsed = repIntentModel;
        const repIntentLatencyMs = Date.now() - repairIntentStartMs;
        const repIntentParsed = JSON.parse((repIntentResp.text ?? '{}').trim());
        const secondIntentVal = validateIntentStageOutput(repIntentParsed, {
          roster: teamMembers,
          validHeadIds: intentBuilt.validHeadIds,
        });

        if (secondIntentVal.valid && secondIntentVal.normalizedIntent) {
          validatedIntent = secondIntentVal.normalizedIntent;
          aiLogs.push(
            createAiCallLog({
              tenantId,
              stage: 'INTENT',
              model: repIntentModel,
              temperature: intentStageCfg.temperature,
              maxOutputTokens: intentStageCfg.maxOutputTokens,
              latencyMs: repIntentLatencyMs,
              validationStatus: 'SCHEMA_REPAIRED',
              validationNote: `INTENT repaired in 1 retry (kind=${validatedIntent.kind})`,
              turnsSent: intentBuilt.historyCapped.recentTurnsCount,
              olderTurnsSummarized: intentBuilt.historyCapped.olderTurnsSummarizedCount,
            })
          );
        } else {
          const failLog = createAiCallLog({
            tenantId,
            stage: 'INTENT',
            model: repIntentModel,
            temperature: intentStageCfg.temperature,
            maxOutputTokens: intentStageCfg.maxOutputTokens,
            latencyMs: repIntentLatencyMs,
            validationStatus: 'ERROR',
            validationNote: `INTENT repair still failed (${secondIntentVal.issues
              .map((i) => i.code)
              .join(', ')})`,
            turnsSent: intentBuilt.historyCapped.recentTurnsCount,
            olderTurnsSummarized: intentBuilt.historyCapped.olderTurnsSummarizedCount,
          });
          aiLogs.push(failLog);
          const clarification = buildValidationFailureClarification(
            secondIntentVal.issues,
            intentBuilt.slotDirectory
          );
          return {
            ...clarification,
            modelUsed: repIntentModel,
            meditateEngineUsed: 'v2' as const,
            aiLog: failLog,
            aiLogs,
          };
        }
      } catch (repErr: any) {
        const errLog = createAiCallLog({
          tenantId,
          stage: 'INTENT',
          model: `${intentStageCfg.model} (repair-failed)`,
          temperature: intentStageCfg.temperature,
          maxOutputTokens: intentStageCfg.maxOutputTokens,
          latencyMs: Date.now() - repairIntentStartMs,
          validationStatus: 'ERROR',
          validationNote: `INTENT repair call failed: ${repErr?.message || 'Unknown error'}`,
        });
        aiLogs.push(errLog);
        const clarification = buildValidationFailureClarification(
          firstIntentVal.issues,
          intentBuilt.slotDirectory
        );
        return {
          ...clarification,
          meditateEngineUsed: 'v2' as const,
          aiLog: errLog,
          aiLogs,
        };
      }
    }

    // Deterministic routing on validated INTENT output
    const routed = routeMeditateV2Intent(validatedIntent, {
      confidenceThreshold,
      ownerLanguage: resolveOwnerPreferredLanguage(teamMembers, ownerProfile, businessProfile),
    });

    if (routed.route !== 'RUN_PLANNER') {
      const replyStr =
        routed.route === 'ANSWER_QUESTION' && !routed.replyToOwner.trim()
          ? answerQuestionFromTasksFallback(tasks, intentBuilt.slotDirectory)
          : routed.replyToOwner;

      const nonPlanner = buildV2NonPlannerResponse({
        route: routed.route,
        intent: validatedIntent,
        replyToOwner: replyStr,
        confirmChips: routed.confirmChips,
        rawBrainDump: brainDump,
        slotDirectory: intentBuilt.slotDirectory,
      });

      const nonPlannerVal = validateMeditatePlan(nonPlanner, resolvedValidationCtx);
      const safeOut = nonPlannerVal.valid
        ? nonPlannerVal.normalizedPlan
        : buildValidationFailureClarification(nonPlannerVal.issues, intentBuilt.slotDirectory);

      const lastLog = aiLogs[aiLogs.length - 1];
      return {
        ...safeOut,
        modelUsed: lastModelUsed,
        meditateEngineUsed: 'v2' as const,
        aiLog: lastLog,
        aiLogs,
      };
    }
  }

  // STAGE 2: PLANNER (runs ONLY for confirmed TASK with empty missingCritical)
  let targetFollowUpId =
    confirmedIntentKind === 'TASK'
      ? priorFollowUpForHeadId ?? null
      : (validatedIntent?.followUpForHeadId ?? priorFollowUpForHeadId ?? null);
  let followUpHead = targetFollowUpId
    ? (Array.isArray(wbsHeads)
        ? wbsHeads.find((h: any) => h?.headId === targetFollowUpId)
        : null) || (activeHead?.headId === targetFollowUpId ? activeHead : null)
    : null;

  if (!confirmedIntentKind && followUpHead) {
    const relevance = assessFollowUpRelevance(brainDump, followUpHead);
    if (relevance === 'UNRELATED') {
      targetFollowUpId = null;
      followUpHead = null;
    } else if (relevance === 'AMBIGUOUS') {
      const slotDirectory = buildSlotDirectory(teamMembers, ownerProfile);
      const clarifyText = `New task, or add to "${followUpHead.title}"?`;
      const clarifyResp = buildV2NonPlannerResponse({
        route: 'AWAIT_OWNER_CONFIRMATION',
        intent: {
          kind: 'TASK',
          confidence: validatedIntent?.confidence ?? 0.65,
          missingCritical: [],
          followUpForHeadId: followUpHead.headId,
          replyToOwner: clarifyText,
        },
        replyToOwner: clarifyText,
        rawBrainDump: brainDump,
        slotDirectory,
        confirmChips: [
          { label: 'Start new plan', kind: 'TASK', followUpForHeadId: null },
          {
            label: `Add to "${String(followUpHead.title || '').slice(0, 28)}"`,
            kind: 'TASK',
            followUpForHeadId: followUpHead.headId,
          },
        ],
      });
      return {
        ...clarifyResp,
        modelUsed: lastModelUsed,
        meditateEngineUsed: 'v2' as const,
        aiLog: aiLogs[aiLogs.length - 1],
        aiLogs,
      };
    }
  }

  const plannerBuilt = buildAnonymizedPlannerPrompt({
    dateContext: buildDateContextLine(businessTodayIso(businessProfile?.timezone)),
    brainDump,
    followUpHead,
    teamMembers,
    tasks,
    categorySops,
    systemMemory,
    principalPrompts,
    businessProfile,
    ownerProfile,
    taskSplittingRules,
    sampleBrainDumps,
    conversationHistory,
    maxRecentConversationTurns,
  });

  const plannerValidationCtx: MeditateValidationContext = {
    roster: teamMembers,
    categoryIds: categorySops.map((c: any) => c.categoryId),
    existingTasks: tasks,
    defaultAccountableSlot: plannerBuilt.slotDirectory.defaultAccountableSlot,
    ownerProfile,
    maxChecklistStepsPerTask: plannerBuilt.maxStepsPerTask,
    allowResolvedPhonesInRaci: false,
  };

  // Dates like "tomorrow" count from today in the business timezone, not UTC.
  const todayIso = businessTodayIso(businessProfile?.timezone);
  const plannerStartMs = Date.now();

  const { response: plannerResp, modelUsed: plannerModel } = await generateWithFallbackModel(
    ai,
    plannerStageCfg.model,
    plannerStageCfg.fallbackModel,
    plannerBuilt.prompt,
    {
      systemInstruction: plannerBuilt.systemInstruction,
      temperature: plannerStageCfg.temperature,
      maxOutputTokens: plannerStageCfg.maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: V2_PLANNER_SCHEMA,
      ...thinkingConfigFor(plannerStageCfg),
    }
  );

  const firstPlannerLatencyMs = Date.now() - plannerStartMs;
  const rawPlannerParsed = JSON.parse((plannerResp.text ?? '{}').trim());
  const hydratedFirst = hydratePlannerDefaults(rawPlannerParsed, {
    referenceDate: todayIso,
    categorySops,
  });

  const firstPlanCheck = validateMeditatePlan(hydratedFirst, plannerValidationCtx);

  const effectiveIntentMeta: MeditateIntentStageOutput = validatedIntent || {
    kind: 'TASK',
    confidence: 1,
    missingCritical: [],
    followUpForHeadId: targetFollowUpId,
    replyToOwner: hydratedFirst?.chatReplyToBoss || '',
  };

  if (firstPlanCheck.valid) {
    const withMeta = {
      ...firstPlanCheck.normalizedPlan,
      v2Intent: effectiveIntentMeta,
      v2Route: 'RUN_PLANNER' as const,
    };
    const deanonymized = deanonymizeMeditateResponse(
      withMeta,
      plannerBuilt.slotDirectory,
      plannerBuilt.maxStepsPerTask,
      todayIso
    );
    const plannerOkLog = createAiCallLog({
      tenantId,
      stage: 'PLANNER',
      model: plannerModel,
      temperature: plannerStageCfg.temperature,
      maxOutputTokens: plannerStageCfg.maxOutputTokens,
      latencyMs: firstPlannerLatencyMs,
      validationStatus: 'VALID',
      validationNote: `Passed validator [engine=v2, lane=${deanonymized.lane || 'QUICK'}]${
        plannerBuilt.piiAudit.clean ? ' | Zero-PII Verified' : ''
      }`,
      turnsSent: plannerBuilt.historyCapped.recentTurnsCount,
      olderTurnsSummarized: plannerBuilt.historyCapped.olderTurnsSummarizedCount,
    });
    aiLogs.push(plannerOkLog);

    return {
      ...deanonymized,
      modelUsed: plannerModel,
      meditateEngineUsed: 'v2' as const,
      aiLog: plannerOkLog,
      aiLogs,
    };
  }

  // First PLANNER pass failed validator -> log ERROR and attempt 1-pass repair
  aiLogs.push(
    createAiCallLog({
      tenantId,
      stage: 'PLANNER',
      model: plannerModel,
      temperature: plannerStageCfg.temperature,
      maxOutputTokens: plannerStageCfg.maxOutputTokens,
      latencyMs: firstPlannerLatencyMs,
      validationStatus: 'ERROR',
      validationNote: `Initial v2 PLANNER failed validator (${firstPlanCheck.issues.length} issue(s): ${firstPlanCheck.issues
        .map((i) => i.code)
        .join(', ')}); attempting 1-pass repair`,
      turnsSent: plannerBuilt.historyCapped.recentTurnsCount,
      olderTurnsSummarized: plannerBuilt.historyCapped.olderTurnsSummarizedCount,
    })
  );

  const repairPlannerStartMs = Date.now();
  const plannerRepairPrompt = buildPlanRepairPrompt(
    plannerBuilt.prompt,
    hydratedFirst,
    firstPlanCheck.issues
  );

  try {
    const { response: repPlanResp, modelUsed: repPlanModel } = await generateWithFallbackModel(
      ai,
      plannerStageCfg.model,
      plannerStageCfg.fallbackModel,
      plannerRepairPrompt,
      {
        systemInstruction: plannerBuilt.systemInstruction,
        temperature: plannerStageCfg.temperature,
        maxOutputTokens: plannerStageCfg.maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: V2_PLANNER_SCHEMA,
        ...thinkingConfigFor(plannerStageCfg),
      }
    );

    const repPlannerLatencyMs = Date.now() - repairPlannerStartMs;
    const repRawParsed = JSON.parse((repPlanResp.text ?? '{}').trim());
    const hydratedSecond = hydratePlannerDefaults(repRawParsed, {
      referenceDate: todayIso,
      categorySops,
    });
    const secondPlanCheck = validateMeditatePlan(hydratedSecond, plannerValidationCtx);

    if (secondPlanCheck.valid) {
      const withMeta = {
        ...secondPlanCheck.normalizedPlan,
        v2Intent: effectiveIntentMeta,
        v2Route: 'RUN_PLANNER' as const,
      };
      const deanonymized = deanonymizeMeditateResponse(
        withMeta,
        plannerBuilt.slotDirectory,
        plannerBuilt.maxStepsPerTask,
        todayIso
      );
      const repOkLog = createAiCallLog({
        tenantId,
        stage: 'PLANNER',
        model: repPlanModel,
        temperature: plannerStageCfg.temperature,
        maxOutputTokens: plannerStageCfg.maxOutputTokens,
        latencyMs: repPlannerLatencyMs,
        validationStatus: 'SCHEMA_REPAIRED',
        validationNote: `v2 PLANNER repaired in 1 retry (resolved ${firstPlanCheck.issues.length} issue(s))`,
        turnsSent: plannerBuilt.historyCapped.recentTurnsCount,
        olderTurnsSummarized: plannerBuilt.historyCapped.olderTurnsSummarizedCount,
      });
      aiLogs.push(repOkLog);

      return {
        ...deanonymized,
        modelUsed: repPlanModel,
        meditateEngineUsed: 'v2' as const,
        aiLog: repOkLog,
        aiLogs,
      };
    }

    const clarification = buildValidationFailureClarification(
      secondPlanCheck.issues,
      plannerBuilt.slotDirectory
    );
    const repFailLog = createAiCallLog({
      tenantId,
      stage: 'PLANNER',
      model: repPlanModel,
      temperature: plannerStageCfg.temperature,
      maxOutputTokens: plannerStageCfg.maxOutputTokens,
      latencyMs: repPlannerLatencyMs,
      validationStatus: 'ERROR',
      validationNote: `v2 PLANNER repair still failed (${secondPlanCheck.issues
        .map((i) => i.code)
        .join(', ')})`,
      turnsSent: plannerBuilt.historyCapped.recentTurnsCount,
      olderTurnsSummarized: plannerBuilt.historyCapped.olderTurnsSummarizedCount,
    });
    aiLogs.push(repFailLog);

    return {
      ...clarification,
      modelUsed: repPlanModel,
      meditateEngineUsed: 'v2' as const,
      aiLog: repFailLog,
      aiLogs,
    };
  } catch (repPlanErr: any) {
    const clarification = buildValidationFailureClarification(
      firstPlanCheck.issues,
      plannerBuilt.slotDirectory
    );
    const repErrLog = createAiCallLog({
      tenantId,
      stage: 'PLANNER',
      model: `${plannerStageCfg.model} (repair-failed)`,
      temperature: plannerStageCfg.temperature,
      maxOutputTokens: plannerStageCfg.maxOutputTokens,
      latencyMs: Date.now() - repairPlannerStartMs,
      validationStatus: 'ERROR',
      validationNote: `v2 PLANNER repair API call failed: ${repPlanErr?.message || 'Unknown error'}`,
    });
    aiLogs.push(repErrLog);

    return {
      ...clarification,
      meditateEngineUsed: 'v2' as const,
      aiLog: repErrLog,
      aiLogs,
    };
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      meditateEngine: resolveMeditateEngine({ envEngine: process.env.MEDITATE_ENGINE }),
      storage: isCloudServerMode() ? 'cloud' : 'local',
    });
  });

  // Guest Demo registration (stores lead cleanly outside tenant workspaces and never reads/writes owner data).
  app.post('/api/demo/register', async (req, res) => {
    const parsed = validateDemoLeadInput({
      name: req.body?.name,
      email: req.body?.email,
      phone: req.body?.phone,
    });
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    let leadId = `local-${Date.now()}`;
    if (isCloudServerMode()) {
      try {
        const created = await addDemoLeadAdmin({
          ...parsed.lead,
          userAgent: String(req.headers['user-agent'] || '').slice(0, 240),
        });
        leadId = created.id;
      } catch (err: any) {
        const message = String(err?.message || err || 'Firestore write failed');
        console.error(`[demo/register] Failed to save demo lead to Firestore: ${message}`);
        return res.status(500).json({
          error: 'Could not save demo registration on the server. Please try again.',
        });
      }
    }
    const leadWithId = { ...parsed.lead, leadId };
    res.json({ ok: true, lead: leadWithId, leadId });
  });

  // Strict owner-only guard for reading or removing `demoLeads` (refuses Demo Mode and verifies ALLOWED_EMAILS).
  const requireAllowedOwner: express.RequestHandler = async (req, res, next) => {
    if (req.headers['x-demo-mode'] === 'true') {
      return res.status(403).json({ error: 'Demo sessions cannot access owner visitor records.' });
    }
    if (!isCloudServerMode()) {
      return res.status(503).json({ error: 'Firebase Admin cloud storage is required for Demo Visitors.' });
    }
    const user = await verifyRequestUser(req.headers.authorization);
    if (user.status === 'SIGNED_OUT') {
      return res.status(401).json({ error: 'Please sign in again.' });
    }
    if (user.status === 'NOT_AUTHORISED') {
      console.warn(`[auth] Refused /api/demo/leads from non-allowed account (${user.reason}).`);
      return res.status(403).json({ error: 'Not authorised', code: 'NOT_AUTHORISED' });
    }
    res.locals.uid = user.uid;
    next();
  };

  app.get('/api/demo/leads', requireAllowedOwner, async (_req, res) => {
    try {
      const visitors = await listDemoLeadsAdmin();
      res.json({ visitors });
    } catch (err: any) {
      console.error(`[demo/leads] Failed to read demoLeads: ${String(err?.message || err)}`);
      res.status(500).json({ error: 'Could not load demo visitors from Firestore.' });
    }
  });

  app.delete('/api/demo/leads/:leadId', requireAllowedOwner, async (req, res) => {
    try {
      const leadId = String(req.params.leadId || '').trim();
      const deleted = await deleteDemoLeadAdmin(leadId);
      if (!deleted) {
        return res.status(404).json({ error: 'Visitor entry not found.' });
      }
      res.json({ ok: true, deletedId: leadId });
    } catch (err: any) {
      const msg = String(err?.message || 'Could not delete visitor entry.');
      const status = /invalid visitor id/i.test(msg) ? 400 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // Sliding-window rate limit for unauthenticated Guest Demo AI requests (40 requests / 15 min per IP).
  const demoAiRateWindow = new Map<string, number[]>();
  const DEMO_AI_WINDOW_MS = 15 * 60_000;
  const DEMO_AI_MAX_REQUESTS = 40;
  function allowDemoAiRequest(ip: string): boolean {
    const now = Date.now();
    const recent = (demoAiRateWindow.get(ip) || []).filter((ts) => now - ts < DEMO_AI_WINDOW_MS);
    if (recent.length >= DEMO_AI_MAX_REQUESTS) {
      demoAiRateWindow.set(ip, recent);
      return false;
    }
    recent.push(now);
    demoAiRateWindow.set(ip, recent);
    return true;
  }

  // Milestone 5A: in cloud mode every AI and scheduler call needs a signed-in user whose
  // email is in ALLOWED_EMAILS, OR an explicit isolated Guest Demo request on /api/ai & /api/jobs.
  const requireSignedIn: express.RequestHandler = async (req, res, next) => {
    const isDemoHeader = req.headers['x-demo-mode'] === 'true' && !req.headers.authorization;
    const isAuthEndpoint = req.originalUrl.startsWith('/api/auth');
    if (isDemoHeader && !isAuthEndpoint) {
      if (req.originalUrl.startsWith('/api/ai')) {
        const clientIp = String(req.headers['x-forwarded-for'] || req.ip || 'unknown')
          .split(',')[0]
          .trim();
        if (!allowDemoAiRequest(clientIp)) {
          return res.status(429).json({
            error: 'Demo AI limit reached for this session (40 requests per 15 minutes). Please wait a few minutes or sign in.',
          });
        }
        const rawLeadId = String(req.headers['x-demo-lead-id'] || '').trim();
        if (rawLeadId && isCloudServerMode()) {
          const isMeditateCall = req.originalUrl.split('?')[0] === '/api/ai/meditate';
          void incrementDemoLeadAiUsageAdmin(rawLeadId, isMeditateCall);
        }
      }
      res.locals.isDemo = true;
      return next();
    }

    if (!isCloudServerMode()) return next();
    const user = await verifyRequestUser(req.headers.authorization);
    if (user.status === 'SIGNED_OUT') {
      return res.status(401).json({ error: 'Please sign in again.' });
    }
    if (user.status === 'NOT_AUTHORISED') {
      console.warn(`[auth] Refused a request from a signed-in account that is not allowed (${user.reason}).`);
      return res.status(403).json({ error: 'Not authorised', code: 'NOT_AUTHORISED' });
    }
    res.locals.uid = user.uid;
    next();
  };
  app.use('/api/ai', requireSignedIn);
  app.use('/api/jobs', requireSignedIn);
  app.use('/api/auth', requireSignedIn);

  // Called by the browser right after sign-in: 200 only for an allowed account.
  app.get('/api/auth/check', (_req, res) => {
    res.json({ allowed: isCloudServerMode(), storage: isCloudServerMode() ? 'cloud' : 'local' });
  });

  app.post('/api/ai/meditate', async (req, res) => {
    const startMs = Date.now();
    const {
      tenantId = DEFAULT_TENANT_ID,
      brainDump,
      activeHead,
      wbsHeads = [],
      confirmedIntentKind,
      priorMissingCritical,
      priorFollowUpForHeadId,
      teamMembers = [],
      tasks = [],
      categorySops = [],
      systemMemory = [],
      principalPrompts,
      businessProfile,
      ownerProfile,
      taskSplittingRules,
      sampleBrainDumps = [],
      conversationHistory = [],
      modelTuning,
      stageConfig: rawStageOverride,
    } = req.body || {};

    const activeEngine = resolveMeditateEngine({
      envEngine: process.env.MEDITATE_ENGINE,
    });

    const stageCfg = resolveStageModelConfig(
      'MEDITATE_PLANNING',
      modelTuning,
      rawStageOverride
    );

    try {
      if (!brainDump || typeof brainDump !== 'string' || !brainDump.trim()) {
        res
          .status(400)
          .json({ error: 'Please enter an operational problem or agenda brain-dump first.' });
        return;
      }

      if (activeEngine === 'v2') {
        const v2Response = await handleMeditateV2Request({
          startMs,
          tenantId,
          brainDump,
          activeHead,
          wbsHeads,
          confirmedIntentKind,
          priorMissingCritical,
          priorFollowUpForHeadId,
          teamMembers,
          tasks,
          categorySops,
          systemMemory,
          principalPrompts,
          businessProfile,
          ownerProfile,
          taskSplittingRules,
          sampleBrainDumps,
          conversationHistory,
          modelTuning,
          rawStageOverride,
        });
        res.json(v2Response);
        return;
      }

      const built = buildAnonymizedMeditatePrompt({
        dateContext: buildDateContextLine(businessTodayIso(businessProfile?.timezone)),
        brainDump,
        activeHead,
        teamMembers,
        tasks,
        categorySops,
        systemMemory,
        principalPrompts,
        businessProfile,
        ownerProfile,
        taskSplittingRules,
        sampleBrainDumps,
        conversationHistory,
        maxRecentConversationTurns:
          modelTuning?.maxRecentConversationTurns ?? MAX_CONVERSATION_TURNS_CAP,
      });

      const apiKey = getConfiguredApiKey();
      if (!apiKey) {
        const fallback = buildFallbackMeditateResponse({
          fallbackReason: 'Missing GEMINI_API_KEY',
        });
        const aiLog = createAiCallLog({
          tenantId,
          stage: 'MEDITATE_PLANNING',
          model: `${stageCfg.model} (honest-fallback)`,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          latencyMs: Date.now() - startMs,
          validationStatus: 'FALLBACK_USED',
          validationNote: `Missing GEMINI_API_KEY [engine=${activeEngine}]; returned honest clarification fallback`,
          turnsSent: built.historyCapped.recentTurnsCount,
          olderTurnsSummarized: built.historyCapped.olderTurnsSummarizedCount,
        });
        res.json({ ...fallback, meditateEngineUsed: activeEngine, aiLog, aiLogs: [aiLog] });
        return;
      }

      const ai = createGeminiClient(apiKey);

      const schema = {
        type: Type.OBJECT,
        properties: {
          intentClassification: {
            type: Type.STRING,
            enum: ['CASUAL_OR_TEST', 'NEEDS_CLARIFICATION', 'ACTIONABLE_AGENDA'],
          },
          chatReplyToBoss: { type: Type.STRING },
          reasoningSummary: { type: Type.STRING },
          agendaTitle: { type: Type.STRING },
          agendaQuadrant: {
            type: Type.STRING,
            enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'],
          },
          agendaMajorOrMinor: {
            type: Type.STRING,
            enum: ['MAJOR', 'MINOR'],
          },
          suggestedMemoryRules: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                category: {
                  type: Type.STRING,
                  enum: ['BUSINESS_RULE', 'VENDOR_FACT', 'STAFF_TRAIT', 'SOP_PREFERENCE'],
                },
                fact: { type: Type.STRING },
              },
              required: ['category', 'fact'],
            },
          },
          // Owner edits the AI changed only because the owner's new message explicitly asked.
          overriddenOwnerEdits: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                tempId: { type: Type.STRING },
                field: { type: Type.STRING },
                quote: { type: Type.STRING, nullable: true },
              },
              required: ['tempId', 'field'],
            },
          },
          draftedTasks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                // Existing task's tempId when refining a plan (null for a new task).
                tempId: { type: Type.STRING, nullable: true },
                title: { type: Type.STRING },
                shortTag: { type: Type.STRING },
                categoryId: { type: Type.STRING },
                quadrant: {
                  type: Type.STRING,
                  enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'],
                },
                majorOrMinor: {
                  type: Type.STRING,
                  enum: ['MAJOR', 'MINOR'],
                },
                taskFrequency: {
                  type: Type.STRING,
                  enum: ['ONE_TIME', 'RECURRING'],
                },
                recurrenceRule: {
                  type: Type.STRING,
                  enum: ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'],
                },
                raci: {
                  type: Type.OBJECT,
                  properties: {
                    R: { type: Type.STRING },
                    A: { type: Type.STRING, nullable: true },
                    C: { type: Type.ARRAY, items: { type: Type.STRING } },
                    I: { type: Type.ARRAY, items: { type: Type.STRING } },
                  },
                  required: ['R', 'A', 'C', 'I'],
                },
                dependsOnSubtaskIndex: { type: Type.INTEGER, nullable: true },
                triggerCondition: {
                  type: Type.STRING,
                  enum: ['FULL_COMPLETION', 'PARTIAL_OR_BOSS_APPROVAL'],
                },
                dueDateOffsetDays: { type: Type.INTEGER },
                startDate: { type: Type.STRING, nullable: true },
                durationDays: { type: Type.NUMBER, nullable: true },
                isForcedDeadline: { type: Type.BOOLEAN, nullable: true },
                forcedDeadlineDate: { type: Type.STRING, nullable: true },
                wbsHeadId: { type: Type.STRING, nullable: true },
                swimlaneStage: { type: Type.STRING, nullable: true },
                microSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
                outboundWhatsappPreview: { type: Type.STRING },
              },
              required: [
                'title',
                'shortTag',
                'categoryId',
                'quadrant',
                'majorOrMinor',
                'taskFrequency',
                'recurrenceRule',
                'raci',
                'triggerCondition',
                'dueDateOffsetDays',
                'microSteps',
                'outboundWhatsappPreview',
              ],
            },
          },
          wbsHeads: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                headId: { type: Type.STRING },
                title: { type: Type.STRING },
                domainCategory: { type: Type.STRING },
                contextSummary: { type: Type.STRING },
                quadrant: {
                  type: Type.STRING,
                  enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'],
                },
                majorOrMinor: {
                  type: Type.STRING,
                  enum: ['MAJOR', 'MINOR'],
                },
                tentativeDurationDays: { type: Type.NUMBER },
                tentativeStartDate: { type: Type.STRING },
                tentativeDeadline: { type: Type.STRING },
                isForcedDeadline: { type: Type.BOOLEAN },
                dynamicStages: { type: Type.ARRAY, items: { type: Type.STRING } },
                involvedPhones: { type: Type.ARRAY, items: { type: Type.STRING } },
                status: {
                  type: Type.STRING,
                  enum: ['DRAFT_HEAD', 'SWIMLANE_READY', 'FROZEN_DISPATCHED'],
                },
              },
              required: [
                'headId',
                'title',
                'domainCategory',
                'contextSummary',
                'quadrant',
                'majorOrMinor',
                'tentativeDurationDays',
                'tentativeStartDate',
                'tentativeDeadline',
                'isForcedDeadline',
                'dynamicStages',
                'involvedPhones',
                'status',
              ],
            },
          },
        },
        required: [
          'intentClassification',
          'chatReplyToBoss',
          'reasoningSummary',
          'agendaTitle',
          'agendaQuadrant',
          'agendaMajorOrMinor',
          'suggestedMemoryRules',
          'draftedTasks',
          'wbsHeads',
        ],
      };

      const { response, modelUsed } = await generateWithFallbackModel(
        ai,
        stageCfg.model,
        stageCfg.fallbackModel,
        built.prompt,
        {
          systemInstruction: built.systemInstruction,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema: schema,
        }
      );

      const firstCallLatencyMs = Date.now() - startMs;
      const rawParsed = JSON.parse((response.text ?? '{}').trim());

      const validationCtx: MeditateValidationContext = {
        roster: teamMembers,
        categoryIds: categorySops.map((c: any) => c.categoryId),
        existingTasks: tasks,
        defaultAccountableSlot: built.slotDirectory.defaultAccountableSlot,
        ownerProfile,
        maxChecklistStepsPerTask: built.maxStepsPerTask,
        allowResolvedPhonesInRaci: false,
      };

      const firstValidation = validateMeditatePlan(rawParsed, validationCtx);

      if (firstValidation.valid) {
        const deanonymized = deanonymizeMeditateResponse(
          firstValidation.normalizedPlan,
          built.slotDirectory,
          built.maxStepsPerTask,
          businessTodayIso(businessProfile?.timezone)
        );

        const aiLog = createAiCallLog({
          tenantId,
          stage: 'MEDITATE_PLANNING',
          model: modelUsed,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          latencyMs: firstCallLatencyMs,
          validationStatus: 'VALID',
          validationNote: `Passed validator [engine=${activeEngine}]${
            built.piiAudit.clean ? ' | Zero-PII Verified' : ''
          }`,
          turnsSent: built.historyCapped.recentTurnsCount,
          olderTurnsSummarized: built.historyCapped.olderTurnsSummarizedCount,
        });

        res.json({
          ...deanonymized,
          modelUsed,
          meditateEngineUsed: activeEngine,
          aiLog,
          aiLogs: [aiLog],
        });
        return;
      }

      // First pass failed deterministic validation -> log attempt and send issues back ONCE for repair
      const initialFailLog = createAiCallLog({
        tenantId,
        stage: 'MEDITATE_PLANNING',
        model: modelUsed,
        temperature: stageCfg.temperature,
        maxOutputTokens: stageCfg.maxOutputTokens,
        latencyMs: firstCallLatencyMs,
        validationStatus: 'ERROR',
        validationNote: `Initial plan failed validator (${firstValidation.issues.length} issue(s): ${firstValidation.issues
          .map((i) => i.code)
          .join(', ')}); attempting 1-pass repair`,
        turnsSent: built.historyCapped.recentTurnsCount,
        olderTurnsSummarized: built.historyCapped.olderTurnsSummarizedCount,
      });

      const repairStartMs = Date.now();
      const repairPrompt = buildPlanRepairPrompt(
        built.prompt,
        rawParsed,
        firstValidation.issues
      );

      let repairLogs: AiCallLogEntry[] = [initialFailLog];

      try {
        const { response: repairResp, modelUsed: repairModelUsed } =
          await generateWithFallbackModel(
            ai,
            stageCfg.model,
            stageCfg.fallbackModel,
            repairPrompt,
            {
              systemInstruction: built.systemInstruction,
              temperature: stageCfg.temperature,
              maxOutputTokens: stageCfg.maxOutputTokens,
              responseMimeType: 'application/json',
              responseSchema: schema,
            }
          );

        const repairLatencyMs = Date.now() - repairStartMs;
        const repairedRaw = JSON.parse((repairResp.text ?? '{}').trim());
        const secondValidation = validateMeditatePlan(repairedRaw, validationCtx);

        if (secondValidation.valid) {
          const deanonymized = deanonymizeMeditateResponse(
            secondValidation.normalizedPlan,
            built.slotDirectory,
            built.maxStepsPerTask,
            businessTodayIso(businessProfile?.timezone)
          );
          const repairOkLog = createAiCallLog({
            tenantId,
            stage: 'MEDITATE_PLANNING',
            model: repairModelUsed,
            temperature: stageCfg.temperature,
            maxOutputTokens: stageCfg.maxOutputTokens,
            latencyMs: repairLatencyMs,
            validationStatus: 'SCHEMA_REPAIRED',
            validationNote: `Repaired in 1 retry [engine=${activeEngine}] (resolved ${firstValidation.issues.length} issue(s))`,
            turnsSent: built.historyCapped.recentTurnsCount,
            olderTurnsSummarized: built.historyCapped.olderTurnsSummarizedCount,
          });
          repairLogs.push(repairOkLog);

          res.json({
            ...deanonymized,
            modelUsed: repairModelUsed,
            meditateEngineUsed: activeEngine,
            aiLog: repairOkLog,
            aiLogs: repairLogs,
          });
          return;
        }

        // Still failing after 1 repair retry -> return NEEDS_CLARIFICATION listing issues for the owner
        const clarification = buildValidationFailureClarification(
          secondValidation.issues,
          built.slotDirectory
        );
        const repairFailLog = createAiCallLog({
          tenantId,
          stage: 'MEDITATE_PLANNING',
          model: repairModelUsed,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          latencyMs: repairLatencyMs,
          validationStatus: 'ERROR',
          validationNote: `Repair pass still failed validator (${secondValidation.issues.length} issue(s): ${secondValidation.issues
            .map((i) => i.code)
            .join(', ')})`,
          turnsSent: built.historyCapped.recentTurnsCount,
          olderTurnsSummarized: built.historyCapped.olderTurnsSummarizedCount,
        });
        repairLogs.push(repairFailLog);

        res.json({
          ...clarification,
          modelUsed: repairModelUsed,
          meditateEngineUsed: activeEngine,
          aiLog: repairFailLog,
          aiLogs: repairLogs,
        });
        return;
      } catch (repairErr: any) {
        const clarification = buildValidationFailureClarification(
          firstValidation.issues,
          built.slotDirectory
        );
        const repairErrLog = createAiCallLog({
          tenantId,
          stage: 'MEDITATE_PLANNING',
          model: `${stageCfg.model} (repair-failed)`,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          latencyMs: Date.now() - repairStartMs,
          validationStatus: 'ERROR',
          validationNote: `Repair API call failed: ${repairErr?.message || 'Unknown error'}`,
        });
        repairLogs.push(repairErrLog);

        res.json({
          ...clarification,
          meditateEngineUsed: activeEngine,
          aiLog: repairErrLog,
          aiLogs: repairLogs,
        });
        return;
      }
    } catch (err: any) {
      const userMessage = err instanceof GeminiCallFailedError ? err.userMessage : undefined;
      console.warn(
        'Meditate API warning (using honest fallback):',
        userMessage || String(err?.message || err).slice(0, 500)
      );
      const fallback = buildFallbackMeditateResponse({
        fallbackReason: err?.message || 'Gemini API request failed',
        userMessage,
      });
      const fallbackStage =
        activeEngine === 'v2'
          ? confirmedIntentKind === 'TASK'
            ? 'PLANNER'
            : 'INTENT'
          : 'MEDITATE_PLANNING';
      const fallbackCfg =
        activeEngine === 'v2'
          ? resolveStageModelConfig(fallbackStage, modelTuning, rawStageOverride)
          : stageCfg;
      const aiLog = createAiCallLog({
        tenantId,
        stage: fallbackStage,
        model: `${fallbackCfg.model} (honest-fallback)`,
        temperature: fallbackCfg.temperature,
        maxOutputTokens: fallbackCfg.maxOutputTokens,
        latencyMs: Date.now() - startMs,
        validationStatus: 'FALLBACK_USED',
        validationNote: err?.message || 'Gemini API request failed',
      });
      res.json({ ...fallback, meditateEngineUsed: activeEngine, aiLog, aiLogs: [aiLog] });
    }
  });

  // Batch 3: a task message as a voice note (Gemini text-to-speech), made when played.
  app.post('/api/ai/voice-note', async (req, res) => {
    const { text, teamMembers = [], ownerProfile, language = 'HINDI' } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'No message text to read out.' });
      return;
    }
    const apiKey = getConfiguredApiKey();
    if (!apiKey) {
      res.status(503).json({ error: 'Voice notes need a Gemini API key on the server.' });
      return;
    }
    const dir = buildSlotDirectory(Array.isArray(teamMembers) ? teamMembers : [], ownerProfile);
    const speechText = buildVoiceNoteSpeechText(text, dir);
    if (!speechText || !isVoiceNoteTextClean(speechText, dir)) {
      res.status(422).json({ error: 'This message could not be made safe to read out.' });
      return;
    }
    try {
      const ai = createGeminiClient(apiKey);
      const { response, modelUsed } = await generateWithFallbackModel(
        ai,
        GEMINI_TTS_MODELS.primary,
        GEMINI_TTS_MODELS.fallback,
        [{ parts: [{ text: buildVoiceNotePrompt(speechText, language) }] }],
        {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_MODELS.voiceName } } },
        }
      );
      const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data);
      if (!part?.inlineData?.data) {
        res.status(502).json({ error: 'The voice note came back empty. Please try again.' });
        return;
      }
      res.json({ audioBase64: part.inlineData.data, mimeType: part.inlineData.mimeType || 'audio/wav', modelUsed });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Could not make the voice note.' });
    }
  });

  app.post('/api/ai/transcribe', async (req, res) => {
    const { audioBase64, mimeType = 'audio/webm' } = req.body || {};
    if (typeof audioBase64 !== 'string' || !audioBase64.trim()) {
      res.status(400).json({ error: 'No audio recorded.' });
      return;
    }
    const apiKey = getConfiguredApiKey();
    if (!apiKey) {
      res.status(503).json({ error: 'Voice transcription needs a Gemini API key on the server.' });
      return;
    }
    try {
      const ai = createGeminiClient(apiKey);
      const { text, modelUsed } = await transcribeAudioClip({
        audioBase64,
        mimeType,
        generate: async (parts) => {
          const { response, modelUsed: used } = await generateWithFallbackModel(
            ai,
            GEMINI_MODELS.fast,
            GEMINI_MODELS.balanced,
            { parts },
            { temperature: 0.1, maxOutputTokens: 1024 }
          );
          return { text: response.text ?? '', modelUsed: used };
        },
      });
      res.json({ text, modelUsed });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Could not transcribe voice note — please type instead.' });
    }
  });

  app.post('/api/ai/process-buffer', async (req, res) => {
    const startMs = Date.now();
    const {
      tenantId = DEFAULT_TENANT_ID,
      employee,
      teamMembers = [],
      buffer,
      activeTasks = [],
      systemMemory = [],
      principalPrompts,
      businessProfile,
      ownerProfile,
      modelTuning,
      stageConfig: rawStageOverride,
    } = req.body || {};

    const stageCfg = resolveStageModelConfig(
      'BUFFER_EVALUATION',
      modelTuning,
      rawStageOverride
    );

    try {
      if (!employee || !buffer || !Array.isArray(buffer.messages) || buffer.messages.length === 0) {
        res.status(400).json({ error: 'Buffer has no messages to process.' });
        return;
      }

      const built = buildAnonymizedBufferPrompt({
        employee,
        teamMembers,
        buffer,
        activeTasks,
        systemMemory,
        principalPrompts,
        businessProfile,
        ownerProfile,
      });

      const apiKey = getConfiguredApiKey();
      if (!apiKey) {
        const fallback = buildNeutralBufferFallbackResponse({
          employee,
          buffer,
          activeTasks,
        });
        const aiLog = createAiCallLog({
          tenantId,
          stage: 'BUFFER_EVALUATION',
          model: `${stageCfg.model} (neutral-fallback)`,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          latencyMs: Date.now() - startMs,
          validationStatus: 'FALLBACK_USED',
          validationNote:
            'Missing GEMINI_API_KEY; logged batch via neutral fallback with zero status changes',
        });
        res.json({ ...fallback, aiLog });
        return;
      }

      const ai = createGeminiClient(apiKey);

      const parts: any[] = [];
      for (let i = 0; i < buffer.messages.length; i++) {
        const m = buffer.messages[i];
        if (m.base64Data && m.mimeType && (m.fileSizeMB ?? 0) <= 15) {
          const cleanBase64 = String(m.base64Data).includes(',')
            ? String(m.base64Data).split(',')[1]
            : String(m.base64Data);
          parts.push({
            inlineData: {
              mimeType: m.mimeType,
              data: cleanBase64,
            },
          });
        }
      }
      parts.push({ text: built.textPart });

      const schema = BUFFER_RESPONSE_SCHEMA;

      const { response, modelUsed } = await generateWithFallbackModel(
        ai,
        stageCfg.model,
        stageCfg.fallbackModel,
        { parts },
        {
          systemInstruction: built.systemInstruction,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema: schema,
        }
      );

      const rawParsed = JSON.parse((response.text ?? '{}').trim());
      const deanonymized = deanonymizeBufferResponse(rawParsed, built.slotDirectory, employee.phone);

      const aiLog = createAiCallLog({
        tenantId,
        stage: 'BUFFER_EVALUATION',
        model: modelUsed,
        temperature: stageCfg.temperature,
        maxOutputTokens: stageCfg.maxOutputTokens,
        latencyMs: Date.now() - startMs,
        validationStatus: 'VALID',
        validationNote: `Evaluated ${buffer.messages.length} buffered item(s)${
          built.piiAudit.clean ? ' | Zero-PII Verified' : ''
        }`,
      });

      res.json({ ...deanonymized, modelUsed, aiLog });
    } catch (err: any) {
      console.warn('Buffer Process API warning (using neutral fallback):', err?.message || err);
      const fallback = buildNeutralBufferFallbackResponse({
        employee,
        buffer,
        activeTasks,
      });
      const aiLog = createAiCallLog({
        tenantId,
        stage: 'BUFFER_EVALUATION',
        model: `${stageCfg.model} (neutral-fallback)`,
        temperature: stageCfg.temperature,
        maxOutputTokens: stageCfg.maxOutputTokens,
        latencyMs: Date.now() - startMs,
        validationStatus: 'FALLBACK_USED',
        validationNote: err?.message || 'Gemini API request failed; applied neutral fallback',
      });
      res.json({ ...fallback, aiLog });
    }
  });

  // In-memory state snapshot for empty-body cron/dev POST /api/jobs/tick calls
  let latestCachedState: OpsDatabaseState | null = null;

  async function draftReleaseMessageForTask(params: {
    task: Task;
    state: OpsDatabaseState;
  }): Promise<{ text: string; aiLog: AiCallLogEntry }> {
    const startMs = Date.now();
    const tenantId = params.state.tenantId || DEFAULT_TENANT_ID;
    const stageCfg = resolveStageModelConfig('MESSAGE', params.state.model_tuning);
    const teamMembers = Object.values(params.state.team_members || {});
    const rMember = params.state.team_members?.[params.task.raci?.R];
    const aMember = params.state.team_members?.[params.task.raci?.A];

    const plainFallback = buildPlainReleaseWhatsappMessage(
      params.task,
      rMember,
      aMember,
      params.task.release?.unlockNoticeText
    );

    const apiKey = getConfiguredApiKey();
    if (!apiKey) {
      return {
        text: plainFallback,
        aiLog: createAiCallLog({
          tenantId,
          stage: 'MESSAGE',
          model: `${stageCfg.model} (template-fallback)`,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          latencyMs: Date.now() - startMs,
          validationStatus: 'FALLBACK_USED',
          validationNote: 'GEMINI_API_KEY not configured; used deterministic plain template.',
        }),
      };
    }

    try {
      const built = buildAnonymizedMessageStagePrompt({
        task: params.task,
        teamMembers,
        businessProfile: params.state.business_profile,
        ownerProfile: params.state.owner_profile,
      });

      const ai = createGeminiClient(apiKey);
      const { response, modelUsed } = await generateWithFallbackModel(
        ai,
        stageCfg.model,
        stageCfg.fallbackModel,
        built.userContent,
        {
          systemInstruction: built.systemInstruction,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
        }
      );

      const candidate = deanonymizeAndValidateMessageStage(
        response.text ?? '',
        built.slotDirectory,
        params.task.raci?.R
      );

      if (!candidate.clean) {
        return {
          text: plainFallback,
          aiLog: createAiCallLog({
            tenantId,
            stage: 'MESSAGE',
            model: `${modelUsed} (template-fallback)`,
            temperature: stageCfg.temperature,
            maxOutputTokens: stageCfg.maxOutputTokens,
            latencyMs: Date.now() - startMs,
            validationStatus: 'FALLBACK_USED',
            validationNote: 'MESSAGE output failed phone-leak or empty check; used plain template.',
          }),
        };
      }

      const finalBody = params.task.release?.unlockNoticeText
        ? `${params.task.release.unlockNoticeText.trim()}\n\n${candidate.text}`
        : candidate.text;

      return {
        text: finalBody,
        aiLog: createAiCallLog({
          tenantId,
          stage: 'MESSAGE',
          model: modelUsed,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          latencyMs: Date.now() - startMs,
          validationStatus: 'VALID',
          validationNote: `Drafted release message for ${params.task.taskCode}${
            built.piiAudit.clean ? ' | Zero-PII Verified' : ''
          }`,
        }),
      };
    } catch (err: any) {
      return {
        text: plainFallback,
        aiLog: createAiCallLog({
          tenantId,
          stage: 'MESSAGE',
          model: `${stageCfg.model} (template-fallback)`,
          temperature: stageCfg.temperature,
          maxOutputTokens: stageCfg.maxOutputTokens,
          latencyMs: Date.now() - startMs,
          validationStatus: 'FALLBACK_USED',
          validationNote: err?.message || 'MESSAGE stage failed; used deterministic plain template.',
        }),
      };
    }
  }

  // Milestone 3: MESSAGE stage writer for newly released tasks
  app.post('/api/ai/release-messages', async (req, res) => {
    try {
      const incomingState = req.body?.state as OpsDatabaseState | undefined;
      const taskCodes = Array.isArray(req.body?.taskCodes)
        ? (req.body.taskCodes as string[])
        : [];
      if (!incomingState || taskCodes.length === 0) {
        return res.json({ messagesByTaskCode: {}, aiLogs: [] });
      }
      if (!isCloudServerMode() && !res.locals.isDemo) latestCachedState = incomingState;

      const messagesByTaskCode: Record<string, string> = {};
      const aiLogs: AiCallLogEntry[] = [];

      for (const code of taskCodes) {
        const task = incomingState.tasks.find((t) => t.taskCode === code);
        // The owner's own message is sent exactly as written: no AI rewrite.
        if (!task || task.messageIsCustom) continue;
        const drafted = await draftReleaseMessageForTask({
          task,
          state: incomingState,
        });
        messagesByTaskCode[code] = drafted.text;
        aiLogs.push(drafted.aiLog);
      }

      res.json({ messagesByTaskCode, aiLogs });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to draft release messages' });
    }
  });

  // Milestone 3: POST /api/jobs/tick — runs releaseDueTasks and sends due daily digests
  app.post('/api/jobs/tick', async (req, res) => {
    try {
      const nowIso =
        typeof req.body?.nowIso === 'string' && !Number.isNaN(Date.parse(req.body.nowIso))
          ? req.body.nowIso
          : new Date().toISOString();
      // Cloud mode: work on the signed-in owner's stored workspace (never the browser's copy).
      // In Guest Demo mode, run strictly on the request state and never touch Firestore or cached state.
      const isDemo = Boolean(res.locals.isDemo);
      const cloudUid: string | null = isCloudServerMode() && !isDemo ? (res.locals.uid as string) : null;
      let storedVersions: Record<string, number> = {};
      let workingState: OpsDatabaseState;
      if (cloudUid) {
        const loaded = await loadWorkspaceAdmin(cloudUid);
        const rebuilt = recordsToState(loaded.records, cloudUid);
        if (!rebuilt.state || !rebuilt.setupComplete) {
          return res.status(409).json({ error: 'This workspace has not been set up yet.' });
        }
        workingState = rebuilt.state;
        storedVersions = loaded.versions;
      } else {
        workingState =
          req.body?.state && typeof req.body.state === 'object'
            ? (req.body.state as OpsDatabaseState)
            : isDemo
              ? createDemoSeedState(nowIso)
              : latestCachedState || createInitialSeedState(nowIso);
      }

      // Pre-draft MESSAGE stage copy for any SCHEDULED tasks eligible to release on this tick
      const settings = buildReleaseSettingsFromState(workingState);
      const messageOverrides: Record<string, string> = {};
      const messageLogs: AiCallLogEntry[] = [];

      for (const task of workingState.tasks) {
        if (task.status !== 'SCHEDULED' || task.messageIsCustom) continue;
        const person = workingState.team_members?.[task.raci?.R];
        const check = canRelease(task, person, nowIso, settings);
        if (check.allowed) {
          const drafted = await draftReleaseMessageForTask({
            task,
            state: workingState,
          });
          messageOverrides[task.taskCode] = drafted.text;
          messageLogs.push(drafted.aiLog);
        }
      }

      const tickResult = runScheduledJobsTick(workingState, nowIso, messageOverrides);
      let nextState = tickResult.nextState;
      for (const log of messageLogs) {
        nextState = appendAiLogToState(nextState, log);
      }

      if (cloudUid) {
        // Save only what changed; refuse if someone changed those records meanwhile.
        const saved = await saveWorkspaceChangesAdmin({
          uid: cloudUid,
          changes: diffRecords(workingState, nextState, cloudUid),
          knownVersions: storedVersions,
          session: `server-tick-${nowIso}`,
        }).catch((err) => {
          throw new Error(`saving the tick: ${String(err?.message || err)}`);
        });
        if (saved.conflicts.length > 0) {
          return res.status(409).json({ error: describeConflicts(saved.conflicts) });
        }
      } else if (!isDemo) {
        latestCachedState = nextState;
      }

      res.json({
        storage: cloudUid ? 'cloud' : 'request',
        state: nextState,
        releasedTaskCodes: tickResult.releasedTaskCodes,
        digestsSent: tickResult.digestsSent,
        expiredCount: tickResult.expiredCount,
        remindersSent: tickResult.remindersSent,
        behindAlertsSent: tickResult.behindAlertsSent || 0,
        aiLogs: messageLogs,
        tickTimestamp: tickResult.tickTimestamp,
      });
    } catch (err: any) {
      const message = String(err?.message || 'Scheduler tick failed');
      console.error(`[jobs/tick] ${message}`);
      // Firestore refused the server's service account (Google Cloud IAM, not the rules file).
      const friendly = /PERMISSION_DENIED/i.test(message)
        ? "The server's Firebase key is not allowed to use Firestore. In Google Cloud console → IAM, give the project's firebase-adminsdk service account the role \"Cloud Datastore User\" (or \"Firebase Admin SDK Administrator Service Agent\"), then try again."
        : message;
      res.status(500).json({ error: friendly });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    process.env.DISABLE_HMR = 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        watch: null,
      },
      appType: 'spa',
    });
    // In Vite 8 middlewareMode with HMR disabled, /@vite/client still calls transport.connect()
    // against :24678 unless suppressed, causing WebSocket closed errors behind Cloud Run HTTPS.
    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
        if (!result) return next();
        const patched = result.code.replace(
          'transport.connect(createHMRHandler(handleMessage));',
          '/* HMR WebSocket disabled */'
        );
        res
          .status(200)
          .set({ 'Content-Type': 'application/javascript; charset=utf-8' })
          .end(patched);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
    app.get('*', async (req, res, next) => {
      try {
        const fs = await import('fs');
        const rawHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
        const html =
          typeof vite.transformIndexHtml === 'function'
            ? await vite.transformIndexHtml(req.originalUrl || req.url, rawHtml)
            : rawHtml;
        res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`OpsCommand AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
