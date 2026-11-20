import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnonymizedIntentPrompt,
  buildMustKnowFactLines,
  hydratePlannerDefaults,
  routeMeditateV2Intent,
} from './meditateV2';
import { buildSlotDirectory, buildTaskTypeLine } from './promptBuilder';
import { normalizeMeditatePlanDates } from './planDates';
import { validateDraftTask } from './validator';
import { applyDraftEdit } from './draftEditing';
import { createDemoSeedState } from './demoData';
import type { CategorySop, MeditateDraftTaskInput } from '../types/ops';

const NOW = '2026-11-19T04:00:00.000Z'; // 09:30 in India

const sop = (over: Partial<CategorySop> = {}): CategorySop => ({
  categoryId: 'DELIVERIES',
  categoryName: 'Deliveries',
  defaultClassification: 'MAJOR',
  sopSystemPrompt: 'Deliver on time.',
  defaultMicroSteps: ['Load', 'Deliver'],
  ...over,
});

test('buildMustKnowFactLines lists only task types with must-know facts', () => {
  const dir = buildSlotDirectory([]);
  const lines = buildMustKnowFactLines(
    [
      sop({ requiredFacts: ['how many', ' address ', ''] }),
      sop({ categoryId: 'OTHER', categoryName: 'Other', requiredFacts: [] }),
      sop({ categoryId: 'NONE', categoryName: 'None' }),
    ],
    dir
  );
  assert.deepEqual(lines, ['- DELIVERIES (Deliveries): how many; address']);
});

test('task-type line shows "Must know" for both planners', () => {
  const dir = buildSlotDirectory([]);
  const line = buildTaskTypeLine(sop({ requiredFacts: ['how many', 'address'] }), dir, new Map());
  assert.match(line, /Must know: how many; address/);
  assert.doesNotMatch(buildTaskTypeLine(sop(), dir, new Map()), /Must know/);
});

test('intent prompt carries the must-know facts and the "ask, never guess" rule', () => {
  const state = createDemoSeedState(NOW);
  const built = buildAnonymizedIntentPrompt({
    brainDump: 'Sign up a new client and make the first delivery',
    teamMembers: Object.values(state.team_members),
    tasks: state.tasks,
    categorySops: state.category_sops,
    systemMemory: state.system_memory,
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
  });
  assert.match(built.prompt, /MUST-KNOW FACTS BY TASK TYPE:\n- DELIVERIES \(Deliveries\): how many jars;/);
  assert.match(built.systemInstruction, /Never fill one in by guessing/);
  assert.equal(built.piiAudit.clean, true);
});

test('missing must-know facts route to one clarifying question, not the planner', () => {
  const routed = routeMeditateV2Intent({
    kind: 'TASK',
    confidence: 0.95,
    missingCritical: ['how many jars', 'office address', 'start date'],
    followUpForHeadId: null,
    replyToOwner: '',
  });
  assert.equal(routed.route, 'ASK_CLARIFYING_QUESTION');
  assert.equal((routed.replyToOwner.match(/\?/g) || []).length, 1);
});

test('normalizeMeditatePlanDates marks a date as assumed only when nobody gave one', () => {
  const plan = normalizeMeditatePlanDates<{ draftedTasks: Array<Record<string, unknown>> }>(
    {
      draftedTasks: [
        { title: 'A', dueDateOffsetDays: 0 }, // offset only: code's default
        { title: 'B', dueHint: 'tomorrow' },
        { title: 'C', dueDate: '2026-11-21' },
        { title: 'D' },
      ],
    },
    { timezone: 'Asia/Kolkata', now: new Date(NOW) }
  );
  assert.deepEqual(
    plan.draftedTasks.map((t) => t.dueDateAssumed),
    [true, false, false, true]
  );
  // The owner's own words count as given.
  const fromWords = normalizeMeditatePlanDates<{ draftedTasks: Array<Record<string, unknown>> }>(
    { draftedTasks: [{ title: 'E', dueDateOffsetDays: 0 }] },
    { timezone: 'Asia/Kolkata', now: new Date(NOW), sourceText: 'do this by Friday' }
  );
  assert.equal(fromWords.draftedTasks[0].dueDateAssumed, false);
});

function draft(over: Partial<MeditateDraftTaskInput> = {}): MeditateDraftTaskInput {
  return {
    tempId: 'd1',
    title: 'Task',
    categoryId: 'DELIVERIES',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MAJOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    raci: { R: '919820100006', A: '919820100003', C: [], I: [] },
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION',
    dueDate: '2026-11-19',
    microSteps: ['Step'],
    ...over,
  };
}

test('an assumed date shows as a note (not an error); choosing a date clears it', () => {
  const state = createDemoSeedState(NOW);
  const ctx = { teamMembers: Object.values(state.team_members), timezone: 'Asia/Kolkata' };
  const issues = validateDraftTask(draft({ dueDateAssumed: true }), ctx);
  const note = issues.find((i) => i.field === 'dueDate');
  assert.equal(note?.severity, 'warning');
  assert.match(note!.message, /No date was given, so 2026-11-19 was assumed/);
  assert.equal(validateDraftTask(draft(), ctx).some((i) => i.field === 'dueDate'), false);

  const edited = applyDraftEdit(draft({ dueDateAssumed: true }), { dueDate: '2026-11-20' }, state.team_members);
  assert.equal(edited.draft.dueDateAssumed, false);
  const unchanged = applyDraftEdit(draft({ dueDateAssumed: true }), { dueDate: '2026-11-19' }, state.team_members);
  assert.equal(unchanged.draft.dueDateAssumed, true);
});

test('server-filled dates stay "assumed" on the screen; the owner\'s own words replace them', () => {
  const hydrated = hydratePlannerDefaults(
    {
      lane: 'PROJECT',
      draftedTasks: [
        { title: 'No date at all', raci: { R: 'P2', A: null, C: [], I: [] }, microSteps: ['x'], dueDateOffsetDays: 0 },
        { title: 'Has a hint', raci: { R: 'P2', A: null, C: [], I: [] }, microSteps: ['x'], dueHint: 'tomorrow' },
        { title: 'Has a date', raci: { R: 'P2', A: null, C: [], I: [] }, microSteps: ['x'], dueDate: '2026-11-21' },
      ],
      wbsHeads: [],
    },
    { referenceDate: '2026-11-19', categorySops: [] }
  );
  assert.deepEqual(
    hydrated.draftedTasks.map((t: { dueDateAssumed: boolean }) => t.dueDateAssumed),
    [true, false, false]
  );
  assert.equal(hydrated.draftedTasks[0].dueDate, '2026-11-19');

  const onScreen = normalizeMeditatePlanDates(hydrated, { timezone: 'Asia/Kolkata', now: new Date(NOW) });
  assert.equal(onScreen.draftedTasks[0].dueDateAssumed, true);
  assert.equal(onScreen.draftedTasks[0].dueDate, '2026-11-19');
  assert.equal(onScreen.draftedTasks[2].dueDateAssumed, false);

  const ownerSaidFriday = normalizeMeditatePlanDates(hydrated, {
    timezone: 'Asia/Kolkata',
    now: new Date(NOW),
    sourceText: 'Get this done by Friday',
  });
  assert.equal(ownerSaidFriday.draftedTasks[0].dueDate, '2026-11-20');
  assert.equal(ownerSaidFriday.draftedTasks[0].dueDateAssumed, false);
});
