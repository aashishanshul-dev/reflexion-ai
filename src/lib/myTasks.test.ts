import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMyTasks,
  buildOwnerDigestText,
  describeFollowUpReason,
  getLastProgressAt,
  getOwnerPhones,
} from './myTasks';
import { BossReviewItem, OpsDatabaseState, Task, TeamMember } from '../types/ops';

function member(phone: string, name: string, authorityLevel: TeamMember['authorityLevel'], lang: TeamMember['preferredLanguage'] = 'ENGLISH'): TeamMember {
  return {
    tenantId: 'default',
    phone,
    slotId: `P${phone.slice(-1)}`,
    name,
    roleTitle: 'Role',
    authorityLevel,
    skills: [],
    maxActiveTasks: 3,
    preferredLanguage: lang,
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    dailyOverviewTime: '09:30',
    isOnLeave: false,
    lastInboundAt: '2026-11-03T04:00:00.000Z',
    lastDailyDigestDate: null,
    bufferMode: 'STANDARD_15_MIN',
    stats: { assigned: 0, completed: 0, partial: 0, overdueCount: 0, totalWorkHoursReplyMins: 0, replyCount: 0 },
    personaPrompt: '',
  };
}

const OWNER = '10000';
const STAFF = '10001';
const BOSS = '10009';
const team: Record<string, TeamMember> = {
  [OWNER]: member(OWNER, 'Owner Prime', 'OWNER'),
  [STAFF]: member(STAFF, 'Operator Alpha', 'STAFF'),
  [BOSS]: member(BOSS, 'Boss Second', 'BOSS'),
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    tenantId: 'default',
    taskCode: 'T-1',
    shortTag: 'Tag',
    agendaId: null,
    title: 'A task',
    categoryId: 'CAT',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    isFrozen: true,
    raci: { R: STAFF, A: OWNER, C: [], I: [] },
    status: 'PENDING',
    completionPercent: 0,
    microSteps: [],
    missingStepsAlert: '',
    dependency: { dependsOnTaskCode: null, triggerCondition: 'FULL_COMPLETION' },
    release: {
      mode: 'NOW',
      releaseAt: null,
      afterTaskCode: null,
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: false,
      releasedAt: '2026-11-03T04:00:00.000Z',
      holdReason: null,
    },
    reminderConfig: { includeInDailyOverview: true, customIntervalHours: null, lastNudgedAt: null, nudgeCount: 0 },
    startDate: '2026-11-03',
    durationDays: 1,
    dueDate: '2026-11-05',
    isForcedDeadline: false,
    forcedDeadlineDate: null,
    outboundWhatsappPreview: '',
    latestAiSummary: '',
    auditLogs: [],
    ...overrides,
  };
}

function review(overrides: Partial<BossReviewItem> = {}): BossReviewItem {
  return {
    tenantId: 'default',
    reviewId: 'R-1',
    taskCode: 'T-1',
    employeePhone: STAFF,
    reviewType: 'BUDGET_APPROVAL',
    employeeMessageSummary: 'Needs approval',
    mediaVerificationNote: '',
    aiSuggestedReplies: [],
    status: 'OPEN',
    createdAt: '2026-11-03T05:00:00.000Z',
    ...overrides,
  };
}

function state(overrides: Partial<OpsDatabaseState> = {}) {
  return {
    tasks: [],
    team_members: team,
    boss_review_queue: [],
    whatsapp_messages: [],
    owner_profile: { personalOperatingPrompt: '', defaultAccountablePhone: OWNER },
    ...overrides,
  } as Pick<OpsDatabaseState, 'tasks' | 'team_members' | 'boss_review_queue' | 'whatsapp_messages' | 'owner_profile'>;
}

// 2026-11-03 10:00 UTC; today in business time is 2026-11-03.
const NOW = { nowIso: '2026-11-03T10:00:00.000Z', todayStr: '2026-11-03' };

test('getOwnerPhones: only authority level OWNER', () => {
  assert.deepEqual(getOwnerPhones(team), [OWNER]);
  assert.deepEqual(getOwnerPhones(Object.values(team)), [OWNER]);
});

