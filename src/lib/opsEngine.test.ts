import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProcessedBufferResult,
  calculateWorkHoursMinutes,
  cascadeTaskSchedule,
  computeDueDate,
  computeStartDateFromDeadline,
  enqueueInboundSimulatorMessage,
  forceUnlockTask,
  freezeAndDispatchStagingTasks,
  handleOversizedVideoEscalation,
  isWithin24HrWindow,
  recalculateWbsHeadDates,
  resolveBossReviewItem,
  sendInstantNudge,
  triggerDailyOverviewCron,
  updateTaskAndNotify,
  validateMediaAttachment,
} from './opsEngine';
import { createInitialSeedState } from './seedData';

test('isWithin24HrWindow checks Meta 24-hour customer service window accurately', () => {
  const now = '2026-11-03T12:00:00.000Z';
  assert.equal(isWithin24HrWindow('2026-11-03T08:00:00.000Z', now), true);
  assert.equal(isWithin24HrWindow('2026-11-02T10:00:00.000Z', now), false);
});

test('calculateWorkHoursMinutes ignores overnight off-shift hours and paused Boss Review intervals', () => {
  // Shift 09:00 to 19:00 local time
  const day1Evening = new Date(2026, 10, 2, 18, 30, 0).toISOString(); // 18:30 (30m left in shift)
  const day2Morning = new Date(2026, 10, 3, 9, 20, 0).toISOString();  // 09:20 (20m into next shift)

  const mins = calculateWorkHoursMinutes(day1Evening, day2Morning, '09:00', '19:00', []);
  assert.equal(mins, 50);

  // Now include a 15-minute Boss Review pause inside the morning window (09:05 to 09:20)
  const pauseStart = new Date(2026, 10, 3, 9, 5, 0).toISOString();
  const pauseEnd = new Date(2026, 10, 3, 9, 20, 0).toISOString();
  const minsWithPause = calculateWorkHoursMinutes(day1Evening, day2Morning, '09:00', '19:00', [
    { pausedAt: pauseStart, resumedAt: pauseEnd },
  ]);
  assert.equal(minsWithPause, 35);
});

test('sendInstantNudge switches employee bufferMode to INSTANT_NUDGE_ACTIVE and increments nudgeCount', () => {
  const seed = createInitialSeedState('2026-11-03T10:00:00.000Z');
  const next = sendInstantNudge(seed, 'T-101', '2026-11-03T10:05:00.000Z');
  const mohan = next.team_members['919876500001'];
  const t101 = next.tasks.find((t) => t.taskCode === 'T-101')!;

  assert.equal(mohan.bufferMode, 'INSTANT_NUDGE_ACTIVE');
  assert.equal(t101.reminderConfig.nudgeCount, 2);
});

test('enqueueInboundSimulatorMessage blocks unregistered numbers before LLM buffer', () => {
  const seed = createInitialSeedState('2026-11-03T10:00:00.000Z');
  const res = enqueueInboundSimulatorMessage(
    seed,
    '919999988888',
    { type: 'text', textContent: 'Hello who is this?' },
    '2026-11-03T10:01:00.000Z'
  );
  assert.equal(res.unknownSenderBlocked, true);
  assert.equal(Object.keys(res.nextState.inbound_message_buffer).length, 0);
});

test('15MB Video Guard blocks >15MB videos from RAM and routes to Boss Review Queue', () => {
  const check = validateMediaAttachment(18.4, 'video/mp4');
  assert.equal(check.allowedInRam, false);
  assert.match(check.guardMessage || '', /Video > 15MB/);

  const seed = createInitialSeedState('2026-11-03T10:00:00.000Z');
  const escalated = handleOversizedVideoEscalation(
    seed,
    '919876500001',
    'site_walkthrough.mp4',
    18.4,
    '2026-11-03T10:02:00.000Z'
  );
  const t101 = escalated.tasks.find((t) => t.taskCode === 'T-101')!;
  assert.equal(t101.status, 'AWAITING_BOSS_DECISION');
  assert.equal(escalated.boss_review_queue[0].taskCode, 'T-101');
});

