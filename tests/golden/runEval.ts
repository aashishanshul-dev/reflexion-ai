import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import {
  buildAnonymizedMeditatePrompt,
  createAiCallLog,
  deanonymizeMeditateResponse,
  PROMPT_VERSION,
  resolveStageModelConfig,
} from '../../src/lib/promptBuilder';
import {
  buildIntentRepairPrompt,
  buildPlanRepairPrompt,
  buildValidationFailureClarification,
  MeditateValidationContext,
  resolveMeditateEngine,
  validateIntentStageOutput,
  validateMeditatePlan,
} from '../../src/lib/validator';
import {
  buildAnonymizedIntentPrompt,
  buildAnonymizedPlannerPrompt,
  buildV2NonPlannerResponse,
  hydratePlannerDefaults,
  routeMeditateV2Intent,
} from '../../src/lib/meditateV2';
import { appendAiLogToState } from '../../src/lib/opsEngine';
import { describeGeminiError, withGeminiTimeout } from '../../src/lib/geminiErrors';
import { callWithBusyRetry } from '../../src/lib/geminiRetry';
import { createInitialSeedState } from '../../src/lib/seedData';
import {
  AiValidationStatus,
  DEFAULT_TENANT_ID,
  MeditateV2IntentKind,
  MeditateV2RouteOutcome,
  OpsDatabaseState,
  TeamMember,
} from '../../src/types/ops';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type EvalExecutionMode = 'SIMULATED' | 'LIVE';

interface GoldenCase {
  id: string;
  scenario: string;
  brainDump: string;
  expected: {
    intentClassification: 'CASUAL_OR_TEST' | 'NEEDS_CLARIFICATION' | 'ACTIONABLE_AGENDA';
    nonTaskKind?: 'NOTE' | 'RULE' | 'CASUAL';
    expectedMode: 'NONE' | 'QUICK_TASK' | 'PROJECT_SWIMLANES';
    minTasks: number;
    maxTasks: number;
    minHeads: number;
    maxHeads: number;
    expectedResponsibleSlots: string[];
  };
  simulatedSlotResponse: any;
}

const EVAL_ROSTER: TeamMember[] = [
  {
    tenantId: DEFAULT_TENANT_ID,
    phone: '919811100001',
    slotId: 'P1',
    name: 'Aarav Mehta',
    roleTitle: 'Operations Owner',
    authorityLevel: 'OWNER',
    skills: ['Approvals', 'Budget Sign-Off', 'Strategy'],
    maxActiveTasks: 5,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '20:00',
    dailyOverviewTime: '09:00',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 0,
      completed: 0,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 0,
      replyCount: 0,
    },
    personaPrompt: 'Crisp executive updates.',
  },
  {
    tenantId: DEFAULT_TENANT_ID,
    phone: '919811100002',
    slotId: 'P2',
    name: 'Dev Patel',
    roleTitle: 'Procurement & Inventory Specialist',
    authorityLevel: 'STAFF',
    skills: ['Procurement', 'Vendor Sourcing', 'Inventory'],
    maxActiveTasks: 3,
    preferredLanguage: 'HINGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '19:00',
    dailyOverviewTime: '09:30',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 1,
      completed: 2,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 24,
      replyCount: 2,
    },
    personaPrompt: 'Practical Hinglish vendor updates.',
  },
  {
    tenantId: DEFAULT_TENANT_ID,
    phone: '919811100003',
    slotId: 'P3',
    name: 'Priya Nair',
    roleTitle: 'Technical & Site Lead',
    authorityLevel: 'STAFF',
    skills: ['Electrical', 'HVAC', 'Technical Maintenance', 'Site Setup'],
    maxActiveTasks: 3,
    preferredLanguage: 'HINGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '19:00',
    dailyOverviewTime: '09:30',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 1,
      completed: 4,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 30,
      replyCount: 3,
    },
    personaPrompt: 'Clear technical checklist instructions.',
  },
  {
    tenantId: DEFAULT_TENANT_ID,
    phone: '919811100004',
    slotId: 'P4',
    name: 'Rohan Verma',
    roleTitle: 'Operations Supervisor',
    authorityLevel: 'SUPERVISOR',
    skills: ['Supervision', 'Quality Inspection', 'Safety Sign-Off'],
    maxActiveTasks: 4,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '19:30',
    dailyOverviewTime: '09:15',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 1,
      completed: 3,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 18,
      replyCount: 2,
    },
    personaPrompt: 'Structured operational sign-off checklists.',
  },
  {
    tenantId: DEFAULT_TENANT_ID,
    phone: '919811100005',
    slotId: 'P5',
    name: 'Kavita Rao',
    roleTitle: 'Accounts & Compliance Executive',
    authorityLevel: 'MANAGER',
    skills: ['Accounts', 'Invoice Audit', 'Compliance'],
    maxActiveTasks: 4,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:30',
    workShiftEnd: '18:30',
    dailyOverviewTime: '09:30',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 1,
      completed: 5,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 20,
      replyCount: 2,
    },
    personaPrompt: 'Formal accounting and invoice audit reminders.',
  },
];