test('Do: open tasks where the owner is Responsible, including scheduled ones', () => {
  const s = state({
    tasks: [
      task({ taskCode: 'T-1', raci: { R: OWNER, A: OWNER, C: [], I: [] }, dueDate: '2026-11-06' }),
      task({ taskCode: 'T-2', raci: { R: OWNER, A: OWNER, C: [], I: [] }, status: 'SCHEDULED', dueDate: '2026-11-04' }),
      task({ taskCode: 'T-3', raci: { R: OWNER, A: OWNER, C: [], I: [] }, status: 'COMPLETED' }),
      task({ taskCode: 'T-4', raci: { R: OWNER, A: OWNER, C: [], I: [] }, status: 'CANCELLED' }),
      task({ taskCode: 'T-5', raci: { R: OWNER, A: OWNER, C: [], I: [] }, archivedAt: '2026-11-03T01:00:00.000Z', status: 'PENDING' }),
      task({ taskCode: 'T-6', raci: { R: OWNER, A: OWNER, C: [], I: [] }, status: 'STAGING_DRAFT' }),
      task({ taskCode: 'T-7', raci: { R: BOSS, A: OWNER, C: [], I: [] } }), // BOSS is not the owner
    ],
  });
  const res = buildMyTasks(s, NOW);
  assert.deepEqual(res.do.map((t) => t.taskCode), ['T-2', 'T-1']); // sorted by due date
  assert.equal(res.counts.do, 2);
});

test('Decide: open reviews on open tasks only, oldest first', () => {
  const s = state({
    tasks: [task({ taskCode: 'T-1', status: 'AWAITING_BOSS_DECISION' }), task({ taskCode: 'T-2', status: 'CANCELLED' })],
    boss_review_queue: [
      review({ reviewId: 'R-2', createdAt: '2026-11-03T06:00:00.000Z' }),
      review({ reviewId: 'R-1', createdAt: '2026-11-03T05:00:00.000Z' }),
      review({ reviewId: 'R-3', status: 'RESOLVED' }),
      review({ reviewId: 'R-4', taskCode: 'T-2' }),
    ],
  });
  const res = buildMyTasks(s, NOW);
  assert.deepEqual(res.decide.map((d) => d.review.reviewId), ['R-1', 'R-2']);
  assert.equal(res.decide[0].task?.taskCode, 'T-1');
});

test('Follow up: overdue, stuck, partly done and waiting for a decision', () => {
  const s = state({
    tasks: [
      task({ taskCode: 'T-OK', dueDate: '2026-11-05', release: { ...task().release!, releasedAt: '2026-11-03T09:00:00.000Z' } }),
      task({ taskCode: 'T-OVER', dueDate: '2026-11-01', release: { ...task().release!, releasedAt: '2026-11-03T09:00:00.000Z' } }),
      task({ taskCode: 'T-STUCK', release: { ...task().release!, releasedAt: '2026-11-02T09:00:00.000Z' } }), // 25 h
      task({ taskCode: 'T-PART', status: 'PARTIALLY_DONE', release: { ...task().release!, releasedAt: '2026-11-03T09:00:00.000Z' } }),
      task({ taskCode: 'T-WAIT', status: 'AWAITING_BOSS_DECISION', release: { ...task().release!, releasedAt: '2026-11-01T09:00:00.000Z' } }),
      task({ taskCode: 'T-MINE', raci: { R: OWNER, A: OWNER, C: [], I: [] }, dueDate: '2026-11-01' }), // owner's own -> Do
      task({ taskCode: 'T-OTHER', raci: { R: STAFF, A: BOSS, C: [], I: [] }, dueDate: '2026-11-01' }), // not owner-accountable
      task({ taskCode: 'T-SCHED', status: 'SCHEDULED', release: { ...task().release!, releasedAt: null } }), // not sent: never stuck
    ],
  });
  const res = buildMyTasks(s, NOW);
  const byCode = Object.fromEntries(res.followUp.map((f) => [f.task.taskCode, f]));
  assert.deepEqual(Object.keys(byCode).sort(), ['T-OVER', 'T-PART', 'T-STUCK', 'T-WAIT']);
  assert.deepEqual(byCode['T-OVER'].reasons, ['OVERDUE']);
  assert.equal(byCode['T-OVER'].overdueDays, 2);
  assert.deepEqual(byCode['T-STUCK'].reasons, ['STUCK']);
  assert.equal(byCode['T-STUCK'].hoursSinceUpdate, 25);
  assert.deepEqual(byCode['T-PART'].reasons, ['PARTIALLY_DONE']);
  assert.deepEqual(byCode['T-WAIT'].reasons, ['AWAITING_DECISION']); // not also STUCK while waiting on the owner
  assert.equal(res.followUp[0].task.taskCode, 'T-OVER'); // overdue first
  assert.equal(res.do.map((t) => t.taskCode).includes('T-MINE'), true);
  assert.equal(describeFollowUpReason('STUCK', byCode['T-STUCK']), 'No update for 25 h');
  assert.equal(describeFollowUpReason('OVERDUE', byCode['T-OVER']), 'Overdue 2 days');
});

