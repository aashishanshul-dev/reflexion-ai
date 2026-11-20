import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWhatsapp24hWindowPolicy,
  buildAutoReminderMessage,
  buildIncompleteReleaseNotice,
  buildPlainReleaseWhatsappMessage,
  buildTaskCancelledMessage,
  canRelease,
  computeNextShiftStart,
  computeReminderDecision,
  defaultReleaseAtLocal,
  describePlannedSendTime,
  findIncompleteReleaseChoice,
  findPastReleaseTime,
  formatNumberedStepsBlock,
  getReminderClockStartMs,
  isTaskClosed,
  isTaskOnActiveBoard,
  isWithinWhatsapp24hWindow,
  migrateTaskReleaseConfig,
  parseScheduledReleaseInstantMs,
  PARENT_CANCELLED_HOLD_REASON,
  promoteUnlockedDependentsToScheduled,
  releaseDueTasks,
  runScheduledJobsTick,
  sendDueReminders,
  summarizeFreezeOutcome,
  summarizeWbsHeadRelease,
  validateDraftReleaseChoices,
} from './releaseEngine';
import { isDevToolsEnabled } from './devFlags';
import { MeditateDraftTaskInput, OpsDatabaseState, Task, TeamMember } from '../types/ops';

function createSyntheticMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    tenantId: 'default',
    phone: '10001',
    slotId: 'P1',
    name: 'Operator Alpha',
    roleTitle: 'Coordinator',
    authorityLevel: 'STAFF',
    skills: ['Operations'],
    maxActiveTasks: 2,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    dailyOverviewTime: '09:30',
    isOnLeave: false,
    lastInboundAt: '2026-11-03T09:00:00.000Z',
    lastDailyDigestDate: null,
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 0,
      completed: 0,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 0,
      replyCount: 0,
    },
    personaPrompt: 'Clear concise updates.',
    ...overrides,
  };
}

function createSyntheticTask(overrides: Partial<Task> = {}): Task {
  return {
    tenantId: 'default',
    taskCode: 'T-201',
    shortTag: 'Unit Check',
    agendaId: null,
    title: 'Inspect primary unit status',
    categoryId: 'CAT_OPS',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    isFrozen: true,
    raci: {
      R: '10001',
      A: '10002',
      C: [],
      I: [],
    },
    status: 'SCHEDULED',
    completionPercent: 0,
    microSteps: [
      { id: 'ms-1', label: 'Verify indicator', status: 'PENDING' },
      { id: 'ms-2', label: 'Submit confirmation', status: 'PENDING' },
    ],
    missingStepsAlert: '',
    dependency: {
      dependsOnTaskCode: null,
      triggerCondition: 'FULL_COMPLETION',
    },
    release: {
      mode: 'NOW',
      releaseAt: null,
      afterTaskCode: null,
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: false,
      ownerConfirmed: false,
      releasedAt: null,
      holdReason: null,
      batchedForDigest: false,
    },
    reminderConfig: {
      includeInDailyOverview: true,
      customIntervalHours: 4,
      lastNudgedAt: null,
      nudgeCount: 0,
    },
    startDate: '2026-11-03',
    durationDays: 1,
    dueDate: '2026-11-03',
    isForcedDeadline: false,
    forcedDeadlineDate: null,
    outboundWhatsappPreview: '',
    latestAiSummary: 'Scheduled',
    auditLogs: [],
    ...overrides,
  };
}

