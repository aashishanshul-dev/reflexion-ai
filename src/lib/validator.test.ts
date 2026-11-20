import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntentRepairPrompt,
  buildNeutralBufferFallbackResponse,
  buildPlanRepairPrompt,
  buildValidationFailureClarification,
  containsPhoneNumberInText,
  MeditateValidationContext,
  resolveMeditateEngine,
  validateIntentStageOutput,
  validateMeditatePlan,
} from './validator';
import { buildSlotDirectory } from './promptBuilder';
import { applyProcessedBufferResult, enqueueInboundSimulatorMessage } from './opsEngine';
import { createInitialSeedState } from './seedData';
import { TeamMember } from '../types/ops';

const GENERIC_ROSTER: TeamMember[] = [
  {
    tenantId: 'default',
    phone: '1000000001',
    slotId: 'P1',
    name: 'Member One',
    roleTitle: 'Operations Owner',
    authorityLevel: 'OWNER',
    skills: ['Strategy', 'Approvals'],
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
    personaPrompt: 'Concise updates.',
  },
  {
    tenantId: 'default',
    phone: '1000000002',
    slotId: 'P2',
    name: 'Member Two',
    roleTitle: 'Field Specialist',
    authorityLevel: 'STAFF',
    skills: ['Procurement', 'Maintenance'],
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
      totalWorkHoursReplyMins: 20,
      replyCount: 2,
    },
    personaPrompt: 'Direct Hinglish.',
  },
  {
    tenantId: 'default',
    phone: '1000000003',
    slotId: 'P3',
    name: 'Member Three',
    roleTitle: 'Supervisor',
    authorityLevel: 'SUPERVISOR',
    skills: ['Supervision', 'Quality'],
    maxActiveTasks: 4,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '19:00',
    dailyOverviewTime: '09:15',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 1,
      completed: 3,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 15,
      replyCount: 1,
    },
    personaPrompt: 'Structured checklist.',
  },
  {
    tenantId: 'default',
    phone: '1000000004',
    slotId: 'P4',
    name: 'Member Four',
    roleTitle: 'Technician (On Leave)',
    authorityLevel: 'STAFF',
    skills: ['Installation'],
    maxActiveTasks: 3,
    preferredLanguage: 'HINGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '19:00',
    dailyOverviewTime: '09:30',
    isOnLeave: true,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 0,
      completed: 1,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 10,
      replyCount: 1,
    },
    personaPrompt: 'Simple updates.',
  },
];

function makeBaseContext(
  overrides: Partial<MeditateValidationContext> = {}
): MeditateValidationContext {
  return {
    roster: GENERIC_ROSTER,
    categoryIds: ['PROCUREMENT', 'MAINTENANCE', 'ACCOUNTS', 'AD_HOC'],
    existingTasks: [{ taskCode: 'T-100', dependency: { dependsOnTaskCode: null, triggerCondition: 'FULL_COMPLETION' } }],
    defaultAccountableSlot: 'P3',
    ownerProfile: {
      personalOperatingPrompt: 'Delegate field tasks.',
      defaultAccountablePhone: '1000000003',
    },
    maxChecklistStepsPerTask: 4,
    allowResolvedPhonesInRaci: false,
    ...overrides,
  };
}

function makeValidQuickPlan() {
  return {
    intentClassification: 'ACTIONABLE_AGENDA',
    chatReplyToBoss: 'Staged 1 task for {{P2}}.',
    reasoningSummary: 'Single-owner continuous work.',
    agendaTitle: 'Routine Equipment Check',
    agendaQuadrant: 'Q1_DO_FIRST',
    agendaMajorOrMinor: 'MINOR',
    suggestedMemoryRules: [],
    draftedTasks: [
      {
        title: 'Check pressure readings',
        shortTag: 'Pressure Check',
        categoryId: 'MAINTENANCE',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MINOR',
        taskFrequency: 'ONE_TIME',
        recurrenceRule: 'NONE',
        raci: { R: 'P2', A: '', C: ['P1'], I: [] },
        dependsOnSubtaskIndex: null,
        triggerCondition: 'FULL_COMPLETION',
        dueDateOffsetDays: 0,
        wbsHeadId: 'HEAD-1',
        swimlaneStage: 'Execution',
        microSteps: ['Inspect gauge', 'Share photo'],
        outboundWhatsappPreview: 'Hello {{P2}}, please check pressure gauge by 2026-11-07.',
      },
    ],
    wbsHeads: [
      {
        headId: 'HEAD-1',
        title: 'Routine Equipment Check',
        domainCategory: 'MAINTENANCE',
        contextSummary: 'Single-person check',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MINOR',
        tentativeDurationDays: 0.5,
        tentativeStartDate: '2026-11-07',
        tentativeDeadline: '2026-11-07',
        isForcedDeadline: false,
        dynamicStages: ['Execution'],
        involvedPhones: ['P2'],
        status: 'SWIMLANE_READY',
      },
    ],
  };
}

