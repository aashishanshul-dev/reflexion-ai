import { createDemoSeedState } from '../../../src/lib/demoData.ts';
import { defaultStageConfig, MODEL_DEFAULTS_VERSION } from '../../../src/lib/modelConfig.ts';
import type { OpsDatabaseState } from '../../../src/types/ops.ts';
import { TEST_CLOCK_ISO, type TuningFixture } from './types.ts';

export function createEmptyFixture(): TuningFixture {
  const state: OpsDatabaseState = {
    tenantId: 'tuning-empty',
    team_members: {},
    category_sops: [
      {
        tenantId: 'tuning-empty',
        categoryId: 'AD_HOC',
        categoryName: 'General Operations',
        defaultClassification: 'MINOR',
        sopSystemPrompt: 'Direct operational action without unnecessary ceremony.',
        defaultMicroSteps: ['Complete task step', 'Confirm update'],
      },
    ],
    umbrella_agendas: [],
    wbs_heads: [],
    tasks: [],
    boss_review_queue: [],
    inbound_message_buffer: {},
    system_memory: [],
    notes: [],
    whatsapp_messages: [],
    principal_prompts: {
      planningPrompt: 'You are OpsCommand AI Meditate Planner. Help the owner structure operations simply without inventing people or facts.',
      evaluationPrompt: 'You are OpsCommand AI Staff Reply Inspector.',
    },
    business_profile: {
      businessName: 'New Workspace',
      businessType: 'General Small Business',
      businessDescription: 'First-time workspace setup.',
      workLocations: 'Main Office',
      defaultStaffLanguage: 'HINGLISH',
      hardRules: '',
      timezone: 'Asia/Kolkata',
      workingDays: [1, 2, 3, 4, 5, 6],
      batchNonUrgentIntoDigest: false,
      enforceWhatsapp24hWindow: false,
    },
    owner_profile: {
      personalOperatingPrompt: 'Keep instructions short, clear, and free of jargon.',
      defaultAccountablePhone: '',
    },
    task_splitting_rules: {
      maxChecklistStepsPerTask: 5,
      defaultMaxActiveTasksPerPerson: 3,
      taskSplittingRule: 'Use QUICK with 1 task for single-owner work and PROJECT when handoffs occur.',
    },
    sample_brain_dumps: [],
    model_tuning: {
      modelDefaultsVersion: MODEL_DEFAULTS_VERSION,
      meditateEngine: 'v2',
      meditateEngineUserSet: true,
      intentConfidenceThreshold: 0.75,
      maxRecentConversationTurns: 8,
      meditate: defaultStageConfig('meditate'),
      intent: defaultStageConfig('intent'),
      planner: defaultStageConfig('planner'),
      bufferEvaluation: defaultStageConfig('bufferEvaluation'),
      message: defaultStageConfig('message'),
    },
    ai_logs: [],
  };

  return {
    id: 'EMPTY',
    holdoutOnly: false,
    label: 'Empty New Workspace',
    ownerName: 'Visitor',
    ownerLanguageNote: 'Any',
    state,
    memberExtras: {},
    records: [],
    vendors: [],
    phoneByName: {},
  };
}

export function createDemoBaselineFixture(): TuningFixture {
  const demoState = createDemoSeedState(TEST_CLOCK_ISO);
  // Keep exact shipped demo state except ensuring clean phoneByName map for evaluation checks
  const phoneByName: Record<string, string> = {};
  for (const m of Object.values(demoState.team_members)) {
    phoneByName[m.name] = m.phone;
  }
  return {
    id: 'DEMO',
    holdoutOnly: false,
    label: 'BlueDrop Water Supplies (Demo Seed)',
    ownerName: 'Arvind Deshmukh',
    ownerLanguageNote: 'English/Hinglish',
    state: demoState,
    memberExtras: {},
    records: [],
    vendors: [],
    phoneByName,
  };
}