function createSyntheticState(overrides: Partial<OpsDatabaseState> = {}): OpsDatabaseState {
  const member1 = createSyntheticMember({ phone: '10001', slotId: 'P1', name: 'Operator Alpha' });
  const member2 = createSyntheticMember({
    phone: '10002',
    slotId: 'P2',
    name: 'Lead Beta',
    authorityLevel: 'SUPERVISOR',
  });

  return {
    tenantId: 'default',
    principal_prompts: {
      planningPrompt: 'Plan tasks.',
      evaluationPrompt: 'Evaluate updates.',
    },
    business_profile: {
      businessName: 'Synthetic Workspace',
      businessType: 'Operations',
      businessDescription: 'General operations workspace.',
      workLocations: 'Zone A, Zone B',
      defaultStaffLanguage: 'ENGLISH',
      hardRules: 'Follow standard operating procedures.',
      timezone: 'Asia/Kolkata',
      workingDays: [1, 2, 3, 4, 5, 6], // Mon-Sat
      batchNonUrgentIntoDigest: false,
      enforceWhatsapp24hWindow: true,
      whatsappTemplateText:
        '[Template] Hello {{name}}, update for [{{shortTag}}] ({{title}}) Due {{dueDate}}:\n{{body}}',
    },
    owner_profile: {
      personalOperatingPrompt: 'Delegate operational execution.',
      defaultAccountablePhone: '10002',
    },
    task_splitting_rules: {
      maxChecklistStepsPerTask: 5,
      defaultMaxActiveTasksPerPerson: 2,
      taskSplittingRule: 'Keep continuous single-owner work together.',
    },
    sample_brain_dumps: [],
    team_members: {
      '10001': member1,
      '10002': member2,
    },
    category_sops: [
      {
        categoryId: 'CAT_OPS',
        categoryName: 'Standard Operations',
        defaultClassification: 'MINOR',
        sopSystemPrompt: 'Verify and confirm.',
        defaultMicroSteps: ['Step 1', 'Step 2'],
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
    model_tuning: {
      meditateEngine: 'legacy',
      maxRecentConversationTurns: 8,
      meditate: {
        model: 'gemini-flash-latest',
        fallbackModel: 'gemini-pro-latest',
        temperature: 0.2,
        maxOutputTokens: 2048,
      },
      bufferEvaluation: {
        model: 'gemini-flash-lite-latest',
        fallbackModel: 'gemini-flash-latest',
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
      message: {
        model: 'gemini-flash-lite-latest',
        fallbackModel: 'gemini-flash-latest',
        temperature: 0.65,
        maxOutputTokens: 512,
      },
    },
    ai_logs: [],
    ...overrides,
  };
}

test('migrateTaskReleaseConfig migrates legacy tasks without release field to mode NOW', () => {
  const legacyTask = createSyntheticTask({
    status: 'PENDING',
    lastOutboundAt: '2026-11-03T10:00:00.000Z',
    release: undefined,
  });

  const migrated = migrateTaskReleaseConfig(legacyTask, '2026-11-03T12:00:00.000Z');
  assert.equal(migrated.mode, 'NOW');
  assert.equal(migrated.releasedAt, '2026-11-03T10:00:00.000Z');
  assert.equal(migrated.requireOwnerConfirm, false);
});

test('canRelease holds when person is on leave', () => {
  const person = createSyntheticMember({ isOnLeave: true });
  const task = createSyntheticTask();
  // 2026-11-03T06:00:00Z = 11:30 Asia/Kolkata (Tuesday, inside 09:00-18:00 shift)
  const res = canRelease(task, person, '2026-11-03T06:00:00.000Z', {
    timezone: 'Asia/Kolkata',
    workingDays: [1, 2, 3, 4, 5],
  });
  assert.equal(res.allowed, false);
  assert.equal(res.reasonCode, 'ON_LEAVE');
  assert.match(res.holdReason || '', /On leave/i);
});

test('canRelease holds outside shift hours and on non-working days using business timezone', () => {
  const person = createSyntheticMember({
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
  });
  const task = createSyntheticTask();

  // 2026-11-03T14:00:00Z = 19:30 Asia/Kolkata (Tuesday evening, after 18:00 shift end)
  const afterHours = canRelease(task, person, '2026-11-03T14:00:00.000Z', {
    timezone: 'Asia/Kolkata',
    workingDays: [1, 2, 3, 4, 5],
  });
  assert.equal(afterHours.allowed, false);
  assert.equal(afterHours.reasonCode, 'OUTSIDE_SHIFT_OR_WORKING_DAY');
  // Next shift start is Wednesday 2026-11-04 09:00 IST = 2026-11-04T03:30:00.000Z
  assert.equal(afterHours.nextEligibleAt, '2026-11-04T03:30:00.000Z');

  // 2026-11-08T06:00:00Z = Sunday 11:30 IST (non-working day when workingDays = Mon-Fri)
  const nonWorkingDay = canRelease(task, person, '2026-11-08T06:00:00.000Z', {
    timezone: 'Asia/Kolkata',
    workingDays: [1, 2, 3, 4, 5],
  });
  assert.equal(nonWorkingDay.allowed, false);
  assert.equal(nonWorkingDay.reasonCode, 'OUTSIDE_SHIFT_OR_WORKING_DAY');
  // Next shift start is Monday 2026-11-09 09:00 IST = 2026-11-09T03:30:00.000Z
  assert.equal(nonWorkingDay.nextEligibleAt, '2026-11-09T03:30:00.000Z');

  // Verify America/New_York timezone calculation as well
  const nyShift = computeNextShiftStart(
    Date.parse('2026-11-03T23:30:00.000Z'), // 18:30 EST (UTC-5)
    '09:00',
    [1, 2, 3, 4, 5],
    'America/New_York'
  );
  // Next morning 09:00 EST = 14:00 UTC
  assert.equal(nyShift.nextShiftIso, '2026-11-04T14:00:00.000Z');
});

test('canRelease enforces active task cap for non-urgent tasks while urgent Q1 tasks bypass cap', () => {
  const person = createSyntheticMember({ maxActiveTasks: 2 });
  const nonUrgent = createSyntheticTask({ quadrant: 'Q2_SCHEDULE' });
  const urgentQ1 = createSyntheticTask({ taskCode: 'T-202', quadrant: 'Q1_DO_FIRST' });

  const heldAtCap = canRelease(nonUrgent, person, '2026-11-03T06:00:00.000Z', {
    timezone: 'Asia/Kolkata',
    workingDays: [1, 2, 3, 4, 5],
    activeReleasedTaskCount: 2,
  });
  assert.equal(heldAtCap.allowed, false);
  assert.equal(heldAtCap.reasonCode, 'AT_CAPACITY_CAP');

  const urgentAllowed = canRelease(urgentQ1, person, '2026-11-03T06:00:00.000Z', {
    timezone: 'Asia/Kolkata',
    workingDays: [1, 2, 3, 4, 5],
    activeReleasedTaskCount: 2,
  });
  assert.equal(urgentAllowed.allowed, true);
});

test('canRelease allows urgent Q1_DO_FIRST tasks outside shift and marks outbound message URGENT', () => {
  const person = createSyntheticMember({ workShiftStart: '12:00', workShiftEnd: '21:00' });
  const urgentQ1 = createSyntheticTask({ taskCode: 'T-203', quadrant: 'Q1_DO_FIRST' });
  const nonUrgent = createSyntheticTask({ taskCode: 'T-204', quadrant: 'Q2_SCHEDULE' });
  // 2026-11-03T04:30:00.000Z = 10:00 IST (before 12:00 shift start)
  const beforeShiftIso = '2026-11-03T04:30:00.000Z';

  const held = canRelease(nonUrgent, person, beforeShiftIso, {
    timezone: 'Asia/Kolkata',
    workingDays: [1, 2, 3, 4, 5, 6],
  });
  assert.equal(held.allowed, false);
  assert.equal(held.reasonCode, 'OUTSIDE_SHIFT_OR_WORKING_DAY');

  const urgent = canRelease(urgentQ1, person, beforeShiftIso, {
    timezone: 'Asia/Kolkata',
    workingDays: [1, 2, 3, 4, 5, 6],
  });
  assert.equal(urgent.allowed, true);

  const urgentMsg = buildPlainReleaseWhatsappMessage(urgentQ1, person);
  assert.match(urgentMsg, /^URGENT:/);
});

test('canRelease requires owner confirmation when requireOwnerConfirm is true', () => {
  const person = createSyntheticMember();
  const unconfirmed = createSyntheticTask({
    release: {
      mode: 'NOW',
      releaseAt: null,
      afterTaskCode: null,
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: true,
      ownerConfirmed: false,
      releasedAt: null,
      holdReason: null,
    },
  });

  const check1 = canRelease(unconfirmed, person, '2026-11-03T06:00:00.000Z', {
    timezone: 'Asia/Kolkata',
  });
  assert.equal(check1.allowed, false);
  assert.equal(check1.reasonCode, 'REQUIRES_OWNER_CONFIRM');

  const confirmed: Task = {
    ...unconfirmed,
    release: { ...unconfirmed.release!, ownerConfirmed: true },
  };
  const check2 = canRelease(confirmed, person, '2026-11-03T06:00:00.000Z', {
    timezone: 'Asia/Kolkata',
  });
  assert.equal(check2.allowed, true);
});

test('AT_TIME, WHEN_FREE, and AFTER_TASK with delayMinutes release accurately via releaseDueTasks', () => {
  const parsedLocalMs = parseScheduledReleaseInstantMs('2026-11-03T15:00', 'Asia/Kolkata');
  assert.equal(new Date(parsedLocalMs!).toISOString(), '2026-11-03T09:30:00.000Z');

  const tActive = createSyntheticTask({
    taskCode: 'T-300',
    status: 'IN_PROGRESS',
    release: {
      mode: 'NOW',
      releaseAt: null,
      afterTaskCode: null,
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: false,
      releasedAt: '2026-11-03T05:00:00.000Z',
      holdReason: null,
    },
  });

  const tAtTime = createSyntheticTask({
    taskCode: 'T-301',
    shortTag: 'Timed Task',
    release: {
      mode: 'AT_TIME',
      releaseAt: '2026-11-03T15:00', // 09:30 UTC
      afterTaskCode: null,
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: false,
      releasedAt: null,
      holdReason: null,
    },
  });

  const tWhenFree = createSyntheticTask({
    taskCode: 'T-302',
    shortTag: 'Idle Slot Task',
    release: {
      mode: 'WHEN_FREE',
      releaseAt: null,
      afterTaskCode: null,
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: false,
      releasedAt: null,
      holdReason: null,
    },
  });

  const tAfterWithDelay = createSyntheticTask({
    taskCode: 'T-303',
    shortTag: 'Delayed Followup',
    status: 'LOCKED_BY_DEPENDENCY',
    dependency: {
      dependsOnTaskCode: 'T-300',
      triggerCondition: 'FULL_COMPLETION',
    },
    release: {
      mode: 'AFTER_TASK',
      releaseAt: null,
      afterTaskCode: 'T-300',
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 30,
      requireOwnerConfirm: false,
      releasedAt: null,
      holdReason: 'Waiting on T-300',
    },
  });

  let state = createSyntheticState({
    tasks: [tActive, tAtTime, tWhenFree, tAfterWithDelay],
  });

  // At 06:00 UTC (11:30 IST): T-301 is future (15:00 IST), T-302 is busy (T-300 active), T-303 is locked
  const tick1 = releaseDueTasks(state, '2026-11-03T06:00:00.000Z');
  assert.deepEqual(tick1.releasedTaskCodes, []);
  assert.equal(tick1.nextState.tasks.find((t) => t.taskCode === 'T-301')?.status, 'SCHEDULED');
  assert.equal(tick1.nextState.tasks.find((t) => t.taskCode === 'T-302')?.status, 'SCHEDULED');
  assert.match(
    tick1.nextState.tasks.find((t) => t.taskCode === 'T-302')?.release?.holdReason || '',
    /free/i
  );

  // Mark T-300 COMPLETED at 09:35 UTC (15:05 IST) and promote dependents
  state = {
    ...tick1.nextState,
    tasks: tick1.nextState.tasks.map((t) =>
      t.taskCode === 'T-300' ? { ...t, status: 'COMPLETED' as const, completionPercent: 100 } : t
    ),
  };
  state = promoteUnlockedDependentsToScheduled(state, 'T-300', {
    nowIso: '2026-11-03T09:35:00.000Z',
  });

  // At 09:35 UTC (15:05 IST):
  // - T-301 (scheduled for 15:00 IST = 09:30 UTC) releases!
  // - T-302 (WHEN_FREE) sees T-301 just took 1 slot if T-301 runs first, wait: both are Q2_SCHEDULE; T-301 is earlier in array so T-301 releases, making activeCount=1, so T-302 stays held!
  // - T-303 has 30m delay until 10:05 UTC, so T-303 stays SCHEDULED!
  const tick2 = releaseDueTasks(state, '2026-11-03T09:35:00.000Z');
  assert.deepEqual(tick2.releasedTaskCodes, ['T-301']);
  assert.equal(tick2.nextState.tasks.find((t) => t.taskCode === 'T-303')?.status, 'SCHEDULED');

  // Complete T-301 and advance to 10:10 UTC (15:40 IST): both T-302 (now free!) and T-303 (30m delay elapsed) can evaluate
  const stateAfterT301Done: OpsDatabaseState = {
    ...tick2.nextState,
    tasks: tick2.nextState.tasks.map((t) =>
      t.taskCode === 'T-301' ? { ...t, status: 'COMPLETED' as const, completionPercent: 100 } : t
    ),
  };
  const tick3 = releaseDueTasks(stateAfterT301Done, '2026-11-03T10:10:00.000Z');
  assert.ok(tick3.releasedTaskCodes.includes('T-302'));
});

test('batchNonUrgentIntoDigest holds non-urgent tasks until daily overview time and bundles them once per day', () => {
  const nonUrgentTask = createSyntheticTask({
    taskCode: 'T-401',
    shortTag: 'Routine Audit',
    quadrant: 'Q3_DELEGATE',
  });
  const baseState = createSyntheticState({
    business_profile: {
      ...createSyntheticState().business_profile,
      batchNonUrgentIntoDigest: true,
    },
    tasks: [nonUrgentTask],
  });

  // 03:45 UTC = 09:15 IST (inside 09:00 shift, BEFORE 09:30 dailyOverviewTime)
  const earlyRelease = releaseDueTasks(baseState, '2026-11-03T03:45:00.000Z');
  assert.deepEqual(earlyRelease.releasedTaskCodes, []);
  const heldTask = earlyRelease.nextState.tasks[0];
  assert.equal(heldTask.status, 'SCHEDULED');
  assert.equal(heldTask.release?.batchedForDigest, true);

  // 04:05 UTC = 09:35 IST (after 09:30 dailyOverviewTime) -> runScheduledJobsTick flushes into daily digest!
  const tickAtDigestTime = runScheduledJobsTick(earlyRelease.nextState, '2026-11-03T04:05:00.000Z');
  assert.deepEqual(tickAtDigestTime.releasedTaskCodes, ['T-401']);
  assert.equal(tickAtDigestTime.digestsSent, 1);
  assert.equal(tickAtDigestTime.nextState.tasks[0].status, 'PENDING');
  const digestMessages = tickAtDigestTime.nextState.whatsapp_messages.filter(
    (m) => m.tag === 'DAILY_DIGEST'
  );
  assert.equal(digestMessages.length, 1);
  assert.match(digestMessages[0].text, /\[Routine Audit\] \[NEW\]/);

  // Subsequent tick on the same day does NOT send duplicate daily digest
  const secondTickSameDay = runScheduledJobsTick(
    tickAtDigestTime.nextState,
    '2026-11-03T05:00:00.000Z'
  );
  assert.equal(secondTickSameDay.digestsSent, 0);
});

test('WhatsApp 24-hour window flag applies template outside 24h and plain message inside 24h', () => {
  const nowIso = '2026-11-03T12:00:00.000Z';
  assert.equal(isWithinWhatsapp24hWindow('2026-11-03T01:00:00.000Z', nowIso), true);
  assert.equal(isWithinWhatsapp24hWindow('2026-11-02T08:00:00.000Z', nowIso), false);

  const stalePerson = createSyntheticMember({
    lastInboundAt: '2026-11-01T10:00:00.000Z', // >24h ago
  });
  const task = createSyntheticTask();
  const plainBody = buildPlainReleaseWhatsappMessage(task, stalePerson);

  const enforcedOut = applyWhatsapp24hWindowPolicy({
    rawText: plainBody,
    person: stalePerson,
    shortTag: task.shortTag,
    title: task.title,
    dueDate: task.dueDate,
    businessProfile: createSyntheticState().business_profile,
    nowIso,
  });
  assert.equal(enforcedOut.isTemplateMessage, true);
  assert.match(enforcedOut.text, /\[Template\] Hello Operator Alpha/);
  assert.ok(enforcedOut.text.includes('[Unit Check]'));

  const flagDisabledOut = applyWhatsapp24hWindowPolicy({
    rawText: plainBody,
    person: stalePerson,
    shortTag: task.shortTag,
    title: task.title,
    dueDate: task.dueDate,
    businessProfile: {
      ...createSyntheticState().business_profile,
      enforceWhatsapp24hWindow: false,
    },
    nowIso,
  });
  assert.equal(flagDisabledOut.isTemplateMessage, false);
  assert.equal(flagDisabledOut.text, plainBody);
});

test('toggleTaskMicroStepManual and updateTaskAndNotify route through release engine and re-notify on edits', async () => {
  const { toggleTaskMicroStepManual, updateTaskAndNotify } = await import('./opsEngine');

  const prereqTask = createSyntheticTask({
    taskCode: 'T-500',
    shortTag: 'Upstream Job',
    status: 'IN_PROGRESS',
    microSteps: [{ id: 'ms-500-1', label: 'Finish setup', status: 'PENDING' }],
  });
  const dependentTask = createSyntheticTask({
    taskCode: 'T-501',
    shortTag: 'Downstream Job',
    status: 'LOCKED_BY_DEPENDENCY',
    dependency: { dependsOnTaskCode: 'T-500', triggerCondition: 'FULL_COMPLETION' },
    release: {
      mode: 'AFTER_TASK',
      releaseAt: null,
      afterTaskCode: 'T-500',
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: false,
      releasedAt: null,
      holdReason: 'Waiting on T-500',
    },
  });

  const state = createSyntheticState({
    tasks: [prereqTask, dependentTask],
  });

  // Completing T-500 manually at 11:30 IST (06:00 UTC) unlocks & releases T-501 via releaseDueTasks
  const afterComplete = toggleTaskMicroStepManual(
    state,
    'T-500',
    'ms-500-1',
    '2026-11-03T06:00:00.000Z'
  );
  assert.equal(afterComplete.tasks.find((t) => t.taskCode === 'T-500')?.status, 'COMPLETED');
  assert.equal(afterComplete.tasks.find((t) => t.taskCode === 'T-501')?.status, 'PENDING');

  // Editing a released task's deadline always re-notifies even if sendWhatsappNotification=false
  const releasedT501 = afterComplete.tasks.find((t) => t.taskCode === 'T-501')!;
  const beforeMsgs = afterComplete.whatsapp_messages.length;
  const editRes = updateTaskAndNotify(
    afterComplete,
    { ...releasedT501, dueDate: '2026-11-05' },
    false,
    '2026-11-03T06:05:00.000Z'
  );
  assert.equal(editRes.notificationSent, true);
  assert.equal(editRes.nextState.whatsapp_messages.length, beforeMsgs + 1);
  const editedTask = editRes.nextState.tasks.find((t) => t.taskCode === 'T-501')!;
  assert.match(
    editedTask.auditLogs[editedTask.auditLogs.length - 1].rawInputSummary,
    /Edited: deadline/
  );
});

// ---------------------------------------------------------------------------
// Milestone 3 review fixes (items 1–9)
// Synthetic clock: 2026-11-03 is a Tuesday. 06:00Z = 11:30 IST (inside the
// 09:00–18:00 shift); 18:18Z = 23:48 IST (outside the shift).
// ---------------------------------------------------------------------------

function createSyntheticDraft(overrides: Partial<MeditateDraftTaskInput> = {}): MeditateDraftTaskInput {
  return {
    tempId: 'draft-1',
    title: 'Check pump pressure',
    shortTag: 'Pump Check',
    categoryId: 'CAT_OPS',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    raci: { R: '10001', A: '10002', C: [], I: [] },
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION',
    dueDate: '2026-11-04',
    microSteps: ['Read the gauge', 'Send photo'],
    release: { mode: 'NOW' },
    ...overrides,
  };
}

const IN_SHIFT = '2026-11-03T06:00:00.000Z';
const OUTSIDE_SHIFT = '2026-11-03T18:18:00.000Z';

test('fix 1: "At a time" default is one hour ahead in the business timezone, not UTC', () => {
  const nowMs = Date.parse(OUTSIDE_SHIFT); // 23:48 IST
  assert.equal(defaultReleaseAtLocal(nowMs, 'Asia/Kolkata'), '2026-11-04T00:48');
  assert.equal(defaultReleaseAtLocal(nowMs, 'UTC'), '2026-11-03T19:18');
  // Read back by the engine in the business timezone it lands exactly 1 hour from now.
  const parsed = parseScheduledReleaseInstantMs(
    defaultReleaseAtLocal(nowMs, 'Asia/Kolkata'),
    'Asia/Kolkata'
  );
  assert.equal(parsed, nowMs + 60 * 60_000);
});

test('fix 2: unfinished "At a time" / "After task" choices are reported and never sent', async () => {
  const { freezeAndDispatchStagingTasks } = await import('./opsEngine');

  assert.match(findIncompleteReleaseChoice({ mode: 'AT_TIME', releaseAt: null }) || '', /date and time/);
  assert.match(findIncompleteReleaseChoice({ mode: 'AT_TIME', releaseAt: '  ' }) || '', /date and time/);
  assert.match(findIncompleteReleaseChoice({ mode: 'AT_TIME', releaseAt: 'not a time' }) || '', /date and time/);
  assert.match(findIncompleteReleaseChoice({ mode: 'AFTER_TASK', afterTaskCode: null }) || '', /which task/);
  assert.equal(findIncompleteReleaseChoice({ mode: 'AFTER_TASK', afterTaskCode: null }, 'T-500'), null);
  assert.equal(findIncompleteReleaseChoice({ mode: 'AT_TIME', releaseAt: '2026-11-04T09:00' }), null);
  assert.equal(findIncompleteReleaseChoice({ mode: 'NOW' }), null);
  assert.equal(findIncompleteReleaseChoice(undefined), null);

  const drafts = [
    createSyntheticDraft({ tempId: 'a', title: 'Timed job', release: { mode: 'AT_TIME', releaseAt: null } }),
    createSyntheticDraft({ tempId: 'b', title: 'Follow-up job', release: { mode: 'AFTER_TASK', afterTaskCode: null } }),
    createSyntheticDraft({
      tempId: 'c',
      title: 'AI-linked job',
      release: { mode: 'AFTER_TASK', afterTaskCode: null },
      dependsOnTempIdOrTaskCode: 'a',
    }),
    createSyntheticDraft({ tempId: 'd', title: 'Plain job' }),
  ];
  const problems = validateDraftReleaseChoices(drafts, 'Asia/Kolkata');
  assert.deepEqual(problems.map((p) => p.tempId), ['a', 'b']);
  const notice = buildIncompleteReleaseNotice(problems);
  assert.match(notice, /^Not sent: finish the release choice for "Timed job"/);
  assert.match(notice, /1 more task/);
  assert.equal(buildIncompleteReleaseNotice([]), '');

  // Even if the UI check were bypassed, the engine holds these tasks instead of sending them.
  const state = createSyntheticState();
  for (const release of [
    { mode: 'AT_TIME' as const, releaseAt: null },
    { mode: 'AFTER_TASK' as const, afterTaskCode: null },
  ]) {
    const next = freezeAndDispatchStagingTasks(state, [createSyntheticDraft({ release })], undefined, IN_SHIFT);
    const created = next.tasks.find((t) => t.title === 'Check pump pressure')!;
    assert.equal(created.status, 'SCHEDULED');
    assert.equal(created.release?.releasedAt, null);
    assert.equal(next.whatsapp_messages.length, 0);
    assert.match(created.release?.holdReason || '', /Pick a date|Choose which task/);
  }
});

test('fix 3: freeze notice says "Scheduled for <time>" unless a message was really sent', async () => {
  const { freezeAndDispatchStagingTasks } = await import('./opsEngine');
  const state = createSyntheticState();

  // AT_TIME tomorrow 09:00 IST -> scheduled, nothing sent
  const timed = freezeAndDispatchStagingTasks(
    state,
    [createSyntheticDraft({ release: { mode: 'AT_TIME', releaseAt: '2026-11-04T09:00' } })],
    undefined,
    IN_SHIFT
  );
  const timedOutcome = summarizeFreezeOutcome(state, timed, IN_SHIFT);
  assert.equal(timedOutcome.sentCount, 0);
  assert.equal(timedOutcome.scheduledCount, 1);
  assert.equal(timedOutcome.notice, 'Scheduled for Wed, Nov 4, 9:00 AM: [Pump Check]. Not sent yet.');
  assert.doesNotMatch(timedOutcome.notice, /Sent on WhatsApp/);

  // NOW inside the shift -> actually sent
  const sent = freezeAndDispatchStagingTasks(state, [createSyntheticDraft()], undefined, IN_SHIFT);
  const sentOutcome = summarizeFreezeOutcome(state, sent, IN_SHIFT);
  assert.equal(sentOutcome.sentCount, 1);
  assert.equal(sentOutcome.notice, 'Sent on WhatsApp: [Pump Check] to Operator Alpha.');

  // NOW outside the shift -> held until the next shift, so "Scheduled for" the shift start + urgent hint
  const night = freezeAndDispatchStagingTasks(state, [createSyntheticDraft()], undefined, OUTSIDE_SHIFT);
  const nightOutcome = summarizeFreezeOutcome(state, night, OUTSIDE_SHIFT);
  assert.equal(nightOutcome.sentCount, 0);
  assert.equal(
    nightOutcome.notice,
    'Scheduled for Wed, Nov 4, 9:00 AM: [Pump Check]. Not sent yet. Mark as urgent to send now.'
  );

  // Mixed batch: one sent, one scheduled, one waiting on another task
  const mixed = freezeAndDispatchStagingTasks(
    state,
    [
      createSyntheticDraft({ tempId: 'm1', title: 'Send now' }),
      createSyntheticDraft({
        tempId: 'm2',
        title: 'Send tomorrow',
        release: { mode: 'AT_TIME', releaseAt: '2026-11-04T09:00' },
      }),
      createSyntheticDraft({
        tempId: 'm3',
        title: 'After first',
        release: { mode: 'AFTER_TASK', afterTaskCode: 'm1' },
      }),
    ],
    undefined,
    IN_SHIFT
  );
  const mixedOutcome = summarizeFreezeOutcome(state, mixed, IN_SHIFT);
  assert.equal(
    mixedOutcome.notice,
    '1 sent on WhatsApp, 1 scheduled for Wed, Nov 4, 9:00 AM (not sent yet), 1 waiting on another task.'
  );
});

test('fix 4: message previews never show "undefined" or an empty Steps heading', async () => {
  const { generateOutboundWhatsappMessage } = await import('./opsEngine');
  const member = createSyntheticMember({ preferredLanguage: 'HINGLISH' });

  assert.equal(formatNumberedStepsBlock(['A', '  ', { label: 'B' }, null, { label: '' }], 'Steps'), 'Steps:\n1. A\n2. B\n');
  assert.equal(formatNumberedStepsBlock([], 'Steps'), '');
  assert.equal(formatNumberedStepsBlock(undefined, 'Steps'), '');
  assert.equal(
    formatNumberedStepsBlock([{ label: 'A', status: 'DONE' }], 'Steps', { withStatus: true }),
    'Steps:\n1. A [DONE]\n'
  );

  // Draft steps are plain strings (this used to print "1. undefined").
  const fromStrings = generateOutboundWhatsappMessage(
    { taskCode: 'QUICK', title: 'Pump', microSteps: ['Read gauge'], dueDate: '2026-11-04', taskFrequency: 'ONE_TIME', recurrenceRule: 'NONE' },
    member
  );
  assert.match(fromStrings, /Steps: 1\) Read gauge\n/); // short brief: steps on one line
  assert.doesNotMatch(fromStrings, /undefined/);

  const noSteps = generateOutboundWhatsappMessage(
    { taskCode: 'QUICK', title: 'Pump', microSteps: [], dueDate: '2026-11-04', taskFrequency: 'ONE_TIME', recurrenceRule: 'NONE' },
    member
  );
  assert.doesNotMatch(noSteps, /Steps:|undefined/);

  const plain = buildPlainReleaseWhatsappMessage(createSyntheticTask({ microSteps: [] }), member);
  assert.doesNotMatch(plain, /Steps:|undefined/);
  assert.match(plain, /3 Nov tak\./); // short brief: "by when" in words, no "Due:" label
});

test('fix 5: planned send time for the Scheduled lane, including tasks waiting on another task', () => {
  const state = createSyntheticState();
  const timed = createSyntheticTask({
    release: { ...createSyntheticTask().release!, mode: 'AT_TIME', releaseAt: '2026-11-04T09:00' },
  });
  assert.equal(describePlannedSendTime(timed, state, IN_SHIFT), 'Wed, Nov 4, 9:00 AM');

  const waiting = createSyntheticTask({
    status: 'LOCKED_BY_DEPENDENCY',
    dependency: { dependsOnTaskCode: 'T-500', triggerCondition: 'FULL_COMPLETION' },
    release: { ...createSyntheticTask().release!, mode: 'AFTER_TASK', afterTaskCode: 'T-500' },
  });
  assert.equal(describePlannedSendTime(waiting, state, IN_SHIFT), 'When T-500 is done');
  assert.equal(
    describePlannedSendTime(
      { ...waiting, release: { ...waiting.release!, delayMinutes: 30 } },
      state,
      IN_SHIFT
    ),
    '30 min after T-500 is done'
  );

  const shiftHeld = createSyntheticTask({
    release: { ...createSyntheticTask().release!, nextEligibleAt: '2026-11-04T03:30:00.000Z' },
  });
  assert.equal(describePlannedSendTime(shiftHeld, state, IN_SHIFT), 'Wed, Nov 4, 9:00 AM');

  const capHeld = createSyntheticTask({
    release: { ...createSyntheticTask().release!, holdReason: 'At active task cap (2/2) — held until capacity frees up' },
  });
  assert.equal(describePlannedSendTime(capHeld, state, IN_SHIFT), "When one of Operator Alpha's tasks closes");

  const confirm = createSyntheticTask({
    release: { ...createSyntheticTask().release!, requireOwnerConfirm: true, ownerConfirmed: false },
  });
  assert.equal(describePlannedSendTime(confirm, state, IN_SHIFT), 'When you confirm it');

  // releaseDueTasks stores the next shift start on held tasks so the lane can show it.
  const night = releaseDueTasks(createSyntheticState({ tasks: [createSyntheticTask()] }), OUTSIDE_SHIFT).nextState;
  assert.equal(night.tasks[0].release?.nextEligibleAt, '2026-11-04T03:30:00.000Z');
  const day = releaseDueTasks(night, IN_SHIFT).nextState;
  assert.equal(day.tasks[0].status, 'PENDING');
  assert.equal(day.tasks[0].release?.nextEligibleAt, null);
});

test('fix 6: marking a task Completed in the edit form unlocks dependents straight away', async () => {
  const { updateTaskAndNotify } = await import('./opsEngine');
  const prereq = createSyntheticTask({
    taskCode: 'T-600',
    status: 'IN_PROGRESS',
    release: { ...createSyntheticTask().release!, releasedAt: '2026-11-03T04:00:00.000Z' },
  });
  const dependent = createSyntheticTask({
    taskCode: 'T-601',
    status: 'LOCKED_BY_DEPENDENCY',
    dependency: { dependsOnTaskCode: 'T-600', triggerCondition: 'FULL_COMPLETION' },
    release: { ...createSyntheticTask().release!, mode: 'AFTER_TASK', afterTaskCode: 'T-600' },
  });
  const state = createSyntheticState({ tasks: [prereq, dependent] });

  const res = updateTaskAndNotify(state, { ...prereq, status: 'COMPLETED', completionPercent: 100 }, false, IN_SHIFT);
  const unlocked = res.nextState.tasks.find((t) => t.taskCode === 'T-601')!;
  assert.equal(unlocked.status, 'PENDING');
  assert.ok(
    res.nextState.whatsapp_messages.some((m) => m.taskCode === 'T-601' && m.tag === 'DEPENDENCY_UNLOCKED')
  );

  // Saving without completing leaves the dependent waiting.
  const notDone = updateTaskAndNotify(state, { ...prereq, title: 'Renamed' }, false, IN_SHIFT);
  assert.equal(notDone.nextState.tasks.find((t) => t.taskCode === 'T-601')?.status, 'LOCKED_BY_DEPENDENCY');
});

test('fix 7: reassigning tells the previous person; unsent tasks get no WhatsApp messages', async () => {
  const { reassignTaskResponsible, updateTaskAndNotify } = await import('./opsEngine');
  const third = createSyntheticMember({ phone: '10003', slotId: 'P3', name: 'Operator Gamma' });
  const sentTask = createSyntheticTask({
    taskCode: 'T-700',
    status: 'IN_PROGRESS',
    release: { ...createSyntheticTask().release!, releasedAt: '2026-11-03T04:00:00.000Z' },
  });
  const scheduledTask = createSyntheticTask({
    taskCode: 'T-701',
    status: 'SCHEDULED',
    release: { ...createSyntheticTask().release!, mode: 'AT_TIME', releaseAt: '2026-11-04T09:00' },
  });
  const base = createSyntheticState({ tasks: [sentTask, scheduledTask] });
  const state = { ...base, team_members: { ...base.team_members, '10003': third } };

  // Already sent: new person gets the handover, previous person is told it moved.
  const moved = reassignTaskResponsible(state, 'T-700', '10003', IN_SHIFT);
  const msgs = moved.whatsapp_messages.filter((m) => m.taskCode === 'T-700');
  assert.equal(msgs.length, 2);
  assert.ok(msgs.some((m) => m.employeePhone === '10003' && /Task Handover/.test(m.text)));
  const toOld = msgs.find((m) => m.employeePhone === '10001');
  assert.ok(toOld && /no longer assigned to you/.test(toOld.text));
  assert.ok(msgs.every((m) => m.tenantId === 'default'));

  // Not sent yet: reassign without any WhatsApp message.
  const movedScheduled = reassignTaskResponsible(state, 'T-701', '10003', IN_SHIFT);
  assert.equal(movedScheduled.whatsapp_messages.length, 0);
  assert.equal(movedScheduled.tasks.find((t) => t.taskCode === 'T-701')?.raci.R, '10003');

  // Edit form: no "Task Update" for an unsent task, even when a push is requested.
  const editScheduled = updateTaskAndNotify(state, { ...scheduledTask, title: 'New title' }, true, IN_SHIFT);
  assert.equal(editScheduled.notificationSent, false);
  assert.equal(editScheduled.nextState.whatsapp_messages.length, 0);
  assert.match(
    editScheduled.nextState.tasks.find((t) => t.taskCode === 'T-701')!.auditLogs.at(-1)!.rawInputSummary,
    /not sent yet, so no WhatsApp update/
  );

  // Edit form reassignment of a sent task: update to the new person + notice to the old one.
  const editMove = updateTaskAndNotify(
    state,
    { ...sentTask, raci: { ...sentTask.raci, R: '10003' } },
    false,
    IN_SHIFT
  );
  assert.equal(editMove.notificationSent, true);
  const phones = editMove.nextState.whatsapp_messages.map((m) => m.employeePhone).sort();
  assert.deepEqual(phones, ['10001', '10003']);
});

test('fix 8: development-only controls are hidden outside development builds', () => {
  assert.equal(isDevToolsEnabled({ DEV: true, MODE: 'development' }), true);
  assert.equal(isDevToolsEnabled({ DEV: false, MODE: 'production' }), false);
  assert.equal(isDevToolsEnabled({ DEV: true, MODE: 'production' }), false);
  assert.equal(isDevToolsEnabled(undefined), false);
});

test('fix 9: a person at their task limit only gets a new task when one of theirs closes', async () => {
  const { freezeAndDispatchStagingTasks, toggleTaskMicroStepManual, updateTaskAndNotify } =
    await import('./opsEngine');
  // Operator Alpha's limit is 2 (maxActiveTasks: 2) and both slots are taken.
  const busy1 = createSyntheticTask({
    taskCode: 'T-901',
    status: 'IN_PROGRESS',
    microSteps: [{ id: 'ms-901', label: 'Only step', status: 'PENDING' }],
    release: { ...createSyntheticTask().release!, releasedAt: '2026-11-03T04:00:00.000Z' },
  });
  const busy2 = createSyntheticTask({
    taskCode: 'T-902',
    status: 'PENDING',
    release: { ...createSyntheticTask().release!, releasedAt: '2026-11-03T04:00:00.000Z' },
  });
  const state = createSyntheticState({ tasks: [busy1, busy2] });

  const frozen = freezeAndDispatchStagingTasks(
    state,
    [createSyntheticDraft({ title: 'Third job', shortTag: 'Third' })],
    undefined,
    IN_SHIFT
  );
  const third = frozen.tasks.find((t) => t.title === 'Third job')!;
  assert.equal(third.status, 'SCHEDULED');
  assert.match(third.release?.holdReason || '', /At active task cap \(2\/2\)/);
  assert.equal(frozen.whatsapp_messages.length, 0);
  assert.equal(describePlannedSendTime(third, frozen, IN_SHIFT), "When one of Operator Alpha's tasks closes");
  assert.match(summarizeFreezeOutcome(state, frozen, IN_SHIFT).notice, /^Scheduled \(not sent yet\): \[Third\]/);

  // A scheduler tick while still full does not send it.
  const stillFull = releaseDueTasks(frozen, '2026-11-03T07:00:00.000Z');
  assert.deepEqual(stillFull.releasedTaskCodes, []);

  // One of their tasks closes (step ticked off by hand) -> the new task goes out.
  const afterClose = toggleTaskMicroStepManual(frozen, 'T-901', 'ms-901', '2026-11-03T07:30:00.000Z');
  assert.equal(afterClose.tasks.find((t) => t.taskCode === 'T-901')?.status, 'COMPLETED');
  const released = afterClose.tasks.find((t) => t.taskCode === third.taskCode)!;
  assert.equal(released.status, 'PENDING');
  assert.ok(afterClose.whatsapp_messages.some((m) => m.taskCode === third.taskCode && m.direction === 'OUTBOUND'));

  // Same when the task is closed from the edit form.
  const viaEditor = updateTaskAndNotify(
    frozen,
    { ...frozen.tasks.find((t) => t.taskCode === 'T-902')!, status: 'COMPLETED', completionPercent: 100 },
    false,
    '2026-11-03T07:30:00.000Z'
  );
  assert.equal(viaEditor.nextState.tasks.find((t) => t.taskCode === third.taskCode)?.status, 'PENDING');
});

test('review fix: a passed "At a time" is not shown; the real hold reason is', () => {
  const state = createSyntheticState();
  // Set for 09:00 IST, now 11:30 IST, but held because the person is at their limit.
  const capHeldAfterTime = createSyntheticTask({
    release: {
      ...createSyntheticTask().release!,
      mode: 'AT_TIME',
      releaseAt: '2026-11-03T09:00',
      holdReason: 'At active task cap (2/2) — held until capacity frees up',
    },
  });
  assert.equal(describePlannedSendTime(capHeldAfterTime, state, IN_SHIFT), "When one of Operator Alpha's tasks closes");
  // Before 09:00 the set time is still shown.
  assert.equal(
    describePlannedSendTime(capHeldAfterTime, state, '2026-11-03T02:00:00.000Z'),
    'Tue, Nov 3, 9:00 AM'
  );
  // A next-shift time that has passed is ignored too.
  const staleShift = createSyntheticTask({
    release: { ...createSyntheticTask().release!, nextEligibleAt: '2026-11-02T03:30:00.000Z', holdReason: 'On leave — held until return' },
  });
  assert.equal(describePlannedSendTime(staleShift, state, IN_SHIFT), 'When Operator Alpha is back from leave');
});

test('review fix: several scheduled tasks with different times are each listed with their time', async () => {
  const { freezeAndDispatchStagingTasks } = await import('./opsEngine');
  const state = createSyntheticState();
  const next = freezeAndDispatchStagingTasks(
    state,
    [
      createSyntheticDraft({ tempId: 'x1', title: 'First', shortTag: 'First', release: { mode: 'AT_TIME', releaseAt: '2026-11-03T15:00' } }),
      createSyntheticDraft({ tempId: 'x2', title: 'Second', shortTag: 'Second', release: { mode: 'AT_TIME', releaseAt: '2026-11-03T17:00' } }),
    ],
    undefined,
    IN_SHIFT
  );
  const notice = summarizeFreezeOutcome(state, next, IN_SHIFT).notice;
  assert.match(notice, /^2 scheduled \(not sent yet\): /);
  assert.match(notice, /\[First\] for Tue, Nov 3, 3:00 PM/);
  assert.match(notice, /\[Second\] for Tue, Nov 3, 5:00 PM/);
});

test('review fix: reassigning an unsent task re-checks release for the new person', async () => {
  const { reassignTaskResponsible, updateTaskAndNotify } = await import('./opsEngine');
  const third = createSyntheticMember({ phone: '10003', slotId: 'P3', name: 'Operator Gamma', maxActiveTasks: 2 });
  const busy = (code: string) =>
    createSyntheticTask({
      taskCode: code,
      status: 'IN_PROGRESS',
      release: { ...createSyntheticTask().release!, releasedAt: '2026-11-03T04:00:00.000Z' },
    });
  const held = createSyntheticTask({
    taskCode: 'T-950',
    status: 'SCHEDULED',
    release: {
      ...createSyntheticTask().release!,
      holdReason: 'At active task cap (2/2) — held until capacity frees up',
    },
  });
  const base = createSyntheticState({ tasks: [busy('T-948'), busy('T-949'), held] });
  const state = { ...base, team_members: { ...base.team_members, '10003': third } };

  // Gamma is free, so the task is sent to Gamma straight away (one normal brief, no handover).
  const moved = reassignTaskResponsible(state, 'T-950', '10003', IN_SHIFT);
  const task = moved.tasks.find((t) => t.taskCode === 'T-950')!;
  assert.equal(task.status, 'PENDING');
  const msgs = moved.whatsapp_messages.filter((m) => m.taskCode === 'T-950');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].employeePhone, '10003');
  assert.equal(msgs[0].tag, 'TASK_DISPATCH');

  // Outside Gamma's shift it stays held, with a reason about Gamma (not the old limit).
  const night = reassignTaskResponsible(state, 'T-950', '10003', OUTSIDE_SHIFT);
  const nightTask = night.tasks.find((t) => t.taskCode === 'T-950')!;
  assert.equal(nightTask.status, 'SCHEDULED');
  assert.match(nightTask.release?.holdReason || '', /Held until next shift/);
  assert.equal(night.whatsapp_messages.length, 0);

  // Same through the edit form.
  const viaEditor = updateTaskAndNotify(state, { ...held, raci: { ...held.raci, R: '10003' } }, false, IN_SHIFT);
  assert.equal(viaEditor.nextState.tasks.find((t) => t.taskCode === 'T-950')?.status, 'PENDING');
});

