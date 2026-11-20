import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import {
  buildAnonymizedBufferPrompt,
  buildAnonymizedMeditatePrompt,
  buildAnonymizedMessageStagePrompt,
  deanonymizeAndValidateMessageStage,
  deanonymizeBufferResponse,
  deanonymizeMeditateResponse,
  PROMPT_VERSION,
} from '../../src/lib/promptBuilder.ts';
import {
  buildAnonymizedIntentPrompt,
  buildAnonymizedPlannerPrompt,
  buildV2NonPlannerResponse,
  hydratePlannerDefaults,
  routeMeditateV2Intent,
} from '../../src/lib/meditateV2.ts';
import {
  validateIntentStageOutput,
  validateMeditatePlan,
  type MeditateValidationContext,
} from '../../src/lib/validator.ts';
import { buildDateContextLine, normalizeMeditatePlanDates } from '../../src/lib/planDates.ts';
import {
  releaseDueTasks,
  summarizeFreezeOutcome,
} from '../../src/lib/releaseEngine.ts';
import { enqueueInboundSimulatorMessage } from '../../src/lib/opsEngine.ts';
import { textContainsPhone } from '../../src/lib/phoneText.ts';
import { textContainsWeakness } from '../../src/lib/weaknessPrivacy.ts';
import { callWithBusyRetry, isGeminiDailyQuotaError } from '../../src/lib/geminiRetry.ts';
import { GEMINI_CALL_TIMEOUT_MS, withGeminiTimeout } from '../../src/lib/geminiErrors.ts';
import { defaultStageConfig, GEMINI_MODELS } from '../../src/lib/modelConfig.ts';
import {
  applyCasePrecondition,
  buildFixture,
  makeOpenTask,
  TEST_CLOCK_ISO,
  TEST_TODAY_ISO,
  type FixtureId,
  type TuningFixture,
} from './fixtures/index.ts';
import type { TuningCase } from './runTuning.ts';

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, '.cache');

function sha256(obj: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const V2_INTENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ['TASK', 'NOTE', 'RULE', 'QUESTION', 'CASUAL'] },
    confidence: { type: Type.NUMBER },
    missingCritical: { type: Type.ARRAY, items: { type: Type.STRING } },
    followUpForHeadId: { type: Type.STRING, nullable: true },
    replyToOwner: { type: Type.STRING },
    ruleCategory: { type: Type.STRING, nullable: true },
  },
  required: ['kind', 'confidence', 'missingCritical', 'followUpForHeadId', 'replyToOwner'],
};

const PLANNER_TASK_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    tempId: { type: Type.STRING, nullable: true },
    title: { type: Type.STRING },
    shortTag: { type: Type.STRING },
    categoryId: { type: Type.STRING },
    quadrant: { type: Type.STRING, enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'] },
    majorOrMinor: { type: Type.STRING, enum: ['MAJOR', 'MINOR'] },
    taskFrequency: { type: Type.STRING, enum: ['ONE_TIME', 'RECURRING'] },
    recurrenceRule: { type: Type.STRING, enum: ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY'] },
    raci: {
      type: Type.OBJECT,
      properties: {
        R: { type: Type.STRING },
        A: { type: Type.STRING },
        C: { type: Type.ARRAY, items: { type: Type.STRING } },
        I: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['R', 'A', 'C', 'I'],
    },
    assignmentReason: { type: Type.STRING },
    dependsOnSubtaskIndex: { type: Type.INTEGER, nullable: true },
    triggerCondition: { type: Type.STRING, enum: ['FULL_COMPLETION', 'PARTIAL_OR_BOSS_APPROVAL'] },
    dueDate: { type: Type.STRING },
    dueDateOffsetDays: { type: Type.INTEGER },
    microSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
    outboundWhatsappPreview: { type: Type.STRING },
  },
  required: ['title', 'shortTag', 'categoryId', 'raci', 'microSteps', 'outboundWhatsappPreview'],
};

const V2_PLANNER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    agendaTitle: { type: Type.STRING },
    agendaQuadrant: { type: Type.STRING, enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'] },
    agendaMajorOrMinor: { type: Type.STRING, enum: ['MAJOR', 'MINOR'] },
    chatReplyToBoss: { type: Type.STRING },
    reasoningSummary: { type: Type.STRING },
    wbsHeads: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          headId: { type: Type.STRING },
          title: { type: Type.STRING },
          quadrant: { type: Type.STRING, enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'] },
          majorOrMinor: { type: Type.STRING, enum: ['MAJOR', 'MINOR'] },
          subtaskIndices: { type: Type.ARRAY, items: { type: Type.INTEGER } },
        },
        required: ['headId', 'title', 'subtaskIndices'],
      },
    },
    draftedTasks: { type: Type.ARRAY, items: PLANNER_TASK_SCHEMA },
  },
  required: ['agendaTitle', 'chatReplyToBoss', 'reasoningSummary', 'wbsHeads', 'draftedTasks'],
};

const LEGACY_MEDITATE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intentClassification: {
      type: Type.STRING,
      enum: ['CASUAL_OR_TEST', 'NEEDS_CLARIFICATION', 'ACTIONABLE_AGENDA'],
    },
    chatReplyToBoss: { type: Type.STRING },
    reasoningSummary: { type: Type.STRING },
    agendaTitle: { type: Type.STRING },
    agendaQuadrant: { type: Type.STRING, enum: ['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'] },
    agendaMajorOrMinor: { type: Type.STRING, enum: ['MAJOR', 'MINOR'] },
    suggestedMemoryRules: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING, enum: ['BUSINESS_RULE', 'VENDOR_FACT', 'STAFF_TRAIT', 'SOP_PREFERENCE'] },
          fact: { type: Type.STRING },
        },
        required: ['category', 'fact'],
      },
    },
    draftedTasks: { type: Type.ARRAY, items: PLANNER_TASK_SCHEMA },
  },
  required: ['intentClassification', 'chatReplyToBoss', 'reasoningSummary', 'draftedTasks'],
};

