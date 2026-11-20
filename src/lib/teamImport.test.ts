import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyImport,
  buildImportPreview,
  canConfirmImport,
  isValidIndianPhone,
  normalizeName,
  parseTeamSetupFile,
  restoreImportBackup,
  TeamSetupFile,
} from './teamImport';
import { createInitialSeedState } from './seedData';
import { OpsDatabaseState, Task, TeamMember } from '../types/ops';

function member(phone: string, name: string, extra: Partial<TeamMember> = {}): TeamMember {
  return {
    phone,
    slotId: 'P1',
    name,
    roleTitle: 'Role',
    authorityLevel: 'STAFF',
    skills: [],
    maxActiveTasks: 3,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    dailyOverviewTime: '09:00',
    isOnLeave: false,
    lastInboundAt: '2026-11-15T00:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: { assigned: 0, completed: 0, partial: 0, overdueCount: 0, totalWorkHoursReplyMins: 0, replyCount: 0 },
    ...extra,
  };
}

/** A workspace with the owner "Aashish Garg" (two a's), Neha, one General task type, and a task. */
function baseState(): OpsDatabaseState {
  const s = createInitialSeedState();
  return {
    ...s,
    team_members: {
      '919000000001': member('919000000001', 'Aashish Garg', { slotId: 'P1', authorityLevel: 'OWNER', roleTitle: 'Owner' }),
      '919000000002': member('919000000002', 'Neha Agarwal', { slotId: 'P2', authorityLevel: 'MANAGER', roleTitle: 'Co-Founder' }),
    },
    category_sops: [
      { categoryId: 'GENERAL', categoryName: 'General', defaultClassification: 'MINOR', sopSystemPrompt: '', defaultMicroSteps: ['Do it'] },
      { categoryId: 'PURCHASE_PROCUREMENT', categoryName: 'Purchase & procurement', defaultClassification: 'MINOR', sopSystemPrompt: '', defaultMicroSteps: ['old step'] },
    ],
    tasks: [
      { taskCode: 'T-1', raci: { R: '919000000002', A: '919000000001', C: [], I: [] }, status: 'IN_PROGRESS', isFrozen: true, title: 'Existing task', microSteps: [] } as unknown as Task,
    ],
  };
}

const FILE: TeamSetupFile = {
  format: 'opscommand-team-setup',
  version: 1,
  people: [
    { name: 'Ashish Garg', authority: 'OWNER', language: 'English', roleTitle: 'Owner & ED', whatTheyHandle: 'Everything', strengths: ['Growth'], weaknesses: ['Bottleneck'], shiftStart: '09:00', shiftEnd: '21:00', maxActiveTasks: 10, reportsTo: null, partnerOf: null, worksCloselyWith: ['Neha Agarwal'] },
    { name: '  neha   agarwal ', authority: 'MANAGER', language: 'English', roleTitle: 'Co-founder', whatTheyHandle: 'Payments', shiftStart: '08:00', shiftEnd: '22:00', maxActiveTasks: 8, reportsTo: null, partnerOf: 'Ashish Garg', worksCloselyWith: ['Ashish Garg', 'Mohan Ram'] },
    { name: 'Mohan Ram', authority: 'MANAGER', language: 'Hinglish', roleTitle: 'Estate Manager', whatTheyHandle: 'Backend', shiftStart: '08:00', shiftEnd: '22:00', maxActiveTasks: 8, reportsTo: 'Ashish Garg', partnerOf: null, worksCloselyWith: ['Neha Agarwal'] },
  ],
  taskTypes: [
    { name: 'purchase & procurement', usually: 'MINOR', defaultResponsible: 'Mohan Ram', backup: 'Ashish Garg', approvalBeforeSpending: true, steps: ['Quote', 'Approve', 'Buy'] },
    { name: 'Development & renovation', usually: 'MAJOR', defaultResponsible: 'Mohan Ram', backup: null, approvalBeforeSpending: true, steps: ['Scope', 'Execute'] },
  ],
};

const NEW_PHONES = { 2: '9811122233' }; // Mohan Ram (index 2) gets a number

test('parseTeamSetupFile: rejects wrong format, accepts valid', () => {
  assert.equal(parseTeamSetupFile('{"format":"nope"}').ok, false);
  assert.equal(parseTeamSetupFile('not json').ok, false);
  const ok = parseTeamSetupFile(JSON.stringify(FILE));
  assert.equal(ok.ok, true);
});

test('normalizeName: case and extra spaces ignored', () => {
  assert.equal(normalizeName('  Neha   Agarwal '), normalizeName('neha agarwal'));
  assert.equal(normalizeName('MOHAN  ram'), 'mohan ram');
});

test('isValidIndianPhone: 10-digit mobile valid, junk invalid', () => {
  assert.equal(isValidIndianPhone('9811122233'), true);
  assert.equal(isValidIndianPhone('123'), false);
  assert.equal(isValidIndianPhone('1234567890'), false); // not 6-9 start
});

test('preview: owner maps to existing account by authority (name spelling differs), Neha matches, Mohan is new', () => {
  const preview = buildImportPreview(FILE, baseState(), NEW_PHONES, new Set());
  const owner = preview.people[0];
  assert.equal(owner.action, 'update');
  assert.equal(owner.isOwnerMapping, true);
  assert.equal(owner.matchedPhone, '919000000001');
  assert.equal(preview.people[1].action, 'update'); // Neha by normalized name
  assert.equal(preview.people[2].action, 'create'); // Mohan Ram
  assert.equal(preview.people[2].needsPhone, true);
});