test('past "At a time" choices are blocked at freeze with a clear message', () => {
  // Now: Tue 3 Nov 11:30 IST.
  const past = findPastReleaseTime({ mode: 'AT_TIME', releaseAt: '2026-11-03T09:00' }, 'Asia/Kolkata', IN_SHIFT);
  assert.equal(
    past,
    'That time (Tue, Nov 3, 9:00 AM) has already passed. Pick a time in the future, or choose "Now".'
  );
  // Future, the current minute, other modes and empty values are not reported here.
  assert.equal(findPastReleaseTime({ mode: 'AT_TIME', releaseAt: '2026-11-03T12:00' }, 'Asia/Kolkata', IN_SHIFT), null);
  assert.equal(findPastReleaseTime({ mode: 'AT_TIME', releaseAt: '2026-11-03T11:30' }, 'Asia/Kolkata', IN_SHIFT), null);
  assert.equal(findPastReleaseTime({ mode: 'NOW', releaseAt: '2026-11-03T09:00' }, 'Asia/Kolkata', IN_SHIFT), null);
  assert.equal(findPastReleaseTime({ mode: 'AT_TIME', releaseAt: null }, 'Asia/Kolkata', IN_SHIFT), null);
  // A full ISO time one minute ago counts as past.
  assert.match(
    findPastReleaseTime({ mode: 'AT_TIME', releaseAt: '2026-11-03T05:59:00.000Z' }, 'Asia/Kolkata', IN_SHIFT) || '',
    /already passed/
  );

  const problems = validateDraftReleaseChoices(
    [
      createSyntheticDraft({ tempId: 'p', title: 'Late job', release: { mode: 'AT_TIME', releaseAt: '2026-11-03T09:00' } }),
      createSyntheticDraft({ tempId: 'f', title: 'Later job', release: { mode: 'AT_TIME', releaseAt: '2026-11-03T15:00' } }),
    ],
    'Asia/Kolkata',
    IN_SHIFT
  );
  assert.deepEqual(problems.map((p) => p.tempId), ['p']);
  assert.match(buildIncompleteReleaseNotice(problems), /^Not sent: finish the release choice for "Late job"\. That time .* has already passed/);

  // The engine still releases a scheduled task once its time arrives (only freezing is blocked).
  const due = createSyntheticTask({
    release: { ...createSyntheticTask().release!, mode: 'AT_TIME', releaseAt: '2026-11-03T09:00' },
  });
  const ticked = releaseDueTasks(createSyntheticState({ tasks: [due] }), IN_SHIFT);
  assert.deepEqual(ticked.releasedTaskCodes, ['T-201']);
});