test('Follow up: stuck-hours boundary, custom setting, and a reply restarts the clock', () => {
  const t = task({ taskCode: 'T-S', release: { ...task().release!, releasedAt: '2026-11-02T10:00:00.000Z' } }); // exactly 24 h
  assert.deepEqual(buildMyTasks(state({ tasks: [t] }), NOW).followUp.map((f) => f.reasons), [['STUCK']]);
  const at23 = { ...t, release: { ...t.release!, releasedAt: '2026-11-02T11:00:00.000Z' } };
  assert.equal(buildMyTasks(state({ tasks: [at23] }), NOW).followUp.length, 0);

  const custom = state({ tasks: [at23], owner_profile: { personalOperatingPrompt: '', defaultAccountablePhone: OWNER, followUpStuckHours: 8 } });
  assert.deepEqual(buildMyTasks(custom, NOW).followUp[0].reasons, ['STUCK']);

  const reply = {
    tenantId: 'default',
    id: 'in-1',
    employeePhone: STAFF,
    direction: 'INBOUND' as const,
    timestamp: '2026-11-03T08:00:00.000Z',
    taskCode: 'T-S',
    text: 'On it',
  };
  assert.equal(getLastProgressAt(t, [reply]), Date.parse(reply.timestamp));
  assert.equal(buildMyTasks(state({ tasks: [t], whatsapp_messages: [reply] }), NOW).followUp.length, 0);
  // A message from someone else, or about another task, does not count.
  assert.equal(getLastProgressAt(t, [{ ...reply, employeePhone: OWNER }]), Date.parse('2026-11-02T10:00:00.000Z'));
});

test('owner digest: three parts, owner language, no phone numbers; nothing to report -> null', () => {
  const s = state({
    tasks: [
      task({ taskCode: 'T-1', shortTag: 'Own', title: 'Sign the lease', raci: { R: OWNER, A: OWNER, C: [], I: [] } }),
      task({ taskCode: 'T-2', shortTag: 'Late', dueDate: '2026-11-01', release: { ...task().release!, releasedAt: '2026-11-03T09:00:00.000Z' } }),
      task({ taskCode: 'T-3', status: 'AWAITING_BOSS_DECISION' }),
    ],
    boss_review_queue: [review({ taskCode: 'T-3' })],
  });
  const summary = buildMyTasks(s, NOW);
  const english = buildOwnerDigestText(summary, team[OWNER], team)!;
  assert.match(english, /^☀️ Good morning Owner Prime, here is your summary:/);
  assert.match(english, /Your tasks \(1\):\n• \[Own\] Sign the lease \(due 2026-11-05\)/);
  assert.match(english, /Decisions waiting for you: 1/);
  assert.match(english, /\[Late\] — Operator Alpha — overdue 2 days/);
  assert.doesNotMatch(english, /1000\d/);

  const hinglish = buildOwnerDigestText(summary, { ...team[OWNER], preferredLanguage: 'HINGLISH' }, team)!;
  assert.match(hinglish, /Namaste Owner Prime ji/);
  assert.match(hinglish, /2 din late/);
  const hindi = buildOwnerDigestText(summary, { ...team[OWNER], preferredLanguage: 'HINDI' }, team)!;
  assert.match(hindi, /नमस्ते Owner Prime जी/);
  assert.match(hindi, /आपके निर्णय का इंतज़ार: 1/);

  assert.equal(buildOwnerDigestText(buildMyTasks(state(), NOW), team[OWNER], team), null);
});
