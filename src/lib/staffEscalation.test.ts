import test from 'node:test';
import assert from 'node:assert/strict';
import { BANQUET_DEMO_PHONES, createBanquetDemoSeedState } from './demoBanquet';
import { applyProcessedBufferResult } from './opsEngine';
import { sendBehindAlerts } from './behindAlerts';
import { buildMyTasks } from './myTasks';
import { buildAnonymizedBufferPrompt, deanonymizeBufferResponse, buildSlotDirectory } from './promptBuilder';
import { hasDevanagariScript } from './staffEscalation';
import type { BufferProcessAiResponse, OpsDatabaseState, Task } from '../types/ops';

const NOW = '2026-11-20T06:30:00.000Z'; // 12:00 IST
const { OWNER, POOJA, GOPAL, RAMESH, MAHESH } = BANQUET_DEMO_PHONES;

function withUrgentWashroomTask(
  base: OpsDatabaseState,
  overrides: Partial<Task> = {}
): { state: OpsDatabaseState; taskCode: string } {
  const taskCode = overrides.taskCode || 'T-WASH-1';
  const task: Task = {
    tenantId: base.tenantId,
    taskCode,
    shortTag: 'Banquet Washroom',
    agendaId: null,
    title: 'Check banquet washroom before tomorrow event',
    categoryId: base.category_sops[0].categoryId,
    quadrant: 'Q1_DO_FIRST',
    majorOrMinor: 'MAJOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    raci: { R: GOPAL, A: OWNER, C: [], I: [] },
    dependency: { dependsOnTaskCode: null, triggerCondition: 'FULL_COMPLETION' },
    startDate: '2026-11-20',
    durationDays: 1,
    dueDate: '2026-11-21',
    dueTime: '10:00',
    isForcedDeadline: true,
    forcedDeadlineDate: '2026-11-21',
    isFrozen: true,
    status: 'IN_PROGRESS',
    completionPercent: 0,
    microSteps: [
      { id: 's1', label: 'Inspect taps and flush', status: 'PENDING' },
      { id: 's2', label: 'Send washroom photo', status: 'PENDING', photoMustShow: 'clean washroom' },
    ],
    missingStepsAlert: '',
    latestAiSummary: '',
    outboundWhatsappPreview: 'Check banquet washroom before tomorrow event.',
    lastOutboundAt: '2026-11-20T04:30:00.000Z',
    reminderConfig: { includeInDailyOverview: true, customIntervalHours: null, lastNudgedAt: null, nudgeCount: 0 },
    auditLogs: [],
    ...overrides,
  };
  return {
    taskCode,
    state: {
      ...base,
      tasks: [task, ...base.tasks],
    },
  };
}

function withBufferedText(
  state: OpsDatabaseState,
  phone: string,
  textContent: string,
  extra: Partial<OpsDatabaseState['inbound_message_buffer'][string]['messages'][number]> = {}
): OpsDatabaseState {
  return {
    ...state,
    inbound_message_buffer: {
      ...state.inbound_message_buffer,
      [phone]: {
        tenantId: state.tenantId,
        employeePhone: phone,
        bufferMode: 'STANDARD_15_MIN',
        firstMessageAt: NOW,
        processAt: NOW,
        messages: [
          {
            id: `m-${Date.now()}-${Math.random()}`,
            timestamp: NOW,
            type: 'text',
            textContent,
            ...extra,
          },
        ],
      },
    },
  };
}

function baseAiReply(
  taskCode: string,
  overrides: Partial<BufferProcessAiResponse> = {}
): BufferProcessAiResponse {
  return {
    matchedTaskCode: taskCode,
    englishBossSummary: 'Staff replied on task.',
    mediaVerificationNote: 'No media.',
    updatedMicroSteps: [],
    completionPercent: 0,
    missingStepsAlert: '',
    whatsappReplyInPreferredLanguage: 'Theek hai ji, baad mein dekhte hain.',
    escalateToBossReview: false,
    delayReported: false,
    ...overrides,
  };
}