test('project badge says Scheduled with times, not Dispatched, until tasks are really sent', async () => {
  const { freezeAndDispatchStagingTasks } = await import('./opsEngine');
  const state = createSyntheticState();
  const head = { headId: 'HEAD-9', status: 'FROZEN_DISPATCHED' as const };

  assert.deepEqual(summarizeWbsHeadRelease({ headId: 'HEAD-9', status: 'SWIMLANE_READY' }, state, IN_SHIFT), {
    label: 'Staged Ready',
    tone: 'staged',
    details: [],
  });

  // Both tasks scheduled for later -> "Scheduled · first <time>"
  const scheduled = freezeAndDispatchStagingTasks(
    state,
    [
      createSyntheticDraft({ tempId: 'h1', shortTag: 'Prep', wbsHeadId: 'HEAD-9', release: { mode: 'AT_TIME', releaseAt: '2026-11-03T15:00' } }),
      createSyntheticDraft({ tempId: 'h2', shortTag: 'Fit', wbsHeadId: 'HEAD-9', release: { mode: 'AT_TIME', releaseAt: '2026-11-03T17:00' } }),
    ],
    undefined,
    IN_SHIFT
  );
  const s1 = summarizeWbsHeadRelease(head, scheduled, IN_SHIFT);
  assert.equal(s1.tone, 'scheduled');
  assert.equal(s1.label, 'Scheduled · first Tue, Nov 3, 3:00 PM');
  assert.deepEqual(s1.details.sort(), ['[Fit] Tue, Nov 3, 5:00 PM', '[Prep] Tue, Nov 3, 3:00 PM']);
  assert.doesNotMatch(s1.label, /Dispatched|Sent/);

  // Frozen at night -> held until the next shift
  const night = freezeAndDispatchStagingTasks(
    state,
    [createSyntheticDraft({ tempId: 'n1', shortTag: 'Night', wbsHeadId: 'HEAD-9' })],
    undefined,
    OUTSIDE_SHIFT
  );
  assert.equal(summarizeWbsHeadRelease(head, night, OUTSIDE_SHIFT).label, 'Scheduled · Wed, Nov 4, 9:00 AM');

  // One sent now, one later -> mixed
  const mixed = freezeAndDispatchStagingTasks(
    state,
    [
      createSyntheticDraft({ tempId: 'm1', shortTag: 'Now', wbsHeadId: 'HEAD-9' }),
      createSyntheticDraft({ tempId: 'm2', shortTag: 'Later', wbsHeadId: 'HEAD-9', release: { mode: 'AT_TIME', releaseAt: '2026-11-03T15:00' } }),
    ],
    undefined,
    IN_SHIFT
  );
  const s3 = summarizeWbsHeadRelease(head, mixed, IN_SHIFT);
  assert.equal(s3.tone, 'mixed');
  assert.equal(s3.label, 'Sent 1/2 · 1 scheduled (Tue, Nov 3, 3:00 PM)');

  // All sent -> "Sent ✓"
  const allSent = freezeAndDispatchStagingTasks(
    state,
    [createSyntheticDraft({ tempId: 'a1', shortTag: 'Go', wbsHeadId: 'HEAD-9' })],
    undefined,
    IN_SHIFT
  );
  assert.equal(summarizeWbsHeadRelease(head, allSent, IN_SHIFT).label, 'Sent ✓');

  // Held by something without a time -> the reason in words
  const waiting = freezeAndDispatchStagingTasks(
    state,
    [createSyntheticDraft({ tempId: 'w1', shortTag: 'Ask', wbsHeadId: 'HEAD-9', release: { mode: 'NOW', requireOwnerConfirm: true } })],
    undefined,
    IN_SHIFT
  );
  assert.equal(summarizeWbsHeadRelease(head, waiting, IN_SHIFT).label, 'Scheduled · when you confirm it');
});

