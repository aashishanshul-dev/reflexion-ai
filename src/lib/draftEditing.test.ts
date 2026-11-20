import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDraftToHead,
  applyDraftEdit,
  buildManualEditLog,
  deleteDraftHead,
  generateDraftMessage,
  mergeRefinedDrafts,
  mergeRefinedHead,
  moveStep,
  newBlankDraft,
  normalizeOwnerEditOverrides,
  removeDraftFromHead,
  renameHead,
} from './draftEditing';
import { recalculateWbsHeadDates } from './opsEngine';
import { MeditateDraftTaskInput, TeamMember, WbsHead } from '../types/ops';

function member(phone: string, slotId: string, name: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    tenantId: 'default',
    phone,
    slotId,
    name,
    roleTitle: 'Coordinator',
    authorityLevel: 'STAFF',
    skills: ['Operations'],
    maxActiveTasks: 3,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    dailyOverviewTime: '09:30',
    isOnLeave: false,
    lastInboundAt: '2026-11-03T09:00:00.000Z',
    lastDailyDigestDate: null,
    bufferMode: 'STANDARD_15_MIN',
    stats: { assigned: 0, completed: 0, partial: 0, overdueCount: 0, totalWorkHoursReplyMins: 0, replyCount: 0 },
    personaPrompt: 'Clear updates.',
    ...overrides,
  };
}

const roster: TeamMember[] = [
  member('10000', 'P1', 'Owner Prime', { authorityLevel: 'OWNER' }),
  member('10001', 'P2', 'Operator Alpha'),
  member('10002', 'P3', 'Lead Beta', { authorityLevel: 'SUPERVISOR' }),
  member('10003', 'P4', 'Helper Gamma'),
];
const team: Record<string, TeamMember> = Object.fromEntries(roster.map((m) => [m.phone, m]));

function draft(overrides: Partial<MeditateDraftTaskInput> = {}): MeditateDraftTaskInput {
  return {
    tempId: 'draft-1',
    title: 'Inspect unit',
    shortTag: 'Unit',
    categoryId: 'CAT_OPS',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    raci: { R: '10001', A: '10002', C: [], I: [] },
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION',
    release: { mode: 'NOW' },
    startDate: '2026-11-04',
    durationDays: 1,
    dueDate: '2026-11-04',
    microSteps: ['Check gauge', 'Send photo'],
    wbsHeadId: 'HEAD-1',
    ...overrides,
  };
}

function head(subTasks: MeditateDraftTaskInput[], overrides: Partial<WbsHead> = {}): WbsHead {
  return {
    headId: 'HEAD-1',
    title: 'Plan A',
    domainCategory: 'CAT_OPS',
    contextSummary: 'Summary',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    tentativeDurationDays: subTasks.length,
    tentativeStartDate: '2026-11-04',
    tentativeDeadline: '2026-11-05',
    isForcedDeadline: false,
    dynamicStages: ['Prep', 'Execution'],
    involvedPhones: ['10001'],
    status: 'SWIMLANE_READY',
    subTasks,
    ...overrides,
  };
}