test('Multimodal buffer processing escalates partial handover to Boss Review, and resolution auto-unlocks T-102 for Balbir', () => {
  let state = createInitialSeedState('2026-11-03T10:00:00.000Z');
  const enq = enqueueInboundSimulatorMessage(
    state,
    '919876500001',
    {
      type: 'image',
      fileName: 'floodlights.jpg',
      mimeType: 'image/jpeg',
      base64Data: 'AAAA_HEAVY_BASE64_STRING',
      textContent: 'Light le li aur Vikram sir ko de di, par shopkeeper GST bill shaam ko bhejega.',
    },
    '2026-11-03T10:15:00.000Z'
  );
  state = enq.nextState;

  state = applyProcessedBufferResult(
    state,
    '919876500001',
    {
      matchedTaskCode: 'T-101',
      englishBossSummary: 'Mohan Ram handed 4 floodlights to Vikram Singh; GST bill still pending.',
      mediaVerificationNote: 'Verified photo of 4x Havells floodlight cartons.',
      updatedMicroSteps: [
        { id: 'ms-101-1', status: 'DONE' },
        { id: 'ms-101-2', status: 'MISSED', evidenceNote: 'Shopkeeper sending GST invoice in evening' },
        { id: 'ms-101-3', status: 'DONE', evidenceNote: 'Handed over physically to Vikram' },
      ],
      completionPercent: 75,
      missingStepsAlert: 'GST Bill photo skipped despite claiming handover.',
      whatsappReplyInPreferredLanguage:
        'धन्यवाद मोहन राम जी! लाइट हैंडओवर नोट किया गया, पर कृपया पक्का GST बिल का फोटो शाम तक जरूर भेजें।',
      escalateToBossReview: true,
      reviewType: 'PARTIAL_HANDOVER_GATE',
      aiSuggestedReplies: ['Approve partial handover & unlock Balbir installation T-102; submit GST bill by 6 PM.'],
    },
    '2026-11-03T10:16:00.000Z'
  );

  // Ephemeral media must be stripped completely
  assert.equal(state.inbound_message_buffer['919876500001'], undefined);
  assert.equal(JSON.stringify(state).includes('AAAA_HEAVY_BASE64_STRING'), false);

  const t101Paused = state.tasks.find((t) => t.taskCode === 'T-101')!;
  assert.equal(t101Paused.status, 'AWAITING_BOSS_DECISION');

  const openRev = state.boss_review_queue.find((r) => r.taskCode === 'T-101' && r.status === 'OPEN')!;
  assert.ok(openRev);

  // Boss clicks 1-click approval chip -> T-102 unlocks to PENDING!
  state = resolveBossReviewItem(
    state,
    openRev.reviewId,
    openRev.aiSuggestedReplies[0],
    true,
    '2026-11-03T10:20:00.000Z'
  );

  const t102After = state.tasks.find((t) => t.taskCode === 'T-102')!;
  assert.equal(t102After.status, 'PENDING');
});

test('freezeAndDispatchStagingTasks sets independent tasks to PENDING and dependent tasks to LOCKED_BY_DEPENDENCY', () => {
  const seed = createInitialSeedState('2026-11-03T10:00:00.000Z');
  const next = freezeAndDispatchStagingTasks(
    seed,
    [
      {
        tempId: 'draft-1',
        title: 'Buy 20m Red Carpet Runner',
        categoryId: 'PROCUREMENT',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        taskFrequency: 'ONE_TIME',
        recurrenceRule: 'NONE',
        raci: { R: '919876500001', A: '919876500003', C: [], I: [] },
        dependsOnTempIdOrTaskCode: null,
        triggerCondition: 'FULL_COMPLETION',
        dueDate: '2026-11-04',
        microSteps: ['Buy carpet', 'Send GST bill'],
      },
      {
        tempId: 'draft-2',
        title: 'Lay Carpet Runner at Main Entrance',
        categoryId: 'EVENT_PREP',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        taskFrequency: 'ONE_TIME',
        recurrenceRule: 'NONE',
        raci: { R: '919876500002', A: '919876500003', C: [], I: [] },
        dependsOnTempIdOrTaskCode: 'draft-1',
        triggerCondition: 'PARTIAL_OR_BOSS_APPROVAL',
        dueDate: '2026-11-04',
        microSteps: ['Lay carpet', 'Send setup photo'],
      },
    ],
    {
      title: 'VIP Entrance Readiness',
      rawBrainDump: 'Buy and lay carpet',
      quadrant: 'Q1_DO_FIRST',
      majorOrMinor: 'MAJOR',
    },
    '2026-11-03T11:00:00.000Z'
  );

  const t106 = next.tasks.find((t) => t.taskCode === 'T-106')!;
  const t107 = next.tasks.find((t) => t.taskCode === 'T-107')!;
  assert.equal(t106.status, 'PENDING');
  assert.equal(t107.status, 'LOCKED_BY_DEPENDENCY');
  assert.equal(t107.dependency.dependsOnTaskCode, 'T-106');
});