const MEDITATE_EVAL_SCHEMA = {
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
    agendaMajorOrMinor: { type: Type.STRING, enum: ['MAJOR', 'MINOR'] },
    suggestedMemoryRules: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING },
          fact: { type: Type.STRING },
        },
        required: ['category', 'fact'],
      },
    },
    draftedTasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          shortTag: { type: Type.STRING },
          categoryId: { type: Type.STRING },
          quadrant: { type: Type.STRING },
          majorOrMinor: { type: Type.STRING },
          taskFrequency: { type: Type.STRING },
          recurrenceRule: { type: Type.STRING },
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
          triggerCondition: { type: Type.STRING },
          dueDateOffsetDays: { type: Type.INTEGER },
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
          quadrant: { type: Type.STRING },
          majorOrMinor: { type: Type.STRING },
          tentativeDurationDays: { type: Type.NUMBER },
          tentativeStartDate: { type: Type.STRING },
          tentativeDeadline: { type: Type.STRING },
          isForcedDeadline: { type: Type.BOOLEAN },
          dynamicStages: { type: Type.ARRAY, items: { type: Type.STRING } },
          involvedPhones: { type: Type.ARRAY, items: { type: Type.STRING } },
          status: { type: Type.STRING },
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

const V2_INTENT_EVAL_SCHEMA = {
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

const V2_PLANNER_EVAL_SCHEMA = {
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
    draftedTasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
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

async function invokeLiveGeminiJson(
  apiKey: string,
  systemInstruction: string,
  prompt: string,
  temperature: number,
  maxOutputTokens: number,
  models: { model: string; fallbackModel?: string },
  responseSchema: any = MEDITATE_EVAL_SCHEMA
): Promise<any> {
  const ai = new GoogleGenAI({ apiKey });
  // Google sometimes answers 503 "high demand". Wait and retry, then use the
  // stage's backup model, so one busy moment doesn't stop the whole eval.
  const { result: response, attempts, usedBackupModel, modelUsed } = await callWithBusyRetry({
    models: [models.model, models.fallbackModel],
    call: (model) =>
      withGeminiTimeout(model, (abortSignal) =>
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction,
            temperature,
            maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema,
            abortSignal,
          },
        })
      ),
    onRetry: (e) =>
      console.warn(
        `  … ${liveCallStats.caseId}: ${describeGeminiError(e.error, e.model)}` +
          (e.nextDelayMs !== null ? `; retrying in ${e.nextDelayMs / 1000}s` : '; trying the backup model')
      ),
  });
  liveCallStats.calls++;
  if (attempts > 1) liveCallStats.retriedCalls++;
  if (usedBackupModel) {
    liveCallStats.backupCalls++;
    liveCallStats.backupCases.add(`${liveCallStats.caseId} (${modelUsed})`);
  }
  return JSON.parse((response.text ?? '{}').trim());
}

/** Counts of live calls that needed a retry or the backup model (shown in the summary). */
const liveCallStats = {
  caseId: '',
  calls: 0,
  retriedCalls: 0,
  backupCalls: 0,
  backupCases: new Set<string>(),
};

function deriveSimulatedV2Intent(tc: GoldenCase) {
  if (tc.expected.intentClassification === 'CASUAL_OR_TEST') {
    const kind: MeditateV2IntentKind = tc.expected.nonTaskKind || 'CASUAL';
    return {
      kind,
      confidence: 0.95,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: tc.simulatedSlotResponse.chatReplyToBoss || 'Acknowledged.',
      ruleCategory:
        kind === 'RULE'
          ? tc.simulatedSlotResponse.suggestedMemoryRules?.[0]?.category || 'BUSINESS_RULE'
          : null,
    };
  }

  if (tc.expected.intentClassification === 'NEEDS_CLARIFICATION') {
    return {
      kind: 'TASK' as const,
      confidence: 0.91,
      missingCritical: ['the exact target specification and location'],
      followUpForHeadId: null,
      replyToOwner: tc.simulatedSlotResponse.chatReplyToBoss || 'Could you clarify the missing details?',
      ruleCategory: null,
    };
  }

  return {
    kind: 'TASK' as const,
    confidence: 0.96,
    missingCritical: [],
    followUpForHeadId: null,
    replyToOwner: 'Confirmed operational task.',
    ruleCategory: null,
  };
}