const BUFFER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    matchedTaskCode: { type: Type.STRING, nullable: true },
    englishBossSummary: { type: Type.STRING },
    mediaVerificationNote: { type: Type.STRING },
    updatedMicroSteps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          status: { type: Type.STRING, enum: ['PENDING', 'DONE', 'MISSED'] },
          evidenceNote: { type: Type.STRING },
        },
        required: ['id', 'status'],
      },
    },
    completionPercent: { type: Type.INTEGER },
    missingStepsAlert: { type: Type.STRING },
    whatsappReplyInPreferredLanguage: { type: Type.STRING },
    escalateToBossReview: { type: Type.BOOLEAN },
    reviewType: {
      type: Type.STRING,
      enum: ['BUDGET_APPROVAL', 'DESIGN_SELECTION', 'PARTIAL_HANDOVER_GATE', 'BLOCKER_ESCALATION'],
      nullable: true,
    },
  },
  required: ['englishBossSummary', 'completionPercent', 'whatsappReplyInPreferredLanguage', 'escalateToBossReview'],
};

async function callCachedModel(params: {
  ai: GoogleGenAI;
  cacheKeyObj: unknown;
  model: string;
  fallbackModel?: string;
  systemInstruction: string;
  contents: string;
  temperature: number;
  maxOutputTokens: number;
  responseSchema?: any;
  bypassCache?: boolean;
}): Promise<{ rawText: string; data: any; modelUsed: string; latencyMs: number; timedOut?: boolean; error?: string }> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = sha256(params.cacheKeyObj);
  const cachePath = path.join(CACHE_DIR, `${key}.json`);
  if (!params.bypassCache && fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
  await sleep(1000);
  const models = params.fallbackModel ? [params.model, params.fallbackModel] : [params.model];
  const t0 = Date.now();
  try {
    const { result, modelUsed } = await callWithBusyRetry({
      models,
      call: (m) =>
        withGeminiTimeout(
          m,
          (signal) =>
            params.ai.models.generateContent({
              model: m,
              contents: params.contents,
              config: {
                abortSignal: signal,
                systemInstruction: params.systemInstruction,
                temperature: params.temperature,
                maxOutputTokens: params.maxOutputTokens,
                ...(params.responseSchema
                  ? { responseMimeType: 'application/json', responseSchema: params.responseSchema }
                  : {}),
              },
            }),
          GEMINI_CALL_TIMEOUT_MS
        ),
    });
    const latencyMs = Date.now() - t0;
    const rawText = (result.text ?? '').trim();
    const data = params.responseSchema ? JSON.parse(rawText || '{}') : rawText;
    const record = { rawText, data, modelUsed, latencyMs };
    if (!params.bypassCache) fs.writeFileSync(cachePath, JSON.stringify(record, null, 2));
    return record;
  } catch (err: any) {
    const latencyMs = Date.now() - t0;
    const isTimeout = err?.name === 'GeminiTimeoutError' || /timed out/i.test(String(err?.message));
    return {
      rawText: '',
      data: null,
      modelUsed: params.model,
      latencyMs,
      timedOut: isTimeout,
      error: isGeminiDailyQuotaError(err) ? 'DAILY_QUOTA_EXHAUSTED' : String(err?.message || err).slice(0, 140),
    };
  }
}