// ---------------------------------------------------------------------------
// Milestone 3.5 — cancel/archive and automatic reminders
// ---------------------------------------------------------------------------

const sentRelease = (overrides: Partial<NonNullable<Task['release']>> = {}) => ({
  ...createSyntheticTask().release!,
  releasedAt: '2026-11-03T04:00:00.000Z', // 09:30 IST
  ...overrides,
});

test('isTaskClosed and isTaskOnActiveBoard', () => {
  assert.equal(isTaskClosed('COMPLETED'), true);
  assert.equal(isTaskClosed('EXPIRED_MISSED'), true);
  assert.equal(isTaskClosed('CANCELLED'), true);
  assert.equal(isTaskClosed('IN_PROGRESS'), false);
  assert.equal(isTaskClosed('SCHEDULED'), false);
  assert.equal(isTaskOnActiveBoard({ status: 'PENDING', archivedAt: null }), true);
  assert.equal(isTaskOnActiveBoard({ status: 'COMPLETED' }), true);
  assert.equal(isTaskOnActiveBoard({ status: 'COMPLETED', archivedAt: '2026-11-03T06:00:00.000Z' }), false);
  assert.equal(isTaskOnActiveBoard({ status: 'STAGING_DRAFT' }), false);
});

test('cancel and reminder messages are short, polite and in the person\'s language', () => {
  const task = createSyntheticTask({ shortTag: 'Unit Check', title: 'Inspect primary unit status' });
  const english = createSyntheticMember({ name: 'Operator Alpha', preferredLanguage: 'ENGLISH' });
  const hinglish = createSyntheticMember({ name: 'Operator Alpha', preferredLanguage: 'HINGLISH' });
  const hindi = createSyntheticMember({ name: 'Operator Alpha', preferredLanguage: 'HINDI' });

  assert.equal(
    buildTaskCancelledMessage(task, english),
    'Hello Operator Alpha, task [Unit Check] "Inspect primary unit status" has been cancelled. Please stop work on it. Thank you.'
  );
  assert.match(buildTaskCancelledMessage(task, hinglish), /^Namaste Operator Alpha ji, .*cancel ho gaya hai\. Kripya .* Dhanyavaad\.$/);
  assert.match(buildTaskCancelledMessage(task, hindi), /^नमस्ते Operator Alpha जी, .*रद्द .*कृपया .*धन्यवाद।$/);

  assert.equal(
    buildAutoReminderMessage(task, english),
    'Hello Operator Alpha, a gentle reminder about task [Unit Check] "Inspect primary unit status". Please share a quick update when you can. Thank you.'
  );
  assert.match(buildAutoReminderMessage(task, hinglish), /^Namaste Operator Alpha ji, .*reminder\. .*kripya update bhej dein\. Dhanyavaad\.$/);
  assert.match(buildAutoReminderMessage(task, hindi), /^नमस्ते Operator Alpha जी, .*कृपया अपडेट भेज दें। धन्यवाद।$/);

  for (const m of [english, hinglish, hindi]) {
    for (const text of [buildTaskCancelledMessage(task, m), buildAutoReminderMessage(task, m)]) {
      assert.ok(text.length < 200, `too long: ${text}`);
      assert.doesNotMatch(text, /undefined|null/);
    }
  }
  // Unknown person: still polite, no "undefined".
  assert.doesNotMatch(buildTaskCancelledMessage(task, null), /undefined/);
});

