import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessReplyScheduleRisk,
  describeTaskTiming,
  formatDueLabel,
  formatDueShort,
  formatDuration,
  formatNowForPrompt,
  getTaskDueInstantMs,
  isTaskBehind,
  normalizeDueTime,
  parseDueTimeFromText,
  timingLabel,
} from './taskTiming';
import { buildAnonymizedBufferPrompt } from './promptBuilder';
import { applyProcessedBufferResult } from './opsEngine';
import { createDemoSeedState } from './demoData';
import { buildTeamGraph, teamStatusLabel } from './teamGraph';
import { buildMyTasks, describeFollowUpReason } from './myTasks';
import { normalizeMeditatePlanDates } from './planDates';
import type { Task } from '../types/ops';

const TZ = 'Asia/Kolkata';
// 2026-11-19 14:09 in India (UTC+5:30)
const AT_1409_IST = '2026-11-19T08:39:00.000Z';
const AT_0930_IST = '2026-11-19T04:00:00.000Z';

test('parseDueTimeFromText: English 12-hour, 24-hour, noon and Hinglish "baje"', () => {
  assert.equal(parseDueTimeFromText('Deliver 40 jars before 11 AM'), '11:00');
  assert.equal(parseDueTimeFromText('by 5:30 pm'), '17:30');
  assert.equal(parseDueTimeFromText('before 12 pm'), '12:00');
  assert.equal(parseDueTimeFromText('12 am'), '00:00');
  assert.equal(parseDueTimeFromText('3p.m.'), '15:00');
  assert.equal(parseDueTimeFromText('cutoff 17:00 sharp'), '17:00');
  assert.equal(parseDueTimeFromText('before noon'), '12:00');
  assert.equal(parseDueTimeFromText('11 baje se pehle'), '11:00');
  assert.equal(parseDueTimeFromText('4 baje tak'), '16:00');
  assert.equal(parseDueTimeFromText('subah 6 baje'), '06:00');
  assert.equal(parseDueTimeFromText('shaam 7 baje'), '19:00');
  assert.equal(parseDueTimeFromText('raat 12 baje'), '23:59');
});

test('parseDueTimeFromText: no time written gives null (never guesses)', () => {
  assert.equal(parseDueTimeFromText('Deliver 40 jars tomorrow'), null);
  assert.equal(parseDueTimeFromText('300 chairs for the lawn'), null);
  assert.equal(parseDueTimeFromText('2026-11-19'), null);
  assert.equal(parseDueTimeFromText('in the morning'), null);
  assert.equal(parseDueTimeFromText(''), null);
  assert.equal(parseDueTimeFromText(undefined), null);
  assert.equal(parseDueTimeFromText('25:00'), null);
});

test('normalizeDueTime keeps only valid HH:mm and pads single-digit hours', () => {
  assert.equal(normalizeDueTime('9:30'), '09:30');
  assert.equal(normalizeDueTime('23:59'), '23:59');
  assert.equal(normalizeDueTime('24:00'), null);
  assert.equal(normalizeDueTime('11 AM'), null);
  assert.equal(normalizeDueTime(null), null);
});

test('getTaskDueInstantMs: due time in the business timezone; end of day without one', () => {
  assert.equal(
    getTaskDueInstantMs({ dueDate: '2026-11-19', dueTime: '11:00' }, TZ),
    Date.parse('2026-11-19T05:30:00.000Z')
  );
  assert.equal(
    getTaskDueInstantMs({ dueDate: '2026-11-19' }, TZ),
    Date.parse('2026-11-19T18:29:00.000Z')
  );
  assert.equal(getTaskDueInstantMs({ dueDate: 'tomorrow' }, TZ), null);
});

test('describeTaskTiming + timingLabel: late, due soon, on time, no due date', () => {
  const now = Date.parse(AT_1409_IST);
  const late = describeTaskTiming({ dueDate: '2026-11-19', dueTime: '11:00' }, now, TZ);
  assert.equal(late.state, 'LATE');
  assert.equal(late.minutesLate, 189);
  assert.equal(timingLabel(late), 'Late by 3h 9m');

  const soon = describeTaskTiming({ dueDate: '2026-11-19', dueTime: '14:30' }, now, TZ);
  assert.equal(soon.state, 'DUE_SOON');
  assert.equal(timingLabel(soon), 'Due in 21m');

  const later = describeTaskTiming({ dueDate: '2026-11-19' }, now, TZ);
  assert.equal(later.state, 'ON_TIME');
  assert.equal(later.hasDueTime, false);

  assert.equal(describeTaskTiming({ dueDate: '' }, now, TZ).state, 'NO_DUE');
  assert.equal(timingLabel(describeTaskTiming({ dueDate: '' }, now, TZ)), '');
});