test('resolveMeditateEngine defaults to v2 and honors only server env var', () => {
  assert.equal(resolveMeditateEngine(), 'v2');
  assert.equal(resolveMeditateEngine({ envEngine: undefined }), 'v2');
  assert.equal(resolveMeditateEngine({ envEngine: '' }), 'v2');
  assert.equal(resolveMeditateEngine({ envEngine: 'unknown' }), 'v2');
  assert.equal(resolveMeditateEngine({ envEngine: 'v2' }), 'v2');
  assert.equal(resolveMeditateEngine({ envEngine: 'legacy' }), 'legacy');
  assert.equal(resolveMeditateEngine({ envEngine: ' LEGACY ' }), 'legacy');
  // Any unexpected extra client fields passed at runtime are ignored in favor of server env/v2
  assert.equal(
    resolveMeditateEngine({ envEngine: undefined, ...({ uiEngine: 'legacy', uiUserSet: true } as any) }),
    'v2'
  );
});

test('containsPhoneNumberInText catches phone numbers in text while ignoring ISO dates and plain quantities', () => {
  assert.equal(containsPhoneNumberInText('Call +91 98765 43210 immediately'), true);
  assert.equal(containsPhoneNumberInText('Reach out at (415) 555-0199 today'), true);
  assert.equal(containsPhoneNumberInText('Member contact 1000-000-002', ['1000000002']), true);
  assert.equal(
    containsPhoneNumberInText('Scheduled from 2026-11-07 to 2026-11-09 with budget 25000'),
    false
  );
});

test('validateMeditatePlan accepts valid Quick plan and defaults blank A to defaultAccountableSlot without changing R', () => {
  const plan = makeValidQuickPlan();
  const res = validateMeditatePlan(plan, makeBaseContext());
  assert.equal(res.valid, true, `Unexpected issues: ${JSON.stringify(res.issues)}`);
  assert.equal(res.normalizedPlan.draftedTasks[0].raci.R, 'P2');
  assert.equal(res.normalizedPlan.draftedTasks[0].raci.A, 'P3');
});

test('validateMeditatePlan rejects unknown R/A/C/I slots, missing/multiple R, multiple A, and R on leave — never auto-changing R', () => {
  const unknownSlotPlan = makeValidQuickPlan();
  unknownSlotPlan.draftedTasks[0].raci.R = 'P99';
  const r1 = validateMeditatePlan(unknownSlotPlan, makeBaseContext());
  assert.equal(r1.valid, false);
  assert.ok(r1.issues.some((i) => i.code === 'UNKNOWN_RACI_SLOT'));
  assert.equal(r1.normalizedPlan.draftedTasks[0].raci.R, 'P99', 'Validator must never rewrite R');

  const multipleRPlan = makeValidQuickPlan();
  multipleRPlan.draftedTasks[0].raci.R = 'P2, P3';
  const r2 = validateMeditatePlan(multipleRPlan, makeBaseContext());
  assert.equal(r2.valid, false);
  assert.ok(r2.issues.some((i) => i.code === 'TASK_R_MISSING_OR_MULTIPLE'));

  const multipleAPlan = makeValidQuickPlan();
  multipleAPlan.draftedTasks[0].raci.A = 'P1/P3';
  const r3 = validateMeditatePlan(multipleAPlan, makeBaseContext());
  assert.equal(r3.valid, false);
  assert.ok(r3.issues.some((i) => i.code === 'TASK_A_MULTIPLE'));

  const onLeavePlan = makeValidQuickPlan();
  onLeavePlan.draftedTasks[0].raci.R = 'P4'; // P4 is on leave
  const r4 = validateMeditatePlan(onLeavePlan, makeBaseContext());
  assert.equal(r4.valid, false);
  assert.ok(r4.issues.some((i) => i.code === 'RESPONSIBLE_ON_LEAVE'));
  assert.equal(r4.normalizedPlan.draftedTasks[0].raci.R, 'P4', 'Validator must not auto-reassign R');
});

