import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnonymizedIntentPrompt,
  buildAnonymizedPlannerPrompt,
  buildCombinedClarifyingQuestion,
  buildV2NonPlannerResponse,
  hydratePlannerDefaults,
  routeMeditateV2Intent,
} from './meditateV2';
import { buildSlotDirectory } from './promptBuilder';
import { normalizeMeditatePlanDates } from './planDates';
import { validateDraftTask, validateMeditatePlan } from './validator';
import { createDemoSeedState } from './demoData';
import type { MeditateDraftTaskInput } from '../types/ops';

const NOW = '2026-11-19T04:00:00.000Z';

test('intent and planner prompts include strict anti-hallucination and honest-unknown guardrails', () => {
  const state = createDemoSeedState(NOW);
  const teamMembers = Object.values(state.team_members);

  const intentBuilt = buildAnonymizedIntentPrompt({
    brainDump: 'Send something soon',
    teamMembers,
    tasks: state.tasks,
    categorySops: state.category_sops,
    systemMemory: state.system_memory,
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
  });

  assert.match(intentBuilt.systemInstruction, /Never invent a person, client, vendor, quantity, price, or date/i);
  assert.match(intentBuilt.systemInstruction, /who, where, when/i);
  assert.match(intentBuilt.systemInstruction, /say so plainly.*never guess or make something up/i);
  assert.equal(intentBuilt.piiAudit.clean, true);

  const plannerBuilt = buildAnonymizedPlannerPrompt({
    brainDump: 'Send 10 jars to Sharma Ji tomorrow',
    teamMembers,
    tasks: state.tasks,
    categorySops: state.category_sops,
    systemMemory: state.system_memory,
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
  });

  assert.match(plannerBuilt.systemInstruction, /Never invent a person, client, vendor, quantity, price, or date/i);
  assert.match(plannerBuilt.systemInstruction, /never invent a date or state an assumed date as fact/i);
  assert.match(plannerBuilt.systemInstruction, /Use ONLY people who exist in ANONYMIZED TEAM SLOTS/i);
  assert.equal(plannerBuilt.piiAudit.clean, true);
});

test('vague inputs with missing who/where/when route to ONE short clarifying question and zero tasks', () => {
  const state = createDemoSeedState(NOW);
  const teamMembers = Object.values(state.team_members);
  const dir = buildSlotDirectory(teamMembers, state.owner_profile);

  const routed = routeMeditateV2Intent({
    kind: 'TASK',
    confidence: 0.92,
    missingCritical: ['which client (who)', 'delivery address (where)', 'delivery date (when)'],
    followUpForHeadId: null,
    replyToOwner: 'Who is the client? Where should we deliver?',
  });

  assert.equal(routed.route, 'ASK_CLARIFYING_QUESTION');
  // Multiple questions from the model are collapsed into ONE combined question.
  assert.equal((routed.replyToOwner.match(/\?/g) || []).length, 1);

  const nonPlanner = buildV2NonPlannerResponse({
    route: 'ASK_CLARIFYING_QUESTION',
    intent: {
      kind: 'TASK',
      confidence: 0.92,
      missingCritical: ['which client (who)', 'delivery address (where)', 'delivery date (when)'],
      followUpForHeadId: null,
      replyToOwner: routed.replyToOwner,
    },
    replyToOwner: routed.replyToOwner,
    rawBrainDump: 'Send jars',
    slotDirectory: dir,
  });

  assert.equal(nonPlanner.intentClassification, 'NEEDS_CLARIFICATION');
  assert.equal(nonPlanner.draftedTasks.length, 0);
  assert.equal((nonPlanner.wbsHeads || []).length, 0);

  const singleQ = buildCombinedClarifyingQuestion(['vendor name', 'amount']);
  assert.equal((singleQ.match(/\?/g) || []).length, 1);
  assert.match(singleQ, /vendor name and amount/);
});

