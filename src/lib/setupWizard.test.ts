import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkspaceFromSetup,
  categoryIdFromName,
  emptySetupAnswers,
  normalizeSetupPhone,
  SetupAnswers,
  validateSetupStep,
} from './setupWizard';

function filled(): SetupAnswers {
  const a = emptySetupAnswers('Asia/Kolkata');
  a.business = { ...a.business, businessName: 'Acme Works', businessType: 'Services', businessDescription: 'We fix things.' };
  a.owner = { ...a.owner, name: 'Owner Prime', roleTitle: 'Founder', phone: '+91 90000 00001', howIWork: 'I approve spends.' };
  a.people = [
    { ...a.owner, name: 'Operator Alpha', roleTitle: 'Technician', phone: '91 90000 00002', authorityLevel: 'STAFF', maxActiveTasks: 2 },
    { ...a.owner, name: 'Lead Beta', roleTitle: 'Supervisor', phone: '919000000003', authorityLevel: 'SUPERVISOR', maxActiveTasks: 4 },
  ];
  a.taskTypes = [
    { name: 'Site visits', defaultClassification: 'MAJOR', defaultSteps: ['Check in', ' ', 'Send photo'] },
    { name: 'Purchases', defaultClassification: 'MINOR', defaultSteps: [] },
  ];
  return a;
}

test('validateSetupStep: each step lists what is missing', () => {
  const empty = emptySetupAnswers('Asia/Kolkata');
  assert.deepEqual(validateSetupStep('BUSINESS', empty), ['Add your business name.', 'Say what kind of business it is.']);
  assert.ok(validateSetupStep('ROLE', empty).some((e) => /add a name/.test(e)));
  assert.ok(validateSetupStep('ROLE', empty).some((e) => /WhatsApp number/.test(e)));
  assert.deepEqual(validateSetupStep('PEOPLE', empty), ['Add at least one person who will receive tasks.']);
  assert.deepEqual(validateSetupStep('TASK_TYPES', empty), []); // task types are optional

  const a = filled();
  for (const step of ['BUSINESS', 'ROLE', 'PEOPLE', 'TASK_TYPES'] as const) {
    assert.deepEqual(validateSetupStep(step, a), [], step);
  }
  const dupe = filled();
  dupe.people[1].phone = '+91-90000-00002';
  assert.ok(validateSetupStep('PEOPLE', dupe).includes('Each person needs a different WhatsApp number.'));
  const badShift = filled();
  badShift.owner.workShiftStart = '9am';
  assert.ok(validateSetupStep('ROLE', badShift).some((e) => /09:00/.test(e)));
  const badType = filled();
  badType.taskTypes.push({ name: 'site visits', defaultClassification: 'MINOR', defaultSteps: [] });
  assert.ok(validateSetupStep('TASK_TYPES', badType).includes('Each task type needs a different name.'));
});

test('buildWorkspaceFromSetup: owner, people and task types from the answers; no demo data', () => {
  const ws = buildWorkspaceFromSetup(filled(), 'uid-1', '2026-11-03T06:00:00.000Z');
  assert.equal(ws.tenantId, 'uid-1');
  const members = Object.values(ws.team_members);
  assert.deepEqual(members.map((m) => [m.phone, m.authorityLevel, m.slotId]), [
    ['919000000001', 'OWNER', 'P1'],
    ['919000000002', 'STAFF', 'P2'],
    ['919000000003', 'SUPERVISOR', 'P3'],
  ]);
  assert.ok(members.every((m) => m.tenantId === 'uid-1'));
  assert.equal(ws.owner_profile.defaultAccountablePhone, '919000000001');
  assert.equal(ws.owner_profile.personalOperatingPrompt, 'I approve spends.');
  assert.equal(ws.business_profile.businessName, 'Acme Works');
  assert.equal(ws.business_profile.timezone, 'Asia/Kolkata');
  assert.deepEqual(ws.category_sops.map((c) => [c.categoryId, c.categoryName, c.defaultMicroSteps]), [
    ['SITE_VISITS', 'Site visits', ['Check in', 'Send photo']],
    ['PURCHASES', 'Purchases', []],
  ]);
  assert.ok(ws.category_sops.every((c) => c.tenantId === 'uid-1'));
  for (const empty of [ws.tasks, ws.wbs_heads, ws.umbrella_agendas, ws.whatsapp_messages, ws.boss_review_queue, ws.notes, ws.system_memory, ws.ai_logs, ws.sample_brain_dumps]) {
    assert.equal(empty.length, 0);
  }
  assert.deepEqual(ws.principal_prompts, { planningPrompt: '', evaluationPrompt: '' });

  // A second person marked OWNER becomes MANAGER: only the signed-in owner is OWNER.
  const twoOwners = filled();
  twoOwners.people[0].authorityLevel = 'OWNER';
  assert.equal(buildWorkspaceFromSetup(twoOwners, 'uid-1', '2026-11-03T06:00:00.000Z').team_members['919000000002'].authorityLevel, 'MANAGER');

  // No task types -> one generic type so the AI always has a category.
  const noTypes = filled();
  noTypes.taskTypes = [];
  assert.deepEqual(buildWorkspaceFromSetup(noTypes, 'uid-1', '2026-11-03T06:00:00.000Z').category_sops.map((c) => c.categoryId), ['GENERAL']);
});

test('helpers: phone digits and category ids', () => {
  assert.equal(normalizeSetupPhone('+91 (900) 000-0001'), '919000000001');
  const taken = new Set<string>();
  assert.equal(categoryIdFromName('Site visits', taken), 'SITE_VISITS');
  assert.equal(categoryIdFromName('site-visits!', taken), 'SITE_VISITS_2');
  assert.equal(categoryIdFromName('***', taken), 'TYPE');
});