test('validateMeditatePlan owner-delegated-category check is a no-op when list is empty and blocks when configured', () => {
  const ownerRPlan = makeValidQuickPlan();
  ownerRPlan.draftedTasks[0].raci.R = 'P1'; // OWNER
  ownerRPlan.draftedTasks[0].categoryId = 'PROCUREMENT';

  // Milestone 1 default: list is empty -> no-op (passes)
  const resNoOp = validateMeditatePlan(ownerRPlan, makeBaseContext());
  assert.equal(resNoOp.valid, true);

  // Milestone 4 ready: when alwaysDelegatesCategories includes PROCUREMENT -> blocks
  const resBlocked = validateMeditatePlan(
    ownerRPlan,
    makeBaseContext({ ownerAlwaysDelegatesCategories: ['PROCUREMENT'] })
  );
  assert.equal(resBlocked.valid, false);
  assert.ok(resBlocked.issues.some((i) => i.code === 'OWNER_DELEGATED_CATEGORY_VIOLATION'));
});

test('validateMeditatePlan enforces category existence, max checklist steps, quick-task head limit, project head/stage refs, dependencies, cycles, and no phones in text', () => {
  // 1. Invalid category
  const badCat = makeValidQuickPlan();
  badCat.draftedTasks[0].categoryId = 'NON_EXISTENT_CAT';
  assert.ok(
    validateMeditatePlan(badCat, makeBaseContext()).issues.some(
      (i) => i.code === 'UNKNOWN_CATEGORY_ID'
    )
  );

  // 2. Exceeds maxChecklistStepsPerTask (4)
  const tooManySteps = makeValidQuickPlan();
  tooManySteps.draftedTasks[0].microSteps = ['S1', 'S2', 'S3', 'S4', 'S5'];
  assert.ok(
    validateMeditatePlan(tooManySteps, makeBaseContext()).issues.some(
      (i) => i.code === 'MAX_CHECKLIST_STEPS_EXCEEDED'
    )
  );

  // 3. Quick-task mode with extra heads
  const extraHeads = makeValidQuickPlan();
  extraHeads.wbsHeads.push({
    ...extraHeads.wbsHeads[0],
    headId: 'HEAD-2',
  });
  assert.ok(
    validateMeditatePlan(extraHeads, makeBaseContext()).issues.some(
      (i) => i.code === 'QUICK_TASK_EXTRA_HEADS'
    )
  );

  // 4. Project-mode invalid stage & dependency cycle
  const projectWithCycleAndBadStage = {
    ...makeValidQuickPlan(),
    draftedTasks: [
      {
        ...makeValidQuickPlan().draftedTasks[0],
        wbsHeadId: 'HEAD-1',
        swimlaneStage: 'Procurement',
        dependsOnSubtaskIndex: 1,
      },
      {
        ...makeValidQuickPlan().draftedTasks[0],
        raci: { R: 'P3', A: 'P1', C: [], I: [] },
        wbsHeadId: 'HEAD-1',
        swimlaneStage: 'UnknownStage',
        dependsOnSubtaskIndex: 0,
      },
    ],
    wbsHeads: [
      {
        ...makeValidQuickPlan().wbsHeads[0],
        dynamicStages: ['Procurement', 'Verification'],
        involvedPhones: ['P2', 'P3'],
      },
    ],
  };
  const projRes = validateMeditatePlan(projectWithCycleAndBadStage, makeBaseContext());
  assert.equal(projRes.valid, false);
  assert.ok(projRes.issues.some((i) => i.code === 'PROJECT_MISSING_HEAD_OR_STAGE'));
  assert.ok(projRes.issues.some((i) => i.code === 'DEPENDENCY_CYCLE'));

  // 5. Phone number inside text field
  const phoneInText = makeValidQuickPlan();
  phoneInText.draftedTasks[0].outboundWhatsappPreview =
    'Please call +91 98123 45678 after completing.';
  assert.ok(
    validateMeditatePlan(phoneInText, makeBaseContext()).issues.some(
      (i) => i.code === 'PHONE_NUMBER_IN_TEXT'
    )
  );
});

