import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBehindAlertText,
  findBehindTasksInProject,
  findRelatedOpenItems,
  sendBehindAlerts,
} from './behindAlerts';
import { BANQUET_DEMO_PHONES, createBanquetDemoSeedState } from './demoBanquet';
import { applyProcessedBufferResult } from './opsEngine';
import { runScheduledJobsTick } from './releaseEngine';

const MORNING = '2026-11-20T04:30:00.000Z'; // 10:00 in India: lawn due 18:00, not late yet
const EVENING = '2026-11-20T13:30:00.000Z'; // 19:00 in India: 18:00 lawn deadline passed
const { POOJA, RAMESH, SURESH } = BANQUET_DEMO_PHONES;

const rameshReply = (overrides: Record<string, unknown> = {}) => ({
  matchedTaskCode: 'T-301',
  englishBossSummary: '100 chairs placed; 150 arrive at 7 PM.',
  mediaVerificationNote: '',
  updatedMicroSteps: [],
  completionPercent: 40,
  missingStepsAlert: '',
  whatsappReplyInPreferredLanguage: 'Ramesh bhai, baaki kaam kab tak?',
  escalateToBossReview: false,
  delayReported: true,
  reportedEta: '7 baje',
  suggestedFix: 'Approve the pending chair order so the vendor delivers by 5 PM.',
  ...overrides,
});

test('findRelatedOpenItems links the late lawn setup to the open chair approval in the same job', () => {
  const state = createBanquetDemoSeedState(MORNING);
  const t301 = state.tasks.find((t) => t.taskCode === 'T-301')!;
  const related = findRelatedOpenItems(state, t301);
  assert.deepEqual(related.map((r) => [r.reviewId, r.taskCode, r.personName]), [['REV-301', 'T-302', 'Suresh Jain']]);
  const t304 = state.tasks.find((t) => t.taskCode === 'T-304')!; // not in the reception job
  assert.deepEqual(findRelatedOpenItems(state, t304), []);
});

test('buildBehindAlertText: Accountable addressed by "Address as", reason, fix and linked approval', () => {
  const state = createBanquetDemoSeedState(MORNING);
  const t301 = state.tasks.find((t) => t.taskCode === 'T-301')!;
  const text = buildBehindAlertText({
    task: { ...t301, scheduleRisk: { reason: 'Reply says part of the work will finish later. Expected finish: 7 baje.', flaggedAt: MORNING, suggestedFix: 'Approve the chairs.' } },
    accountable: state.team_members[POOJA],
    responsible: state.team_members[RAMESH],
    related: findRelatedOpenItems(state, t301),
  });
  assert.equal(
    text,
    '⚠️ Pooja ji, [Lawn 2 Setup] (Ramesh Choudhary) time se peeche hai.\n' +
      'Reply says part of the work will finish later. Expected finish: 7 baje.\n' +
      'Sujhav: Approve the chairs.\n' +
      'Isi kaam mein approval baaki: Suresh Jain — [150 Extra Chairs] (REV-301).'
  );
  const en = buildBehindAlertText({ task: t301, accountable: { name: 'Owner', preferredLanguage: 'ENGLISH' }, responsible: null, related: [] });
  assert.match(en, /^⚠️ Owner, \[Lawn 2 Setup\] is behind\.$/);
});

test('a reply that says the work will finish late alerts the Accountable once, not on every reply', () => {
  const state = createBanquetDemoSeedState(MORNING);
  const first = applyProcessedBufferResult(state, RAMESH, rameshReply(), MORNING);
  const alerts = first.whatsapp_messages.filter((m) => m.tag === 'BEHIND_ALERT');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].employeePhone, POOJA);
  assert.match(alerts[0].text, /Sujhav: Approve the pending chair order/);
  assert.match(alerts[0].text, /REV-301/);
  const t301 = first.tasks.find((t) => t.taskCode === 'T-301')!;
  assert.ok(t301.scheduleRisk?.alertedAt);
  assert.equal(t301.scheduleRisk?.suggestedFix, 'Approve the pending chair order so the vendor delivers by 5 PM.');

  // Another update in the same behind spell: no second alert.
  const withBuffer = {
    ...first,
    inbound_message_buffer: { [RAMESH]: { ...state.inbound_message_buffer[RAMESH] } },
  };
  const second = applyProcessedBufferResult(withBuffer, RAMESH, rameshReply({ suggestedFix: null }), MORNING);
  assert.equal(second.whatsapp_messages.filter((m) => m.tag === 'BEHIND_ALERT').length, 1);
});

test('an on-time reply sends no alert', () => {
  const state = createBanquetDemoSeedState(MORNING);
  const next = applyProcessedBufferResult(
    state,
    RAMESH,
    rameshReply({ delayReported: false, reportedEta: null, suggestedFix: null }),
    MORNING
  );
  assert.equal(next.whatsapp_messages.filter((m) => m.tag === 'BEHIND_ALERT').length, 0);
});

test('the scheduler tick alerts late tasks with no reply, once, and never the Responsible themself', () => {
  const state = createBanquetDemoSeedState(MORNING);
  const tick1 = runScheduledJobsTick(state, EVENING);
  const alerted = tick1.nextState.whatsapp_messages.filter((m) => m.tag === 'BEHIND_ALERT');
  assert.ok((tick1.behindAlertsSent || 0) >= 1);
  const lawnAlert = alerted.find((m) => m.taskCode === 'T-301')!;
  assert.equal(lawnAlert.employeePhone, POOJA);
  assert.match(lawnAlert.text, /Past the deadline \(.* 18:00\) by 1h; no update yet\./);
  // The owner's own call (owner is R and A) is not alerted to themself.
  assert.equal(alerted.some((m) => m.taskCode === 'T-305'), false);

  const tick2 = runScheduledJobsTick(tick1.nextState, EVENING);
  assert.equal(tick2.behindAlertsSent || 0, 0);
});

test('findBehindTasksInProject shows what a pending approval is holding up', () => {
  const state = createBanquetDemoSeedState(MORNING);
  const t302 = state.tasks.find((t) => t.taskCode === 'T-302')!;
  assert.deepEqual(findBehindTasksInProject(state, t302, Date.parse(MORNING)).map((t) => t.taskCode), []);
  const later = findBehindTasksInProject(state, t302, Date.parse(EVENING)).map((t) => t.taskCode);
  assert.ok(later.includes('T-301'));
  assert.equal(sendBehindAlerts(state, 'not a date').alertedTaskCodes.length, 0);
  assert.equal(state.team_members[SURESH].name, 'Suresh Jain');
});