test('unanswerable QUESTION with empty reply falls back to an honest plain statement', () => {
  const routed = routeMeditateV2Intent({
    kind: 'QUESTION',
    confidence: 0.95,
    missingCritical: [],
    followUpForHeadId: null,
    replyToOwner: '   ',
  });

  assert.equal(routed.route, 'ANSWER_QUESTION');
  assert.match(routed.replyToOwner, /don't have enough information/i);
});

test('validator rejects invented team members and unknown {{P99}} / [P99] slot placeholders in text', () => {
  const state = createDemoSeedState(NOW);
  const teamMembers = Object.values(state.team_members);
  const categoryIds = state.category_sops.map((c) => c.categoryId);
  const dir = buildSlotDirectory(teamMembers, state.owner_profile);
  const validR = dir.defaultResponsibleSlot;
  const validA = dir.defaultAccountableSlot;
  const validCat = categoryIds[0];

  const inventedSlotPlan = validateMeditatePlan(
    {
      intentClassification: 'ACTIONABLE_AGENDA',
      lane: 'QUICK',
      chatReplyToBoss: 'Assigned to {{P99}} for tomorrow.',
      reasoningSummary: 'Test',
      agendaTitle: 'Test',
      agendaQuadrant: 'Q2_SCHEDULE',
      agendaMajorOrMinor: 'MINOR',
      wbsHeads: [],
      suggestedMemoryRules: [],
      draftedTasks: [
        {
          title: 'Deliver to [P99]',
          shortTag: 'Deliver',
          categoryId: validCat,
          quadrant: 'Q2_SCHEDULE',
          majorOrMinor: 'MINOR',
          taskFrequency: 'ONE_TIME',
          recurrenceRule: 'NONE',
          raci: { R: validR, A: validA, C: [], I: [] },
          triggerCondition: 'FULL_COMPLETION',
          dueDateOffsetDays: 1,
          microSteps: ['Call {{P88}} before leaving'],
          outboundWhatsappPreview: 'Hi, coordinate with {{P99}}.',
        },
      ],
    },
    { roster: teamMembers, categoryIds }
  );

  assert.equal(inventedSlotPlan.valid, false);
  const unknownCodes = inventedSlotPlan.issues.filter((i) => i.code === 'UNKNOWN_SLOT_PLACEHOLDER');
  assert.equal(unknownCodes.length, 4);

  const inventedPersonRaci = validateMeditatePlan(
    {
      intentClassification: 'ACTIONABLE_AGENDA',
      lane: 'QUICK',
      chatReplyToBoss: 'Staged task.',
      reasoningSummary: 'Test',
      agendaTitle: 'Test',
      agendaQuadrant: 'Q2_SCHEDULE',
      agendaMajorOrMinor: 'MINOR',
      wbsHeads: [],
      suggestedMemoryRules: [],
      draftedTasks: [
        {
          title: 'Follow up on quote',
          shortTag: 'Quote',
          categoryId: validCat,
          quadrant: 'Q2_SCHEDULE',
          majorOrMinor: 'MINOR',
          taskFrequency: 'ONE_TIME',
          recurrenceRule: 'NONE',
          raci: { R: 'Rohan', A: validA, C: [], I: [] },
          triggerCondition: 'FULL_COMPLETION',
          dueDateOffsetDays: 1,
          microSteps: ['Check quote'],
          outboundWhatsappPreview: 'Please check quote.',
        },
      ],
    },
    { roster: teamMembers, categoryIds }
  );

  assert.equal(inventedPersonRaci.valid, false);
  assert.ok(inventedPersonRaci.issues.some((i) => i.code === 'UNKNOWN_RACI_SLOT'));
});

test('tricky input with quantity and price but no date marks dueDateAssumed=true and warns', () => {
  const state = createDemoSeedState(NOW);
  const teamMembers = Object.values(state.team_members);
  const dir = buildSlotDirectory(teamMembers, state.owner_profile);

  const hydrated = hydratePlannerDefaults(
    {
      lane: 'QUICK',
      draftedTasks: [
        {
          title: 'Deliver 20 jars to ABC Corp (Rs 50 each)',
          raci: { R: dir.defaultResponsibleSlot, A: dir.defaultAccountableSlot, C: [], I: [] },
          dueDateOffsetDays: 0,
          microSteps: ['Load 20 jars'],
        },
      ],
      wbsHeads: [],
    },
    { referenceDate: '2026-11-19', categorySops: state.category_sops }
  );

  assert.equal(hydrated.draftedTasks[0].dueDateAssumed, true);

  const normalizedNoDate = normalizeMeditatePlanDates(hydrated, {
    timezone: 'Asia/Kolkata',
    now: new Date(NOW),
    sourceText: 'Send 20 jars at Rs 50 each to ABC Corp',
  });
  assert.equal(normalizedNoDate.draftedTasks[0].dueDateAssumed, true);

  const draft: MeditateDraftTaskInput = {
    tempId: 'd-tricky',
    title: 'Deliver 20 jars to ABC Corp',
    categoryId: state.category_sops[0].categoryId,
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    raci: { R: dir.defaultResponsiblePhone, A: dir.defaultAccountablePhone, C: [], I: [] },
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION',
    dueDate: normalizedNoDate.draftedTasks[0].dueDate,
    dueDateAssumed: normalizedNoDate.draftedTasks[0].dueDateAssumed,
    microSteps: ['Load 20 jars'],
  };

  const issues = validateDraftTask(draft, { teamMembers, timezone: 'Asia/Kolkata' });
  assert.ok(issues.some((i) => i.field === 'dueDate' && /assumed/i.test(i.message)));

  const normalizedWithDate = normalizeMeditatePlanDates(hydrated, {
    timezone: 'Asia/Kolkata',
    now: new Date(NOW),
    sourceText: 'Send 20 jars to ABC Corp tomorrow',
  });
  assert.equal(normalizedWithDate.draftedTasks[0].dueDateAssumed, false);
});