test('buildPlanRepairPrompt and buildValidationFailureClarification list issues cleanly without leaking phone numbers or inventing tasks', () => {
  const dir = buildSlotDirectory(GENERIC_ROSTER);
  const badPlan = makeValidQuickPlan();
  badPlan.draftedTasks[0].raci.R = 'P4';
  // Staff-facing WhatsApp preview: phones here are still a hard block.
  badPlan.draftedTasks[0].outboundWhatsappPreview = 'Contact 9876543210 directly.';

  const check = validateMeditatePlan(badPlan, makeBaseContext());
  assert.equal(check.valid, false);

  const repairPrompt = buildPlanRepairPrompt('ORIGINAL_PROMPT', badPlan, check.issues);
  assert.ok(repairPrompt.includes('RESPONSIBLE_ON_LEAVE'));
  assert.ok(repairPrompt.includes('PHONE_NUMBER_IN_TEXT'));
  assert.ok(!repairPrompt.includes('9876543210'), 'Repair prompt must redact leaked phone digits');

  const clarification = buildValidationFailureClarification(check.issues, dir);
  assert.equal(clarification.intentClassification, 'NEEDS_CLARIFICATION');
  assert.deepEqual(clarification.draftedTasks, []);
  assert.deepEqual(clarification.wbsHeads, []);
  assert.ok(clarification.chatReplyToBoss?.includes('Member Four'));
  assert.ok(!clarification.chatReplyToBoss?.includes('9876543210'));
});

test('buildNeutralBufferFallbackResponse + applyProcessedBufferResult logs batch, marks task "Update received — needs review", sends neutral ack, and changes zero statuses', () => {
  let state = createInitialSeedState('2026-11-07T10:00:00.000Z');
  const staffPhone = Object.keys(state.team_members)[1];
  const member = state.team_members[staffPhone];
  const taskBefore = state.tasks.find((t) => t.raci.R === staffPhone)!;
  const statusBefore = taskBefore.status;
  const percentBefore = taskBefore.completionPercent;
  const stepsBefore = structuredClone(taskBefore.microSteps);

  // Even when message contains words that old keyword fallback used to match ("ho gaya", "done", "nahi")
  const enq = enqueueInboundSimulatorMessage(
    state,
    staffPhone,
    {
      type: 'text',
      textContent: 'Kaam pura done ho gaya hai, bill abhi nahi mila.',
    },
    '2026-11-07T10:05:00.000Z'
  );
  state = enq.nextState;

  const neutralRes = buildNeutralBufferFallbackResponse({
    employee: member,
    buffer: state.inbound_message_buffer[staffPhone],
    activeTasks: [taskBefore],
  });

  assert.equal(neutralRes.isNeutralFallback, true);
  assert.deepEqual(neutralRes.updatedMicroSteps, []);
  assert.equal(neutralRes.escalateToBossReview, false);
  assert.equal(neutralRes.englishBossSummary, 'Update received — needs review');

  const afterState = applyProcessedBufferResult(
    state,
    staffPhone,
    neutralRes,
    '2026-11-07T10:06:00.000Z'
  );

  const taskAfter = afterState.tasks.find((t) => t.taskCode === taskBefore.taskCode)!;
  assert.equal(taskAfter.status, statusBefore, 'Task status must NOT change on neutral fallback');
  assert.equal(
    taskAfter.completionPercent,
    percentBefore,
    'Completion percent must NOT change on neutral fallback'
  );
  assert.deepEqual(
    taskAfter.microSteps,
    stepsBefore,
    'Micro-step statuses must NOT change on neutral fallback'
  );
  assert.equal(taskAfter.latestAiSummary, 'Update received — needs review');
  assert.equal(taskAfter.missingStepsAlert, 'Update received — needs review');

  const lastWa = afterState.whatsapp_messages[afterState.whatsapp_messages.length - 1];
  assert.equal(lastWa.direction, 'OUTBOUND');
  assert.equal(lastWa.tag, 'NEUTRAL_FALLBACK_ACK');
});