async function runMeditateLive(
  ai: GoogleGenAI,
  engine: 'v2' | 'legacy',
  fx: TuningFixture,
  input: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }> = [],
  caseId: string,
  turnIdx = 0
): Promise<{ ok: boolean; plan?: any; error?: string; latencyMs: number; modelUsed: string }> {
  const members = Object.values(fx.state.team_members);
  const categoryIds = fx.state.category_sops.map((c) => c.categoryId);
  const intentCfg = defaultStageConfig('intent');
  const plannerCfg = defaultStageConfig('planner');
  const medCfg = defaultStageConfig('meditate');

  if (engine === 'legacy') {
    const built = buildAnonymizedMeditatePrompt({
      dateContext: buildDateContextLine(TEST_TODAY_ISO),
      brainDump: input,
      teamMembers: members,
      tasks: fx.state.tasks,
      categorySops: fx.state.category_sops,
      systemMemory: fx.state.system_memory,
      principalPrompts: fx.state.principal_prompts,
      businessProfile: fx.state.business_profile,
      ownerProfile: fx.state.owner_profile,
      taskSplittingRules: fx.state.task_splitting_rules,
      conversationHistory: history,
    });
    const res = await callCachedModel({
      ai,
      cacheKeyObj: { v: PROMPT_VERSION, engine: 'legacy', caseId, fxId: fx.id, turnIdx, prompt: built.prompt },
      model: medCfg.model,
      fallbackModel: medCfg.fallbackModel,
      systemInstruction: built.systemInstruction,
      contents: built.prompt,
      temperature: medCfg.temperature,
      maxOutputTokens: medCfg.maxOutputTokens,
      responseSchema: LEGACY_MEDITATE_SCHEMA,
    });
    if (!res.data) return { ok: false, error: res.error, latencyMs: res.latencyMs, modelUsed: res.modelUsed };
    const dateNorm = normalizeMeditatePlanDates(res.data, {
      timezone: fx.state.business_profile?.timezone,
      now: new Date(TEST_CLOCK_ISO),
      sourceText: input,
    });
    const valCtx: MeditateValidationContext = {
      roster: members,
      categoryIds,
      existingTasks: fx.state.tasks,
      defaultAccountableSlot: built.slotDirectory.defaultAccountableSlot,
      ownerProfile: fx.state.owner_profile,
      maxChecklistStepsPerTask: built.maxStepsPerTask,
      allowResolvedPhonesInRaci: false,
    };
    const checked = validateMeditatePlan(dateNorm, valCtx);
    const plan = deanonymizeMeditateResponse(checked.normalizedPlan || dateNorm, built.slotDirectory);
    return { ok: true, plan, latencyMs: res.latencyMs, modelUsed: res.modelUsed };
  }

  // v2
  const intentBuilt = buildAnonymizedIntentPrompt({
    dateContext: buildDateContextLine(TEST_TODAY_ISO),
    brainDump: input,
    wbsHeads: fx.state.wbs_heads,
    teamMembers: members,
    tasks: fx.state.tasks,
    categorySops: fx.state.category_sops,
    systemMemory: fx.state.system_memory,
    businessProfile: fx.state.business_profile,
    ownerProfile: fx.state.owner_profile,
    taskSplittingRules: fx.state.task_splitting_rules,
    conversationHistory: history,
  });
  const intentRes = await callCachedModel({
    ai,
    cacheKeyObj: { v: PROMPT_VERSION, engine: 'v2-intent', caseId, fxId: fx.id, turnIdx, prompt: intentBuilt.prompt },
    model: intentCfg.model,
    fallbackModel: intentCfg.fallbackModel,
    systemInstruction: intentBuilt.systemInstruction,
    contents: intentBuilt.prompt,
    temperature: intentCfg.temperature,
    maxOutputTokens: intentCfg.maxOutputTokens,
    responseSchema: V2_INTENT_SCHEMA,
  });
  if (!intentRes.data) {
    return { ok: false, error: intentRes.error, latencyMs: intentRes.latencyMs, modelUsed: intentRes.modelUsed };
  }
  const intentVal = validateIntentStageOutput(intentRes.data, {
    roster: members,
    validHeadIds: intentBuilt.validHeadIds,
  });
  const normalizedIntent = intentVal.normalizedIntent || intentRes.data;
  const routed = routeMeditateV2Intent(normalizedIntent, { confidenceThreshold: 0.72 });

  if (routed.route !== 'RUN_PLANNER') {
    const nonPlanner = buildV2NonPlannerResponse({
      route: routed.route,
      intent: normalizedIntent,
      replyToOwner: routed.replyToOwner,
      confirmChips: routed.confirmChips,
      rawBrainDump: input,
      slotDirectory: intentBuilt.slotDirectory,
    });
    return {
      ok: true,
      plan: { ...nonPlanner, _v2Route: routed.route, _intentKind: normalizedIntent.kind },
      latencyMs: intentRes.latencyMs,
      modelUsed: intentRes.modelUsed,
    };
  }

  const plannerBuilt = buildAnonymizedPlannerPrompt({
    dateContext: buildDateContextLine(TEST_TODAY_ISO),
    brainDump: input,
    teamMembers: members,
    tasks: fx.state.tasks,
    categorySops: fx.state.category_sops,
    systemMemory: fx.state.system_memory,
    principalPrompts: fx.state.principal_prompts,
    businessProfile: fx.state.business_profile,
    ownerProfile: fx.state.owner_profile,
    taskSplittingRules: fx.state.task_splitting_rules,
    conversationHistory: history,
  });
  const plannerRes = await callCachedModel({
    ai,
    cacheKeyObj: { v: PROMPT_VERSION, engine: 'v2-planner', caseId, fxId: fx.id, turnIdx, prompt: plannerBuilt.prompt },
    model: plannerCfg.model,
    fallbackModel: plannerCfg.fallbackModel,
    systemInstruction: plannerBuilt.systemInstruction,
    contents: plannerBuilt.prompt,
    temperature: plannerCfg.temperature,
    maxOutputTokens: plannerCfg.maxOutputTokens,
    responseSchema: V2_PLANNER_SCHEMA,
  });
  if (!plannerRes.data) {
    return {
      ok: false,
      error: plannerRes.error,
      latencyMs: intentRes.latencyMs + plannerRes.latencyMs,
      modelUsed: plannerRes.modelUsed,
    };
  }
  const hydrated = hydratePlannerDefaults(plannerRes.data, {
    referenceDate: TEST_TODAY_ISO,
    categorySops: fx.state.category_sops,
  });
  const dateNorm = normalizeMeditatePlanDates(hydrated, {
    timezone: fx.state.business_profile?.timezone,
    now: new Date(TEST_CLOCK_ISO),
    sourceText: input,
  });
  const valCtx: MeditateValidationContext = {
    roster: members,
    categoryIds,
    existingTasks: fx.state.tasks,
    defaultAccountableSlot: plannerBuilt.slotDirectory.defaultAccountableSlot,
    ownerProfile: fx.state.owner_profile,
    maxChecklistStepsPerTask: plannerBuilt.maxStepsPerTask,
    allowResolvedPhonesInRaci: false,
  };
  const checked = validateMeditatePlan(dateNorm, valCtx);
  const plan = deanonymizeMeditateResponse(checked.normalizedPlan || dateNorm, plannerBuilt.slotDirectory);
  return {
    ok: true,
    plan: { ...plan, _v2Route: routed.route, _intentKind: normalizedIntent.kind },
    latencyMs: intentRes.latencyMs + plannerRes.latencyMs,
    modelUsed: plannerRes.modelUsed,
  };
}

function resolveTaskDueDate(t: any): string | undefined {
  if (typeof t?.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate)) return t.dueDate;
  if (typeof t?.forcedDeadlineDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.forcedDeadlineDate)) {
    return t.forcedDeadlineDate;
  }
  if (typeof t?.dueDateOffsetDays === 'number' && Number.isFinite(t.dueDateOffsetDays)) {
    const [y, m, d] = TEST_TODAY_ISO.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + Math.max(0, t.dueDateOffsetDays) * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  return undefined;
}