test('1. Staff replies "I\'m on leave, can\'t do it" -> escalates to manager/owner; staff told owner is informed', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base);
  const buffered = withBufferedText(state, GOPAL, "I'm on leave, can't do it");

  const next = applyProcessedBufferResult(
    buffered,
    GOPAL,
    baseAiReply(taskCode, { whatsappReplyInPreferredLanguage: 'theek hai ji, baad mein dekhte hain' }),
    NOW
  );

  const task = next.tasks.find((t) => t.taskCode === taskCode)!;
  assert.equal(task.status, 'AWAITING_BOSS_DECISION');
  assert.ok(task.scheduleRisk);
  const review = next.boss_review_queue.find((r) => r.taskCode === taskCode && r.status === 'OPEN');
  assert.ok(review);
  assert.equal(review!.trigger, 'ON_LEAVE');
  assert.equal(review!.routedToPhone, OWNER);

  const gopalOutbound = next.whatsapp_messages.filter(
    (m) => m.employeePhone === GOPAL && m.direction === 'OUTBOUND' && m.taskCode === taskCode
  );
  assert.ok(gopalOutbound.length >= 1);
  assert.match(gopalOutbound.at(-1)!.text, /बता दिया गया|inform/i);
});

test('2. Staff replies "I\'ll do it in 2 days" when deadline is tomorrow -> escalates (timeline slip past deadline)', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base);
  const buffered = withBufferedText(state, GOPAL, "I'll do it in 2 days");

  const next = applyProcessedBufferResult(
    buffered,
    GOPAL,
    baseAiReply(taskCode, { reportedEta: 'in 2 days', delayReported: false }),
    NOW
  );

  const task = next.tasks.find((t) => t.taskCode === taskCode)!;
  assert.equal(task.status, 'AWAITING_BOSS_DECISION');
  const review = next.boss_review_queue.find((r) => r.taskCode === taskCode && r.status === 'OPEN');
  assert.equal(review?.trigger, 'TIMELINE_SLIP');
});

test('3. Staff replies "this is not my work / give it to someone else" -> escalates (reassignment)', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base);
  const buffered = withBufferedText(state, GOPAL, 'this is not my work, give it to someone else');

  const next = applyProcessedBufferResult(buffered, GOPAL, baseAiReply(taskCode), NOW);
  const review = next.boss_review_queue.find((r) => r.taskCode === taskCode && r.status === 'OPEN');
  assert.equal(review?.trigger, 'REASSIGNMENT');
  assert.equal(next.tasks.find((t) => t.taskCode === taskCode)!.status, 'AWAITING_BOSS_DECISION');
});

test('4. Staff replies "I can\'t, no material / generator is broken" -> escalates (blocker)', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base);
  const buffered = withBufferedText(state, GOPAL, "I can't, no material and generator is broken");

  const next = applyProcessedBufferResult(buffered, GOPAL, baseAiReply(taskCode), NOW);
  const review = next.boss_review_queue.find((r) => r.taskCode === taskCode && r.status === 'OPEN');
  assert.equal(review?.trigger, 'BLOCKER');
});

test('5. Staff replies "I have too many tasks" -> escalates (capacity)', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base);
  const buffered = withBufferedText(state, GOPAL, 'I have too many tasks right now');

  const next = applyProcessedBufferResult(buffered, GOPAL, baseAiReply(taskCode), NOW);
  const review = next.boss_review_queue.find((r) => r.taskCode === taskCode && r.status === 'OPEN');
  assert.equal(review?.trigger, 'CAPACITY');
});

test('6. Sent urgent task, no reply by behind-threshold before deadline -> escalates (no response)', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base, {
    dueDate: '2026-11-20',
    dueTime: '13:00', // 60 mins after NOW (12:00 IST) -> within 120m threshold
    status: 'PENDING',
    lastOutboundAt: '2026-11-20T04:00:00.000Z',
  });

  const { nextState, alertedTaskCodes } = sendBehindAlerts(state, NOW, { onlyTaskCodes: [taskCode] });
  assert.deepEqual(alertedTaskCodes, [taskCode]);
  const review = nextState.boss_review_queue.find((r) => r.taskCode === taskCode && r.status === 'OPEN');
  assert.ok(review);
  assert.equal(review!.trigger, 'NO_RESPONSE');
  assert.ok(nextState.whatsapp_messages.some((m) => m.tag === 'BEHIND_ALERT' && m.taskCode === taskCode && m.employeePhone === OWNER));
});

