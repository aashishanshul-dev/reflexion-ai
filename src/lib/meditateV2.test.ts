import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerQuestionFromTasksFallback,
  buildAnonymizedIntentPrompt,
  buildAnonymizedPlannerPrompt,
  buildCombinedClarifyingQuestion,
  buildV2NonPlannerResponse,
  DEFAULT_INTENT_CONFIDENCE_THRESHOLD,
  hydratePlannerDefaults,
  MEDITATE_CONFIRM_CHIPS,
  parseDueHintToDate,
  resolveIntentConfidenceThreshold,
  routeMeditateV2Intent,
} from './meditateV2';
import {
  addMemoryRuleToState,
  addNoteToState,
  approveMemoryRuleInState,
  deleteNoteFromState,
} from './opsEngine';
import {
  buildSlotDirectory,
  deanonymizeMeditateResponse,
  resolveStageModelConfig,
} from './promptBuilder';
import { validateMeditatePlan } from './validator';
import {
  CategorySop,
  OpsDatabaseState,
  SystemMemoryRule,
  Task,
  TeamMember,
} from '../types/ops';

const SYNTHETIC_ROSTER: TeamMember[] = [
  {
    tenantId: 'default',
    phone: '1000000001',
    slotId: 'P1',
    name: 'Member Alpha',
    roleTitle: 'Operations Lead',
    authorityLevel: 'OWNER',
    skills: ['Approvals', 'Planning'],
    maxActiveTasks: 5,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '19:00',
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
    personaPrompt: 'Concise summary style.',
  },
  {
    tenantId: 'default',
    phone: '1000000002',
    slotId: 'P2',
    name: 'Member Beta',
    roleTitle: 'Technical Specialist',
    authorityLevel: 'STAFF',
    skills: ['Diagnostics', 'Verification'],
    maxActiveTasks: 3,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    dailyOverviewTime: '09:30',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 1,
      completed: 2,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 15,
      replyCount: 1,
    },
    personaPrompt: 'Stepwise checklist style.',
  },
  {
    tenantId: 'default',
    phone: '1000000003',
    slotId: 'P3',
    name: 'Member Gamma',
    roleTitle: 'Quality Coordinator',
    authorityLevel: 'SUPERVISOR',
    skills: ['Review', 'Sign-Off'],
    maxActiveTasks: 4,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '18:30',
    dailyOverviewTime: '09:15',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 0,
      completed: 3,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 12,
      replyCount: 1,
    },
    personaPrompt: 'Formal sign-off checklist.',
  },
];

const SYNTHETIC_SOPS: CategorySop[] = [
  {
    tenantId: 'default',
    categoryId: 'CAT_ALPHA',
    categoryName: 'Category Alpha',
    defaultClassification: 'MAJOR',
    sopSystemPrompt: 'Standard procedure alpha.',
    defaultMicroSteps: ['Step one', 'Step two'],
  },
  {
    tenantId: 'default',
    categoryId: 'CAT_BETA',
    categoryName: 'Category Beta',
    defaultClassification: 'MINOR',
    sopSystemPrompt: 'Standard procedure beta.',
    defaultMicroSteps: ['Step one'],
  },
];

