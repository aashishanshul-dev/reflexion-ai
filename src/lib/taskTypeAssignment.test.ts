import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnonymizedMeditatePrompt,
  buildRosterLine,
  buildSlotDirectory,
  buildTaskTypeLine,
  countOpenTasksByPhone,
  resolveTaskTypeOwner,
} from './promptBuilder';
import { buildAnonymizedPlannerPrompt } from './meditateV2';
import { normalizeTaskTypeAssignment } from './taskTypeAssignment';
import { buildWorkspaceFromSetup, emptySetupAnswers } from './setupWizard';
import { CategorySop, Task, TeamMember } from '../types/ops';

function member(phone: string, slotId: string, name: string, extra: Partial<TeamMember> = {}): TeamMember {
  return {
    phone,
    slotId,
    name,
    roleTitle: 'Team Member',
    authorityLevel: 'STAFF',
    skills: [],
    maxActiveTasks: 2,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    dailyOverviewTime: '09:00',
    isOnLeave: false,
    lastInboundAt: '2026-11-14T00:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: { assigned: 0, completed: 0, partial: 0, overdueCount: 0, totalWorkHoursReplyMins: 0, replyCount: 0 },
    ...extra,
  };
}

const OWNER = member('911000000001', 'P1', 'Alpha Owner', { authorityLevel: 'OWNER', maxActiveTasks: 5 });
const DEF = member('911000000002', 'P2', 'Bravo Person', {
  responsibilities: 'Buys supplies. Alpha Owner asks Bravo to call 911000000003 for quotes.',
});
const BACKUP = member('911000000003', 'P3', 'Charlie Person', { responsibilities: 'Handles repairs and the front desk.' });
const ROSTER = [OWNER, DEF, BACKUP];

function openTask(phone: string, code: string): Task {
  return { taskCode: code, raci: { R: phone, A: OWNER.phone, C: [], I: [] }, isFrozen: true, status: 'IN_PROGRESS' } as unknown as Task;
}

const SOP: CategorySop = {
  categoryId: 'PURCHASES',
  categoryName: 'Purchases',
  defaultClassification: 'MINOR',
  sopSystemPrompt: '',
  defaultMicroSteps: ['Get quote'],
  defaultResponsiblePhone: DEF.phone,
  backupResponsiblePhone: BACKUP.phone,
  spendApprovalRequired: true,
};

test('countOpenTasksByPhone: only frozen, open, non-draft tasks count', () => {
  const counts = countOpenTasksByPhone([
    openTask(DEF.phone, 'T1'),
    { ...openTask(DEF.phone, 'T2'), status: 'COMPLETED' } as Task,
    { ...openTask(DEF.phone, 'T3'), isFrozen: false } as Task,
    { ...openTask(DEF.phone, 'T4'), status: 'STAGING_DRAFT' } as Task,
  ]);
  assert.equal(counts.get(DEF.phone), 1);
});

test('resolveTaskTypeOwner: default when available', () => {
  const dir = buildSlotDirectory(ROSTER);
  const r = resolveTaskTypeOwner(SOP, dir, new Map());
  assert.deepEqual([r.slotId, r.source, r.phone], ['P2', 'DEFAULT', DEF.phone]);
});

test('resolveTaskTypeOwner: backup when default is on leave', () => {
  const dir = buildSlotDirectory([OWNER, { ...DEF, isOnLeave: true }, BACKUP]);
  const r = resolveTaskTypeOwner(SOP, dir, new Map());
  assert.equal(r.slotId, 'P3');
  assert.equal(r.source, 'BACKUP');
  assert.match(r.reason, /P2 on leave -> backup P3/);
});

test('resolveTaskTypeOwner: backup when default is at task limit', () => {
  const dir = buildSlotDirectory(ROSTER);
  const counts = countOpenTasksByPhone([openTask(DEF.phone, 'T1'), openTask(DEF.phone, 'T2')]);
  const r = resolveTaskTypeOwner(SOP, dir, counts);
  assert.equal(r.slotId, 'P3');
  assert.match(r.reason, /P2 at task limit 2\/2/);
});