function deriveSimulatedV2Planner(tc: GoldenCase) {
  const base = structuredClone(tc.simulatedSlotResponse);
  const isQuick = tc.expected.expectedMode === 'QUICK_TASK';
  if (isQuick) {
    const firstTask = base.draftedTasks?.[0];
    return {
      lane: 'QUICK',
      chatReplyToBoss: base.chatReplyToBoss,
      reasoningSummary: base.reasoningSummary,
      agendaTitle: base.agendaTitle,
      agendaQuadrant: null,
      agendaMajorOrMinor: null,
      suggestedMemoryRules: base.suggestedMemoryRules || [],
      draftedTasks: firstTask
        ? [
            {
              ...firstTask,
              quadrant: null,
              majorOrMinor: null,
              startDate: null,
              durationDays: null,
              dueDate: null,
              dueHint: 'today',
              wbsHeadId: null,
              swimlaneStage: null,
            },
          ]
        : [],
      wbsHeads: [],
    };
  }

  return {
    lane: 'PROJECT',
    chatReplyToBoss: base.chatReplyToBoss,
    reasoningSummary: base.reasoningSummary,
    agendaTitle: base.agendaTitle,
    agendaQuadrant: base.agendaQuadrant ?? null,
    agendaMajorOrMinor: base.agendaMajorOrMinor ?? null,
    suggestedMemoryRules: base.suggestedMemoryRules || [],
    draftedTasks: (base.draftedTasks || []).map((t: any) => ({
      ...t,
      startDate: t.startDate ?? null,
      durationDays: t.durationDays ?? null,
      dueDate: t.dueDate ?? null,
      dueHint: t.dueHint ?? null,
    })),
    wbsHeads: base.wbsHeads || [],
  };
}