test('cancelling a sent task: leaves the board, tells the person once, logs it, frees the slot', async () => {
  const { cancelTask } = await import('./opsEngine');
  // Operator Alpha's limit is 2: two sent tasks, one held at the limit.
  const busy1 = createSyntheticTask({ taskCode: 'T-901', shortTag: 'Job One', status: 'IN_PROGRESS', release: sentRelease() });
  const busy2 = createSyntheticTask({ taskCode: 'T-902', status: 'PENDING', release: sentRelease() });
  const held = createSyntheticTask({
    taskCode: 'T-903',
    status: 'SCHEDULED',
    release: { ...createSyntheticTask().release!, holdReason: 'At active task cap (2/2) — held until capacity frees up' },
  });
  const state = createSyntheticState({ tasks: [busy1, busy2, held] });

  const res = cancelTask(state, 'T-901', IN_SHIFT);
  const cancelled = res.nextState.tasks.find((t) => t.taskCode === 'T-901')!;
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.cancelledAt, IN_SHIFT);
  assert.equal(isTaskOnActiveBoard(cancelled), false);
  assert.equal(cancelled.auditLogs.at(-1)?.sender, 'OWNER_CANCEL');
  assert.equal(res.personNotified, true);

  const stopMsgs = res.nextState.whatsapp_messages.filter((m) => m.tag === 'TASK_CANCELLED');
  assert.equal(stopMsgs.length, 1);
  assert.equal(stopMsgs[0].employeePhone, '10001');
  assert.equal(stopMsgs[0].tenantId, 'default');
  assert.match(stopMsgs[0].text, /\[Job One\].*cancelled\. Please stop work on it\./);

  // The freed slot releases the held task.
  assert.deepEqual(res.releasedTaskCodes, ['T-903']);
  assert.equal(res.nextState.tasks.find((t) => t.taskCode === 'T-903')?.status, 'PENDING');

  // Cancelling again does nothing.
  const again = cancelTask(res.nextState, 'T-901', IN_SHIFT);
  assert.equal(again.nextState, res.nextState);
});

test('cancelling a task that was not sent yet sends no message; open reviews are closed', async () => {
  const { cancelTask } = await import('./opsEngine');
  const scheduled = createSyntheticTask({
    taskCode: 'T-910',
    status: 'SCHEDULED',
    release: { ...createSyntheticTask().release!, mode: 'AT_TIME', releaseAt: '2026-11-04T09:00' },
  });
  const inReview = createSyntheticTask({ taskCode: 'T-911', status: 'AWAITING_BOSS_DECISION', release: sentRelease() });
  const state = createSyntheticState({
    tasks: [scheduled, inReview],
    boss_review_queue: [
      {
        tenantId: 'default',
        reviewId: 'REV-1',
        taskCode: 'T-911',
        employeePhone: '10001',
        reviewType: 'BLOCKER_ESCALATION',
        employeeMessageSummary: 'Blocked',
        mediaVerificationNote: '',
        aiSuggestedReplies: [],
        status: 'OPEN',
        createdAt: '2026-11-03T05:00:00.000Z',
      },
    ],
  });

  const unsent = cancelTask(state, 'T-910', IN_SHIFT);
  assert.equal(unsent.personNotified, false);
  assert.equal(unsent.nextState.whatsapp_messages.length, 0);
  assert.equal(unsent.nextState.tasks.find((t) => t.taskCode === 'T-910')?.status, 'CANCELLED');

  const reviewed = cancelTask(state, 'T-911', IN_SHIFT);
  assert.equal(reviewed.personNotified, true);
  const review = reviewed.nextState.boss_review_queue[0];
  assert.equal(review.status, 'RESOLVED');
  assert.match(review.resolutionReply || '', /cancelled/);
});

test('archiving: finished tasks are only moved to Archived; live tasks are cancelled', async () => {
  const { archiveTask } = await import('./opsEngine');
  const done = createSyntheticTask({ taskCode: 'T-920', status: 'COMPLETED', release: sentRelease() });
  const live = createSyntheticTask({ taskCode: 'T-921', status: 'IN_PROGRESS', release: sentRelease() });
  const state = createSyntheticState({ tasks: [done, live] });

  const archivedDone = archiveTask(state, 'T-920', IN_SHIFT);
  const doneAfter = archivedDone.nextState.tasks.find((t) => t.taskCode === 'T-920')!;
  assert.equal(doneAfter.status, 'COMPLETED');
  assert.equal(doneAfter.archivedAt, IN_SHIFT);
  assert.equal(isTaskOnActiveBoard(doneAfter), false);
  assert.equal(archivedDone.nextState.whatsapp_messages.length, 0);
  assert.equal(archivedDone.personNotified, false);

  const archivedLive = archiveTask(state, 'T-921', IN_SHIFT);
  const liveAfter = archivedLive.nextState.tasks.find((t) => t.taskCode === 'T-921')!;
  assert.equal(liveAfter.status, 'CANCELLED');
  assert.equal(Boolean(liveAfter.archivedAt), true);
  assert.equal(archivedLive.personNotified, true);
  assert.equal(archivedLive.nextState.whatsapp_messages.filter((m) => m.tag === 'TASK_CANCELLED').length, 1);
});