test('resolveTaskTypeOwner: nobody when default and backup are both unavailable', () => {
  const dir = buildSlotDirectory([OWNER, { ...DEF, isOnLeave: true }, BACKUP]);
  const counts = countOpenTasksByPhone([openTask(BACKUP.phone, 'T1'), openTask(BACKUP.phone, 'T2')]);
  const r = resolveTaskTypeOwner(SOP, dir, counts);
  assert.equal(r.slotId, null);
  assert.equal(r.source, 'NONE');
  assert.match(r.reason, /P2 on leave; P3 at task limit/);
});

test('resolveTaskTypeOwner: removed people and missing settings are ignored', () => {
  const dir = buildSlotDirectory(ROSTER);
  const removed = resolveTaskTypeOwner({ defaultResponsiblePhone: '919999999999', backupResponsiblePhone: BACKUP.phone }, dir, new Map());
  assert.equal(removed.slotId, 'P3');
  const none = resolveTaskTypeOwner({}, dir, new Map());
  assert.deepEqual([none.slotId, none.source, none.reason], [null, 'NONE', 'no default set']);
});

test('buildRosterLine: includes scrubbed "Handles" text only when set', () => {
  const dir = buildSlotDirectory(ROSTER);
  const line = buildRosterLine(dir.phoneToEntry.get(DEF.phone)!, 1, dir);
  assert.match(line, /ActiveWorkload: 1\/2 \| Handles: "Buys supplies\. P1 asks P2 to call P3 for quotes\."/);
  assert.doesNotMatch(line, /Alpha|Bravo|911000000003/);
  const ownerLine = buildRosterLine(dir.phoneToEntry.get(OWNER.phone)!, 0, dir);
  assert.doesNotMatch(ownerLine, /Handles:/);
});

test('buildTaskTypeLine: default, backup, assign-now and spend approval; unchanged when not set', () => {
  const dir = buildSlotDirectory([OWNER, { ...DEF, isOnLeave: true }, BACKUP]);
  const line = buildTaskTypeLine(SOP, dir, new Map());
  assert.match(line, /Default R: P2 \| Backup R: P3 \| Assign now: P3 \(P2 on leave -> backup P3\) \| Spending needs approval: yes/);
  const plain = buildTaskTypeLine({ ...SOP, defaultResponsiblePhone: null, backupResponsiblePhone: null, spendApprovalRequired: false }, dir, new Map());
  assert.equal(plain, '- PURCHASES (MINOR):  | Default Steps: Get quote');
});

test('both planner prompts carry Handles, task-type owners and the selection rules with no PII', () => {
  const common = {
    brainDump: 'Order cleaning supplies for the week.',
    teamMembers: ROSTER,
    tasks: [] as Task[],
    categorySops: [SOP],
    systemMemory: [],
  };
  const legacy = buildAnonymizedMeditatePrompt(common);
  const v2 = buildAnonymizedPlannerPrompt(common);
  for (const built of [legacy, v2]) {
    assert.equal(built.piiAudit.clean, true, built.piiAudit.violations.join(', '));
    assert.match(built.prompt, /Handles: "Handles repairs and the front desk\."/);
    assert.match(built.prompt, /PURCHASES .*Assign now: P2 \(default P2\) \| Spending needs approval: yes/);
    assert.match(built.systemInstruction, /RESPONSIBLE \(R\) SELECTION ORDER/);
    assert.match(built.systemInstruction, /"Handles" text/);
  }
});