test('7. Staff still confused after one clarifying answer -> escalates (confusion)', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base);
  const withPriorClarification: OpsDatabaseState = {
    ...state,
    whatsapp_messages: [
      ...state.whatsapp_messages,
      {
        id: 'prior-clarify-1',
        employeePhone: GOPAL,
        direction: 'OUTBOUND',
        timestamp: '2026-11-20T05:00:00.000Z',
        tag: 'AI_CONFIRMATION',
        taskCode,
        text: 'लॉन 2 का मुख्य वॉशरूम चेक करना है।',
      },
    ],
  };
  const buffered = withBufferedText(withPriorClarification, GOPAL, 'Still confused, samajh nahi aaya kya karna hai');

  const next = applyProcessedBufferResult(buffered, GOPAL, baseAiReply(taskCode), NOW);
  const review = next.boss_review_queue.find((r) => r.taskCode === taskCode && r.status === 'OPEN');
  assert.equal(review?.trigger, 'CONFUSION');
});

test('8. Escalation routes to RESPONSIBLE person\'s manager if one exists, else OWNER', () => {
  const base = createBanquetDemoSeedState(NOW);
  // Shape A: Ramesh reports to Pooja (Manager)
  const rameshTaskState = withUrgentWashroomTask(base, {
    taskCode: 'T-MGR-1',
    raci: { R: RAMESH, A: '', C: [], I: [] },
  });
  const bufA = withBufferedText(rameshTaskState.state, RAMESH, 'Main chutti pe hun, nahi ho payega');
  const outA = applyProcessedBufferResult(bufA, RAMESH, baseAiReply('T-MGR-1'), NOW);
  const revA = outA.boss_review_queue.find((r) => r.taskCode === 'T-MGR-1');
  assert.equal(revA?.routedToPhone, POOJA);
  assert.ok(
    outA.whatsapp_messages.some(
      (m) => m.taskCode === 'T-MGR-1' && m.employeePhone === POOJA && (m.tag === 'OWNER_DECISION_PROMPT' || m.tag === 'BEHIND_ALERT')
    )
  );

  // Shape B: Gopal reports to OWNER (Harsh Bhandari)
  const gopalTaskState = withUrgentWashroomTask(base, {
    taskCode: 'T-OWN-1',
    raci: { R: GOPAL, A: '', C: [], I: [] },
  });
  const bufB = withBufferedText(gopalTaskState.state, GOPAL, 'Main chutti pe hun, nahi ho payega');
  const outB = applyProcessedBufferResult(bufB, GOPAL, baseAiReply('T-OWN-1'), NOW);
  const revB = outB.boss_review_queue.find((r) => r.taskCode === 'T-OWN-1');
  assert.equal(revB?.routedToPhone, OWNER);
  assert.ok(
    outB.whatsapp_messages.some(
      (m) => m.taskCode === 'T-OWN-1' && m.employeePhone === OWNER && (m.tag === 'OWNER_DECISION_PROMPT' || m.tag === 'BEHIND_ALERT')
    )
  );
});