test('tasks waiting on a cancelled task stay held with "Waiting: parent task cancelled"', async () => {
  const { cancelTask } = await import('./opsEngine');
  const parent = createSyntheticTask({ taskCode: 'T-940', status: 'IN_PROGRESS', release: sentRelease() });
  const locked = createSyntheticTask({
    taskCode: 'T-941',
    status: 'LOCKED_BY_DEPENDENCY',
    dependency: { dependsOnTaskCode: 'T-940', triggerCondition: 'FULL_COMPLETION' },
    release: { ...createSyntheticTask().release!, mode: 'AFTER_TASK', afterTaskCode: 'T-940' },
  });
  const scheduledAfter = createSyntheticTask({
    taskCode: 'T-942',
    status: 'SCHEDULED',
    release: { ...createSyntheticTask().release!, mode: 'AFTER_TASK', afterTaskCode: 'T-940' },
  });
  const state = createSyntheticState({ tasks: [parent, locked, scheduledAfter] });

  const res = cancelTask(state, 'T-940', IN_SHIFT);
  assert.deepEqual(res.waitingTaskCodes.sort(), ['T-941', 'T-942']);
  for (const code of ['T-941', 'T-942']) {
    const t = res.nextState.tasks.find((x) => x.taskCode === code)!;
    assert.notEqual(t.status, 'PENDING');
    assert.equal(t.release?.holdReason, PARENT_CANCELLED_HOLD_REASON);
    assert.equal(describePlannedSendTime(t, res.nextState, IN_SHIFT), 'Not planned — the task it waits for was cancelled');
  }
  assert.equal(res.nextState.whatsapp_messages.filter((m) => m.taskCode !== 'T-940').length, 0);

  // Later ticks keep them held.
  const later = releaseDueTasks(res.nextState, '2026-11-03T08:00:00.000Z');
  assert.deepEqual(later.releasedTaskCodes, []);
  assert.equal(
    later.nextState.tasks.find((t) => t.taskCode === 'T-942')?.release?.holdReason,
    PARENT_CANCELLED_HOLD_REASON
  );
});

test('a WhatsApp reply about a cancelled task is logged only and changes no status', async () => {
  const { applyProcessedBufferResult, cancelTask } = await import('./opsEngine');
  const task = createSyntheticTask({ taskCode: 'T-960', status: 'IN_PROGRESS', release: sentRelease() });
  const cancelled = cancelTask(createSyntheticState({ tasks: [task] }), 'T-960', IN_SHIFT).nextState;
  const withBuffer: OpsDatabaseState = {
    ...cancelled,
    inbound_message_buffer: {
      '10001': {
        tenantId: 'default',
        employeePhone: '10001',
        bufferMode: 'STANDARD_15_MIN',
        firstMessageAt: '2026-11-03T06:10:00.000Z',
        processAt: '2026-11-03T06:25:00.000Z',
        messages: [{ id: 'b1', timestamp: '2026-11-03T06:10:00.000Z', type: 'text', textContent: 'Finished both steps' }],
      },
    },
  };
  const after = applyProcessedBufferResult(
    withBuffer,
    '10001',
    {
      matchedTaskCode: 'T-960',
      englishBossSummary: 'Done',
      mediaVerificationNote: '',
      updatedMicroSteps: [
        { id: 'ms-1', status: 'DONE' },
        { id: 'ms-2', status: 'DONE' },
      ],
      completionPercent: 100,
      missingStepsAlert: '',
      whatsappReplyInPreferredLanguage: 'Thanks',
      escalateToBossReview: false,
    },
    '2026-11-03T06:30:00.000Z'
  );
  const t = after.tasks.find((x) => x.taskCode === 'T-960')!;
  assert.equal(t.status, 'CANCELLED');
  assert.deepEqual(t.microSteps.map((s) => s.status), ['PENDING', 'PENDING']);
  assert.match(t.auditLogs.at(-1)?.aiDecision || '', /status unchanged/);
  assert.ok(after.whatsapp_messages.some((m) => m.direction === 'INBOUND' && m.taskCode === 'T-960'));
  assert.deepEqual(after.inbound_message_buffer, {});
});

test('automatic reminders: due after the interval inside the shift, and not otherwise', () => {
  const state = createSyntheticState();
  const ctx = { timezone: 'Asia/Kolkata', workingDays: [1, 2, 3, 4, 5, 6], whatsappMessages: [] };
  const person = state.team_members['10001'];
  // Sent 09:30 IST, normal interval 4h -> due from 13:30 IST (08:00Z).
  const task = createSyntheticTask({ status: 'PENDING', release: sentRelease(), reminderConfig: { ...createSyntheticTask().reminderConfig, customIntervalHours: null } });

  assert.equal(computeReminderDecision(task, person, ctx, '2026-11-03T08:00:00.000Z').due, true);
  assert.match(computeReminderDecision(task, person, ctx, '2026-11-03T07:59:00.000Z').reason, /Interval \(4h\)/);
  // Outside shift (18:00 IST = 12:30Z is the shift end) and at night.
  assert.equal(computeReminderDecision(task, person, ctx, '2026-11-03T12:30:00.000Z').reason, 'Outside shift');
  assert.equal(computeReminderDecision(task, person, ctx, OUTSIDE_SHIFT).reason, 'Outside shift');
  // Sunday 8 Nov is not a working day.
  assert.equal(computeReminderDecision(task, person, ctx, '2026-11-08T08:00:00.000Z').reason, 'Not a working day');
  // On leave / owner.
  assert.equal(computeReminderDecision(task, { ...person, isOnLeave: true }, ctx, '2026-11-03T08:00:00.000Z').reason, 'On leave');
  assert.equal(
    computeReminderDecision(task, { ...person, authorityLevel: 'OWNER' }, ctx, '2026-11-03T08:00:00.000Z').reason,
    'Owner tasks are not nudged'
  );
  // Statuses that are skipped.
  for (const status of ['AWAITING_BOSS_DECISION', 'COMPLETED', 'CANCELLED', 'SCHEDULED', 'LOCKED_BY_DEPENDENCY'] as const) {
    assert.equal(computeReminderDecision({ ...task, status }, person, ctx, '2026-11-03T08:00:00.000Z').due, false, status);
  }
  assert.equal(
    computeReminderDecision({ ...task, archivedAt: IN_SHIFT }, person, ctx, '2026-11-03T08:00:00.000Z').due,
    false
  );
  // Custom interval wins; Q1 defaults to 2h.
  assert.equal(
    computeReminderDecision({ ...task, reminderConfig: { ...task.reminderConfig, customIntervalHours: 1 } }, person, ctx, '2026-11-03T05:00:00.000Z').due,
    true
  );
  assert.equal(computeReminderDecision({ ...task, quadrant: 'Q1_DO_FIRST' }, person, ctx, '2026-11-03T06:00:00.000Z').due, true);
});

test('automatic reminders: a reply or a manual nudge restarts the clock', () => {
  const state = createSyntheticState();
  const person = state.team_members['10001'];
  const task = createSyntheticTask({ status: 'IN_PROGRESS', release: sentRelease(), reminderConfig: { ...createSyntheticTask().reminderConfig, customIntervalHours: null } });
  const reply = {
    tenantId: 'default',
    id: 'in-1',
    employeePhone: '10001',
    direction: 'INBOUND' as const,
    timestamp: '2026-11-03T07:00:00.000Z', // 12:30 IST
    taskCode: 'T-201',
    text: 'Working on it',
  };
  const ctx = { timezone: 'Asia/Kolkata', workingDays: [1, 2, 3, 4, 5, 6], whatsappMessages: [reply] };
  assert.equal(getReminderClockStartMs(task, [reply]), Date.parse(reply.timestamp));
  assert.equal(computeReminderDecision(task, person, ctx, '2026-11-03T08:00:00.000Z').due, false);
  assert.equal(computeReminderDecision(task, person, ctx, '2026-11-03T11:00:00.000Z').due, true);
  // A reply from someone else, or about another task, does not count.
  assert.equal(getReminderClockStartMs(task, [{ ...reply, employeePhone: '10002' }]), Date.parse('2026-11-03T04:00:00.000Z'));
  assert.equal(getReminderClockStartMs(task, [{ ...reply, taskCode: 'T-999' }]), Date.parse('2026-11-03T04:00:00.000Z'));
  // A manual nudge also restarts it.
  const nudged = { ...task, reminderConfig: { ...task.reminderConfig, lastNudgedAt: '2026-11-03T07:30:00.000Z' } };
  assert.equal(computeReminderDecision(nudged, person, { ...ctx, whatsappMessages: [] }, '2026-11-03T08:00:00.000Z').due, false);
});

test('automatic reminders: at most 3 a day for normal tasks, no cap for Q1, logged and counted', () => {
  // Interval 1h, shift 09:00-18:00 IST.
  const base = createSyntheticTask({
    status: 'PENDING',
    release: sentRelease(),
    reminderConfig: { ...createSyntheticTask().reminderConfig, customIntervalHours: 1 },
  });
  const run = (task: Task, times: string[]) => {
    let state = createSyntheticState({ tasks: [task] });
    const sent: number[] = [];
    for (const at of times) {
      const res = sendDueReminders(state, at);
      sent.push(res.remindedTaskCodes.length);
      state = res.nextState;
    }
    return { state, sent };
  };
  const hourly = ['05:00', '06:00', '07:00', '08:00', '09:00'].map((h) => `2026-11-03T${h}:00.000Z`);

  const normal = run(base, hourly);
  assert.deepEqual(normal.sent, [1, 1, 1, 0, 0]);
  const t = normal.state.tasks[0];
  assert.equal(t.reminderConfig.autoNudgesOnDate, 3);
  assert.equal(t.reminderConfig.autoNudgeDate, '2026-11-03');
  assert.equal(t.reminderConfig.nudgeCount, 3);
  assert.equal(t.status, 'PENDING');
  assert.equal(t.auditLogs.filter((a) => a.sender === 'AUTO_REMINDER').length, 3);
  const msgs = normal.state.whatsapp_messages.filter((m) => m.tag === 'AUTO_REMINDER');
  assert.equal(msgs.length, 3);
  assert.ok(msgs.every((m) => m.tenantId === 'default' && m.employeePhone === '10001' && /gentle reminder/.test(m.text)));

  // The next working day the count starts again.
  const nextDay = sendDueReminders(normal.state, '2026-11-04T05:00:00.000Z');
  assert.equal(nextDay.remindedTaskCodes.length, 1);
  assert.equal(nextDay.nextState.tasks[0].reminderConfig.autoNudgesOnDate, 1);

  const urgent = run({ ...base, quadrant: 'Q1_DO_FIRST' }, hourly);
  assert.deepEqual(urgent.sent, [1, 1, 1, 1, 1]);

  // Nothing due -> same state object back.
  const quiet = createSyntheticState({ tasks: [base] });
  assert.equal(sendDueReminders(quiet, OUTSIDE_SHIFT).nextState, quiet);
});

test('scheduler tick sends due reminders and reports remindersSent', () => {
  const pending = createSyntheticTask({ status: 'PENDING', release: sentRelease(), reminderConfig: { ...createSyntheticTask().reminderConfig, customIntervalHours: null } });
  const state = createSyntheticState({
    tasks: [pending],
    team_members: {
      ...createSyntheticState().team_members,
      '10001': createSyntheticMember({ lastDailyDigestDate: '2026-11-03' }),
    },
  });
  const inShift = runScheduledJobsTick(state, '2026-11-03T08:00:00.000Z');
  assert.equal(inShift.remindersSent, 1);
  assert.equal(inShift.nextState.whatsapp_messages.filter((m) => m.tag === 'AUTO_REMINDER').length, 1);

  const night = runScheduledJobsTick(state, OUTSIDE_SHIFT);
  assert.equal(night.remindersSent, 0);
});