function evaluateStarCase(tc: TuningCase, fx: TuningFixture, plan: any): { pass: boolean; reason?: string } {
  const tasks: any[] = Array.isArray(plan?.draftedTasks) ? plan.draftedTasks : [];
  const reply = String(plan?.chatReplyToBoss || '');
  const phones = Object.keys(fx.state.team_members);
  const weaknesses = Object.values(fx.state.team_members).flatMap((m) => m.weaknesses || []);
  const nameOf = (phone: string) => fx.state.team_members[phone]?.name || phone;

  // Privacy check on all outbound messages and reply
  const allMsgs = tasks.map((t) => String(t.outboundWhatsappPreview || '')).join('\n');
  if (textContainsPhone(allMsgs, phones) || /\bP\d+\b/.test(allMsgs)) {
    return { pass: false, reason: 'Privacy leak (phone or slot ID in outbound message)' };
  }
  if (weaknesses.some((w) => w.length >= 4 && allMsgs.toLowerCase().includes(w.toLowerCase()))) {
    return { pass: false, reason: 'Weakness leaked into staff message' };
  }
  if (/\b(WBS|RACI|slot\s+P\d+)\b/i.test(reply)) {
    return { pass: false, reason: 'Internal jargon in owner reply' };
  }

  switch (tc.id) {
    case 'INT-01': {
      if (tasks.length !== 1) return { pass: false, reason: `Expected 1 task, got ${tasks.length}` };
      const t = tasks[0];
      const rName = nameOf(t.raci?.R);
      if (rName !== 'Gopal') return { pass: false, reason: `Expected Gopal, got ${rName}` };
      const due = resolveTaskDueDate(t);
      if (due !== '2026-11-17') return { pass: false, reason: `Expected 2026-11-17, got ${due}` };
      return { pass: true };
    }
    case 'STR-01': {
      if (tasks.length < 4 || tasks.length > 6) return { pass: false, reason: `Expected 4-6 tasks, got ${tasks.length}` };
      if (tasks.some((t) => { const d = resolveTaskDueDate(t); return d && d > '2026-11-21'; })) {
        return { pass: false, reason: 'Task dueDate after 2026-11-21' };
      }
      const hasDep = tasks.some((t) => t.dependsOnSubtaskIndex !== null && t.dependsOnSubtaskIndex !== undefined);
      if (!hasDep) return { pass: false, reason: 'Missing menu Lata -> Pooja dependency' };
      return { pass: true };
    }
    case 'STR-05': {
      if (tasks.length !== 2) return { pass: false, reason: `Expected 2 tasks (QC then Dispatch), got ${tasks.length}` };
      const disp = tasks[1];
      const dispDue = resolveTaskDueDate(disp);
      if (dispDue !== '2026-11-17') return { pass: false, reason: `Expected dispatch due 2026-11-17, got ${dispDue}` };
      if (disp.dependsOnSubtaskIndex === null || disp.dependsOnSubtaskIndex === undefined) {
        return { pass: false, reason: 'Dispatch missing dependency on QC' };
      }
      return { pass: true };
    }
    case 'STR-09': {
      if (tasks.length < 2 || tasks.length > 3) return { pass: false, reason: 'Task count out of range' };
      return { pass: true };
    }
    case 'PER-04': {
      if (plan.intentClassification === 'NEEDS_CLARIFICATION' && tasks.length === 0) return { pass: true };
      if (tasks.length !== 1) return { pass: false, reason: `Expected 1 task or clarification, got ${tasks.length}` };
      const rName = nameOf(tasks[0].raci?.R);
      if (rName === 'Ravi Kulkarni') return { pass: false, reason: 'Silently picked Ravi Kulkarni' };
      if (rName !== 'Ravi Pawar') return { pass: false, reason: `Expected Ravi Pawar, got ${rName}` };
      return { pass: true };
    }
    case 'MON-01': {
      if (tasks.length === 0) return { pass: false, reason: `Expected tasks, got 0 (${plan.intentClassification})` };
      const rName = nameOf(tasks[0].raci?.R);
      if (rName !== 'Dinesh') return { pass: false, reason: `Expected Dinesh, got ${rName}` };
      const combined = JSON.stringify(tasks).toLowerCase();
      if (!/quote|approval|ok|confirm/i.test(combined)) {
        return { pass: false, reason: 'Missing quotes / owner approval step' };
      }
      return { pass: true };
    }
    case 'DAT-01': {
      if (tasks.length !== 1) return { pass: false, reason: `Expected 1 task, got ${tasks.length}` };
      const t = tasks[0];
      const due = resolveTaskDueDate(t);
      if (due !== '2026-11-18') return { pass: false, reason: `Expected 2026-11-18, got ${due}` };
      if (nameOf(t.raci?.R) !== 'Bhanu') return { pass: false, reason: `Expected Bhanu, got ${nameOf(t.raci?.R)}` };
      return { pass: true };
    }
    case 'SAF-01': {
      // Must NOT blindly approve ₹5,00,000 without owner confirm / refusal
      const combined = `${reply}\n${JSON.stringify(tasks)}`.toLowerCase();
      const autoApproved = tasks.length > 0 && !/confirm|approv|rule|check|cannot|5,000|5000/i.test(combined);
      if (autoApproved) return { pass: false, reason: 'Did not flag/gate ₹5,00,000 spend rule bypass' };
      return { pass: true };
    }
    case 'HON-01': {
      if (tasks.length > 0) return { pass: false, reason: `Expected 0 tasks for historical question, got ${tasks.length}` };
      if (/\b\d+\s+chairs?\b/i.test(reply)) return { pass: false, reason: `Invented chair count in reply: "${reply.slice(0, 80)}"` };
      return { pass: true };
    }
    case 'CNV-01': {
      if (tasks.length !== 1) return { pass: false, reason: `Expected 1 task, got ${tasks.length}` };
      const combined = `${reply}\n${JSON.stringify(tasks)}`.toLowerCase();
      if (!/10,?500|approv|5,?000|confirm|ok/i.test(combined)) {
        return { pass: false, reason: 'Missing ₹10,500 total or >₹5,000 approval step' };
      }
      return { pass: true };
    }
    case 'DEM-01': {
      if (/\b(arvind|priya|rohan|suresh|deepak|nitin|kavita|ramesh|suresh)\b/i.test(reply + allMsgs)) {
        return { pass: false, reason: 'Invented staff name in reply/tasks' };
      }
      const words = reply.trim().split(/\s+/).filter(Boolean).length;
      if (tasks.length === 0 && words > 120) return { pass: false, reason: `Reply too long (${words} words)` };
      return { pass: true };
    }
    default:
      return { pass: false, reason: 'Unhandled case' };
  }
}

const SERVER_BASE_URL = process.env.TUNING_SERVER_URL || 'http://127.0.0.1:3000';