test('applyDraftEdit changes every editable field and marks it owner-edited', () => {
  const original = draft();
  const { draft: edited, changedFields } = applyDraftEdit(
    original,
    {
      title: 'Inspect unit and valves',
      shortTag: 'Valves',
      microSteps: ['Check gauge', 'Check valves', 'Send photo'],
      'raci.R': '10003',
      'raci.A': '10000',
      'raci.C': ['10002'],
      'raci.I': ['10001', '10002'],
      categoryId: 'CAT_OTHER',
      quadrant: 'Q1_DO_FIRST',
      majorOrMinor: 'MAJOR',
      dueDate: '2026-11-06',
      durationDays: 2,
      release: { mode: 'AT_TIME', releaseAt: '2026-11-05T09:00' },
      taskFrequency: 'RECURRING',
      recurrenceRule: 'WEEKLY',
    },
    team
  );
  assert.equal(changedFields.length, 15);
  assert.equal(edited.title, 'Inspect unit and valves');
  assert.equal(edited.shortTag, 'Valves');
  assert.deepEqual(edited.raci, { R: '10003', A: '10000', C: ['10002'], I: ['10001', '10002'] });
  assert.equal(edited.categoryId, 'CAT_OTHER');
  assert.equal(edited.quadrant, 'Q1_DO_FIRST');
  assert.equal(edited.majorOrMinor, 'MAJOR');
  assert.equal(edited.dueDate, '2026-11-06');
  assert.equal(edited.durationDays, 2);
  assert.equal(edited.startDate, '2026-11-05'); // 2 days ending 6 Nov
  assert.deepEqual(edited.release, { mode: 'AT_TIME', releaseAt: '2026-11-05T09:00' });
  assert.equal(edited.taskFrequency, 'RECURRING');
  assert.equal(edited.recurrenceRule, 'WEEKLY');
  assert.equal(edited.ownerEditedFields?.includes('raci.C'), true);
  // AI's original values kept for the log.
  assert.equal(edited.aiSnapshot?.title, 'Inspect unit');
  assert.equal(edited.aiSnapshot?.['raci.R'], '10001');
  // Message regenerated from the new fields (no custom text).
  assert.equal(edited.messageIsCustom, false);
  assert.match(edited.outboundWhatsappPreview || '', /Helper Gamma.*\[Valves\].*Inspect unit and valves/s);
  assert.match(edited.outboundWhatsappPreview || '', /2\) Check valves/); // short brief: steps on one line

  // A second edit keeps the first snapshot.
  const again = applyDraftEdit(edited, { title: 'Final title' }, team).draft;
  assert.equal(again.aiSnapshot?.title, 'Inspect unit');
  // No change -> same object, nothing marked.
  const same = applyDraftEdit(original, { title: 'Inspect unit' }, team);
  assert.equal(same.draft, original);
  assert.deepEqual(same.changedFields, []);
});

test('one-time vs recurring keeps the repeat rule consistent', () => {
  const recurring = applyDraftEdit(draft(), { taskFrequency: 'RECURRING' }, team).draft;
  assert.equal(recurring.recurrenceRule, 'DAILY');
  const back = applyDraftEdit(recurring, { taskFrequency: 'ONE_TIME' }, team).draft;
  assert.equal(back.recurrenceRule, 'NONE');
});

test('custom message is kept exactly and survives later edits; reset goes back to generated', () => {
  const custom = 'Hello, please check the unit gauge today and reply with a photo.';
  const withMsg = applyDraftEdit(draft(), { outboundWhatsappPreview: custom }, team).draft;
  assert.equal(withMsg.messageIsCustom, true);
  assert.equal(withMsg.outboundWhatsappPreview, custom);
  assert.ok(withMsg.ownerEditedFields?.includes('outboundWhatsappPreview'));

  const retitled = applyDraftEdit(withMsg, { title: 'Another title' }, team).draft;
  assert.equal(retitled.outboundWhatsappPreview, custom);

  const reset = applyDraftEdit(retitled, { outboundWhatsappPreview: null }, team).draft;
  assert.equal(reset.messageIsCustom, false);
  assert.ok(!reset.ownerEditedFields?.includes('outboundWhatsappPreview'));
  assert.equal(reset.outboundWhatsappPreview, generateDraftMessage(reset, team));
});