function makeEmptySyntheticState(): OpsDatabaseState {
  return {
    tenantId: 'default',
    team_members: Object.fromEntries(SYNTHETIC_ROSTER.map((m) => [m.phone, m])),
    umbrella_agendas: [],
    wbs_heads: [],
    tasks: [],
    category_sops: SYNTHETIC_SOPS,
    system_memory: [],
    notes: [],
    boss_review_queue: [],
    inbound_message_buffer: {},
    whatsapp_messages: [],
    principal_prompts: {
      planningPrompt: 'Generic planner directive.',
      evaluationPrompt: 'Generic buffer directive.',
    },
    business_profile: {
      businessName: 'Generic Operations Unit',
      businessType: 'Multi-Team Operations',
      businessDescription: 'Structured task coordination.',
      workLocations: 'Zone A, Zone B',
      defaultStaffLanguage: 'ENGLISH',
      hardRules: 'Attach verification evidence.',
    },
    owner_profile: {
      personalOperatingPrompt: 'Delegate execution to specialists.',
      defaultAccountablePhone: '1000000003',
    },
    task_splitting_rules: {
      maxChecklistStepsPerTask: 4,
      defaultMaxActiveTasksPerPerson: 3,
      taskSplittingRule:
        'Keep one-person continuous work as QUICK; split cross-person handoffs into PROJECT.',
    },
    sample_brain_dumps: [],
    model_tuning: {
      meditateEngine: 'v2',
      meditateEngineUserSet: true,
      maxRecentConversationTurns: 8,
      intentConfidenceThreshold: 0.75,
      meditate: {
        model: 'gemini-flash-latest',
        fallbackModel: 'gemini-flash-lite-latest',
        temperature: 0.2,
        maxOutputTokens: 4096,
      },
      intent: {
        model: 'gemini-flash-lite-latest',
        fallbackModel: 'gemini-flash-latest',
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
      planner: {
        model: 'gemini-flash-latest',
        fallbackModel: 'gemini-flash-lite-latest',
        temperature: 0.2,
        maxOutputTokens: 4096,
      },
      bufferEvaluation: {
        model: 'gemini-flash-lite-latest',
        fallbackModel: 'gemini-flash-latest',
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    },
    ai_logs: [],
  };
}

test('resolveIntentConfidenceThreshold defaults to 0.75 and clamps out-of-range values', () => {
  assert.equal(resolveIntentConfidenceThreshold(undefined), DEFAULT_INTENT_CONFIDENCE_THRESHOLD);
  assert.equal(resolveIntentConfidenceThreshold(null), 0.75);
  assert.equal(resolveIntentConfidenceThreshold(Number.NaN), 0.75);
  assert.equal(resolveIntentConfidenceThreshold(-0.4), 0);
  assert.equal(resolveIntentConfidenceThreshold(1.5), 1);
  assert.equal(resolveIntentConfidenceThreshold(0.826), 0.83);
});

test('buildCombinedClarifyingQuestion always produces a single combined question', () => {
  // Preserves model reply when it already contains exactly one question
  const singleQ = buildCombinedClarifyingQuestion(
    ['target zone', 'unit count'],
    'Which target zone and unit count should {{P2}} use?'
  );
  assert.equal(singleQ, 'Which target zone and unit count should {{P2}} use?');
  assert.equal((singleQ.match(/\?/g) || []).length, 1);

  // Collapses multi-question model output into ONE combined question
  const collapsed = buildCombinedClarifyingQuestion(
    ['target zone', 'unit count', 'spec code'],
    'Which zone? How many units? Which spec code?'
  );
  assert.equal(
    collapsed,
    'Before staging this task, could you confirm target zone, unit count and spec code?'
  );
  assert.equal((collapsed.match(/\?/g) || []).length, 1);

  // Single missing item
  const oneItem = buildCombinedClarifyingQuestion(['target zone?'], '');
  assert.equal(oneItem, 'Before staging this task, could you confirm target zone?');
});

test('routeMeditateV2Intent routes low confidence to confirm chips and routes all 5 semantic kinds accurately', () => {
  // 1. Low confidence -> confirm chips
  const lowConf = routeMeditateV2Intent(
    {
      kind: 'NOTE',
      confidence: 0.62,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: 'Unit B pressure reading noted.',
    },
    { confidenceThreshold: 0.75 }
  );
  assert.equal(lowConf.route, 'AWAIT_OWNER_CONFIRMATION');
  assert.deepEqual(
    lowConf.confirmChips.map((c) => c.label),
    ['Make it a task', 'Save as note', 'Add as rule', 'Just chatting']
  );
  assert.equal(lowConf.confirmChips.length, MEDITATE_CONFIRM_CHIPS.length);

  // 2. Owner chip confirmation overrides low confidence
  const chipConfirmed = routeMeditateV2Intent(
    {
      kind: 'NOTE',
      confidence: 0.5,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: '',
    },
    { confidenceThreshold: 0.75, confirmedKind: 'RULE' }
  );
  assert.equal(chipConfirmed.route, 'STAGE_PENDING_RULE');
  assert.equal(chipConfirmed.effectiveKind, 'RULE');
  assert.equal(chipConfirmed.confirmChips.length, 0);

  // 3. TASK with missingCritical -> ASK_CLARIFYING_QUESTION (no planner)
  const missingTask = routeMeditateV2Intent({
    kind: 'TASK',
    confidence: 0.9,
    missingCritical: ['target location', 'quantity'],
    followUpForHeadId: null,
    replyToOwner: 'Where? How many?',
  });
  assert.equal(missingTask.route, 'ASK_CLARIFYING_QUESTION');
  assert.equal((missingTask.replyToOwner.match(/\?/g) || []).length, 1);

  // 4. TASK without missingCritical -> RUN_PLANNER
  const readyTask = routeMeditateV2Intent({
    kind: 'TASK',
    confidence: 0.92,
    missingCritical: [],
    followUpForHeadId: null,
    replyToOwner: 'Confirmed task.',
  });
  assert.equal(readyTask.route, 'RUN_PLANNER');

  // 5. NOTE, RULE, QUESTION, CASUAL
  assert.equal(
    routeMeditateV2Intent({
      kind: 'NOTE',
      confidence: 0.88,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: 'Saved note.',
    }).route,
    'SAVE_NOTE'
  );
  assert.equal(
    routeMeditateV2Intent({
      kind: 'RULE',
      confidence: 0.91,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: 'Staged rule.',
    }).route,
    'STAGE_PENDING_RULE'
  );
  assert.equal(
    routeMeditateV2Intent({
      kind: 'QUESTION',
      confidence: 0.89,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: 'Two tasks are active.',
    }).route,
    'ANSWER_QUESTION'
  );
  assert.equal(
    routeMeditateV2Intent({
      kind: 'CASUAL',
      confidence: 0.95,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: 'Hello!',
    }).route,
    'CASUAL_REPLY'
  );
});

test('parseDueHintToDate deterministically converts natural dueHint phrases to calendar dates', () => {
  // 2026-11-07 is a Saturday (UTC day 6)
  const refDate = '2026-11-07';

  assert.deepEqual(parseDueHintToDate(null, refDate), {
    dueDate: null,
    offsetDays: null,
    isForcedDeadline: false,
  });

  assert.deepEqual(parseDueHintToDate('today', refDate), {
    dueDate: '2026-11-07',
    offsetDays: 0,
    isForcedDeadline: false,
  });

  assert.deepEqual(parseDueHintToDate('tomorrow', refDate), {
    dueDate: '2026-11-08',
    offsetDays: 1,
    isForcedDeadline: false,
  });

  assert.deepEqual(parseDueHintToDate('day after tomorrow', refDate), {
    dueDate: '2026-11-09',
    offsetDays: 2,
    isForcedDeadline: false,
  });

  assert.deepEqual(parseDueHintToDate('in 3 days', refDate), {
    dueDate: '2026-11-10',
    offsetDays: 3,
    isForcedDeadline: false,
  });

  assert.deepEqual(parseDueHintToDate('within 2 weeks', refDate), {
    dueDate: '2026-11-21',
    offsetDays: 14,
    isForcedDeadline: true,
  });

  // Next Friday from Saturday 2026-11-07 is 2026-11-13; "before Friday" -> Thursday 2026-11-12
  const beforeFri = parseDueHintToDate('before Friday', refDate);
  assert.equal(beforeFri.dueDate, '2026-11-12');
  assert.equal(beforeFri.offsetDays, 5);
  assert.equal(beforeFri.isForcedDeadline, true);

  // "by Friday" -> Friday 2026-11-13
  const byFri = parseDueHintToDate('by Friday', refDate);
  assert.equal(byFri.dueDate, '2026-11-13');
  assert.equal(byFri.offsetDays, 6);
  assert.equal(byFri.isForcedDeadline, true);

  // Explicit ISO date with "before"
  const beforeIso = parseDueHintToDate('before 2026-11-12', refDate);
  assert.equal(beforeIso.dueDate, '2026-11-11');
  assert.equal(beforeIso.isForcedDeadline, true);

  // Same-day time-of-day hint
  const before5pm = parseDueHintToDate('before 5 PM', refDate);
  assert.equal(before5pm.dueDate, '2026-11-07');
  assert.equal(before5pm.offsetDays, 0);
  assert.equal(before5pm.isForcedDeadline, true);
});

test('hydratePlannerDefaults fills nullable dates, durations, quadrant, and size and converts dueHint while preserving RACI', () => {
  const rawQuickPlan = {
    lane: 'QUICK',
    chatReplyToBoss: 'Staged quick task for {{P2}}.',
    reasoningSummary: 'Single-person continuous work.',
    agendaTitle: '',
    agendaQuadrant: null,
    agendaMajorOrMinor: null,
    suggestedMemoryRules: [],
    draftedTasks: [
      {
        title: 'Run diagnostic check on Unit Alpha',
        shortTag: null,
        categoryId: 'CAT_ALPHA',
        quadrant: null,
        majorOrMinor: null,
        taskFrequency: null,
        recurrenceRule: null,
        raci: { R: 'P2', A: null, C: [], I: [] },
        dependsOnSubtaskIndex: null,
        triggerCondition: null,
        startDate: null,
        durationDays: null,
        dueDate: null,
        dueHint: 'before Friday',
        isForcedDeadline: null,
        forcedDeadlineDate: null,
        wbsHeadId: null,
        swimlaneStage: null,
        microSteps: ['Check indicator', 'Capture log'],
        outboundWhatsappPreview: 'Hello {{P2}}, run diagnostic check.',
      },
    ],
    wbsHeads: [],
  };

  const hydrated = hydratePlannerDefaults(rawQuickPlan, {
    referenceDate: '2026-11-07',
    categorySops: SYNTHETIC_SOPS,
  });

  assert.equal(hydrated.lane, 'QUICK');
  assert.deepEqual(hydrated.wbsHeads, []);
  assert.equal(hydrated.draftedTasks[0].startDate, '2026-11-07');
  assert.equal(hydrated.draftedTasks[0].dueDate, '2026-11-12');
  assert.equal(hydrated.draftedTasks[0].dueDateOffsetDays, 5);
  assert.equal(hydrated.draftedTasks[0].durationDays, 1);
  assert.equal(hydrated.draftedTasks[0].isForcedDeadline, true);
  assert.equal(hydrated.draftedTasks[0].forcedDeadlineDate, '2026-11-12');
  assert.equal(hydrated.draftedTasks[0].majorOrMinor, 'MAJOR'); // from CAT_ALPHA defaultClassification
  assert.equal(hydrated.draftedTasks[0].quadrant, 'Q2_SCHEDULE');
  assert.equal(hydrated.draftedTasks[0].raci.R, 'P2');

  const valCheck = validateMeditatePlan(hydrated, {
    roster: SYNTHETIC_ROSTER,
    categoryIds: SYNTHETIC_SOPS.map((s) => s.categoryId),
    existingTasks: [],
    defaultAccountableSlot: 'P3',
    maxChecklistStepsPerTask: 4,
    allowResolvedPhonesInRaci: false,
  });
  assert.equal(valCheck.valid, true);
  assert.equal(valCheck.normalizedPlan.draftedTasks[0].raci.A, 'P3');

  const dir = buildSlotDirectory(SYNTHETIC_ROSTER, {
    personalOperatingPrompt: '',
    defaultAccountablePhone: '1000000003',
  });
  const deanonymized = deanonymizeMeditateResponse(valCheck.normalizedPlan, dir, 4);
  assert.equal(deanonymized.draftedTasks[0].raci.R, '1000000002');
  assert.equal(deanonymized.draftedTasks[0].raci.A, '1000000003');
});

test('buildAnonymizedIntentPrompt and buildAnonymizedPlannerPrompt scrub PII, omit word-count rules, and exclude unapproved memory rules', () => {
  const state = makeEmptySyntheticState();
  const rules: SystemMemoryRule[] = [
    {
      tenantId: 'default',
      memoryId: 'MEM-APPROVED',
      category: 'BUSINESS_RULE',
      fact: 'Approved standing rule alpha.',
      approved: true,
      active: true,
    },
    {
      tenantId: 'default',
      memoryId: 'MEM-PENDING',
      category: 'BUSINESS_RULE',
      fact: 'Unapproved pending rule beta.',
      approved: false,
      active: true,
    },
  ];
  const history = Array.from({ length: 10 }, (_, idx) => ({
    role: idx % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `Turn ${idx + 1} mentioning Member Beta (1000000002)`,
  }));

  const intentPrompt = buildAnonymizedIntentPrompt({
    brainDump: 'Assign Member Beta at +1000000002 to check Zone A.',
    wbsHeads: [],
    teamMembers: SYNTHETIC_ROSTER,
    tasks: [],
    categorySops: SYNTHETIC_SOPS,
    systemMemory: rules,
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
    taskSplittingRules: state.task_splitting_rules,
    conversationHistory: history,
    maxRecentConversationTurns: 8,
  });

  assert.equal(intentPrompt.piiAudit.clean, true);
  assert.equal(intentPrompt.historyCapped.recentTurnsCount, 8);
  assert.equal(intentPrompt.historyCapped.olderTurnsSummarizedCount, 2);
  assert.ok(intentPrompt.prompt.includes('Approved standing rule alpha.'));
  assert.ok(!intentPrompt.prompt.includes('Unapproved pending rule beta.'));
  assert.ok(!/12\s*words/i.test(intentPrompt.systemInstruction));

  const plannerPrompt = buildAnonymizedPlannerPrompt({
    brainDump: 'Assign Member Beta at 1000000002 to check Zone A before Friday.',
    teamMembers: SYNTHETIC_ROSTER,
    tasks: [],
    categorySops: SYNTHETIC_SOPS,
    systemMemory: rules,
    principalPrompts: state.principal_prompts,
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
    taskSplittingRules: state.task_splitting_rules,
    conversationHistory: history,
    maxRecentConversationTurns: 8,
  });

  assert.equal(plannerPrompt.piiAudit.clean, true);
  assert.ok(plannerPrompt.prompt.includes('Approved standing rule alpha.'));
  assert.ok(!plannerPrompt.prompt.includes('Unapproved pending rule beta.'));
  assert.ok(!/12\s*words/i.test(plannerPrompt.systemInstruction));
});

test('buildV2NonPlannerResponse, answerQuestionFromTasksFallback, notes helpers, and pending memory approval helpers work end-to-end', () => {
  let state = makeEmptySyntheticState();
  const dir = buildSlotDirectory(SYNTHETIC_ROSTER, state.owner_profile);

  // Empty tasks fallback answer
  assert.equal(
    answerQuestionFromTasksFallback([], dir),
    'There are currently no active open tasks on the board.'
  );

  // Active task fallback answer scrubs PII into slots
  const sampleTask: Task = {
    tenantId: 'default',
    taskCode: 'T-201',
    shortTag: 'Check A',
    agendaId: null,
    title: 'Inspect Zone A with Member Beta',
    categoryId: 'CAT_ALPHA',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    raci: { R: '1000000002', A: '1000000003', C: [], I: [] },
    dependency: { dependsOnTaskCode: null, triggerCondition: 'FULL_COMPLETION' },
    startDate: '2026-11-07',
    durationDays: 1,
    dueDate: '2026-11-07',
    isForcedDeadline: false,
    forcedDeadlineDate: null,
    status: 'IN_PROGRESS',
    completionPercent: 50,
    microSteps: [],
    missingStepsAlert: '',
    reminderConfig: {
      lastNudgedAt: null,
      nudgeCount: 0,
      includeInDailyOverview: true,
      customIntervalHours: null,
    },
    auditLogs: [],
    isFrozen: true,
    latestAiSummary: 'In progress.',
    outboundWhatsappPreview: 'Check Zone A',
  };
  const boardSummary = answerQuestionFromTasksFallback([sampleTask], dir);
  assert.ok(boardSummary.includes('[T-201]'));
  assert.ok(boardSummary.includes('{{P2}}'));
  assert.ok(!boardSummary.includes('Member Beta'));

  // Non-planner RULE response sets approved=false
  const ruleRes = buildV2NonPlannerResponse({
    route: 'STAGE_PENDING_RULE',
    intent: {
      kind: 'RULE',
      confidence: 0.94,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: 'Staged rule for {{P2}}.',
      ruleCategory: 'SOP_PREFERENCE',
    },
    replyToOwner: 'Staged rule for {{P2}}.',
    rawBrainDump: 'Always ask {{P2}} for timestamped verification.',
    slotDirectory: dir,
  });
  assert.equal(ruleRes.pendingRuleToSave?.approved, false);
  assert.equal(ruleRes.pendingRuleToSave?.category, 'SOP_PREFERENCE');
  assert.ok(ruleRes.pendingRuleToSave?.fact.includes('Member Beta'));

  // State helpers: notes & pending rules
  state = addNoteToState(state, 'Reference serial X-404 recorded.', '2026-11-07T10:00:00.000Z');
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].tenantId, 'default');
  const noteId = state.notes[0].noteId;

  state = deleteNoteFromState(state, noteId);
  assert.equal(state.notes.length, 0);

  state = addMemoryRuleToState(state, {
    category: 'BUSINESS_RULE',
    fact: 'Require dual sign-off on major items.',
    approved: false,
  });
  assert.equal(state.system_memory.length, 1);
  assert.equal(state.system_memory[0].approved, false);
  assert.equal(state.system_memory[0].active, false);
  assert.equal(state.system_memory[0].tenantId, 'default');

  const memId = state.system_memory[0].memoryId;
  state = approveMemoryRuleInState(state, memId);
  assert.equal(state.system_memory[0].approved, true);
  assert.equal(state.system_memory[0].active, true);

  // Stage config resolution for INTENT and PLANNER
  const intentCfg = resolveStageModelConfig('INTENT', state.model_tuning);
  const plannerCfg = resolveStageModelConfig('PLANNER', state.model_tuning);
  assert.equal(intentCfg.model, 'gemini-flash-lite-latest');
  assert.equal(intentCfg.temperature, 0.1);
  assert.equal(plannerCfg.model, 'gemini-flash-latest');
  assert.equal(plannerCfg.temperature, 0.2);
});