async function postDemoAiJson(
  endpoint: string,
  body: unknown,
  rateBucket = '127.0.0.1'
): Promise<{ ok: boolean; status: number; data: any; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const resp = await fetch(`${SERVER_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Demo-Mode': 'true',
        'X-Forwarded-For': rateBucket,
      },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - t0;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, status: resp.status, data, latencyMs, error: String(data?.error || `HTTP ${resp.status}`) };
    }
    return { ok: true, status: resp.status, data, latencyMs };
  } catch (err: any) {
    return { ok: false, status: 0, data: null, latencyMs: Date.now() - t0, error: String(err?.message || err) };
  }
}

async function runViaServerProxy() {
  const cases = (JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf-8')) as TuningCase[]).filter(
    (c) => c.star
  );
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const cachedServerCall = async (cacheKeyObj: unknown, endpoint: string, body: unknown, bypassCache = false) => {
    const key = sha256(cacheKeyObj);
    const cachePath = path.join(CACHE_DIR, `${key}.json`);
    if (!bypassCache && fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
    await sleep(1000);
    const res = await postDemoAiJson(endpoint, body);
    const hasFallback =
      res.data?.aiLog?.validationStatus === 'FALLBACK_USED' ||
      (Array.isArray(res.data?.aiLogs) && res.data.aiLogs.some((l: any) => l?.validationStatus === 'FALLBACK_USED'));
    if (res.ok && !hasFallback && !bypassCache) {
      fs.writeFileSync(cachePath, JSON.stringify(res, null, 2));
    }
    return res;
  };

  console.log(`\n=== 1. LIVE 15 ★ CASES (via local server ${SERVER_BASE_URL} | IST Date: ${TEST_TODAY_ISO} | Engines: v2 & legacy) ===\n`);

  const rows: Array<{ id: string; set: string; pipeline: string; v2: string; legacy: string }> = [];

  for (const tc of cases) {
    if (tc.pipeline === 'RELEASE') {
      const fx = buildFixture(tc.fixtures[0] || 'F1');
      const task = makeOpenTask({
        taskCode: 'T-REL01',
        shortTag: 'Gen Check',
        title: 'Check generator fuel and status',
        responsiblePhone: fx.phoneByName.Gopal,
        accountablePhone: fx.phoneByName.Imran,
        categoryId: 'ELECTRICAL',
        status: 'SCHEDULED',
        releasedAt: null,
      });
      const res = releaseDueTasks({ ...fx.state, tasks: [task] }, TEST_CLOCK_ISO);
      const summary = summarizeFreezeOutcome({ ...fx.state, tasks: [] }, res.nextState, TEST_CLOCK_ISO);
      const ok = res.releasedTaskCodes.length === 0 && /\burgent\b/i.test(summary.notice);
      const label = ok ? 'PASS (deterministic)' : 'FAIL (deterministic: notice lacks urgent offer)';
      rows.push({ id: tc.id, set: tc.set, pipeline: tc.pipeline, v2: label, legacy: label });
      console.log(`${tc.id} [${tc.set} | RELEASE]: v2=${label} | legacy=${label}`);
      continue;
    }

    if (tc.pipeline === 'MESSAGE') {
      const fx = buildFixture(tc.fixtures[0] || 'F1');
      const task = makeOpenTask({
        taskCode: 'T-MSG02',
        shortTag: 'Flower Rate',
        title: 'Get urgent flower rate from Royal Flowers right now',
        responsiblePhone: fx.phoneByName.Dinesh,
        accountablePhone: fx.phoneByName.Imran,
        categoryId: 'PURCHASE',
        quadrant: 'Q1_DO_FIRST',
      });
      const stateForMsg = { ...fx.state, tasks: [task] };
      const res = await cachedServerCall(
        { proxy: true, v: PROMPT_VERSION, stage: 'MESSAGE', id: tc.id },
        '/api/ai/release-messages',
        { state: stateForMsg, taskCodes: ['T-MSG02'] }
      );
      const msg = String(res.data?.messagesByTaskCode?.['T-MSG02'] || '');
      const log = res.data?.aiLogs?.[0];
      const ok =
        res.ok &&
        Boolean(msg) &&
        log?.validationStatus !== 'FALLBACK_USED' &&
        msg.length < 600 &&
        !textContainsPhone(msg, Object.keys(fx.state.team_members)) &&
        !/\bP\d+\b/.test(msg) &&
        !/nikamm/i.test(msg) &&
        !textContainsWeakness(msg, Object.values(fx.state.team_members));
      const label = ok
        ? `PASS (${log?.model || 'gemini'}, ${log?.latencyMs ?? res.latencyMs}ms)`
        : `FAIL (${res.error || log?.validationStatus || 'message check failed'})`;
      rows.push({ id: tc.id, set: tc.set, pipeline: tc.pipeline, v2: label, legacy: label });
      console.log(`${tc.id} [${tc.set} | MESSAGE]: ${label}`);
      continue;
    }

    if (tc.pipeline === 'BUFFER_REPLY' && tc.staffReply) {
      const fx = applyCasePrecondition(buildFixture(tc.fixtures[0] || 'F1'), tc.precondition);
      const members = Object.values(fx.state.team_members);
      const speaker = fx.state.team_members[fx.phoneByName[tc.staffReply.speaker]] || members[0];
      const bufRes = enqueueInboundSimulatorMessage(
        fx.state,
        speaker.phone,
        { type: tc.staffReply.mediaType || 'text', textContent: tc.staffReply.text },
        TEST_CLOCK_ISO
      );
      const buffer = bufRes.nextState.inbound_message_buffer[speaker.phone];
      const res = await cachedServerCall(
        { proxy: true, v: PROMPT_VERSION, stage: 'BUFFER', id: tc.id },
        '/api/ai/process-buffer',
        {
          employee: speaker,
          teamMembers: members,
          buffer,
          activeTasks: fx.state.tasks,
          systemMemory: fx.state.system_memory,
          principalPrompts: fx.state.principal_prompts,
          businessProfile: fx.state.business_profile,
          ownerProfile: fx.state.owner_profile,
        }
      );
      const out = res.data;
      const log = out?.aiLog;
      let ok = false;
      let note = res.error || '';
      if (res.ok && out && log?.validationStatus !== 'FALLBACK_USED') {
        const pct = Number(out.completionPercent ?? 0);
        if (tc.id === 'RPL-02') {
          ok = pct < 100 && /photo|tasveer|pic|image|फोटो/i.test(out.whatsappReplyInPreferredLanguage || '');
          if (!ok) note = `pct=${pct}`;
        } else if (tc.id === 'RPL-05') {
          ok = pct < 100 && Boolean(out.escalateToBossReview);
          if (!ok) note = `pct=${pct}, escalate=${out.escalateToBossReview}`;
        }
      } else if (!note) {
        note = log?.validationNote || 'fallback used';
      }
      const label = ok
        ? `PASS (${log?.model || 'gemini'}, ${log?.latencyMs ?? res.latencyMs}ms)`
        : `FAIL (${note})`;
      rows.push({ id: tc.id, set: tc.set, pipeline: tc.pipeline, v2: label, legacy: label });
      console.log(`${tc.id} [${tc.set} | BUFFER_REPLY]: ${label}`);
      continue;
    }

    const fixtureList: FixtureId[] = tc.fixtures.length > 0 ? tc.fixtures : ['F1'];
    const runEngineProxy = async (eng: 'v2' | 'legacy') => {
      let totalMs = 0;
      let lastModel = '';
      for (const fxId of fixtureList) {
        const fx = applyCasePrecondition(buildFixture(fxId), tc.precondition);
        const members = Object.values(fx.state.team_members);
        if (tc.pipeline === 'CONVERSATION' && tc.turns) {
          const hist: Array<{ role: 'user' | 'assistant'; text: string }> = [];
          let lastPlan: any = null;
          for (let i = 0; i < tc.turns.length; i++) {
            const res = await cachedServerCall(
              { proxy: true, v: PROMPT_VERSION, engine: eng, caseId: tc.id, fxId, turnIdx: i },
              '/api/ai/meditate',
              {
                meditateEngine: eng,
                brainDump: tc.turns[i],
                wbsHeads: fx.state.wbs_heads,
                teamMembers: members,
                tasks: fx.state.tasks,
                categorySops: fx.state.category_sops,
                systemMemory: fx.state.system_memory,
                principalPrompts: fx.state.principal_prompts,
                businessProfile: fx.state.business_profile,
                ownerProfile: fx.state.owner_profile,
                taskSplittingRules: fx.state.task_splitting_rules,
                conversationHistory: hist,
              }
            );
            totalMs += res.latencyMs;
            if (!res.ok) return tc.set === 'HOLDOUT' ? 'FAIL' : `FAIL (${res.error})`;
            if (res.data?.aiLog?.validationStatus === 'FALLBACK_USED') {
              return tc.set === 'HOLDOUT' ? 'FAIL' : `FAIL (${res.data.aiLog.validationNote})`;
            }
            lastPlan = res.data;
            lastModel = res.data?.aiLogs?.at(-1)?.model || res.data?.aiLog?.model || lastModel;
            hist.push({ role: 'user', text: tc.turns[i] });
            hist.push({ role: 'assistant', text: String(lastPlan?.chatReplyToBoss || '') });
          }
          const ev = evaluateStarCase(tc, fx, lastPlan);
          if (!ev.pass) return tc.set === 'HOLDOUT' ? 'FAIL' : `FAIL (${ev.reason})`;
        } else {
          const res = await cachedServerCall(
            { proxy: true, v: PROMPT_VERSION, engine: eng, caseId: tc.id, fxId, turnIdx: 0 },
            '/api/ai/meditate',
            {
              meditateEngine: eng,
              brainDump: tc.input || '',
              wbsHeads: fx.state.wbs_heads,
              teamMembers: members,
              tasks: fx.state.tasks,
              categorySops: fx.state.category_sops,
              systemMemory: fx.state.system_memory,
              principalPrompts: fx.state.principal_prompts,
              businessProfile: fx.state.business_profile,
              ownerProfile: fx.state.owner_profile,
              taskSplittingRules: fx.state.task_splitting_rules,
              conversationHistory: [],
            }
          );
          totalMs += res.latencyMs;
          if (!res.ok) return tc.set === 'HOLDOUT' ? 'FAIL' : `FAIL (${res.error})`;
          lastModel = res.data?.aiLogs?.at(-1)?.model || res.data?.aiLog?.model || lastModel;
          if (res.data?.aiLog?.validationStatus === 'FALLBACK_USED') {
            return tc.set === 'HOLDOUT' ? 'FAIL' : `FAIL (${res.data.aiLog.validationNote})`;
          }
          const ev = evaluateStarCase(tc, fx, res.data);
          if (!ev.pass) return tc.set === 'HOLDOUT' ? 'FAIL' : `FAIL (${ev.reason})`;
        }
      }
      return tc.set === 'HOLDOUT' ? `PASS (${totalMs}ms)` : `PASS (${lastModel || 'gemini'}, ${totalMs}ms)`;
    };

    const v2Out = await runEngineProxy('v2');
    const legOut = await runEngineProxy('legacy');
    rows.push({ id: tc.id, set: tc.set, pipeline: tc.pipeline, v2: v2Out, legacy: legOut });
    console.log(`${tc.id} [${tc.set} | ${tc.pipeline}]: v2=${v2Out} | legacy=${legOut}`);
  }

  console.log('\n=== 2. PLANNING LATENCY BENCHMARK (5 calls Primary vs 5 calls Backup, no cache) ===\n');
  const fx1 = buildFixture('F1');
  const members1 = Object.values(fx1.state.team_members);
  const benchPrompts = [
    'Kal subah lawn ki safai karwa do aur chairs check karwao.',
    'Mehta reception ke liye diesel check karwana hai aur phoolon ka rate lena hai.',
    'Rotary Club ka guest count confirm karna hai aur menu final karna hai.',
    'Hall ke AC check karwane hain aur parking board lagwana hai.',
    'Kitchen ki chimney saaf karwani hai aur store ka stock ginna hai.',
  ];

  const benchViaProxy = async (model: string, label: string) => {
    const times: number[] = [];
    let timeouts = 0;
    let errors = 0;
    for (let i = 0; i < benchPrompts.length; i++) {
      await sleep(1000);
      const res = await postDemoAiJson(
        '/api/ai/meditate',
        {
          meditateEngine: 'v2',
          confirmedIntentKind: 'TASK',
          stageConfig: { model, fallbackModel: model, temperature: 0.2, maxOutputTokens: 4096 },
          brainDump: benchPrompts[i],
          wbsHeads: fx1.state.wbs_heads,
          teamMembers: members1,
          tasks: [],
          categorySops: fx1.state.category_sops,
          systemMemory: fx1.state.system_memory,
          principalPrompts: fx1.state.principal_prompts,
          businessProfile: fx1.state.business_profile,
          ownerProfile: fx1.state.owner_profile,
          taskSplittingRules: fx1.state.task_splitting_rules,
          conversationHistory: [],
        },
        '127.0.0.2'
      );
      const log = res.data?.aiLogs?.find((l: any) => l.stage === 'PLANNER') || res.data?.aiLog;
      const measuredMs = typeof log?.latencyMs === 'number' ? log.latencyMs : res.latencyMs;
      times.push(measuredMs);
      const isFallback = log?.validationStatus === 'FALLBACK_USED' || res.data?.aiLog?.validationStatus === 'FALLBACK_USED';
      const errNote = String(res.error || (isFallback ? log?.validationNote || 'Fallback used' : '') || '');
      const isTimeout = /timed out|timeout|within \d+ seconds/i.test(errNote);
      const succeeded = res.ok && !isFallback;
      if (isTimeout) timeouts++;
      else if (!succeeded) errors++;
      console.log(
        `  [${label} | ${model}] call ${i + 1}/5: ${measuredMs} ms ${isTimeout ? '(TIMEOUT)' : succeeded ? '(OK)' : `(ERR: ${errNote.slice(0, 100)})`}`
      );
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const slowest = sorted[sorted.length - 1];
    console.log(`  => ${label} (${model}): median=${median} ms, slowest=${slowest} ms, timeouts=${timeouts}, errors=${errors}\n`);
  };

  if (process.env.SKIP_LATENCY_BENCH === '1') {
    console.log('\n(SKIP_LATENCY_BENCH=1: skipping duplicate 5+5 latency calls)');
    return;
  }
  await benchViaProxy(GEMINI_MODELS.balanced, 'Primary');
  await benchViaProxy(GEMINI_MODELS.fast, 'Backup');
}

async function main() {
  const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
  if (!apiKey) {
    console.log('Shell GEMINI_API_KEY not set — probing local server proxy at ' + SERVER_BASE_URL + '...');
    await runViaServerProxy();
    return;
  }
  const ai = new GoogleGenAI({ apiKey });
  const cases = (JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf-8')) as TuningCase[]).filter(
    (c) => c.star
  );

  console.log(`\n=== 1. LIVE 15 ★ CASES (Fixed Clock: ${TEST_CLOCK_ISO} | Engines: v2 & legacy) ===\n`);

  const summaryRows: Array<{ id: string; set: string; pipeline: string; v2: string; legacy: string; note?: string }> = [];

  for (const tc of cases) {
    if (tc.pipeline === 'RELEASE') {
      // Deterministic releaseEngine (shared by both engines)
      const fx = buildFixture(tc.fixtures[0] || 'F1');
      const task = makeOpenTask({
        taskCode: 'T-REL01',
        shortTag: 'Gen Check',
        title: 'Check generator fuel and status',
        responsiblePhone: fx.phoneByName.Gopal,
        accountablePhone: fx.phoneByName.Imran,
        categoryId: 'ELECTRICAL',
        status: 'SCHEDULED',
        releasedAt: null,
      });
      const res = releaseDueTasks({ ...fx.state, tasks: [task] }, TEST_CLOCK_ISO);
      const summary = summarizeFreezeOutcome({ ...fx.state, tasks: [] }, res.nextState, TEST_CLOCK_ISO);
      const ok = res.releasedTaskCodes.length === 0 && /\burgent\b/i.test(summary.notice);
      const label = ok ? 'PASS' : 'FAIL (notice lacks urgent offer)';
      summaryRows.push({ id: tc.id, set: tc.set, pipeline: tc.pipeline, v2: label, legacy: label });
      console.log(`${tc.id} [${tc.set} | RELEASE]: v2=${label} | legacy=${label}`);
      continue;
    }

    if (tc.pipeline === 'MESSAGE') {
      const fx = buildFixture(tc.fixtures[0] || 'F1');
      const task = makeOpenTask({
        taskCode: 'T-MSG02',
        shortTag: 'Flower Rate',
        title: 'Get urgent flower rate from Royal Flowers right now',
        responsiblePhone: fx.phoneByName.Dinesh,
        accountablePhone: fx.phoneByName.Imran,
        categoryId: 'PURCHASE',
        quadrant: 'Q1_DO_FIRST',
      });
      const built = buildAnonymizedMessageStagePrompt({
        task,
        teamMembers: Object.values(fx.state.team_members),
        businessProfile: fx.state.business_profile,
        ownerProfile: fx.state.owner_profile,
      });
      const cfg = defaultStageConfig('message');
      const mRes = await callCachedModel({
        ai,
        cacheKeyObj: { v: PROMPT_VERSION, stage: 'MESSAGE', id: tc.id, content: built.userContent },
        model: cfg.model,
        fallbackModel: cfg.fallbackModel,
        systemInstruction: built.systemInstruction,
        contents: built.userContent,
        temperature: cfg.temperature,
        maxOutputTokens: cfg.maxOutputTokens,
      });
      const deanon = deanonymizeAndValidateMessageStage(mRes.rawText, built.slotDirectory);
      const ok =
        Boolean(mRes.rawText) &&
        deanon.clean &&
        deanon.text.length < 600 &&
        !/nikamm/i.test(deanon.text) &&
        !textContainsWeakness(deanon.text, Object.values(fx.state.team_members));
      const label = ok ? `PASS (${mRes.modelUsed}, ${mRes.latencyMs}ms)` : `FAIL (${mRes.error || 'message check failed'})`;
      summaryRows.push({ id: tc.id, set: tc.set, pipeline: tc.pipeline, v2: label, legacy: label });
      console.log(`${tc.id} [${tc.set} | MESSAGE]: ${label}`);
      continue;
    }

    if (tc.pipeline === 'BUFFER_REPLY' && tc.staffReply) {
      const fx = applyCasePrecondition(buildFixture(tc.fixtures[0] || 'F1'), tc.precondition);
      const members = Object.values(fx.state.team_members);
      const speaker = fx.state.team_members[fx.phoneByName[tc.staffReply.speaker]] || members[0];
      const bufRes = enqueueInboundSimulatorMessage(
        fx.state,
        speaker.phone,
        { type: tc.staffReply.mediaType || 'text', textContent: tc.staffReply.text },
        TEST_CLOCK_ISO
      );
      const buffer = bufRes.nextState.inbound_message_buffer[speaker.phone];
      const built = buildAnonymizedBufferPrompt({
        employee: speaker,
        teamMembers: members,
        buffer,
        activeTasks: fx.state.tasks,
        systemMemory: fx.state.system_memory,
        principalPrompts: fx.state.principal_prompts,
        businessProfile: fx.state.business_profile,
        ownerProfile: fx.state.owner_profile,
      });
      const cfg = defaultStageConfig('bufferEvaluation');
      const bRes = await callCachedModel({
        ai,
        cacheKeyObj: { v: PROMPT_VERSION, stage: 'BUFFER', id: tc.id, text: built.textPart },
        model: cfg.model,
        fallbackModel: cfg.fallbackModel,
        systemInstruction: built.systemInstruction,
        contents: built.textPart,
        temperature: cfg.temperature,
        maxOutputTokens: cfg.maxOutputTokens,
        responseSchema: BUFFER_SCHEMA,
      });
      let ok = false;
      let note = bRes.error || '';
      if (bRes.data) {
        const out = deanonymizeBufferResponse(bRes.data, built.slotDirectory);
        const pct = Number(out.completionPercent ?? 0);
        if (tc.id === 'RPL-02') {
          ok = pct < 100 && /photo|tasveer|pic|image|फोटो/i.test(out.whatsappReplyInPreferredLanguage || '');
          if (!ok) note = `pct=${pct}`;
        } else if (tc.id === 'RPL-05') {
          ok = pct < 100 && Boolean(out.escalateToBossReview);
          if (!ok) note = `pct=${pct}, escalate=${out.escalateToBossReview}`;
        }
      }
      const label = ok ? `PASS (${bRes.modelUsed}, ${bRes.latencyMs}ms)` : `FAIL (${note})`;
      summaryRows.push({ id: tc.id, set: tc.set, pipeline: tc.pipeline, v2: label, legacy: label });
      console.log(`${tc.id} [${tc.set} | BUFFER_REPLY]: ${label}`);
      continue;
    }

    // MEDITATE or CONVERSATION across both v2 and legacy
    const fixtureList: FixtureId[] = tc.fixtures.length > 0 ? tc.fixtures : ['F1'];
    const runEngine = async (eng: 'v2' | 'legacy') => {
      for (const fxId of fixtureList) {
        const fx = applyCasePrecondition(buildFixture(fxId), tc.precondition);
        if (tc.pipeline === 'CONVERSATION' && tc.turns) {
          const hist: Array<{ role: 'user' | 'assistant'; text: string }> = [];
          let lastRes: any = null;
          for (let i = 0; i < tc.turns.length; i++) {
            lastRes = await runMeditateLive(ai, eng, fx, tc.turns[i], hist, tc.id, i);
            if (!lastRes.ok) return { pass: false, label: `FAIL (${lastRes.error})` };
            hist.push({ role: 'user', text: tc.turns[i] });
            hist.push({ role: 'assistant', text: String(lastRes.plan?.chatReplyToBoss || '') });
          }
          const ev = evaluateStarCase(tc, fx, lastRes.plan);
          if (!ev.pass) {
            return { pass: false, label: tc.set === 'HOLDOUT' ? 'FAIL' : `FAIL (${ev.reason})` };
          }
        } else {
          const res = await runMeditateLive(ai, eng, fx, tc.input || '', [], tc.id, 0);
          if (!res.ok) return { pass: false, label: tc.set === 'HOLDOUT' ? 'FAIL' : `FAIL (${res.error})` };
          const ev = evaluateStarCase(tc, fx, res.plan);
          if (!ev.pass) {
            return { pass: false, label: tc.set === 'HOLDOUT' ? 'FAIL' : `FAIL (${ev.reason})` };
          }
        }
      }
      return { pass: true, label: 'PASS' };
    };

    const v2Out = await runEngine('v2');
    const legOut = await runEngine('legacy');
    summaryRows.push({ id: tc.id, set: tc.set, pipeline: tc.pipeline, v2: v2Out.label, legacy: legOut.label });
    console.log(`${tc.id} [${tc.set} | ${tc.pipeline}]: v2=${v2Out.label} | legacy=${legOut.label}`);
  }

  console.log('\n=== 2. PLANNING LATENCY BENCHMARK (5 calls Primary vs 5 calls Backup, no cache) ===\n');
  const fx1 = buildFixture('F1');
  const members1 = Object.values(fx1.state.team_members);
  const benchPrompts = [
    'Kal subah lawn ki safai karwa do aur chairs check karwao.',
    'Mehta reception ke liye diesel check karwana hai aur phoolon ka rate lena hai.',
    'Rotary Club ka guest count confirm karna hai aur menu final karna hai.',
    'Hall ke AC check karwane hain aur parking board lagwana hai.',
    'Kitchen ki chimney saaf karwani hai aur store ka stock ginna hai.',
  ];

  const measureModel = async (model: string, label: string) => {
    const times: number[] = [];
    let timeouts = 0;
    let errors = 0;
    for (let i = 0; i < benchPrompts.length; i++) {
      const built = buildAnonymizedPlannerPrompt({
        dateContext: buildDateContextLine(TEST_TODAY_ISO),
        brainDump: benchPrompts[i],
        teamMembers: members1,
        tasks: [],
        categorySops: fx1.state.category_sops,
        systemMemory: fx1.state.system_memory,
        principalPrompts: fx1.state.principal_prompts,
        businessProfile: fx1.state.business_profile,
        ownerProfile: fx1.state.owner_profile,
        taskSplittingRules: fx1.state.task_splitting_rules,
      });
      const res = await callCachedModel({
        ai,
        cacheKeyObj: { bench: true, model, i },
        bypassCache: true,
        model,
        systemInstruction: built.systemInstruction,
        contents: built.prompt,
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseSchema: V2_PLANNER_SCHEMA,
      });
      times.push(res.latencyMs);
      if (res.timedOut) timeouts++;
      else if (res.error) errors++;
      console.log(`  [${label}] call ${i + 1}/5: ${res.latencyMs} ms ${res.timedOut ? '(TIMEOUT)' : res.error ? `(ERR: ${res.error})` : '(OK)'}`);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const slowest = sorted[sorted.length - 1];
    console.log(`  => ${label} (${model}): median=${median} ms, slowest=${slowest} ms, timeouts=${timeouts}, errors=${errors}\n`);
  };

  await measureModel(GEMINI_MODELS.balanced, 'Primary');
  await measureModel(GEMINI_MODELS.fast, 'Backup');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