async function runGoldenEvaluation() {
  const evalMode: EvalExecutionMode = process.argv.includes('--live') ? 'LIVE' : 'SIMULATED';
  const activeEngine = resolveMeditateEngine({ envEngine: process.env.MEDITATE_ENGINE });
  const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();

  if (evalMode === 'LIVE' && (!apiKey || apiKey === 'MY_GEMINI_API_KEY')) {
    console.error('================================================================================');
    console.error('OpsCommand AI — Golden Evaluation Suite [MODE: LIVE]');
    console.error(
      'ERROR: Live evaluation requested (--live), but GEMINI_API_KEY is not configured.'
    );
    console.error('Refusing to substitute simulated fixtures in LIVE mode.');
    console.error('================================================================================');
    process.exit(1);
  }

  const casesPath = path.join(__dirname, 'goldenCases.json');
  const goldenCases = JSON.parse(fs.readFileSync(casesPath, 'utf-8')) as GoldenCase[];

  let state: OpsDatabaseState = {
    ...createInitialSeedState(),
    tenantId: DEFAULT_TENANT_ID,
    team_members: Object.fromEntries(EVAL_ROSTER.map((m) => [m.phone, m])),
    owner_profile: {
      personalOperatingPrompt:
        'Delegate ground execution to specialists; route budget variances to Boss Review Queue.',
      defaultAccountablePhone: '919811100004',
    },
    ai_logs: [],
  };

  const evalBusinessProfile = {
    businessName: 'Multi-Site Operations Group',
    businessType: 'Facility, Retail & Event Operations',
    businessDescription: 'Multi-department ground operations managed over WhatsApp.',
    workLocations: 'Main Facility, Hall A, Warehouse Bay B, Server Closet',
    defaultStaffLanguage: 'HINGLISH' as const,
    hardRules: 'Require vendor invoice photo for all purchases.',
  };

  // Multi-turn history fixture (12 turns -> verifies 8-turn cap + 4 older turns summarized)
  const syntheticHistory = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text:
      i % 2 === 0
        ? `Earlier directive #${i + 1} referencing Dev Patel (+919811100002)`
        : `Ack #${i + 1} staged for Priya Nair`,
  }));

  let passedCount = 0;
  let intentPassCount = 0;
  let laneModePassCount = 0;
  let validatorPassCount = 0;
  let zeroPiiPassCount = 0;
  let slotMappingPassCount = 0;
  let historyCapPassCount = 0;
  let totalLatencyMs = 0;
  const failures: string[] = [];

  console.log('================================================================================');
  console.log(
    `OpsCommand AI — Golden Evaluation Suite (${goldenCases.length} Cases) | MODE: ${evalMode}`
  );
  console.log(`Prompt Version: ${PROMPT_VERSION} | MEDITATE_ENGINE: ${activeEngine}`);
  console.log(
    evalMode === 'SIMULATED'
      ? 'Execution Source: SIMULATED (Deterministic Golden Fixtures + Validator + Slot Identity)'
      : 'Execution Source: LIVE (Real Gemini API + Validator + 1-Pass Repair)'
  );
  console.log('================================================================================');

  for (const tc of goldenCases) {
    liveCallStats.caseId = tc.id;
    const startMs = Date.now();
    let zeroPiiOk = false;
    let historyCapOk = false;
    let deanonymized: any;
    let validatorOk = false;
    let nonTaskRouteOk = true;

    if (activeEngine === 'v2') {
      // ==================== MEDITATE V2 (INTENT -> ROUTER -> PLANNER) ====================
      const intentStartMs = Date.now();
      const intentCfg = resolveStageModelConfig('INTENT', state.model_tuning);
      const intentBuilt = buildAnonymizedIntentPrompt({
        brainDump: tc.brainDump,
        wbsHeads: [],
        teamMembers: EVAL_ROSTER,
        tasks: [],
        categorySops: state.category_sops,
        systemMemory: [],
        businessProfile: evalBusinessProfile,
        ownerProfile: state.owner_profile,
        taskSplittingRules: state.task_splitting_rules,
        conversationHistory: syntheticHistory,
        maxRecentConversationTurns: state.model_tuning.maxRecentConversationTurns,
      });

      zeroPiiOk = intentBuilt.piiAudit.clean;
      historyCapOk =
        intentBuilt.historyCapped.recentTurnsCount === 8 &&
        intentBuilt.historyCapped.olderTurnsSummarizedCount === 4 &&
        intentBuilt.historyCapped.olderTurnsSummary.length > 0;

      let intentStatus: AiValidationStatus = 'VALID';
      let intentNote = '';
      let validatedIntent = null as ReturnType<typeof validateIntentStageOutput>['normalizedIntent'];
      let intentIssues = [] as ReturnType<typeof validateIntentStageOutput>['issues'];

      if (evalMode === 'LIVE') {
        const rawIntent = await invokeLiveGeminiJson(
          apiKey,
          intentBuilt.systemInstruction,
          intentBuilt.prompt,
          intentCfg.temperature,
          intentCfg.maxOutputTokens,
          intentCfg,
          V2_INTENT_EVAL_SCHEMA
        );
        const firstIntentCheck = validateIntentStageOutput(rawIntent, {
          roster: EVAL_ROSTER,
          validHeadIds: intentBuilt.validHeadIds,
        });
        if (firstIntentCheck.valid && firstIntentCheck.normalizedIntent) {
          validatedIntent = firstIntentCheck.normalizedIntent;
          intentStatus = 'VALID';
          intentNote = `${tc.id}: INTENT passed validator on 1st pass (LIVE)`;
        } else {
          const repairPrompt = buildIntentRepairPrompt(
            intentBuilt.prompt,
            rawIntent,
            firstIntentCheck.issues
          );
          const repairedIntent = await invokeLiveGeminiJson(
            apiKey,
            intentBuilt.systemInstruction,
            repairPrompt,
            intentCfg.temperature,
            intentCfg.maxOutputTokens,
            intentCfg,
            V2_INTENT_EVAL_SCHEMA
          );
          const secondIntentCheck = validateIntentStageOutput(repairedIntent, {
            roster: EVAL_ROSTER,
            validHeadIds: intentBuilt.validHeadIds,
          });
          if (secondIntentCheck.valid && secondIntentCheck.normalizedIntent) {
            validatedIntent = secondIntentCheck.normalizedIntent;
            intentStatus = 'SCHEMA_REPAIRED';
            intentNote = `${tc.id}: INTENT repaired in 1 retry (LIVE)`;
          } else {
            intentIssues = secondIntentCheck.issues;
            intentStatus = 'ERROR';
            intentNote = `${tc.id}: INTENT failed validator after 1 retry (LIVE)`;
          }
        }
      } else {
        const rawIntent = deriveSimulatedV2Intent(tc);
        const check = validateIntentStageOutput(rawIntent, {
          roster: EVAL_ROSTER,
          validHeadIds: intentBuilt.validHeadIds,
        });
        validatedIntent = check.normalizedIntent;
        intentIssues = check.issues;
        intentStatus = check.valid ? 'VALID' : 'ERROR';
        intentNote = check.valid
          ? `${tc.id}: INTENT passed validator (SIMULATED)`
          : `${tc.id}: INTENT validator errors: ${check.issues.map((i) => i.code).join(', ')}`;
      }

      state = appendAiLogToState(
        state,
        createAiCallLog({
          tenantId: state.tenantId,
          stage: 'INTENT',
          model: evalMode === 'LIVE' ? intentCfg.model : `${intentCfg.model} (simulated-eval)`,
          temperature: intentCfg.temperature,
          maxOutputTokens: intentCfg.maxOutputTokens,
          latencyMs: Math.max(1, Date.now() - intentStartMs),
          validationStatus: intentStatus,
          validationNote: intentNote,
          turnsSent: intentBuilt.historyCapped.recentTurnsCount,
          olderTurnsSummarized: intentBuilt.historyCapped.olderTurnsSummarizedCount,
        })
      );

      if (!validatedIntent) {
        validatorOk = false;
        deanonymized = buildValidationFailureClarification(intentIssues, intentBuilt.slotDirectory);
      } else {
        const routed = routeMeditateV2Intent(validatedIntent, {
          confidenceThreshold: state.model_tuning.intentConfidenceThreshold,
        });

        if (routed.route !== 'RUN_PLANNER') {
          const nonPlanner = buildV2NonPlannerResponse({
            route: routed.route as Exclude<MeditateV2RouteOutcome, 'RUN_PLANNER'>,
            intent: validatedIntent,
            replyToOwner: routed.replyToOwner,
            confirmChips: routed.confirmChips,
            rawBrainDump: tc.brainDump,
            slotDirectory: intentBuilt.slotDirectory,
          });
          const npCheck = validateMeditatePlan(nonPlanner, {
            roster: EVAL_ROSTER,
            categoryIds: state.category_sops.map((c) => c.categoryId),
            existingTasks: [],
            defaultAccountablePhone: intentBuilt.slotDirectory.defaultAccountablePhone,
            ownerProfile: state.owner_profile,
            maxChecklistStepsPerTask: state.task_splitting_rules?.maxChecklistStepsPerTask ?? 5,
            allowResolvedPhonesInRaci: true,
          });
          validatorOk = npCheck.valid;
          deanonymized = npCheck.valid
            ? npCheck.normalizedPlan
            : buildValidationFailureClarification(npCheck.issues, intentBuilt.slotDirectory);

          if (deanonymized.pendingRuleToSave && deanonymized.pendingRuleToSave.approved !== false) {
            nonTaskRouteOk = false;
          }
          if (evalMode === 'SIMULATED' && tc.expected.nonTaskKind) {
            if (tc.expected.nonTaskKind === 'NOTE') {
              nonTaskRouteOk =
                deanonymized.v2Route === 'SAVE_NOTE' && Boolean(deanonymized.noteToSave?.text);
            } else if (tc.expected.nonTaskKind === 'RULE') {
              nonTaskRouteOk =
                deanonymized.v2Route === 'STAGE_PENDING_RULE' &&
                deanonymized.pendingRuleToSave?.approved === false;
            } else if (tc.expected.nonTaskKind === 'CASUAL') {
              nonTaskRouteOk = deanonymized.v2Route === 'CASUAL_REPLY';
            }
          }
        } else {
          // Stage 2: PLANNER
          const plannerStartMs = Date.now();
          const plannerCfg = resolveStageModelConfig('PLANNER', state.model_tuning);
          const plannerBuilt = buildAnonymizedPlannerPrompt({
            brainDump: tc.brainDump,
            followUpHead: null,
            teamMembers: EVAL_ROSTER,
            tasks: [],
            categorySops: state.category_sops,
            systemMemory: [],
            principalPrompts: state.principal_prompts,
            businessProfile: evalBusinessProfile,
            ownerProfile: state.owner_profile,
            taskSplittingRules: state.task_splitting_rules,
            sampleBrainDumps: [],
            conversationHistory: syntheticHistory,
            maxRecentConversationTurns: state.model_tuning.maxRecentConversationTurns,
          });

          zeroPiiOk = zeroPiiOk && plannerBuilt.piiAudit.clean;
          historyCapOk =
            historyCapOk &&
            plannerBuilt.historyCapped.recentTurnsCount === 8 &&
            plannerBuilt.historyCapped.olderTurnsSummarizedCount === 4 &&
            plannerBuilt.historyCapped.olderTurnsSummary.length > 0;

          const plannerValCtx: MeditateValidationContext = {
            roster: EVAL_ROSTER,
            categoryIds: state.category_sops.map((c) => c.categoryId),
            existingTasks: [],
            defaultAccountableSlot: plannerBuilt.slotDirectory.defaultAccountableSlot,
            ownerProfile: state.owner_profile,
            maxChecklistStepsPerTask: plannerBuilt.maxStepsPerTask,
            allowResolvedPhonesInRaci: false,
          };

          let plannerStatus: AiValidationStatus = 'VALID';
          let plannerNote = '';

          if (evalMode === 'LIVE') {
            const firstRawPlan = await invokeLiveGeminiJson(
              apiKey,
              plannerBuilt.systemInstruction,
              plannerBuilt.prompt,
              plannerCfg.temperature,
              plannerCfg.maxOutputTokens,
              plannerCfg,
              V2_PLANNER_EVAL_SCHEMA
            );
            const firstHydrated = hydratePlannerDefaults(firstRawPlan, {
              referenceDate: '2026-11-07',
              categorySops: state.category_sops,
            });
            const firstPlanCheck = validateMeditatePlan(firstHydrated, plannerValCtx);

            if (firstPlanCheck.valid) {
              validatorOk = true;
              plannerStatus = 'VALID';
              plannerNote = `${tc.id}: PLANNER passed validator on 1st pass (LIVE)`;
              deanonymized = deanonymizeMeditateResponse(
                {
                  ...firstPlanCheck.normalizedPlan,
                  v2Intent: validatedIntent,
                  v2Route: 'RUN_PLANNER',
                  meditateEngineUsed: 'v2',
                },
                plannerBuilt.slotDirectory,
                plannerBuilt.maxStepsPerTask
              );
            } else {
              const repairPrompt = buildPlanRepairPrompt(
                plannerBuilt.prompt,
                firstHydrated,
                firstPlanCheck.issues
              );
              const repairedRawPlan = await invokeLiveGeminiJson(
                apiKey,
                plannerBuilt.systemInstruction,
                repairPrompt,
                plannerCfg.temperature,
                plannerCfg.maxOutputTokens,
                plannerCfg,
                V2_PLANNER_EVAL_SCHEMA
              );
              const secondHydrated = hydratePlannerDefaults(repairedRawPlan, {
                referenceDate: '2026-11-07',
                categorySops: state.category_sops,
              });
              const secondPlanCheck = validateMeditatePlan(secondHydrated, plannerValCtx);

              if (secondPlanCheck.valid) {
                validatorOk = true;
                plannerStatus = 'SCHEMA_REPAIRED';
                plannerNote = `${tc.id}: PLANNER repaired in 1 retry (LIVE)`;
                deanonymized = deanonymizeMeditateResponse(
                  {
                    ...secondPlanCheck.normalizedPlan,
                    v2Intent: validatedIntent,
                    v2Route: 'RUN_PLANNER',
                    meditateEngineUsed: 'v2',
                  },
                  plannerBuilt.slotDirectory,
                  plannerBuilt.maxStepsPerTask
                );
              } else {
                validatorOk = false;
                plannerStatus = 'ERROR';
                plannerNote = `${tc.id}: PLANNER failed validator after 1 retry (LIVE)`;
                deanonymized = buildValidationFailureClarification(
                  secondPlanCheck.issues,
                  plannerBuilt.slotDirectory
                );
              }
            }
          } else {
            const rawSimPlan = deriveSimulatedV2Planner(tc);
            const hydratedPlan = hydratePlannerDefaults(rawSimPlan, {
              referenceDate: '2026-11-07',
              categorySops: state.category_sops,
            });
            const planCheck = validateMeditatePlan(hydratedPlan, plannerValCtx);
            validatorOk = planCheck.valid;
            plannerStatus = planCheck.valid ? 'VALID' : 'ERROR';
            plannerNote = planCheck.valid
              ? `${tc.id}: PLANNER passed validator (SIMULATED)`
              : `${tc.id}: PLANNER validator errors: ${planCheck.issues.map((i) => i.code).join(', ')}`;
            deanonymized = planCheck.valid
              ? deanonymizeMeditateResponse(
                  {
                    ...planCheck.normalizedPlan,
                    v2Intent: validatedIntent,
                    v2Route: 'RUN_PLANNER',
                    meditateEngineUsed: 'v2',
                  },
                  plannerBuilt.slotDirectory,
                  plannerBuilt.maxStepsPerTask
                )
              : buildValidationFailureClarification(
                  planCheck.issues,
                  plannerBuilt.slotDirectory
                );
          }

          state = appendAiLogToState(
            state,
            createAiCallLog({
              tenantId: state.tenantId,
              stage: 'PLANNER',
              model: evalMode === 'LIVE' ? plannerCfg.model : `${plannerCfg.model} (simulated-eval)`,
              temperature: plannerCfg.temperature,
              maxOutputTokens: plannerCfg.maxOutputTokens,
              latencyMs: Math.max(1, Date.now() - plannerStartMs),
              validationStatus: plannerStatus,
              validationNote: plannerNote,
              turnsSent: plannerBuilt.historyCapped.recentTurnsCount,
              olderTurnsSummarized: plannerBuilt.historyCapped.olderTurnsSummarizedCount,
            })
          );
        }
      }
    } else {
      // ==================== LEGACY ENGINE ====================
      const stageCfg = resolveStageModelConfig('MEDITATE_PLANNING', state.model_tuning);

      const built = buildAnonymizedMeditatePrompt({
        brainDump: tc.brainDump,
        teamMembers: EVAL_ROSTER,
        tasks: [],
        categorySops: state.category_sops,
        systemMemory: [],
        businessProfile: evalBusinessProfile,
        ownerProfile: state.owner_profile,
        taskSplittingRules: state.task_splitting_rules,
        sampleBrainDumps: [],
        conversationHistory: syntheticHistory,
        maxRecentConversationTurns: state.model_tuning.maxRecentConversationTurns,
      });

      zeroPiiOk = built.piiAudit.clean;
      historyCapOk =
        built.historyCapped.recentTurnsCount === 8 &&
        built.historyCapped.olderTurnsSummarizedCount === 4 &&
        built.historyCapped.olderTurnsSummary.length > 0;

      const validationCtx: MeditateValidationContext = {
        roster: EVAL_ROSTER,
        categoryIds: state.category_sops.map((c) => c.categoryId),
        existingTasks: [],
        defaultAccountableSlot: built.slotDirectory.defaultAccountableSlot,
        ownerProfile: state.owner_profile,
        maxChecklistStepsPerTask: built.maxStepsPerTask,
        allowResolvedPhonesInRaci: false,
      };

      let validationStatus: AiValidationStatus = 'VALID';
      let validationNote = '';

      if (evalMode === 'LIVE') {
        const firstRaw = await invokeLiveGeminiJson(
          apiKey,
          built.systemInstruction,
          built.prompt,
          stageCfg.temperature,
          stageCfg.maxOutputTokens,
          stageCfg
        );
        const firstCheck = validateMeditatePlan(firstRaw, validationCtx);
        if (firstCheck.valid) {
          validatorOk = true;
          validationStatus = 'VALID';
          validationNote = `${tc.id}: Passed validator on 1st pass (LIVE)`;
          deanonymized = deanonymizeMeditateResponse(
            firstCheck.normalizedPlan,
            built.slotDirectory,
            built.maxStepsPerTask
          );
        } else {
          const repairPrompt = buildPlanRepairPrompt(built.prompt, firstRaw, firstCheck.issues);
          const repairedRaw = await invokeLiveGeminiJson(
            apiKey,
            built.systemInstruction,
            repairPrompt,
            stageCfg.temperature,
            stageCfg.maxOutputTokens,
            stageCfg
          );
          const secondCheck = validateMeditatePlan(repairedRaw, validationCtx);
          if (secondCheck.valid) {
            validatorOk = true;
            validationStatus = 'SCHEMA_REPAIRED';
            validationNote = `${tc.id}: Repaired in 1 retry (LIVE)`;
            deanonymized = deanonymizeMeditateResponse(
              secondCheck.normalizedPlan,
              built.slotDirectory,
              built.maxStepsPerTask
            );
          } else {
            validatorOk = false;
            validationStatus = 'ERROR';
            validationNote = `${tc.id}: Failed validator after 1 retry (LIVE)`;
            deanonymized = buildValidationFailureClarification(
              secondCheck.issues,
              built.slotDirectory
            );
          }
        }
      } else {
        const rawModelResponse = tc.simulatedSlotResponse;
        const check = validateMeditatePlan(rawModelResponse, validationCtx);
        validatorOk = check.valid;
        validationStatus = check.valid ? 'VALID' : 'ERROR';
        validationNote = check.valid
          ? `${tc.id}: Passed validator (SIMULATED)`
          : `${tc.id}: Validator errors: ${check.issues.map((i) => i.code).join(', ')}`;
        deanonymized = check.valid
          ? deanonymizeMeditateResponse(
              check.normalizedPlan,
              built.slotDirectory,
              built.maxStepsPerTask
            )
          : buildValidationFailureClarification(check.issues, built.slotDirectory);
      }

      const latencyMs = Math.max(1, Date.now() - startMs);
      const aiLog = createAiCallLog({
        tenantId: state.tenantId,
        stage: 'MEDITATE_PLANNING',
        model: evalMode === 'LIVE' ? stageCfg.model : `${stageCfg.model} (simulated-eval)`,
        temperature: stageCfg.temperature,
        maxOutputTokens: stageCfg.maxOutputTokens,
        latencyMs,
        validationStatus,
        validationNote,
        turnsSent: built.historyCapped.recentTurnsCount,
        olderTurnsSummarized: built.historyCapped.olderTurnsSummarizedCount,
      });
      state = appendAiLogToState(state, aiLog);
    }

    if (zeroPiiOk) zeroPiiPassCount++;
    if (historyCapOk) historyCapPassCount++;
    if (validatorOk) validatorPassCount++;

    totalLatencyMs += Math.max(1, Date.now() - startMs);

    // 4. Check Intent
    const intentOk =
      deanonymized.intentClassification === tc.expected.intentClassification && nonTaskRouteOk;
    if (intentOk) intentPassCount++;

    // 5. Check Task/Lane Mode
    const tasksCount = Array.isArray(deanonymized.draftedTasks)
      ? deanonymized.draftedTasks.length
      : 0;
    const headsCount = Array.isArray(deanonymized.wbsHeads) ? deanonymized.wbsHeads.length : 0;

    const actualMode: 'NONE' | 'QUICK_TASK' | 'PROJECT_SWIMLANES' =
      tasksCount === 0
        ? 'NONE'
        : tasksCount === 1 && headsCount <= 1
          ? 'QUICK_TASK'
          : 'PROJECT_SWIMLANES';

    const effectiveMinHeads =
      activeEngine === 'v2' && tc.expected.expectedMode === 'QUICK_TASK'
        ? 0
        : tc.expected.minHeads;

    const boundsOk =
      tasksCount >= tc.expected.minTasks &&
      tasksCount <= tc.expected.maxTasks &&
      headsCount >= effectiveMinHeads &&
      headsCount <= tc.expected.maxHeads;

    const v2LaneTagOk =
      activeEngine !== 'v2' ||
      actualMode === 'NONE' ||
      (actualMode === 'QUICK_TASK' ? deanonymized.lane === 'QUICK' : deanonymized.lane === 'PROJECT');

    const laneModeOk = actualMode === tc.expected.expectedMode && boundsOk && v2LaneTagOk;
    if (laneModeOk) laneModePassCount++;

    // 6. Check Slot-to-Phone roundtrip mapping (all RACI R/A are real registered phones, zero raw P1..P5 left)
    const registeredPhones = new Set(EVAL_ROSTER.map((m) => m.phone));
    const slotMapOk = (deanonymized.draftedTasks || []).every(
      (t: any) =>
        registeredPhones.has(t.raci?.R) &&
        registeredPhones.has(t.raci?.A) &&
        !/^P\d+$/i.test(t.raci?.R) &&
        !/^P\d+$/i.test(t.raci?.A)
    );
    if (slotMapOk) slotMappingPassCount++;

    const casePassed =
      zeroPiiOk && historyCapOk && validatorOk && intentOk && laneModeOk && slotMapOk;
    if (casePassed) {
      passedCount++;
      console.log(
        `✔ [${evalMode}] ${tc.id} | ${tc.expected.intentClassification.padEnd(
          19
        )} | Mode: ${actualMode.padEnd(17)} | Tasks: ${tasksCount} | Heads: ${headsCount} | VAL: PASS | PII: CLEAN`
      );
    } else {
      const reason = `zeroPii=${zeroPiiOk}, historyCap=${historyCapOk}, validator=${validatorOk}, intent=${intentOk} (got ${deanonymized.intentClassification}, nonTaskRouteOk=${nonTaskRouteOk}), laneMode=${laneModeOk} (got ${actualMode}, lane=${deanonymized.lane || 'legacy'}, tasks=${tasksCount}, heads=${headsCount}), slotMap=${slotMapOk}`;
      failures.push(`${tc.id} (${tc.scenario}): ${reason}`);
      console.error(`✖ [${evalMode}] ${tc.id} FAILED -> ${reason}`);
    }
  }

  const total = goldenCases.length;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

  console.log('--------------------------------------------------------------------------------');
  console.log(`EVALUATION METRICS SUMMARY [MODE: ${evalMode}]:`);
  console.log(`- Evaluation Execution Mode          : ${evalMode}`);
  console.log(`- Active Meditate Engine             : ${activeEngine}`);
  console.log(`- Total Golden Brain-Dumps Evaluated : ${total}`);
  console.log(`- Overall Pass Rate                  : ${passedCount}/${total} (${pct(passedCount)})`);
  console.log(`- Intent Classification Accuracy     : ${intentPassCount}/${total} (${pct(intentPassCount)})`);
  console.log(`- Quick-Task vs Swimlane Accuracy    : ${laneModePassCount}/${total} (${pct(laneModePassCount)})`);
  console.log(`- Deterministic Validator Pass Rate  : ${validatorPassCount}/${total} (${pct(validatorPassCount)})`);
  console.log(`- Zero-PII Slot Anonymization Rate   : ${zeroPiiPassCount}/${total} (${pct(zeroPiiPassCount)})`);
  console.log(`- Server Slot->Phone Mapping Rate    : ${slotMappingPassCount}/${total} (${pct(slotMappingPassCount)})`);
  console.log(`- 8-Turn History Cap + Summary Rate  : ${historyCapPassCount}/${total} (${pct(historyCapPassCount)})`);
  console.log(`- Telemetry Entries in state.ai_logs : ${state.ai_logs.length} (min expected: ${total})`);
  console.log(`- Average Pipeline Latency           : ${(totalLatencyMs / total).toFixed(2)} ms`);
  if (evalMode === 'LIVE') {
    console.log(`- Live Gemini Calls                  : ${liveCallStats.calls}`);
    console.log(`- Calls Needing a Busy-Retry         : ${liveCallStats.retriedCalls}`);
    console.log(
      `- Calls Answered by Backup Model     : ${liveCallStats.backupCalls}` +
        (liveCallStats.backupCases.size ? ` — ${[...liveCallStats.backupCases].join(', ')}` : '')
    );
  }
  console.log('================================================================================');

  const logsOk = activeEngine === 'v2' ? state.ai_logs.length >= total : state.ai_logs.length === total;
  if (failures.length > 0 || !logsOk) {
    console.error(`Golden Evaluation [${evalMode}] Failed:`, failures);
    process.exit(1);
  }
}

runGoldenEvaluation().catch((err) => {
  console.error('Unexpected error in Golden Eval:', err);
  process.exit(1);
});