test('formatDuration, formatDueLabel, formatDueShort, formatNowForPrompt', () => {
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(189), '3h 9m');
  assert.equal(formatDuration(120), '2h');
  assert.equal(formatDuration(60 * 24 * 2 + 240), '2d 4h');
  assert.equal(formatDueLabel({ dueDate: '2026-11-19', dueTime: '11:00' }), '2026-11-19 11:00');
  assert.equal(formatDueLabel({ dueDate: '2026-11-19' }), '2026-11-19');
  assert.equal(formatDueShort({ dueDate: '2026-11-19', dueTime: '11:00' }), '19 Nov, 11:00');
  assert.equal(formatDueShort({ dueDate: '2026-11-19' }), '19 Nov');
  assert.equal(formatNowForPrompt(Date.parse(AT_1409_IST), TZ), '2026-11-19 14:09 (Asia/Kolkata)');
});

function liveTask(over: Partial<Task> = {}): Task {
  return {
    taskCode: 'T-1',
    shortTag: 'Tag',
    agendaId: null,
    title: 'Task',
    categoryId: 'GENERAL',
    quadrant: 'Q1_DO_FIRST',
    majorOrMinor: 'MAJOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    isFrozen: true,
    raci: { R: '1', A: '2', C: [], I: [] },
    status: 'IN_PROGRESS',
    completionPercent: 50,
    microSteps: [],
    missingStepsAlert: '',
    dependency: { dependsOnTaskCode: null, triggerCondition: 'FULL_COMPLETION' } as Task['dependency'],
    reminderConfig: {} as Task['reminderConfig'],
    startDate: '2026-11-19',
    durationDays: 1,
    dueDate: '2026-11-19',
    dueTime: '11:00',
    isForcedDeadline: false,
    forcedDeadlineDate: null,
    outboundWhatsappPreview: '',
    latestAiSummary: '',
    auditLogs: [],
    ...over,
  };
}

test('isTaskBehind: open and late, or flagged; never for drafts, closed or archived tasks', () => {
  const now = Date.parse(AT_1409_IST);
  assert.equal(isTaskBehind(liveTask(), now, TZ), true);
  assert.equal(isTaskBehind(liveTask({ dueTime: '18:00' }), now, TZ), false);
  assert.equal(
    isTaskBehind(liveTask({ dueTime: '18:00', scheduleRisk: { reason: 'x', flaggedAt: AT_1409_IST } }), now, TZ),
    true
  );
  assert.equal(isTaskBehind(liveTask({ status: 'COMPLETED' }), now, TZ), false);
  assert.equal(isTaskBehind(liveTask({ status: 'STAGING_DRAFT', isFrozen: false }), now, TZ), false);
  assert.equal(isTaskBehind(liveTask({ archivedAt: AT_1409_IST }), now, TZ), false);
});

test('assessReplyScheduleRisk: code decides late from the clock; AI only reports a delay', () => {
  const task = { dueDate: '2026-11-19', dueTime: '11:00' };
  const late = assessReplyScheduleRisk({
    task,
    allDone: false,
    delayReported: false,
    nowMs: Date.parse(AT_1409_IST),
    timezone: TZ,
  });
  assert.ok(late);
  assert.match(late!.reason, /Past the deadline \(2026-11-19 11:00\) by 3h 9m/);
  assert.match(late!.reason, /No finish time given yet/);

  const early = assessReplyScheduleRisk({
    task,
    allDone: false,
    delayReported: true,
    reportedEta: '10:45 tak',
    nowMs: Date.parse(AT_0930_IST),
    timezone: TZ,
  });
  assert.match(early!.reason, /will finish later\. Expected finish: 10:45 tak\./);
  assert.equal(early!.reportedEta, '10:45 tak');

  assert.equal(
    assessReplyScheduleRisk({ task, allDone: false, delayReported: false, nowMs: Date.parse(AT_0930_IST), timezone: TZ }),
    null
  );
  assert.equal(
    assessReplyScheduleRisk({ task, allDone: true, delayReported: true, nowMs: Date.parse(AT_1409_IST), timezone: TZ }),
    null
  );
});

test('reply prompt: current time, each task due time and a code-computed "Late by" label', () => {
  const state = createDemoSeedState(AT_1409_IST);
  const nitin = state.team_members['919820100006'];
  const active = state.tasks.filter((t) => t.raci.R === nitin.phone && t.status === 'IN_PROGRESS');
  const built = buildAnonymizedBufferPrompt({
    employee: nitin,
    teamMembers: Object.values(state.team_members),
    buffer: state.inbound_message_buffer[nitin.phone],
    activeTasks: active,
    systemMemory: state.system_memory,
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
    nowIso: AT_1409_IST,
  });
  assert.match(built.textPart, /CURRENT TIME: 2026-11-19 14:09 \(Asia\/Kolkata\)/);
  assert.match(built.textPart, /"due": "2026-11-19 11:00"/);
  assert.match(built.textPart, /"timing": "Late by 3h 9m"/);
  assert.match(built.systemInstruction, /delayReported/);
  assert.match(built.systemInstruction, /Never ask for proof or details that belong to a different task/);
  assert.equal(built.piiAudit.clean, true);
});