test('9. Owner sees escalation in My Tasks (Decide + Follow up) AND gets a WhatsApp alert; no duplicates on repeat', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base);
  const buf1 = withBufferedText(state, GOPAL, 'ok 2 din baad kar dunga');
  const step1 = applyProcessedBufferResult(buf1, GOPAL, baseAiReply(taskCode), NOW);

  const myTasks = buildMyTasks(step1, {
    nowIso: NOW,
    todayStr: '2026-11-20',
    timezone: step1.business_profile.timezone,
  });
  assert.ok(myTasks.decide.some((d) => d.review.taskCode === taskCode));
  assert.ok(myTasks.followUp.some((f) => f.task.taskCode === taskCode));
  assert.ok(step1.whatsapp_messages.some((m) => m.employeePhone === OWNER && m.taskCode === taskCode && m.tag === 'OWNER_DECISION_PROMPT'));

  // Second message on same open issue updates existing review instead of duplicating
  const buf2 = withBufferedText(step1, GOPAL, 'main abhi chutti pe hun, nahi ho payega');
  const step2 = applyProcessedBufferResult(buf2, GOPAL, baseAiReply(taskCode), NOW);
  const openForTask = step2.boss_review_queue.filter((r) => r.taskCode === taskCode && r.status === 'OPEN');
  assert.equal(openForTask.length, 1);
  assert.equal(openForTask[0].trigger, 'ON_LEAVE');
  assert.equal(step2.whatsapp_messages.filter((m) => m.tag === 'BEHIND_ALERT' && m.taskCode === taskCode).length, 1);
});

test('10. Non-urgent task, deadline in 2 weeks, staff says "I\'ll do it in 2 days" -> logged, NOT a full escalation', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base, {
    quadrant: 'Q2_SCHEDULE',
    dueDate: '2026-12-04',
    dueTime: '18:00',
    isForcedDeadline: false,
    forcedDeadlineDate: null,
  });
  const buf = withBufferedText(state, GOPAL, "I'll do it in 2 days");
  const next = applyProcessedBufferResult(
    buf,
    GOPAL,
    baseAiReply(taskCode, { delayReported: true, reportedEta: 'in 2 days' }),
    NOW
  );
  assert.equal(next.boss_review_queue.some((r) => r.taskCode === taskCode && r.status === 'OPEN'), false);
  assert.notEqual(next.tasks.find((t) => t.taskCode === taskCode)!.status, 'AWAITING_BOSS_DECISION');
});

test('11. Staff replies "done" with required photo -> task completes normally, no escalation', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base);
  const buf = withBufferedText(state, GOPAL, 'done', {
    type: 'image',
    fileName: 'washroom.jpg',
    base64Data: 'data:image/jpeg;base64,AAA',
  });
  const next = applyProcessedBufferResult(
    buf,
    GOPAL,
    baseAiReply(taskCode, {
      completionPercent: 100,
      updatedMicroSteps: [
        { id: 's1', status: 'DONE' },
        { id: 's2', status: 'DONE', photoShows: true },
      ],
      whatsappReplyInPreferredLanguage: 'बहुत बढ़िया गोपाल जी, काम पूरा हो गया।',
    }),
    NOW
  );
  assert.equal(next.tasks.find((t) => t.taskCode === taskCode)!.status, 'COMPLETED');
  assert.equal(next.boss_review_queue.some((r) => r.taskCode === taskCode && r.status === 'OPEN'), false);
});

test('12. Staff asks one normal clarifying question and then proceeds -> no escalation', () => {
  const base = createBanquetDemoSeedState(NOW);
  const { state, taskCode } = withUrgentWashroomTask(base);
  const buf = withBufferedText(state, GOPAL, 'Lawn 1 ya Lawn 2 ka washroom check karna hai?');
  const next = applyProcessedBufferResult(
    buf,
    GOPAL,
    baseAiReply(taskCode, {
      completionPercent: 10,
      whatsappReplyInPreferredLanguage: 'गोपाल जी, लॉन 2 का मुख्य वॉशरूम चेक करना है।',
    }),
    NOW
  );
  assert.equal(next.boss_review_queue.some((r) => r.taskCode === taskCode && r.status === 'OPEN'), false);
  assert.equal(next.tasks.find((t) => t.taskCode === taskCode)!.status, 'IN_PROGRESS');
});