// ---------------------------------------------------------------------------
// Milestone 3.6 — owner-edited drafts are frozen exactly; custom messages sent verbatim
// ---------------------------------------------------------------------------

test('freezing an owner-edited draft gives a task that matches every edit exactly', async () => {
  const { freezeAndDispatchStagingTasks } = await import('./opsEngine');
  const { applyDraftEdit } = await import('./draftEditing');
  const base = createSyntheticState();
  const third = createSyntheticMember({ phone: '10003', slotId: 'P3', name: 'Helper Gamma' });
  const state: OpsDatabaseState = { ...base, team_members: { ...base.team_members, '10003': third } };

  const edited = applyDraftEdit(
    createSyntheticDraft({ tempId: 'e1' }),
    {
      title: 'Owner edited title',
      shortTag: 'Owner Tag',
      microSteps: ['Second step first', 'Then this'],
      'raci.R': '10003',
      'raci.A': '10001',
      'raci.C': ['10002'],
      'raci.I': ['10001'],
      categoryId: 'CAT_OPS',
      quadrant: 'Q3_DELEGATE',
      majorOrMinor: 'MAJOR',
      dueDate: '2026-11-06',
      durationDays: 2,
      release: { mode: 'AT_TIME', releaseAt: '2026-11-05T10:00' },
      taskFrequency: 'RECURRING',
      recurrenceRule: 'WEEKLY',
    },
    state.team_members
  ).draft;

  const frozen = freezeAndDispatchStagingTasks(state, [edited], undefined, IN_SHIFT);
  const task = frozen.tasks.find((t) => t.title === 'Owner edited title')!;
  assert.equal(task.shortTag, 'Owner Tag');
  assert.deepEqual(task.microSteps.map((s) => s.label), ['Second step first', 'Then this']);
  assert.deepEqual(task.raci, { R: '10003', A: '10001', C: ['10002'], I: ['10001'] });
  assert.equal(task.categoryId, 'CAT_OPS');
  assert.equal(task.quadrant, 'Q3_DELEGATE');
  assert.equal(task.majorOrMinor, 'MAJOR');
  assert.equal(task.dueDate, '2026-11-06');
  assert.equal(task.startDate, '2026-11-05');
  assert.equal(task.durationDays, 2);
  assert.equal(task.release?.mode, 'AT_TIME');
  assert.equal(task.release?.releaseAt, '2026-11-05T10:00');
  assert.equal(task.taskFrequency, 'RECURRING');
  assert.equal(task.recurrenceRule, 'WEEKLY');
  assert.equal(task.status, 'SCHEDULED');
  // Editing drafts sent nothing; freezing a scheduled task sends nothing yet either.
  assert.equal(frozen.whatsapp_messages.length, 0);
});

test('a custom message is sent exactly as written; the 24h template wraps it outside the window', async () => {
  const { freezeAndDispatchStagingTasks } = await import('./opsEngine');
  const { applyDraftEdit } = await import('./draftEditing');
  const custom = 'Please check the unit pressure before lunch and send one clear photo. Thank you!';

  const state = createSyntheticState();
  const edited = applyDraftEdit(createSyntheticDraft({ tempId: 'm1' }), { outboundWhatsappPreview: custom }, state.team_members).draft;
  const frozen = freezeAndDispatchStagingTasks(state, [edited], undefined, '2026-11-03T09:30:00.000Z');
  const task = frozen.tasks.find((t) => t.title === 'Check pump pressure')!;
  assert.equal(task.messageIsCustom, true);
  const sent = frozen.whatsapp_messages.filter((m) => m.taskCode === task.taskCode);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, custom); // inside the 24h window: verbatim

  // An AI rewrite offered by the tick is ignored for a custom message.
  const scheduled = freezeAndDispatchStagingTasks(
    state,
    [applyDraftEdit(createSyntheticDraft({ tempId: 'm2', release: { mode: 'AT_TIME', releaseAt: '2026-11-03T16:00' } }), { outboundWhatsappPreview: custom }, state.team_members).draft],
    undefined,
    '2026-11-03T09:30:00.000Z'
  );
  const code = scheduled.tasks.find((t) => t.status === 'SCHEDULED')!.taskCode;
  const released = releaseDueTasks(scheduled, '2026-11-03T10:31:00.000Z', { messageOverrides: { [code]: 'AI rewrite' } });
  assert.equal(released.nextState.whatsapp_messages.find((m) => m.taskCode === code)?.text, custom);

  // Outside the 24h window the approved template wraps the owner's exact text.
  const quiet = createSyntheticState({
    team_members: {
      ...state.team_members,
      '10001': createSyntheticMember({ lastInboundAt: '2026-10-01T09:00:00.000Z' }),
    },
  });
  const wrapped = freezeAndDispatchStagingTasks(quiet, [edited], undefined, '2026-11-03T09:30:00.000Z');
  const wrappedMsg = wrapped.whatsapp_messages.find((m) => m.direction === 'OUTBOUND')!;
  assert.equal(wrappedMsg.isTemplateMessage, true);
  assert.ok(wrappedMsg.text.includes(custom));
});

// ---------------------------------------------------------------------------
// Milestone 4 — owner digest and owner tasks
// ---------------------------------------------------------------------------

test('tick: the owner gets a My tasks digest; staff get their normal digest; empty owner digest is skipped', () => {
  const owner = createSyntheticMember({ phone: '10000', slotId: 'P0', name: 'Owner Prime', authorityLevel: 'OWNER' });
  const base = createSyntheticState();
  const members = { ...base.team_members, '10000': owner };
  const delegatedLate = createSyntheticTask({
    taskCode: 'T-401',
    shortTag: 'Late Job',
    status: 'PENDING',
    dueDate: '2026-11-01',
    raci: { R: '10001', A: '10000', C: [], I: [] },
    release: { ...createSyntheticTask().release!, releasedAt: '2026-11-03T03:50:00.000Z' },
  });
  const ownTask = createSyntheticTask({
    taskCode: 'T-402',
    shortTag: 'Own Job',
    title: 'Owner own work',
    status: 'PENDING',
    raci: { R: '10000', A: '10000', C: [], I: [] },
    release: { ...createSyntheticTask().release!, releasedAt: '2026-11-03T03:50:00.000Z' },
  });
  const state = { ...base, team_members: members, tasks: [delegatedLate, ownTask] };

  // 04:05 UTC = 09:35 IST: after everyone's 09:30 digest time.
  const tick = runScheduledJobsTick(state, '2026-11-03T04:05:00.000Z');
  const digests = tick.nextState.whatsapp_messages.filter((m) => m.tag === 'DAILY_DIGEST');
  const ownerDigest = digests.find((m) => m.employeePhone === '10000')!;
  assert.match(ownerDigest.text, /Your tasks \(1\):\n• \[Own Job\] Owner own work/);
  assert.match(ownerDigest.text, /Decisions waiting for you: 0/);
  assert.match(ownerDigest.text, /\[Late Job\] — Operator Alpha — overdue 2 days/);
  assert.equal(ownerDigest.tenantId, 'default');
  const staffDigest = digests.find((m) => m.employeePhone === '10001')!;
  assert.match(staffDigest.text, /Daily Shift Digest for Operator Alpha/);
  assert.equal(tick.nextState.team_members['10000'].lastDailyDigestDate, '2026-11-03');

  // Nothing for the owner -> no owner digest (but the day is still marked done).
  const quiet = runScheduledJobsTick({ ...base, team_members: members, tasks: [] }, '2026-11-03T04:05:00.000Z');
  assert.equal(quiet.nextState.whatsapp_messages.filter((m) => m.employeePhone === '10000').length, 0);
  assert.equal(quiet.nextState.team_members['10000'].lastDailyDigestDate, '2026-11-03');
});

test('owner tasks are never auto-reminded; the Shift Digest button also sends the owner summary', async () => {
  const { triggerDailyOverviewCron } = await import('./opsEngine');
  const owner = createSyntheticMember({ phone: '10000', slotId: 'P0', name: 'Owner Prime', authorityLevel: 'OWNER' });
  const base = createSyntheticState();
  const ownTask = createSyntheticTask({
    taskCode: 'T-410',
    shortTag: 'Own Job',
    status: 'PENDING',
    raci: { R: '10000', A: '10000', C: [], I: [] },
    release: { ...createSyntheticTask().release!, releasedAt: '2026-11-02T03:00:00.000Z' },
  });
  const state = { ...base, team_members: { ...base.team_members, '10000': owner }, tasks: [ownTask] };
  assert.deepEqual(sendDueReminders(state, '2026-11-03T08:00:00.000Z').remindedTaskCodes, []);

  const cron = triggerDailyOverviewCron(state, '2026-11-03T04:05:00.000Z');
  const ownerMsg = cron.nextState.whatsapp_messages.find((m) => m.employeePhone === '10000')!;
  assert.match(ownerMsg.text, /Your tasks \(1\):\n• \[Own Job\]/);
  assert.equal(ownerMsg.tenantId, 'default');
});

test('Shift Digest: a new daily copy records its own send time, so it is not shown as stuck', async () => {
  const { triggerDailyOverviewCron } = await import('./opsEngine');
  const { buildMyTasks } = await import('./myTasks');
  const owner = createSyntheticMember({ phone: '10000', slotId: 'P0', name: 'Owner Prime', authorityLevel: 'OWNER' });
  const base = createSyntheticState();
  const daily = createSyntheticTask({
    taskCode: 'T-420',
    status: 'PENDING',
    taskFrequency: 'RECURRING',
    recurrenceRule: 'DAILY',
    dueDate: '2026-11-02',
    raci: { R: '10001', A: '10000', C: [], I: [] },
    release: { ...createSyntheticTask().release!, releasedAt: '2026-11-02T03:00:00.000Z' },
  });
  const state = { ...base, team_members: { ...base.team_members, '10000': owner }, tasks: [daily] };
  const now = '2026-11-03T04:05:00.000Z';
  const cron = triggerDailyOverviewCron(state, now);
  const fresh = cron.nextState.tasks.find((t) => t.taskCode !== 'T-420')!;
  assert.equal(fresh.release?.releasedAt, now);
  const summary = buildMyTasks(cron.nextState, { nowIso: now, todayStr: '2026-11-03' });
  assert.equal(summary.followUp.find((f) => f.task.taskCode === fresh.taskCode), undefined);
});