test('demo: Nitin\'s "remaining 20 in second trip" at 14:09 flags the 11 AM delivery behind; Team chart shows it', () => {
  const state = createDemoSeedState(AT_1409_IST);
  const nitin = '919820100006';
  const next = applyProcessedBufferResult(
    state,
    nitin,
    {
      matchedTaskCode: 'T-201',
      englishBossSummary: 'First 20 jars left; remaining 20 on a second trip.',
      mediaVerificationNote: '',
      updatedMicroSteps: [],
      completionPercent: 50,
      missingStepsAlert: '',
      whatsappReplyInPreferredLanguage: 'Nitin bhai, baaki 20 jars kitne baje tak pahunchenge?',
      escalateToBossReview: false,
      delayReported: true,
      reportedEta: null,
    },
    AT_1409_IST
  );
  const t201 = next.tasks.find((t) => t.taskCode === 'T-201')!;
  assert.ok(t201.scheduleRisk, 'scheduleRisk should be set');
  assert.match(t201.scheduleRisk!.reason, /Past the deadline \(.* 11:00\) by 3h 9m/);
  assert.match(t201.auditLogs.at(-1)!.aiDecision || '', /Behind:/);

  const graph = buildTeamGraph(
    Object.values(next.team_members),
    next.category_sops,
    next.tasks,
    t201.dueDate,
    { nowMs: Date.parse(AT_1409_IST), timezone: TZ }
  );
  const node = graph.nodes.find((n) => n.phone === nitin)!;
  assert.equal(node.behind >= 1, true);
  assert.equal(teamStatusLabel(node).tone, 'danger');
  assert.match(teamStatusLabel(node).text, /behind|overdue/);
});

test('teamStatusLabel: leave, overdue, behind, on track', () => {
  assert.deepEqual(teamStatusLabel({ isOnLeave: true, overdue: 2, behind: 2 }), { text: 'On leave', tone: 'leave' });
  assert.deepEqual(teamStatusLabel({ isOnLeave: false, overdue: 1, behind: 1 }), { text: '1 overdue', tone: 'danger' });
  assert.deepEqual(teamStatusLabel({ isOnLeave: false, overdue: 0, behind: 2 }), { text: '2 behind', tone: 'danger' });
  assert.deepEqual(teamStatusLabel({ isOnLeave: false, overdue: 0, behind: 0 }), { text: 'On track', tone: 'ok' });
});

test('My tasks follow-up: a delegated task late by the hour shows BEHIND with "Late by"', () => {
  const owner = '1';
  const staff = '2';
  const base = createDemoSeedState(AT_1409_IST);
  const memberOf = (phone: string, level: 'OWNER' | 'STAFF') => ({
    ...Object.values(base.team_members)[0],
    phone,
    name: level === 'OWNER' ? 'Owner' : 'Staff',
    authorityLevel: level,
  });
  const summary = buildMyTasks(
    {
      tasks: [liveTask({ raci: { R: staff, A: owner, C: [], I: [] }, lastOutboundAt: AT_1409_IST })],
      team_members: { [owner]: memberOf(owner, 'OWNER'), [staff]: memberOf(staff, 'STAFF') },
      boss_review_queue: [],
      whatsapp_messages: [],
      owner_profile: base.owner_profile,
    },
    { nowIso: AT_1409_IST, todayStr: '2026-11-19', timezone: TZ }
  );
  assert.equal(summary.followUp.length, 1);
  assert.deepEqual(summary.followUp[0].reasons, ['BEHIND']);
  assert.equal(describeFollowUpReason('BEHIND', summary.followUp[0]), 'Late by 3h 9m');
});

test('normalizeMeditatePlanDates reads the time of day from dueHint or the title', () => {
  const plan = normalizeMeditatePlanDates<{ draftedTasks: Array<Record<string, unknown>> }>(
    {
      draftedTasks: [
        { title: 'Deliver 40 jars before 11 AM', dueHint: 'today' },
        { title: 'Set up the lawn', dueHint: 'today 6 pm' },
        { title: 'Check diesel', dueHint: 'tomorrow' },
        { title: 'Valid AI time', dueTime: '9:15' },
      ],
    },
    { timezone: TZ, now: new Date(AT_0930_IST) }
  );
  assert.deepEqual(
    plan.draftedTasks.map((t) => t.dueTime),
    ['11:00', '18:00', null, '09:15']
  );
});
