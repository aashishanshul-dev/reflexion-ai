import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoSeedState, validateDemoLeadInput } from './demoData.ts';
import { normalizeOpsDatabaseState } from '../services/dataService.ts';

test('validateDemoLeadInput: accepts and normalizes valid guest details', () => {
  const res = validateDemoLeadInput(
    {
      name: '  Riya Verma  ',
      email: ' Riya.Verma@OfficeClient.IN ',
      phone: '+91 98201 55443',
    },
    '2026-11-15T10:00:00.000Z'
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.lead, {
    name: 'Riya Verma',
    email: 'riya.verma@officeclient.in',
    phone: '919820155443',
    registeredAt: '2026-11-15T10:00:00.000Z',
  });
});

test('validateDemoLeadInput: accepts international numbers and rejects invalid inputs', () => {
  const intl = validateDemoLeadInput({
    name: 'David Chen',
    email: 'dchen@officepark.com',
    phone: '+1 (415) 555-0192',
  });
  assert.equal(intl.ok, true);

  assert.equal(validateDemoLeadInput({ name: 'A', email: 'a@b.com', phone: '9820155443' }).ok, false);
  assert.equal(validateDemoLeadInput({ name: 'Riya', email: 'not-an-email', phone: '9820155443' }).ok, false);
  assert.equal(validateDemoLeadInput({ name: 'Riya', email: 'riya@co.in', phone: '12345' }).ok, false);
  assert.equal(validateDemoLeadInput({ name: 'Riya', email: 'riya@co.in', phone: '12345678901234567' }).ok, false);
});

test('createDemoSeedState: uses BlueDrop Water Supplies and contains zero hospitality or tooling jargon', () => {
  const fixedNow = '2026-11-15T10:30:00.000Z';
  const seed = createDemoSeedState(fixedNow);

  assert.equal(seed.business_profile.businessName, 'BlueDrop Water Supplies');
  const serialized = JSON.stringify(seed);
  assert.equal(
    /Heritage Lawn|Amargarh|Siddharth|Banquet|Resort|Hospitality|Apex Precision|Carbide|Metrology|Endmill|Kennametal|GST reconciliation|variance/i.test(
      serialized
    ),
    false
  );
});

test('createDemoSeedState: 7 connected team members with symmetric links and zero overlapping cards', () => {
  const fixedNow = '2026-11-15T10:30:00.000Z';
  const seed = createDemoSeedState(fixedNow);
  const members = Object.values(seed.team_members);
  assert.equal(members.length, 7);

  for (const m of members) {
    if (m.reportsToPhone) {
      assert.notEqual(m.reportsToPhone, m.phone);
      assert.ok(seed.team_members[m.reportsToPhone]);
    }
    if (m.partnerOfPhone) {
      assert.equal(seed.team_members[m.partnerOfPhone]?.partnerOfPhone, m.phone);
    }
    for (const peerPhone of m.worksCloselyWithPhones || []) {
      assert.ok(seed.team_members[peerPhone]);
      assert.ok((seed.team_members[peerPhone].worksCloselyWithPhones || []).includes(m.phone));
    }
    assert.ok(m.orgChartPosition);
    assert.equal(m.strengths?.length, 2);
    assert.equal(m.weaknesses?.length, 1);
  }

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i].orgChartPosition!;
      const b = members[j].orgChartPosition!;
      const overlapsX = Math.abs(a.x - b.x) < 220;
      const overlapsY = Math.abs(a.y - b.y) < 110;
      assert.equal(overlapsX && overlapsY, false);
    }
  }
});

test('createDemoSeedState: BlueDrop 5 SOPs, tasks T-201..T-207, REV-201, and queued Nitin WhatsApp reply', () => {
  const fixedNow = '2026-11-15T10:30:00.000Z';
  const seed = createDemoSeedState(fixedNow);

  assert.equal(seed.category_sops.length, 5);
  for (const sop of seed.category_sops) {
    assert.ok(sop.defaultMicroSteps.length >= 3 && sop.defaultMicroSteps.length <= 5);
    assert.ok(sop.defaultResponsiblePhone && seed.team_members[sop.defaultResponsiblePhone]);
    assert.ok(sop.backupResponsiblePhone && seed.team_members[sop.backupResponsiblePhone]);
  }

  assert.equal(seed.tasks.length, 7);
  const t201 = seed.tasks.find((t) => t.taskCode === 'T-201');
  assert.equal(t201?.status, 'IN_PROGRESS');
  assert.equal(t201?.raci.R, '919820100006'); // Nitin

  const t202 = seed.tasks.find((t) => t.taskCode === 'T-202');
  assert.equal(t202?.status, 'LOCKED_BY_DEPENDENCY');
  assert.equal(t202?.dependency?.dependsOnTaskCode, 'T-201');
  assert.equal(t202?.raci.A, '919820100003'); // Rohan

  const t204 = seed.tasks.find((t) => t.taskCode === 'T-204');
  assert.equal(t204?.status, 'SCHEDULED');
  assert.equal(t204?.raci.R, '919820100007'); // Kavita
  assert.ok(t204?.release?.releaseAt);
  assert.ok(Date.parse(t204!.release!.releaseAt!) < Date.parse(fixedNow));

  assert.ok(seed.boss_review_queue.some((r) => r.reviewId === 'REV-201' && r.status === 'OPEN' && r.taskCode === 'T-203'));
  assert.equal(
    seed.inbound_message_buffer['919820100006']?.messages[0]?.textContent,
    'Van left, 20 jars loaded, remaining 20 in second trip.'
  );
  assert.equal(seed.sample_brain_dumps.length, 3);

  const normalized = normalizeOpsDatabaseState(seed, createDemoSeedState(fixedNow));
  assert.equal(Object.keys(normalized.team_members).length, 7);
  assert.equal(normalized.tasks.length, 7);
});

test('normalizeOpsDatabaseState ignores old saved meditateEngine and user-override values', () => {
  const seed = createDemoSeedState('2026-11-16T04:30:00.000Z');
  const legacySaved = {
    ...seed,
    model_tuning: {
      ...seed.model_tuning,
      meditateEngine: 'legacy' as const,
      meditateEngineUserSet: true,
    },
  };
  const normalized = normalizeOpsDatabaseState(legacySaved, createDemoSeedState('2026-11-16T04:30:00.000Z'));
  assert.equal(normalized.model_tuning.meditateEngine, 'v2');
  assert.equal(normalized.model_tuning.meditateEngineUserSet, false);
});
