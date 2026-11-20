import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamScorecard, completedAtMs } from './scorecard';
import { suggestRuleFromOwnerEdit } from './ruleSuggestions';
import { BANQUET_DEMO_PHONES, createBanquetDemoSeedState } from './demoBanquet';

const MORNING = '2026-11-20T04:30:00.000Z'; // 10:00 India
const EVENING = '2026-11-20T13:30:00.000Z'; // 19:00 India
const { RAMESH, GOPAL, POOJA, SURESH } = BANQUET_DEMO_PHONES;

test('scorecard: behind now, on-time rate, reply speed and tomorrow\'s load per person', () => {
  const state = createBanquetDemoSeedState(MORNING);
  const morning = buildTeamScorecard(state, Date.parse(MORNING));
  const ramesh = morning.find((r) => r.phone === RAMESH)!;
  assert.deepEqual([ramesh.openNow, ramesh.behindNow, ramesh.dueByTomorrow, ramesh.limit], [1, 0, 1, 3]);
  assert.equal(ramesh.avgReplyMins, Math.round(55 / 6));
  const gopal = morning.find((r) => r.phone === GOPAL)!;
  assert.equal(gopal.onTimeRate, 100); // AC fix finished the day it was due

  const evening = buildTeamScorecard(state, Date.parse(EVENING));
  assert.equal(evening.find((r) => r.phone === RAMESH)!.behindNow, 1);
  assert.ok(evening[0].behindNow >= 1, 'people with late work are listed first');
});

test('scorecard flags someone with more due by tomorrow than they can carry', () => {
  const state = createBanquetDemoSeedState(MORNING);
  const t = state.tasks.find((x) => x.taskCode === 'T-301')!;
  const extra = [1, 2, 3].map((i) => ({ ...t, taskCode: `T-9${i}`, wbsHeadId: null, agendaId: null }));
  const row = buildTeamScorecard({ ...state, tasks: [...state.tasks, ...extra] }, Date.parse(MORNING)).find(
    (r) => r.phone === RAMESH
  )!;
  assert.deepEqual([row.dueByTomorrow, row.limit, row.overloadedTomorrow], [4, 3, true]);
});

test('completedAtMs uses the entry that completed the task', () => {
  assert.equal(
    completedAtMs({
      auditLogs: [
        { timestamp: '2026-11-19T05:00:00.000Z', sender: 'x', rawInputSummary: '', aiDecision: 'Updated to COMPLETED (100%).' },
        { timestamp: '2026-11-19T09:00:00.000Z', sender: 'x', rawInputSummary: '', aiDecision: 'Archived.' },
      ],
    }),
    Date.parse('2026-11-19T05:00:00.000Z')
  );
  assert.equal(completedAtMs({ auditLogs: [] }), null);
});

test('Save as rule: reassigning a task type suggests a rule; an added step suggests another', () => {
  const state = createBanquetDemoSeedState(MORNING);
  const base = {
    categoryId: 'VENDOR_PURCHASE',
    raci: { R: POOJA, A: POOJA, C: [], I: [] },
    microSteps: ['Get three quotes', 'Check the vendor delivered on time last month'],
    aiSnapshot: { 'raci.R': SURESH, microSteps: ['Get three quotes'] },
  };
  assert.deepEqual(
    suggestRuleFromOwnerEdit({ draft: base, changedFields: ['raci.R'], teamMembers: state.team_members, categories: state.category_sops }),
    { category: 'SOP_PREFERENCE', fact: 'For Vendors & purchase work, give it to Pooja Mehta instead of Suresh Jain.' }
  );
  assert.deepEqual(
    suggestRuleFromOwnerEdit({ draft: base, changedFields: ['microSteps'], teamMembers: state.team_members, categories: state.category_sops }),
    { category: 'SOP_PREFERENCE', fact: 'For Vendors & purchase work, always include the step: "Check the vendor delivered on time last month".' }
  );
  assert.equal(
    suggestRuleFromOwnerEdit({ draft: base, changedFields: ['title'], teamMembers: state.team_members, categories: state.category_sops }),
    null
  );
});

test('routines: a task type\'s checklist goes to its default person (backup if they are busy or away)', async () => {
  const { buildRoutineDraft } = await import('./routines');
  const state = createBanquetDemoSeedState(MORNING);
  const power = state.category_sops.find((c) => c.categoryId === 'POWER')!;
  const once = buildRoutineDraft(power, state, { daily: false, nowMs: Date.parse(MORNING) })!;
  assert.equal(once.raci.R, BANQUET_DEMO_PHONES.MAHESH);
  assert.equal(once.raci.A, GOPAL);
  assert.deepEqual(once.microSteps, power.defaultMicroSteps);
  assert.deepEqual([once.taskFrequency, once.recurrenceRule, once.dueDate], ['ONE_TIME', 'NONE', '2026-11-20']);
  const daily = buildRoutineDraft(power, state, { daily: true, nowMs: Date.parse(MORNING) })!;
  assert.deepEqual([daily.taskFrequency, daily.recurrenceRule, daily.title], ['RECURRING', 'DAILY', 'Power & generator (daily)']);
  const away = {
    ...state,
    team_members: {
      ...state.team_members,
      [BANQUET_DEMO_PHONES.MAHESH]: { ...state.team_members[BANQUET_DEMO_PHONES.MAHESH], isOnLeave: true },
    },
  };
  assert.equal(buildRoutineDraft(power, away, { daily: false, nowMs: Date.parse(MORNING) })!.raci.R, GOPAL);
  const general = state.category_sops.find((c) => c.categoryId === 'GENERAL')!;
  assert.equal(buildRoutineDraft(general, state, { daily: false, nowMs: Date.parse(MORNING) }), null);
});