test('validateIntentStageOutput and buildIntentRepairPrompt validate Meditate v2 INTENT output and redact phone numbers', () => {
  const validIntent = validateIntentStageOutput(
    {
      kind: 'TASK',
      confidence: 0.88,
      missingCritical: ['target zone'],
      followUpForHeadId: 'HEAD-UNKNOWN',
      replyToOwner: 'Which target zone should {{P2}} inspect?',
      ruleCategory: null,
    },
    {
      roster: GENERIC_ROSTER,
      validHeadIds: ['HEAD-1'],
    }
  );
  assert.equal(validIntent.valid, true);
  assert.equal(validIntent.normalizedIntent?.kind, 'TASK');
  assert.equal(
    validIntent.normalizedIntent?.followUpForHeadId,
    null,
    'Unknown followUpForHeadId should normalize safely to null'
  );

  const badIntentRaw = {
    kind: 'INVALID_KIND',
    confidence: 1.5,
    missingCritical: ['Call 1000000002'],
    followUpForHeadId: null,
    replyToOwner: 'Reach +91 98123 45678 now.',
  };
  const badCheck = validateIntentStageOutput(badIntentRaw, { roster: GENERIC_ROSTER });
  assert.equal(badCheck.valid, false);
  assert.ok(badCheck.issues.some((i) => i.code === 'INVALID_INTENT'));
  // replyToOwner / missingCritical are owner-facing: phones are swapped out, not blocked.
  assert.ok(!badCheck.issues.some((i) => i.code === 'PHONE_NUMBER_IN_TEXT'));

  const repair = buildIntentRepairPrompt('INTENT_PROMPT', badIntentRaw, badCheck.issues);
  assert.ok(repair.includes('INTENT VALIDATION REPAIR REQUIRED'));
  assert.ok(!repair.includes('98123 45678'));
});

test('validateMeditatePlan enforces Meditate v2 non-empty QUICK/PROJECT plans and phone-free dueHint/note/pendingRule fields', () => {
  const emptyQuick = {
    ...makeValidQuickPlan(),
    lane: 'QUICK',
    draftedTasks: [],
    wbsHeads: [],
  };
  const emptyCheck = validateMeditatePlan(emptyQuick, makeBaseContext());
  assert.equal(emptyCheck.valid, false);
  assert.ok(emptyCheck.issues.some((i) => i.code === 'EMPTY_ACTIONABLE_PLAN'));

  const leakedNote = {
    intentClassification: 'CASUAL_OR_TEST',
    chatReplyToBoss: 'Saved note.',
    reasoningSummary: 'Note captured.',
    agendaTitle: 'Captured Note',
    agendaQuadrant: 'Q4_LOW',
    agendaMajorOrMinor: 'MINOR',
    suggestedMemoryRules: [],
    draftedTasks: [],
    wbsHeads: [],
    noteToSave: {
      text: 'Contact +91 98765 43210 for reference.',
    },
  };
  const noteCheck = validateMeditatePlan(leakedNote, makeBaseContext());
  assert.equal(noteCheck.valid, false);
  assert.ok(noteCheck.issues.some((i) => i.code === 'PHONE_NUMBER_IN_TEXT'));
});

// ---------------------------------------------------------------------------
// Milestone 3.6 — draft checks
// ---------------------------------------------------------------------------
import { validateDraftPlan, validateDraftTask } from './validator';
import { MeditateDraftTaskInput } from '../types/ops';

function draftMember(phone: string, name: string, authorityLevel: TeamMember['authorityLevel'] = 'STAFF'): TeamMember {
  return {
    tenantId: 'default',
    phone,
    slotId: `P${phone.slice(-1)}`,
    name,
    roleTitle: 'Role',
    authorityLevel,
    skills: [],
    maxActiveTasks: 3,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    dailyOverviewTime: '09:30',
    isOnLeave: false,
    lastInboundAt: '2026-11-03T09:00:00.000Z',
    lastDailyDigestDate: null,
    bufferMode: 'STANDARD_15_MIN',
    stats: { assigned: 0, completed: 0, partial: 0, overdueCount: 0, totalWorkHoursReplyMins: 0, replyCount: 0 },
    personaPrompt: '',
  };
}