test('triggerDailyOverviewCron expires yesterday uncompleted recurring tasks and skips AWAITING_BOSS_DECISION', () => {
  const seed = createInitialSeedState('2026-11-03T09:00:00.000Z');
  // Make T-103 due yesterday so we verify auto-expiration
  const modified = {
    ...seed,
    tasks: seed.tasks.map((t) =>
      t.taskCode === 'T-103' ? { ...t, dueDate: '2026-11-02' } : t
    ),
  };
  const { nextState, expiredCount, digestsSent } = triggerDailyOverviewCron(
    modified,
    '2026-11-03T09:30:00.000Z'
  );
  assert.equal(expiredCount, 1);
  assert.ok(digestsSent >= 1);
  assert.equal(nextState.tasks.find((t) => t.taskCode === 'T-103')?.status, 'EXPIRED_MISSED');
  // T-104 in AWAITING_BOSS_DECISION must remain untouched
  assert.equal(nextState.tasks.find((t) => t.taskCode === 'T-104')?.status, 'AWAITING_BOSS_DECISION');

  // Uncompleted recurring task T-103 auto-spawns a fresh clone instance for today (T-106)
  const t106 = nextState.tasks.find((t) => t.taskCode === 'T-106');
  assert.ok(t106, 'Fresh recurring clone T-106 should be auto-spawned');
  assert.equal(t106.status, 'PENDING');
  assert.equal(t106.dueDate, '2026-11-03');
  assert.equal(t106.completionPercent, 0);
  assert.equal(t106.title, modified.tasks.find((t) => t.taskCode === 'T-103')?.title);
});

test('updateTaskAndNotify updates task details and dispatches Hinglish WhatsApp notification to teammate', () => {
  const seed = createInitialSeedState('2026-11-03T10:00:00.000Z');
  const target = seed.tasks.find((t) => t.taskCode === 'T-101')!;
  const updated = {
    ...target,
    title: 'Purchase 4 Heavy Duty IP66 LED Floodlights (Updated specs)',
    microSteps: [
      ...target.microSteps,
      { id: 'ms-101-4', label: 'Verify 2-year warranty card', status: 'PENDING' as const },
    ],
  };

  const { nextState, notificationSent } = updateTaskAndNotify(seed, updated, true, '2026-11-03T10:05:00.000Z');
  assert.equal(notificationSent, true);
  const updatedInState = nextState.tasks.find((t) => t.taskCode === 'T-101')!;
  assert.equal(updatedInState.microSteps.length, 4);

  const lastMsg = nextState.whatsapp_messages[nextState.whatsapp_messages.length - 1];
  assert.equal(lastMsg.tag, 'TASK_UPDATE');
  assert.equal(lastMsg.employeePhone, updated.raci.R);
  assert.match(lastMsg.text, /Task Update \[Lawn Floodlights\]/);
});

test('computeDueDate and computeStartDateFromDeadline calculate offsets correctly', () => {
  assert.equal(computeDueDate('2026-11-04', 1), '2026-11-04');
  assert.equal(computeDueDate('2026-11-04', 2), '2026-11-05');
  assert.equal(computeDueDate('2026-11-04', 3), '2026-11-06');
  assert.equal(computeStartDateFromDeadline('2026-11-06', 3), '2026-11-04');
  assert.equal(computeStartDateFromDeadline('2026-11-04', 1), '2026-11-04');
});

