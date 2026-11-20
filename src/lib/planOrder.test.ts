import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAiTaskOrder, PLAN_ORDER_RULES, toShortHeadId } from './planOrder';
import { buildAnonymizedPlannerPrompt } from './meditateV2';
import { createDemoSeedState } from './demoData';

type D = {
  tempId: string;
  swimlaneStage?: string;
  dependsOnTempIdOrTaskCode: string | null;
  release?: { mode?: 'NOW' | 'AT_TIME' | 'AFTER_TASK' | 'WHEN_FREE'; afterTaskCode?: string | null };
  ownerEditedFields?: Array<'release'>;
};

const stages = ['Confirm', 'Deliver', 'Bill'];
const d = (tempId: string, stage: string, extra: Partial<D> = {}): D => ({
  tempId,
  swimlaneStage: stage,
  dependsOnTempIdOrTaskCode: null,
  ...extra,
});

test('applyAiTaskOrder: the AI\'s "waits for" links show as "After task"', () => {
  const out = applyAiTaskOrder([
    d('a', 'Confirm'),
    d('b', 'Deliver', { dependsOnTempIdOrTaskCode: 'a' }),
    d('c', 'Bill', { dependsOnTempIdOrTaskCode: 'b' }),
  ]);
  assert.equal(out[0].release, undefined);
  assert.equal(out[1].release?.mode, 'AFTER_TASK');
  assert.equal(out[1].release?.afterTaskCode, 'a');
  assert.equal(out[2].release?.afterTaskCode, 'b');
});

test('applyAiTaskOrder: never invents a link from stages; keeps owner and existing choices', () => {
  const input = [
    d('chairs', 'Confirm'),
    d('power', 'Deliver'), // later stage, no link: stays parallel (Sharma live run)
    d('x', 'Bill', { dependsOnTempIdOrTaskCode: 'chairs', release: { mode: 'NOW' }, ownerEditedFields: ['release'] }),
    d('y', 'Bill', { dependsOnTempIdOrTaskCode: 'chairs', release: { mode: 'AT_TIME' } }),
  ];
  const out = applyAiTaskOrder(input);
  assert.equal(out[1].dependsOnTempIdOrTaskCode, null);
  assert.equal(out[1].release, undefined);
  assert.equal(out[2].release?.mode, 'NOW');
  assert.equal(out[3].release?.mode, 'AT_TIME');
  assert.equal(input[1].release, undefined); // input untouched
});

test('validateDraftPlan notes a later-stage task that goes out before the earlier stage', async () => {
  const { validateDraftPlan } = await import('./validator');
  const state = createDemoSeedState('2026-11-19T04:00:00.000Z');
  const mk = (tempId: string, stage: string, extra: Record<string, unknown> = {}) => ({
    tempId,
    title: tempId,
    categoryId: 'DELIVERIES',
    quadrant: 'Q2_SCHEDULE' as const,
    majorOrMinor: 'MAJOR' as const,
    taskFrequency: 'ONE_TIME' as const,
    recurrenceRule: 'NONE' as const,
    raci: { R: '919820100006', A: '919820100003', C: [], I: [] },
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION' as const,
    dueDate: '2026-11-20',
    microSteps: ['Step'],
    swimlaneStage: stage,
    ...extra,
  });
  const res = validateDraftPlan(
    [
      mk('a', 'Confirm'),
      mk('b', 'Deliver'),
      mk('c', 'Bill', { dependsOnTempIdOrTaskCode: 'b', release: { mode: 'AFTER_TASK', afterTaskCode: 'b' } }),
      mk('e', 'Bill', { release: { mode: 'NOW' }, ownerEditedFields: ['release'] }),
    ],
    { teamMembers: Object.values(state.team_members), timezone: 'Asia/Kolkata', stages }
  );
  const notes = (id: string) => res.byTempId[id].filter((i) => i.field === 'release');
  assert.equal(notes('a').length, 0);
  assert.match(notes('b')[0].message, /Goes out now, before "Confirm" is done/);
  assert.equal(notes('b')[0].severity, 'warning');
  assert.equal(notes('c').length, 0);
  assert.equal(notes('e').length, 0); // owner chose Now
  assert.equal(res.errorCount, 0);
});

test('toShortHeadId: keeps HEAD-style labels, replaces raw AI IDs with the next free HEAD-n', () => {
  assert.equal(toShortHeadId('HEAD-D1', new Set()), 'HEAD-D1');
  assert.equal(toShortHeadId('wbs_metro_onboarding', new Set(['HEAD-D1', 'HEAD-D2'])), 'HEAD-1');
  assert.equal(toShortHeadId('wbs_metro_onboarding', new Set(['HEAD-1', 'HEAD-2'])), 'HEAD-3');
  assert.equal(toShortHeadId('HEAD-1', new Set(['HEAD-1'])), 'HEAD-2');
  assert.equal(toShortHeadId('', new Set()), 'HEAD-1');
});

test('planner prompt includes the task-order rule', () => {
  const state = createDemoSeedState('2026-11-19T04:00:00.000Z');
  const built = buildAnonymizedPlannerPrompt({
    brainDump: 'Onboard a new client in steps',
    teamMembers: Object.values(state.team_members),
    tasks: state.tasks,
    categorySops: state.category_sops,
    systemMemory: state.system_memory,
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
  });
  assert.ok(built.systemInstruction.includes(PLAN_ORDER_RULES));
});

test('withGeneratedDraftMessages: drafts get the addressed short brief; owner-written messages stay', async () => {
  const { withGeneratedDraftMessages } = await import('./draftEditing');
  const state = createDemoSeedState('2026-11-19T04:00:00.000Z');
  const base = {
    tempId: 'x',
    title: 'Make first jar delivery to Metro Hospital',
    shortTag: 'Metro Delivery',
    categoryId: 'DELIVERIES',
    quadrant: 'Q2_SCHEDULE' as const,
    majorOrMinor: 'MAJOR' as const,
    taskFrequency: 'ONE_TIME' as const,
    recurrenceRule: 'NONE' as const,
    raci: { R: '919820100006', A: '919820100003', C: [], I: [] },
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION' as const,
    dueDate: '2026-11-23',
    dueTime: '10:00',
    microSteps: ['Load jars', 'Deliver'],
    outboundWhatsappPreview: 'Delivery team ready for Metro Hospital first drop.',
  };
  const [gen, custom] = withGeneratedDraftMessages(
    [base, { ...base, tempId: 'y', messageIsCustom: true, outboundWhatsappPreview: 'My own words' }],
    state.team_members
  );
  assert.match(gen.outboundWhatsappPreview!, /^Namaste Nitin bhai, \[Metro Delivery\] .* — 23 Nov, 10:00 tak\.\nSteps: 1\) Load jars · 2\) Deliver/);
  assert.equal(custom.outboundWhatsappPreview, 'My own words');
});

test('readableShortTag turns code-style tags into words and keeps normal tags', async () => {
  const { readableShortTag } = await import('./meditateV2');
  assert.equal(readableShortTag('FIRST_DELIVERY'), 'First Delivery');
  assert.equal(readableShortTag('SALES-ONBOARDING'), 'Sales Onboarding');
  assert.equal(readableShortTag('LAWN_3_SETUP'), 'Lawn 3 Setup');
  assert.equal(readableShortTag('Sunrise 40 Jars'), 'Sunrise 40 Jars');
  assert.equal(readableShortTag('AC'), 'AC');
});
