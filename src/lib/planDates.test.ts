import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDateContextLine,
  businessTodayIso,
  normalizeMeditatePlanDates,
  resolvePlanDate,
} from './planDates';
import { buildAnonymizedMeditatePrompt } from './promptBuilder';
import { createInitialSeedState } from './seedData';
import { validateMeditatePlan } from './validator';

// 20:00 UTC on Mon 9 Nov 2026 is already 01:30 on Tue 10 Nov in India.
const LATE_EVENING_UTC = new Date('2026-11-09T20:00:00.000Z');
const MONDAY = '2026-11-09';

test('"today" is taken in the business timezone, not UTC', () => {
  assert.equal(businessTodayIso('Asia/Kolkata', LATE_EVENING_UTC), '2026-11-10');
  assert.equal(businessTodayIso('UTC', LATE_EVENING_UTC), '2026-11-09');
  // Unknown timezone falls back safely instead of throwing.
  assert.match(businessTodayIso('Not/AZone', LATE_EVENING_UTC), /^\d{4}-\d{2}-\d{2}$/);
});

test('date words become real dates', () => {
  assert.equal(resolvePlanDate('Tomorrow', MONDAY), '2026-11-10');
  assert.equal(resolvePlanDate('tomorrow morning', MONDAY), '2026-11-10');
  assert.equal(resolvePlanDate('Friday', MONDAY), '2026-11-13');
  assert.equal(resolvePlanDate('by Friday', MONDAY), '2026-11-13');
  assert.equal(resolvePlanDate('next week', MONDAY), '2026-11-16');
  assert.equal(resolvePlanDate('in 3 days', MONDAY), '2026-11-12');
  assert.equal(resolvePlanDate('today', MONDAY), MONDAY);
  // Real dates pass through; timestamps keep their date part.
  assert.equal(resolvePlanDate('2026-12-01', MONDAY), '2026-12-01');
  assert.equal(resolvePlanDate('2026-11-10T05:00:00Z', MONDAY), '2026-11-10');
  // Unreadable or impossible values give null instead of being saved.
  assert.equal(resolvePlanDate('whenever possible', MONDAY), null);
  assert.equal(resolvePlanDate('2026-02-30', MONDAY), null);
  assert.equal(resolvePlanDate('', MONDAY), null);
  assert.equal(resolvePlanDate(undefined, MONDAY), null);
});

test('regression: legacy plan with dueDate "Tomorrow" gets a real date in the business timezone', () => {
  const plan = {
    intentClassification: 'ACTIONABLE_AGENDA',
    chatReplyToBoss: 'Scheduled the lawn watering for tomorrow.',
    draftedTasks: [
      { title: 'Water the Main Lawn', dueDate: 'Tomorrow', startDate: 'today' },
      { title: 'Trim hedges', dueDate: 'whenever', dueHint: 'by Friday' },
      { title: 'Order seeds', dueDateOffsetDays: 2 },
    ],
    wbsHeads: [
      {
        headId: 'HEAD-LAWN',
        tentativeStartDate: 'today',
        tentativeDeadline: 'next week',
        subTasks: [{ title: 'Water the Main Lawn', dueDate: 'Tomorrow' }],
      },
    ],
  };

  const out = normalizeMeditatePlanDates(plan, { timezone: 'Asia/Kolkata', now: LATE_EVENING_UTC });
  // Business "today" is Tue 10 Nov in India, so "tomorrow" is Wed 11 Nov.
  assert.equal(out.draftedTasks[0].dueDate, '2026-11-11');
  assert.equal(out.draftedTasks[0].startDate, '2026-11-10');
  assert.equal(out.draftedTasks[1].dueDate, '2026-11-13'); // unreadable dueDate -> dueHint "by Friday"
  assert.equal(out.draftedTasks[2].dueDate, '2026-11-12'); // offset counted from business today
  assert.equal(out.wbsHeads[0].tentativeStartDate, '2026-11-10');
  assert.equal(out.wbsHeads[0].tentativeDeadline, '2026-11-17');
  assert.equal(out.wbsHeads[0].subTasks[0].dueDate, '2026-11-11');
  // Input is not mutated.
  assert.equal(plan.draftedTasks[0].dueDate, 'Tomorrow');

  const everyDate = JSON.stringify(out).match(/"(?:dueDate|startDate|tentative\w+)":"[^"]*"/g) || [];
  for (const field of everyDate) {
    assert.match(field, /"\d{4}-\d{2}-\d{2}"$/, `not a real date: ${field}`);
  }
});