test('13 & 14 & 15. Language & script consistency: Hinglish stays Roman, Hindi stays Devanagari, Owner alert uses Owner language', () => {
  const base = createBanquetDemoSeedState(NOW);
  // Make Gopal HINGLISH (Roman) in one test and Mahesh HINDI (Devanagari) in another, Owner ENGLISH
  const customMembers = {
    ...base.team_members,
    [OWNER]: { ...base.team_members[OWNER], preferredLanguage: 'ENGLISH' as const },
    [GOPAL]: { ...base.team_members[GOPAL], preferredLanguage: 'HINGLISH' as const },
    [MAHESH]: { ...base.team_members[MAHESH], preferredLanguage: 'HINDI' as const },
  };
  const customBase: OpsDatabaseState = { ...base, team_members: customMembers };

  // 13. Hinglish (Roman) person: even if AI returns Devanagari, code forces Roman Hinglish across turns + escalation
  const { state: s1, taskCode: tc1 } = withUrgentWashroomTask(customBase, { taskCode: 'T-ROM-1' });
  const buf1 = withBufferedText(s1, GOPAL, 'ok 2 din baad kar dunga');
  const turn1 = applyProcessedBufferResult(
    buf1,
    GOPAL,
    baseAiReply(tc1, { whatsappReplyInPreferredLanguage: 'ठीक है जी, मैंने मालिक को बता दिया है।' }),
    NOW
  );
  const buf2 = withBufferedText(turn1, GOPAL, 'main abhi chutti pe hun, nahi ho payega');
  const turn2 = applyProcessedBufferResult(
    buf2,
    GOPAL,
    baseAiReply(tc1, { whatsappReplyInPreferredLanguage: 'ठीक है गोपाल जी, मालिक को बता दिया।' }),
    NOW
  );
  const gopalMsgs = turn2.whatsapp_messages.filter((m) => m.employeePhone === GOPAL && m.direction === 'OUTBOUND' && m.taskCode === tc1);
  assert.ok(gopalMsgs.length >= 2);
  for (const m of gopalMsgs) {
    assert.equal(hasDevanagariScript(m.text), false, `Expected Roman Hinglish only, got: ${m.text}`);
  }

  // 14. Devanagari-preference person: even if AI drifts to Roman, code forces Devanagari
  const { state: s2, taskCode: tc2 } = withUrgentWashroomTask(customBase, {
    taskCode: 'T-DEV-1',
    raci: { R: MAHESH, A: OWNER, C: [], I: [] },
  });
  const bufDev = withBufferedText(s2, MAHESH, 'nahi ho payega, chutti pe hun');
  const turnDev = applyProcessedBufferResult(
    bufDev,
    MAHESH,
    baseAiReply(tc2, { whatsappReplyInPreferredLanguage: 'Theek hai Mahesh ji, owner ko bata diya hai.' }),
    NOW
  );
  const maheshReply = turnDev.whatsapp_messages.filter((m) => m.employeePhone === MAHESH && m.direction === 'OUTBOUND' && m.taskCode === tc2).at(-1)!;
  assert.equal(hasDevanagariScript(maheshReply.text), true, `Expected Devanagari Hindi, got: ${maheshReply.text}`);

  // 15. Owner escalation alert is in Owner's language (ENGLISH), independent of Mahesh's HINDI
  const ownerPrompt = turnDev.whatsapp_messages.find(
    (m) => m.employeePhone === OWNER && m.taskCode === tc2 && m.tag === 'OWNER_DECISION_PROMPT'
  )!;
  assert.match(ownerPrompt.text, /Decision needed/);
  assert.equal(hasDevanagariScript(ownerPrompt.text), false);

  // Also verify prompt + deanonymizer enforce script and privacy
  const dir = buildSlotDirectory(Object.values(customMembers), customBase.owner_profile);
  const promptBuilt = buildAnonymizedBufferPrompt({
    employee: customMembers[GOPAL],
    teamMembers: Object.values(customMembers),
    buffer: buf1.inbound_message_buffer[GOPAL],
    activeTasks: s1.tasks,
    systemMemory: [],
  });
  assert.match(promptBuilt.systemInstruction, /Roman script ONLY/);
  const deanon = deanonymizeBufferResponse(
    { whatsappReplyInPreferredLanguage: 'ठीक है {{P3}} जी।' },
    dir,
    GOPAL
  );
  assert.equal(hasDevanagariScript(deanon.whatsappReplyInPreferredLanguage), false);
});