test('preview: a reference to the owner file-name is NOT a problem (resolves to account); a bad name is', () => {
  const clean = buildImportPreview(FILE, baseState(), NEW_PHONES, new Set());
  assert.equal(clean.problems.length, 0); // "Ashish Garg" references resolve to Aashish's account

  const withBad: TeamSetupFile = {
    ...FILE,
    people: [...FILE.people, { name: 'Ramesh', authority: 'STAFF', reportsTo: 'Nobody Here', worksCloselyWith: [] }],
  };
  const bad = buildImportPreview(withBad, baseState(), { ...NEW_PHONES, 3: '9800000000' }, new Set());
  assert.ok(bad.problems.some((p) => /Nobody Here/.test(p.message)));
});

test('canConfirmImport: blocked until the new person has a valid phone or is skipped', () => {
  const state = baseState();
  const p0 = buildImportPreview(FILE, state, {}, new Set());
  assert.equal(canConfirmImport(p0, {}, new Set()), false); // Mohan has no number
  const p1 = buildImportPreview(FILE, state, NEW_PHONES, new Set());
  assert.equal(canConfirmImport(p1, NEW_PHONES, new Set()), true);
  const skip = new Set([2]);
  const p2 = buildImportPreview(FILE, state, {}, skip);
  assert.equal(canConfirmImport(p2, {}, skip), true); // skipped instead
});

test('applyImport: owner kept (name/phone/OWNER), existing phones kept, new phone stored as 91+digits, links resolved', () => {
  const state = baseState();
  const result = applyImport(FILE, state, NEW_PHONES, new Set(), { email: 'me@x.com' });
  const m = result.state.team_members;

  // Owner unchanged identity, updated fields, still OWNER.
  assert.ok(m['919000000001']);
  assert.equal(m['919000000001'].name, 'Aashish Garg'); // not renamed
  assert.equal(m['919000000001'].authorityLevel, 'OWNER');
  assert.equal(m['919000000001'].responsibilities, 'Everything');

  // New person stored under 91 + 10 digits, with a fresh slot (not P1/P2).
  assert.ok(m['919811122233']);
  assert.equal(m['919811122233'].name, 'Mohan Ram');
  assert.ok(!['P1', 'P2'].includes(m['919811122233'].slotId || ''));

  // Links resolved to phones; owner-name reference -> owner account.
  assert.equal(m['919000000002'].partnerOfPhone, '919000000001'); // Neha partnerOf Ashish -> Aashish
  assert.equal(m['919811122233'].reportsToPhone, '919000000001'); // Mohan reportsTo Ashish -> Aashish

  // Task type matched by name updated (kept id); new one created; General untouched.
  const sopNames = result.state.category_sops.map((c) => c.categoryName);
  assert.ok(sopNames.includes('General'));
  const proc = result.state.category_sops.find((c) => c.categoryId === 'PURCHASE_PROCUREMENT')!;
  assert.equal(proc.defaultResponsiblePhone, '919811122233'); // Mohan
  assert.equal(proc.backupResponsiblePhone, '919000000001'); // Ashish -> owner account
  assert.ok(sopNames.includes('Development & renovation'));

  assert.equal(result.counts.peopleCreated, 1);
  assert.equal(result.counts.peopleUpdated, 2);
});

test('applyImport: existing tasks are never changed', () => {
  const state = baseState();
  const before = JSON.stringify(state.tasks);
  const result = applyImport(FILE, state, NEW_PHONES, new Set());
  assert.equal(JSON.stringify(result.state.tasks), before);
});

test('applyImport: running twice does not create duplicates', () => {
  const state = baseState();
  const once = applyImport(FILE, state, NEW_PHONES, new Set()).state;
  // Second run: Mohan now exists by name, so he matches (no new phone needed).
  const twice = applyImport(FILE, once, {}, new Set()).state;
  assert.equal(Object.keys(twice.team_members).length, Object.keys(once.team_members).length);
  const names = Object.values(twice.team_members).map((m) => m.name.toLowerCase());
  assert.equal(names.filter((n) => n === 'mohan ram').length, 1);
  // Task types also stable.
  assert.equal(twice.category_sops.length, once.category_sops.length);
});

test('backup + undo: applyImport snapshots prior state; restore brings it back exactly', () => {
  const state = baseState();
  const result = applyImport(FILE, state, NEW_PHONES, new Set());
  assert.ok(result.state.last_import_backup);
  assert.equal(result.backup.team_members['919000000001'].name, 'Aashish Garg');
  assert.equal(Object.keys(result.backup.team_members).length, 2); // before Mohan was added

  const restored = restoreImportBackup(result.state, result.state.last_import_backup!);
  assert.equal(Object.keys(restored.team_members).length, 2);
  assert.equal(restored.category_sops.length, state.category_sops.length);
  assert.equal(restored.team_members['919811122233'], undefined); // new person gone
  assert.equal(restored.last_import_backup, null);
});

test('applyImport: skipped new person is not created and does not break links', () => {
  const state = baseState();
  const result = applyImport(FILE, state, {}, new Set([2])); // skip Mohan
  assert.equal(result.counts.peopleSkipped, 1);
  assert.equal(result.counts.peopleCreated, 0);
  // Neha's worksCloselyWith pointed at Mohan (skipped) -> that link is dropped, not an error.
  assert.ok(!(result.state.team_members['919000000002'].worksCloselyWithPhones || []).some((p) => p.startsWith('9811')));
});