test('normalizeTaskTypeAssignment: unknown/blank become null, backup equal to default is dropped', () => {
  const roster = [DEF.phone, BACKUP.phone];
  assert.deepEqual(normalizeTaskTypeAssignment({ defaultPhone: DEF.phone, backupPhone: BACKUP.phone, spendApprovalRequired: true }, roster), {
    defaultResponsiblePhone: DEF.phone,
    backupResponsiblePhone: BACKUP.phone,
    spendApprovalRequired: true,
  });
  assert.deepEqual(normalizeTaskTypeAssignment({ defaultPhone: DEF.phone, backupPhone: DEF.phone }, roster), {
    defaultResponsiblePhone: DEF.phone,
    backupResponsiblePhone: null,
    spendApprovalRequired: false,
  });
  assert.deepEqual(normalizeTaskTypeAssignment({ defaultPhone: '', backupPhone: '919999999999' }, roster), {
    defaultResponsiblePhone: null,
    backupResponsiblePhone: null,
    spendApprovalRequired: false,
  });
});

test('buildWorkspaceFromSetup: carries "What they handle" (trimmed), blank stays empty', () => {
  const a = emptySetupAnswers('UTC');
  a.business = { ...a.business, businessName: 'Biz', businessType: 'Type' };
  a.owner = { ...a.owner, name: 'Owner One', roleTitle: 'Owner', phone: '919000000001', responsibilities: '  Approvals and money. ' };
  a.people = [
    { ...a.owner, name: 'Staff Two', roleTitle: 'Staff', phone: '919000000002', authorityLevel: 'STAFF', responsibilities: undefined },
  ];
  const ws = buildWorkspaceFromSetup(a, 'uid-1', '2026-11-14T00:00:00.000Z');
  assert.equal(ws.team_members['919000000001'].responsibilities, 'Approvals and money.');
  assert.equal(ws.team_members['919000000002'].responsibilities, '');
});

test('buildRosterLine: includes scrubbed strengths and weaknesses, none when empty', () => {
  const withSW = member('911000000004', 'P4', 'Delta Person', {
    strengths: ['vendor relations'],
    weaknesses: ['Charlie Person is slow at writing'],
  });
  const dir = buildSlotDirectory([OWNER, DEF, BACKUP, withSW]);
  const line = buildRosterLine(dir.phoneToEntry.get(withSW.phone)!, 0, dir);
  assert.match(line, /Strengths: \[vendor relations\]/);
  // Name inside a weakness phrase is scrubbed to a slot id.
  assert.match(line, /Weaknesses: \[P3 is slow at writing\]/);
  assert.doesNotMatch(line, /Charlie/);
  const plainLine = buildRosterLine(dir.phoneToEntry.get(OWNER.phone)!, 0, dir);
  assert.doesNotMatch(plainLine, /Strengths:|Weaknesses:/);
});

test('both planner prompts carry strengths, weaknesses, the assignment order and assignmentReason, with no PII', () => {
  const roster = [
    OWNER,
    member('911000000002', 'P2', 'Bravo Person', { strengths: ['vendor relations'], weaknesses: ['shy on calls'] }),
    member('911000000003', 'P3', 'Charlie Person', { responsibilities: 'Repairs.' }),
  ];
  const common = { brainDump: 'Order supplies.', teamMembers: roster, tasks: [] as Task[], categorySops: [SOP], systemMemory: [] };
  const legacy = buildAnonymizedMeditatePrompt(common);
  const v2 = buildAnonymizedPlannerPrompt(common);
  for (const built of [legacy, v2]) {
    assert.equal(built.piiAudit.clean, true, built.piiAudit.violations.join(', '));
    assert.match(built.prompt, /Strengths: \[vendor relations\]/);
    assert.match(built.prompt, /Weaknesses: \[shy on calls\]/);
    assert.match(built.systemInstruction, /RESPONSIBLE \(R\) SELECTION ORDER/);
    assert.match(built.systemInstruction, /AVOID anyone whose Weaknesses fit the work/);
    assert.match(built.systemInstruction, /WEAKNESS SUPPORT STEP/);
    assert.match(built.systemInstruction, /assignmentReason/);
    // The assignment order the user asked for: named -> default -> backup -> best match.
    assert.match(built.systemInstruction, /If the owner names who should do it/);
    assert.match(built.systemInstruction, /Assign now: Px/);
  }
});