const draftRoster = [draftMember('10000', 'Owner Prime', 'OWNER'), draftMember('10001', 'Operator Alpha'), draftMember('10002', 'Lead Beta')];
const draftCtx = {
  teamMembers: draftRoster,
  categoryIds: ['CAT_OPS'],
  ownerProfile: { personalOperatingPrompt: '', defaultAccountablePhone: '10002', alwaysDelegatesCategories: ['CAT_OPS'] },
  maxChecklistStepsPerTask: 3,
  timezone: 'Asia/Kolkata',
  now: '2026-11-03T06:00:00.000Z',
  existingTaskCodes: ['T-101'],
};

function goodDraft(overrides: Partial<MeditateDraftTaskInput> = {}): MeditateDraftTaskInput {
  return {
    tempId: 'd1',
    title: 'Inspect unit',
    shortTag: 'Unit',
    categoryId: 'CAT_OPS',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    raci: { R: '10001', A: '10002', C: [], I: [] },
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION',
    release: { mode: 'NOW' },
    startDate: '2026-11-04',
    durationDays: 1,
    dueDate: '2026-11-04',
    microSteps: ['Check gauge'],
    ...overrides,
  };
}

const errorsOf = (d: MeditateDraftTaskInput) =>
  validateDraftTask(d, draftCtx).filter((i) => i.severity === 'error').map((i) => i.field);
const warningsOf = (d: MeditateDraftTaskInput) =>
  validateDraftTask(d, draftCtx).filter((i) => i.severity === 'warning').map((i) => i.field);

test('validateDraftTask: a good draft has no problems', () => {
  assert.deepEqual(validateDraftTask(goodDraft(), draftCtx), []);
});

test('validateDraftTask: blocking errors', () => {
  assert.deepEqual(errorsOf(goodDraft({ title: '  ' })), ['title']);
  assert.deepEqual(errorsOf(goodDraft({ raci: { R: '', A: '10002', C: [], I: [] } })), ['raci.R']);
  assert.deepEqual(errorsOf(goodDraft({ raci: { R: '19999', A: '10002', C: [], I: [] } })), ['raci.R']);
  assert.deepEqual(errorsOf(goodDraft({ raci: { R: '10001', A: '19999', C: [], I: [] } })), ['raci.A']);
  assert.deepEqual(errorsOf(goodDraft({ raci: { R: '10001', A: '10002', C: ['19999'], I: ['18888'] } })), ['raci.C', 'raci.I']);
  assert.deepEqual(errorsOf(goodDraft({ title: 'Call 98765 43210 now' })), ['title']);
  assert.deepEqual(errorsOf(goodDraft({ microSteps: ['Ring +91 98765 43210'] })), ['microSteps']);
  assert.deepEqual(
    errorsOf(goodDraft({ outboundWhatsappPreview: 'Inspect unit, call 9876543210', messageIsCustom: true })),
    ['outboundWhatsappPreview']
  );
  assert.deepEqual(errorsOf(goodDraft({ quadrant: 'Q9' as any })), ['quadrant']);
  assert.deepEqual(errorsOf(goodDraft({ dueDate: '2026-11-02' })), ['dueDate']);
  assert.deepEqual(errorsOf(goodDraft({ dueDate: 'soon' })), ['dueDate']);
  assert.deepEqual(errorsOf(goodDraft({ taskFrequency: 'RECURRING', recurrenceRule: 'NONE' })), ['recurrenceRule']);
  assert.deepEqual(errorsOf(goodDraft({ release: { mode: 'AT_TIME', releaseAt: null } })), ['release']);
  assert.deepEqual(errorsOf(goodDraft({ release: { mode: 'AT_TIME', releaseAt: '2026-11-03T09:00' } })), ['release']);
});

test('validateDraftTask: warnings do not block', () => {
  assert.deepEqual(warningsOf(goodDraft({ microSteps: [] })), ['microSteps']);
  assert.deepEqual(warningsOf(goodDraft({ microSteps: ['a', 'b', 'c', 'd'] })), ['microSteps']);
  assert.deepEqual(warningsOf(goodDraft({ categoryId: 'CAT_UNKNOWN' })), ['categoryId']);
  assert.deepEqual(warningsOf(goodDraft({ raci: { R: '10000', A: '10002', C: [], I: [] } })), ['raci.R']);
  assert.deepEqual(warningsOf(goodDraft({ raci: { R: '10001', A: '', C: [], I: [] } })), ['raci.A']);
  assert.deepEqual(
    warningsOf(goodDraft({ title: 'New title', outboundWhatsappPreview: 'Please inspect the unit', messageIsCustom: true })),
    ['outboundWhatsappPreview']
  );
  assert.deepEqual(errorsOf(goodDraft({ microSteps: [] })), []);
});