test('recalculateWbsHeadDates back-calculates stages when isForcedDeadline is true', () => {
  const head = {
    headId: 'HEAD-TEST',
    title: 'VIP Event Prep',
    domainCategory: 'EVENT_PREP',
    contextSummary: 'Need lights and cables installed before 4 PM event cutoff.',
    quadrant: 'Q1_DO_FIRST' as const,
    majorOrMinor: 'MAJOR' as const,
    tentativeDurationDays: 2,
    tentativeStartDate: '2026-11-04',
    tentativeDeadline: '2026-11-05',
    isForcedDeadline: true,
    dynamicStages: ['Procurement', 'Mounting'],
    involvedPhones: ['919876500001', '919876500002'],
    status: 'SWIMLANE_READY' as const,
    subTasks: [
      {
        tempId: 't1',
        title: 'Buy lights',
        shortTag: 'Lawn Lights',
        categoryId: 'PROCUREMENT',
        quadrant: 'Q1_DO_FIRST' as const,
        majorOrMinor: 'MAJOR' as const,
        taskFrequency: 'ONE_TIME' as const,
        recurrenceRule: 'NONE' as const,
        raci: { R: '919876500001', A: '919876500003', C: [], I: [] },
        dependsOnTempIdOrTaskCode: null,
        triggerCondition: 'FULL_COMPLETION' as const,
        startDate: '2026-11-04',
        durationDays: 1,
        dueDate: '2026-11-04',
        isForcedDeadline: false,
        forcedDeadlineDate: null,
        wbsHeadId: 'HEAD-TEST',
        swimlaneStage: 'Procurement',
        microSteps: ['Buy lights'],
        outboundWhatsappPreview: 'Buy lights',
      },
      {
        tempId: 't2',
        title: 'Mount lights',
        shortTag: 'Light Mounting',
        categoryId: 'MAINTENANCE',
        quadrant: 'Q1_DO_FIRST' as const,
        majorOrMinor: 'MAJOR' as const,
        taskFrequency: 'ONE_TIME' as const,
        recurrenceRule: 'NONE' as const,
        raci: { R: '919876500002', A: '919876500003', C: [], I: [] },
        dependsOnTempIdOrTaskCode: 't1',
        triggerCondition: 'FULL_COMPLETION' as const,
        startDate: '2026-11-05',
        durationDays: 1,
        dueDate: '2026-11-05',
        isForcedDeadline: false,
        forcedDeadlineDate: null,
        wbsHeadId: 'HEAD-TEST',
        swimlaneStage: 'Mounting',
        microSteps: ['Mount lights'],
        outboundWhatsappPreview: 'Mount lights',
      },
    ],
  };

  const recalculated = recalculateWbsHeadDates(head);
  assert.equal(recalculated.isForcedDeadline, true);
  assert.equal(recalculated.tentativeDeadline, '2026-11-05');
  // Task 2 ends on tentativeDeadline
  assert.equal(recalculated.subTasks[1].dueDate, '2026-11-05');
  assert.equal(recalculated.subTasks[1].startDate, '2026-11-05');
  // Task 1 back-calculated to end before Task 2 starts
  assert.equal(recalculated.subTasks[0].dueDate, '2026-11-04');
  assert.equal(recalculated.subTasks[0].startDate, '2026-11-04');
  assert.equal(recalculated.tentativeStartDate, '2026-11-04');
});

test('cascadeTaskSchedule automatically shifts downstream dependent tasks forward', () => {
  const seed = createInitialSeedState('2026-11-03T10:00:00.000Z');
  // T-102 depends on T-101.
  // Move T-101 to start on 2026-11-06 with duration 2 days (dueDate 2026-11-07)
  const res = cascadeTaskSchedule(seed.tasks, 'T-101', '2026-11-06', 2);
  assert.ok(res.cascadedCount >= 1, 'T-102 should be cascaded forward');
  const t102 = res.updatedTasks.find((t) => t.taskCode === 'T-102')!;
  // T-102 min start is 2026-11-08 (day after T-101 dueDate 2026-11-07)
  assert.equal(t102.startDate, '2026-11-08');
  assert.equal(t102.dueDate, '2026-11-08');
});

test('Outbound WhatsApp notifications use human-readable shortTag rather than raw ticket codes', () => {
  const seed = createInitialSeedState('2026-11-03T10:00:00.000Z');

  // Test 1: sendInstantNudge uses shortTag
  const nudgedState = sendInstantNudge(seed, 'T-101', '2026-11-03T10:05:00.000Z');
  const nudgeMsg = nudgedState.whatsapp_messages[nudgedState.whatsapp_messages.length - 1];
  assert.ok(nudgeMsg.text.includes('[Lawn Floodlights]'), `Expected nudge message to contain shortTag: ${nudgeMsg.text}`);
  assert.ok(!nudgeMsg.text.includes('[T-101]'), `Nudge message should not contain raw [T-101]: ${nudgeMsg.text}`);

  // Test 2: forceUnlockTask uses shortTag
  const unlockedState = forceUnlockTask(seed, 'T-102', 'Boss authorized manual start', '2026-11-03T10:06:00.000Z');
  const unlockMsg = unlockedState.whatsapp_messages[unlockedState.whatsapp_messages.length - 1];
  assert.ok(unlockMsg.text.includes('[Floodlight Mounting]'), `Expected unlock message to contain shortTag: ${unlockMsg.text}`);
  assert.ok(!unlockMsg.text.includes('[T-102]'), `Unlock message should not contain raw [T-102]: ${unlockMsg.text}`);

  // Test 3: resolveBossReviewItem uses shortTag
  const resolvedState = resolveBossReviewItem(
    seed,
    seed.boss_review_queue[0].reviewId,
    'Chalo allow kiya GST bill shaam tak aayega',
    true,
    '2026-11-03T10:07:00.000Z'
  );
  const resolveMsg = resolvedState.whatsapp_messages[resolvedState.whatsapp_messages.length - 1];
  assert.ok(resolveMsg.text.includes('[Cable Bill UTR]'), `Expected resolve review message to contain shortTag: ${resolveMsg.text}`);
  assert.ok(!resolveMsg.text.includes('[T-104]'), `Resolve review message should not contain raw [T-104]: ${resolveMsg.text}`);
});