test('steps: add, remove and reorder', () => {
  assert.deepEqual(moveStep(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveStep(['a', 'b', 'c'], 2, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveStep(['a', 'b'], 0, 5), ['a', 'b']);
  const added = applyDraftEdit(draft(), { microSteps: ['Check gauge', 'Send photo', '  New  ', ''] }, team).draft;
  assert.deepEqual(added.microSteps, ['Check gauge', 'Send photo', 'New']);
  const removed = applyDraftEdit(added, { microSteps: ['Send photo'] }, team).draft;
  assert.deepEqual(removed.microSteps, ['Send photo']);
});

test('add, delete and rename: blank task, deleted AI tasks remembered, head rename and delete', () => {
  const h = head([draft(), draft({ tempId: 'draft-2', title: 'Second' })]);
  const blank = newBlankDraft({ head: h, defaultAccountablePhone: '10002', todayDate: '2026-11-03', idSuffix: '1' });
  assert.equal(blank.ownerAdded, true);
  assert.equal(blank.raci.R, '');
  assert.equal(blank.raci.A, '10002');
  assert.equal(blank.wbsHeadId, 'HEAD-1');
  assert.equal(blank.dueDate, '2026-11-05');
  assert.equal(blank.swimlaneStage, 'Prep');

  const withBlank = addDraftToHead(h, blank);
  assert.equal(withBlank.subTasks.length, 3);
  const noAi = removeDraftFromHead(withBlank, 'draft-2');
  assert.deepEqual(noAi.ownerDeletedTempIds, ['draft-2']);
  const noBlank = removeDraftFromHead(noAi, blank.tempId);
  assert.deepEqual(noBlank.ownerDeletedTempIds, ['draft-2']); // owner-added tasks need no memory
  assert.equal(noBlank.subTasks.length, 1);

  const renamed = renameHead(h, '  New plan name ');
  assert.equal(renamed.title, 'New plan name');
  assert.equal(renamed.titleEditedByOwner, true);
  assert.equal(renameHead(h, '   '), h);

  const frozen = head([], { headId: 'HEAD-2', status: 'FROZEN_DISPATCHED' });
  assert.deepEqual(
    deleteDraftHead([h, frozen], 'HEAD-1').map((x) => x.headId),
    ['HEAD-2']
  );
  assert.deepEqual(deleteDraftHead([h, frozen], 'HEAD-2').map((x) => x.headId), ['HEAD-1', 'HEAD-2']);
});

test('owner-set due dates survive head date recalculation', () => {
  const edited = applyDraftEdit(draft({ tempId: 'a' }), { dueDate: '2026-11-10' }, team).draft;
  const h = head([edited, draft({ tempId: 'b', dueDate: '2026-11-05' })]);
  const recalculated = recalculateWbsHeadDates(h);
  assert.equal(recalculated.subTasks[0].dueDate, '2026-11-10');
  assert.equal(recalculated.subTasks[1].startDate, '2026-11-11');
});

test('edit log records field, AI value and owner value without names or phones', () => {
  const original = draft({ title: 'Ask Operator Alpha to call 98765 00002' });
  const res = applyDraftEdit(
    original,
    { title: 'Ask Helper Gamma to inspect', 'raci.R': '10003', 'raci.C': ['10002'] },
    team
  );
  const log = buildManualEditLog({
    after: res.draft,
    changedFields: res.changedFields,
    teamMembers: roster,
    tenantId: 'default',
    nowIso: '2026-11-03T06:00:00.000Z',
  })!;
  assert.equal(log.stage, 'OWNER_EDIT');
  assert.equal(log.tenantId, 'default');
  assert.equal(log.manualEdits?.length, 3);
  const byField = Object.fromEntries((log.manualEdits || []).map((e) => [e.field, e]));
  assert.equal(byField['raci.R'].aiValue, 'P2');
  assert.equal(byField['raci.R'].ownerValue, 'P4');
  assert.deepEqual(byField['raci.C'].ownerValue, ['P3']);
  assert.deepEqual(byField['raci.C'].aiValue, []);
  const serialized = JSON.stringify(log);
  for (const forbidden of ['Operator Alpha', 'Helper Gamma', 'Lead Beta', '98765', '10001', '10003']) {
    assert.ok(!serialized.includes(forbidden), `log leaks ${forbidden}`);
  }
  assert.equal(buildManualEditLog({ after: original, changedFields: [], teamMembers: roster, nowIso: '2026-11-03T06:00:00.000Z' }), null);

  // Owner-added task: AI value is null.
  const blank = newBlankDraft({ head: null, todayDate: '2026-11-03', idSuffix: 'x' });
  const filled = applyDraftEdit(blank, { title: 'Hand task', 'raci.R': '10001' }, team);
  const blankLog = buildManualEditLog({ after: filled.draft, changedFields: filled.changedFields, teamMembers: roster, nowIso: '2026-11-03T06:00:00.000Z' })!;
  assert.ok(blankLog.manualEdits?.every((e) => e.aiValue === null));
});

test('AI refinement keeps owner edits unless the owner explicitly asked to change them', () => {
  const edited = applyDraftEdit(draft(), { title: 'Owner title', 'raci.R': '10003' }, team).draft;
  const aiRefined = draft({ title: 'AI title', raci: { R: '10001', A: '10002', C: [], I: [] }, microSteps: ['AI step'] });

  const kept = mergeRefinedDrafts({ previous: [edited], refined: [aiRefined], teamMembers: team })[0];
  assert.equal(kept.title, 'Owner title');
  assert.equal(kept.raci.R, '10003');
  assert.deepEqual(kept.microSteps, ['AI step']); // not edited by the owner -> AI may change it
  assert.deepEqual(kept.ownerEditedFields, ['title', 'raci.R']);

  const overridden = mergeRefinedDrafts({
    previous: [edited],
    refined: [aiRefined],
    overrides: [{ tempId: 'draft-1', field: 'raci.R', quote: 'give it to P2 instead' }],
    teamMembers: team,
  })[0];
  assert.equal(overridden.title, 'Owner title');
  assert.equal(overridden.raci.R, '10001');
  assert.deepEqual(overridden.ownerEditedFields, ['title']);
  assert.match(overridden.aiOverrideNotes?.[0] || '', /Changed Responsible because you asked: "give it to P2 instead"/);
});

test('AI refinement: deleted tasks stay deleted, owner-added tasks stay, renamed head keeps its title', () => {
  const ownerTask = { ...newBlankDraft({ head: null, todayDate: '2026-11-03', idSuffix: 'o' }), title: 'Owner task', raci: { R: '10001', A: '10002', C: [], I: [] }, wbsHeadId: 'HEAD-1' };
  const previous = renameHead(
    removeDraftFromHead(head([draft(), draft({ tempId: 'draft-2', title: 'To delete' }), ownerTask]), 'draft-2'),
    'Owner plan name'
  );
  const refined = head([draft({ title: 'Inspect unit' }), draft({ tempId: 'draft-2', title: 'To delete' }), draft({ tempId: 'draft-3', title: 'New AI task' })], {
    title: 'AI plan name',
  });

  const merged = mergeRefinedHead({ previous, refined, teamMembers: team });
  assert.equal(merged.title, 'Owner plan name');
  assert.deepEqual(merged.subTasks.map((t) => t.tempId), ['draft-1', 'draft-3', ownerTask.tempId]);
  assert.deepEqual(merged.ownerDeletedTempIds, ['draft-2']);

  const explicit = mergeRefinedHead({
    previous,
    refined,
    overrides: [
      { tempId: 'draft-2', field: 'restoreTask', quote: 'bring back the deleted step' },
      { tempId: ownerTask.tempId, field: 'removeTask', quote: 'drop my extra task' },
      { tempId: 'HEAD-1', field: 'headTitle', quote: 'rename the plan' },
    ],
    teamMembers: team,
  });
  assert.equal(explicit.title, 'AI plan name');
  assert.deepEqual(explicit.subTasks.map((t) => t.tempId), ['draft-1', 'draft-2', 'draft-3']);
});

test('normalizeOwnerEditOverrides drops malformed entries', () => {
  assert.deepEqual(normalizeOwnerEditOverrides(null), []);
  assert.deepEqual(
    normalizeOwnerEditOverrides([
      { tempId: 'd1', field: 'title', quote: 'x' },
      { tempId: '', field: 'title' },
      { tempId: 'd2', field: 'notAField' },
      'junk',
      { tempId: 'HEAD-1', field: 'headTitle' },
    ]),
    [
      { tempId: 'd1', field: 'title', quote: 'x' },
      { tempId: 'HEAD-1', field: 'headTitle', quote: undefined },
    ]
  );
});

test('AI refinement without echoed tempIds: drafts are matched by title', () => {
  const edited = applyDraftEdit(draft({ tempId: 'draft-1', title: 'Inspect unit' }), { 'raci.R': '10003' }, team).draft;
  const aiNoId = draft({ tempId: 'draft-NEW-0', title: 'inspect UNIT', raci: { R: '10001', A: '10002', C: [], I: [] } });
  const merged = mergeRefinedDrafts({ previous: [edited], refined: [aiNoId], teamMembers: team });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tempId, 'draft-1');
  assert.equal(merged[0].raci.R, '10003');
});

test('an untouched release choice is not recorded as an edit (missing release means "Now")', () => {
  const noRelease = draft({ release: undefined });
  const res = applyDraftEdit(
    noRelease,
    { release: { mode: 'NOW', releaseAt: null, afterTaskCode: null, afterTrigger: 'FULL_COMPLETION', delayMinutes: 0, requireOwnerConfirm: false } },
    team
  );
  assert.deepEqual(res.changedFields, []);
  const changed = applyDraftEdit(noRelease, { release: { mode: 'WHEN_FREE' } }, team);
  assert.deepEqual(changed.changedFields, ['release']);
});

test('blank short tag is filled from the title; new tasks never default to a past due date', () => {
  const blank = newBlankDraft({ head: head([], { tentativeDeadline: '2026-11-01' }), todayDate: '2026-11-03', idSuffix: 'p' });
  assert.equal(blank.dueDate, '2026-11-03');
  const future = newBlankDraft({ head: head([], { tentativeDeadline: '2026-11-09' }), todayDate: '2026-11-03', idSuffix: 'f' });
  assert.equal(future.dueDate, '2026-11-09');
  const filled = applyDraftEdit(blank, { title: 'Buy spares: two fuses', 'raci.R': '10001' }, team).draft;
  assert.equal(filled.shortTag, 'Buy spares');
  assert.ok(!filled.ownerEditedFields?.includes('shortTag'));
  const owned = applyDraftEdit(filled, { shortTag: 'Mine' }, team).draft;
  assert.equal(applyDraftEdit(owned, { title: 'Other title' }, team).draft.shortTag, 'Mine');
});

test('refining a quick task keeps the owner\'s edits, like plans', async () => {
  const { mergeRefinedQuickDraft, quickDraftAsHead, isQuickDraftHeadId } = await import('./draftEditing');
  const quick = applyDraftEdit(
    draft({ tempId: 'quick-1', wbsHeadId: null }),
    { 'raci.R': '10003', outboundWhatsappPreview: 'Please check the unit gauge and send a photo. Thanks!' },
    team
  ).draft;

  const asHead = quickDraftAsHead(quick);
  assert.equal(asHead.headId, 'QUICK-quick-1');
  assert.equal(isQuickDraftHeadId(asHead.headId), true);
  assert.equal(isQuickDraftHeadId('HEAD-1'), false);
  assert.deepEqual(asHead.subTasks[0].ownerEditedFields, ['outboundWhatsappPreview', 'raci.R']);

  // AI echoes the tempId and changes R, the message and the due date: owner edits come back.
  const aiRefined = draft({
    tempId: 'quick-1',
    wbsHeadId: null,
    dueDate: '2026-11-08',
    raci: { R: '10001', A: '10002', C: [], I: [] },
    outboundWhatsappPreview: 'AI text',
  });
  const merged = mergeRefinedQuickDraft({ previous: quick, refined: aiRefined, teamMembers: team })!;
  assert.equal(merged.raci.R, '10003');
  assert.equal(merged.outboundWhatsappPreview, 'Please check the unit gauge and send a photo. Thanks!');
  assert.equal(merged.messageIsCustom, true);
  assert.equal(merged.dueDate, '2026-11-08'); // not edited by the owner -> AI may change it
  assert.equal(merged.wbsHeadId, null);

  // Explicitly asked: the AI's value wins and a note explains why.
  const asked = mergeRefinedQuickDraft({
    previous: quick,
    refined: aiRefined,
    overrides: [{ tempId: 'quick-1', field: 'raci.R', quote: 'give it to P2' }],
    teamMembers: team,
  })!;
  assert.equal(asked.raci.R, '10001');
  assert.match(asked.aiOverrideNotes?.[0] || '', /Changed Responsible because you asked/);

  // AI did not echo the tempId but kept the title: still the same task.
  const noId = mergeRefinedQuickDraft({
    previous: quick,
    refined: { ...aiRefined, tempId: 'draft-new-0' },
    teamMembers: team,
  })!;
  assert.equal(noId.tempId, 'quick-1');
  assert.equal(noId.raci.R, '10003');

  // A different new quick task is not merged.
  assert.equal(
    mergeRefinedQuickDraft({ previous: quick, refined: draft({ tempId: 'draft-new-1', title: 'Something else' }), teamMembers: team }),
    null
  );
});