test('validateDraftPlan: broken, self and circular dependencies; first error for the freeze message', () => {
  const ok = validateDraftPlan(
    [goodDraft(), goodDraft({ tempId: 'd2', dependsOnTempIdOrTaskCode: 'd1' }), goodDraft({ tempId: 'd3', release: { mode: 'AFTER_TASK', afterTaskCode: 'T-101' } })],
    draftCtx
  );
  assert.equal(ok.errorCount, 0);
  assert.equal(ok.firstError, null);

  const broken = validateDraftPlan([goodDraft({ dependsOnTempIdOrTaskCode: 'deleted-draft' })], draftCtx);
  assert.equal(broken.errorCount, 1);
  assert.match(broken.firstError!.issue.message, /no longer exists/);

  const self = validateDraftPlan([goodDraft({ dependsOnTempIdOrTaskCode: 'd1' })], draftCtx);
  assert.match(self.byTempId.d1[0].message, /cannot wait for itself/);

  const circle = validateDraftPlan(
    [goodDraft({ dependsOnTempIdOrTaskCode: 'd2' }), goodDraft({ tempId: 'd2', dependsOnTempIdOrTaskCode: 'd1' })],
    draftCtx
  );
  assert.equal(circle.errorCount, 2);
  assert.match(circle.byTempId.d1[0].message, /circle/);

  const mixed = validateDraftPlan([goodDraft({ microSteps: [] }), goodDraft({ tempId: 'd2', title: 'Second', raci: { R: '', A: '10002', C: [], I: [] } })], draftCtx);
  assert.equal(mixed.warningCount, 1);
  assert.equal(mixed.errorCount, 1);
  assert.equal(mixed.firstError?.title, 'Second');
  assert.equal(mixed.firstError?.issue.field, 'raci.R');
});

test('validateMeditatePlan hard-blocks private weakness phrases in staff-facing text and assignmentReason', () => {
  const rosterWithWeakness: TeamMember[] = GENERIC_ROSTER.map((m) =>
    m.slotId === 'P2' ? { ...m, weaknesses: ['slow at paperwork'] } : m
  );
  const ctx = makeBaseContext({ roster: rosterWithWeakness });

  // Clean plan passes.
  assert.equal(validateMeditatePlan(makeValidQuickPlan(), ctx).valid, true);

  // Weakness echoed into the outbound WhatsApp message -> blocked.
  const inPreview = makeValidQuickPlan();
  inPreview.draftedTasks[0].outboundWhatsappPreview = 'Hello {{P2}}, you are slow at paperwork, please hurry.';
  const r1 = validateMeditatePlan(inPreview, ctx);
  assert.equal(r1.valid, false);
  assert.ok(r1.issues.some((i) => i.code === 'WEAKNESS_IN_STAFF_TEXT' && i.path.includes('outboundWhatsappPreview')));

  // Weakness echoed into a checklist step -> blocked.
  const inStep = makeValidQuickPlan();
  inStep.draftedTasks[0].microSteps = ['Inspect gauge', 'SLOW AT PAPERWORK so send a voice note'];
  assert.ok(
    validateMeditatePlan(inStep, ctx).issues.some(
      (i) => i.code === 'WEAKNESS_IN_STAFF_TEXT' && i.path.includes('microSteps')
    )
  );

  // Weakness cited in the owner-facing reason -> still blocked.
  const inReason = makeValidQuickPlan();
  (inReason.draftedTasks[0] as any).assignmentReason = 'Picked despite being slow at paperwork';
  assert.ok(
    validateMeditatePlan(inReason, ctx).issues.some(
      (i) => i.code === 'WEAKNESS_IN_STAFF_TEXT' && i.path.includes('assignmentReason')
    )
  );

  // With no weaknesses configured, the same text is fine.
  const noWeakCtx = makeBaseContext();
  assert.equal(validateMeditatePlan(inPreview, noWeakCtx).valid, true);
});