test('an unreadable date with no hint is dropped so the app default applies', () => {
  const out = normalizeMeditatePlanDates(
    { draftedTasks: [{ title: 'x', dueDate: 'soonish', startDate: 'later' }] },
    { timezone: 'Asia/Kolkata', now: LATE_EVENING_UTC }
  );
  assert.equal('dueDate' in out.draftedTasks[0], false);
  assert.equal('startDate' in out.draftedTasks[0], false);
});

test('a normalized gardener plan still passes the plan validator', () => {
  const state = createInitialSeedState('2026-11-09T10:00:00.000Z');
  const roster = Object.values(state.team_members);
  const balbir = roster.find((m) => m.name === 'Balbir')!;
  const plan = {
    intentClassification: 'ACTIONABLE_AGENDA',
    chatReplyToBoss: 'Scheduled the lawn watering for Balbir tomorrow.',
    reasoningSummary: 'Routine maintenance.',
    agendaTitle: 'Main Lawn Watering',
    agendaQuadrant: 'Q2_SCHEDULE',
    agendaMajorOrMinor: 'MINOR',
    suggestedMemoryRules: [],
    wbsHeads: [],
    draftedTasks: [
      {
        title: 'Water the Main Lawn',
        shortTag: 'Lawn',
        categoryId: state.category_sops[0].categoryId,
        quadrant: 'Q2_SCHEDULE',
        majorOrMinor: 'MINOR',
        dueDate: 'Tomorrow',
        raci: { R: balbir.phone, A: state.owner_profile!.defaultAccountablePhone, C: [], I: [] },
        microSteps: ['Water the lawn'],
        outboundWhatsappPreview: 'Namaste Balbir bhai! Kal main lawn water kar dena.',
      },
    ],
  };
  const dated = normalizeMeditatePlanDates(plan, { timezone: 'Asia/Kolkata', now: LATE_EVENING_UTC });
  const check = validateMeditatePlan(dated, {
    roster,
    categoryIds: state.category_sops.map((c) => c.categoryId),
    existingTasks: state.tasks,
    defaultAccountablePhone: state.owner_profile?.defaultAccountablePhone,
    ownerProfile: state.owner_profile,
    maxChecklistStepsPerTask: 5,
    allowResolvedPhonesInRaci: true,
  });
  assert.equal(check.valid, true, JSON.stringify(check.issues));
  assert.equal(check.normalizedPlan.draftedTasks[0].dueDate, '2026-11-11');
});

test('regression: a past date guessed by the AI is replaced using the owner\'s own words', () => {
  // Seen in the browser: AI wrote "2023-10-25" for "water the lawn tomorrow".
  const out = normalizeMeditatePlanDates(
    {
      draftedTasks: [{ title: 'Water the main lawn', dueDate: '2023-10-25', startDate: '2023-10-25' }],
      wbsHeads: [
        {
          headId: 'HEAD-LAWN',
          tentativeStartDate: '2023-10-25',
          tentativeDeadline: '2023-10-25',
          subTasks: [{ title: 'Water the main lawn', dueDate: '2023-10-25' }],
        },
      ],
    },
    {
      timezone: 'Asia/Kolkata',
      now: new Date('2026-11-09T12:00:00.000Z'), // Mon 9 Nov 2026, 17:30 in India
      sourceText: 'Ask the gardener to water the lawn tomorrow.',
    }
  );
  assert.equal(out.draftedTasks[0].dueDate, '2026-11-10');
  assert.equal('startDate' in out.draftedTasks[0], false); // past start dropped -> app default (today)
  assert.equal(out.wbsHeads[0].tentativeDeadline, '2026-11-10');
  assert.equal(out.wbsHeads[0].subTasks[0].dueDate, '2026-11-10');
});

test('the AI prompt tells the model today\'s date in the business timezone', () => {
  const line = buildDateContextLine('2026-11-09');
  assert.match(line, /TODAY \(business timezone\): 2026-11-09 \(Monday\)/);
  assert.match(line, /tomorrow = 2026-11-10/);

  const state = createInitialSeedState('2026-11-09T10:00:00.000Z');
  const built = buildAnonymizedMeditatePrompt({
    dateContext: line,
    brainDump: 'Ask the gardener to water the lawn tomorrow.',
    teamMembers: Object.values(state.team_members),
    tasks: [],
    categorySops: state.category_sops,
    systemMemory: [],
  });
  assert.ok(built.prompt.startsWith(line));
});
