import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMemberProfileUpdate,
  applyPersonRemoval,
  applyPersonRemovalWithSops,
  autoArrangeOrgPositions,
  buildTeamGraph,
  checkReportsToChange,
  computeTeamCapacity,
  getPersonSopAssignments,
  getSymmetricClosePeerPhones,
  getSymmetricPartnerPhone,
  loadBand,
  matchesMemberSearch,
  openTasksForPhone,
  ORG_CARD_HEIGHT,
  ORG_CARD_WIDTH,
  overdueCountByPhone,
  syncPartnerLink,
  syncWorksCloselyLink,
} from './teamGraph';
import { CategorySop, Task, TeamMember } from '../types/ops';

function member(phone: string, name: string, extra: Partial<TeamMember> = {}): TeamMember {
  return {
    phone,
    slotId: 'P?',
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

function task(code: string, rPhone: string, over: Partial<Task> = {}): Task {
  return {
    taskCode: code,
    raci: { R: rPhone, A: '', C: [], I: [] },
    isFrozen: true,
    status: 'IN_PROGRESS',
    dueDate: '2026-12-01',
    ...over,
  } as unknown as Task;
}

const TODAY = '2026-11-15';

test('loadBand: green <70%, amber 70-100%, red >100%', () => {
  assert.equal(loadBand(0, 3), 'green');
  assert.equal(loadBand(2, 3), 'green'); // 66%
  assert.equal(loadBand(7, 10), 'amber'); // 70%
  assert.equal(loadBand(3, 3), 'amber'); // 100%
  assert.equal(loadBand(4, 3), 'red'); // >100%
});

test('computeTeamCapacity: under capacity, no warning', () => {
  const members = [member('1', 'A', { maxActiveTasks: 3 }), member('2', 'B', { maxActiveTasks: 3 })];
  const tasks = [task('T1', '1'), task('T2', '2')];
  const cap = computeTeamCapacity(members, tasks);
  assert.equal(cap.totalActive, 2);
  assert.equal(cap.totalCapacity, 6);
  assert.equal(cap.atLimitPhones.length, 0);
  assert.equal(cap.overloaded, false);
  assert.equal(cap.warning, '');
});

test('computeTeamCapacity: someone at their limit flags waiting + warning but not overload', () => {
  const members = [member('1', 'A', { maxActiveTasks: 2 }), member('2', 'B', { maxActiveTasks: 5 })];
  const tasks = [task('T1', '1'), task('T2', '1')]; // A at 2/2, B idle
  const cap = computeTeamCapacity(members, tasks);
  assert.deepEqual(cap.atLimitPhones, ['1']);
  assert.equal(cap.waitingCount, 0); // exactly at limit, none beyond
  assert.equal(cap.overloaded, false);
  assert.match(cap.warning, /at their task limit/);
});

test('computeTeamCapacity: total active over capacity -> overloaded with waiting count', () => {
  const members = [member('1', 'A', { maxActiveTasks: 1 }), member('2', 'B', { maxActiveTasks: 1 })];
  const tasks = [task('T1', '1'), task('T2', '1'), task('T3', '1'), task('T4', '2')];
  const cap = computeTeamCapacity(members, tasks);
  assert.equal(cap.totalActive, 4);
  assert.equal(cap.totalCapacity, 2);
  assert.equal(cap.overloaded, true);
  assert.equal(cap.waitingCount, 2); // 2 beyond A's cap of 1
  assert.match(cap.warning, /overloaded/);
});

test('computeTeamCapacity: on-leave people add no capacity', () => {
  const members = [member('1', 'A', { maxActiveTasks: 3, isOnLeave: true }), member('2', 'B', { maxActiveTasks: 3 })];
  const cap = computeTeamCapacity(members, []);
  assert.equal(cap.totalCapacity, 3);
});

test('overdueCountByPhone: counts only open, past-due tasks', () => {
  const tasks = [
    task('T1', '1', { dueDate: '2026-11-10' }), // overdue
    task('T2', '1', { dueDate: '2026-12-01' }), // future
    task('T3', '1', { dueDate: '2026-11-10', status: 'COMPLETED' }), // closed
  ];
  const counts = overdueCountByPhone(tasks, TODAY);
  assert.equal(counts.get('1'), 1);
});

test('buildTeamGraph: reports edge, dashed backup/close/partner, orphan detection', () => {
  const owner = member('1', 'Owner');
  const partner = member('2', 'Co', { partnerOfPhone: '1' });
  const mgrReport = member('3', 'Staff', { reportsToPhone: '1', worksCloselyWithPhones: ['2'] });
  const lonely = member('4', 'Lonely');
  const sops: CategorySop[] = [
    { categoryId: 'X', categoryName: 'X', defaultClassification: 'MINOR', sopSystemPrompt: '', defaultMicroSteps: [], defaultResponsiblePhone: '3', backupResponsiblePhone: '1' },
  ];
  const g = buildTeamGraph([owner, partner, mgrReport, lonely], sops, [], TODAY);

  assert.ok(g.edges.some((e) => e.kind === 'reports' && e.from === '1' && e.to === '3'));
  assert.ok(g.edges.some((e) => e.kind === 'partner'));
  assert.ok(g.edges.some((e) => e.kind === 'close'));
  assert.ok(g.edges.some((e) => e.kind === 'backup' && ((e.from === '3' && e.to === '1') || (e.from === '1' && e.to === '3'))));
  // Owner, partner, staff are all linked; only Lonely is an orphan.
  assert.deepEqual(g.orphanPhones, ['4']);
  // Depth: owner root 0, staff under owner 1.
  assert.equal(g.nodes.find((n) => n.phone === '3')!.depth, 1);
});

test('buildTeamGraph: reports-to cycle does not hang and depth stays finite', () => {
  const a = member('1', 'A', { reportsToPhone: '2' });
  const b = member('2', 'B', { reportsToPhone: '1' });
  const g = buildTeamGraph([a, b], [], [], TODAY);
  assert.ok(g.nodes.every((n) => Number.isFinite(n.depth)));
});

test('buildTeamGraph: node load band and top-2 strengths', () => {
  const m = member('1', 'A', { maxActiveTasks: 2, strengths: ['one', 'two', 'three'] });
  const g = buildTeamGraph([m], [], [task('T1', '1'), task('T2', '1')], TODAY);
  const node = g.nodes[0];
  assert.equal(node.band, 'amber'); // 2/2
  assert.deepEqual(node.topStrengths, ['one', 'two']);
});

test('openTasksForPhone + applyPersonRemoval: REASSIGN moves open tasks, clears links', () => {
  const members = {
    '1': member('1', 'A'),
    '2': member('2', 'B', { reportsToPhone: '1', worksCloselyWithPhones: ['1'], partnerOfPhone: '1' }),
  };
  const tasks = [task('T1', '1'), task('T2', '1', { status: 'COMPLETED' })];
  assert.equal(openTasksForPhone('1', tasks).length, 1);

  const out = applyPersonRemoval('1', { kind: 'REASSIGN', targetPhone: '2' }, members, tasks, '2026-11-15T00:00:00Z');
  assert.equal(out.members['1'], undefined);
  assert.equal(out.members['2'].reportsToPhone, null);
  assert.equal(out.members['2'].partnerOfPhone, null);
  assert.deepEqual(out.members['2'].worksCloselyWithPhones, []);
  assert.equal(out.tasks.find((t) => t.taskCode === 'T1')!.raci.R, '2'); // reassigned
  assert.equal(out.tasks.find((t) => t.taskCode === 'T2')!.raci.R, '1'); // closed task untouched
});

test('applyPersonRemoval: CANCEL cancels open tasks; DIRECT leaves tasks as-is', () => {
  const members = { '1': member('1', 'A'), '2': member('2', 'B') };
  const tasks = [task('T1', '1')];
  const cancelled = applyPersonRemoval('1', { kind: 'CANCEL' }, members, tasks, '2026-11-15T00:00:00Z');
  assert.equal(cancelled.tasks[0].status, 'CANCELLED');

  const direct = applyPersonRemoval('2', { kind: 'DIRECT' }, members, tasks, '2026-11-15T00:00:00Z');
  assert.equal(direct.tasks[0].status, 'IN_PROGRESS');
  assert.equal(direct.members['2'], undefined);
});

test('checkReportsToChange: blocks self-links and loops, and signals replacement when manager already set', () => {
  const members = {
    '1': member('1', 'Owner'),
    '2': member('2', 'Lead', { reportsToPhone: '1' }),
    '3': member('3', 'Coord', { reportsToPhone: '2' }),
    '4': member('4', 'Advisor'),
  };

  // Self-link
  const selfRes = checkReportsToChange(members, '2', '2');
  assert.equal(selfRes.ok, false);
  if (!selfRes.ok) assert.equal(selfRes.reason, 'SELF');

  // Reporting loop: Owner cannot report to Coord (Owner -> Coord -> Lead -> Owner)
  const loopRes = checkReportsToChange(members, '1', '3');
  assert.equal(loopRes.ok, false);
  if (!loopRes.ok) assert.equal(loopRes.reason, 'CYCLE');

  // Manager replacement: Coord already reports to Lead; switching to Advisor triggers REPLACE prompt
  const replaceRes = checkReportsToChange(members, '3', '4');
  assert.equal(replaceRes.ok, true);
  if (replaceRes.ok) {
    assert.equal(replaceRes.kind, 'REPLACE');
    if (replaceRes.kind === 'REPLACE') {
      assert.equal(replaceRes.currentManagerPhone, '2');
      assert.equal(replaceRes.currentManagerName, 'Lead');
    }
  }

  // Fresh manager assignment for Advisor (no prior manager) or clearing -> DIRECT
  const freshRes = checkReportsToChange(members, '4', '1');
  assert.deepEqual(freshRes, { ok: true, kind: 'DIRECT' });
  const clearRes = checkReportsToChange(members, '3', null);
  assert.deepEqual(clearRes, { ok: true, kind: 'DIRECT' });
});

test('two-way link sync: Partner and Works closely with stay symmetric across add, reassign, edit, delete', () => {
  const base: Record<string, TeamMember> = {
    '1': member('1', 'Owner'),
    '2': member('2', 'Co-Owner'),
    '3': member('3', 'Lead'),
  };

  // Partner two-way set & symmetric read
  const paired = syncPartnerLink(base, '1', '2');
  assert.equal(paired['1'].partnerOfPhone, '2');
  assert.equal(paired['2'].partnerOfPhone, '1');
  assert.equal(getSymmetricPartnerPhone('1', paired), '2');
  assert.equal(getSymmetricPartnerPhone('2', paired), '1');

  // Re-pairing 1 -> 3 cleans up stale pointer on 2
  const repaired = syncPartnerLink(paired, '1', '3');
  assert.equal(repaired['1'].partnerOfPhone, '3');
  assert.equal(repaired['3'].partnerOfPhone, '1');
  assert.equal(repaired['2'].partnerOfPhone, null);

  // Clearing partner removes both sides
  const unpaired = syncPartnerLink(repaired, '3', null);
  assert.equal(unpaired['1'].partnerOfPhone, null);
  assert.equal(unpaired['3'].partnerOfPhone, null);

  // Works closely with add & delete stay symmetric
  const closeAdded = syncWorksCloselyLink(base, '2', '3', true);
  assert.deepEqual(getSymmetricClosePeerPhones('2', closeAdded), ['3']);
  assert.deepEqual(getSymmetricClosePeerPhones('3', closeAdded), ['2']);

  const closeRemoved = syncWorksCloselyLink(closeAdded, '3', '2', false);
  assert.deepEqual(getSymmetricClosePeerPhones('2', closeRemoved), []);
  assert.deepEqual(getSymmetricClosePeerPhones('3', closeRemoved), []);

  // applyMemberProfileUpdate propagates both Partner & Works closely changes across peers
  const edited = applyMemberProfileUpdate(closeAdded, {
    ...closeAdded['1'],
    partnerOfPhone: '2',
    worksCloselyWithPhones: ['3'],
  });
  assert.equal(edited['2'].partnerOfPhone, '1');
  assert.deepEqual(edited['3'].worksCloselyWithPhones, ['2', '1']);
});

test('autoArrangeOrgPositions: produces zero-overlap boxes with partners adjacent and reports strictly below', () => {
  const owner = member('1', 'Owner', { partnerOfPhone: '2' });
  const partner = member('2', 'Partner', { partnerOfPhone: '1' });
  const m1 = member('3', 'Manager 1', { reportsToPhone: '1' });
  const m2 = member('4', 'Manager 2', { reportsToPhone: '2' });
  const s1 = member('5', 'Staff 1', { reportsToPhone: '3' });
  const s2 = member('6', 'Staff 2', { reportsToPhone: '3' });
  const orphan = member('7', 'Unassigned');

  const members = [owner, partner, m1, m2, s1, s2, orphan];
  const pos = autoArrangeOrgPositions(members, [], [], TODAY);

  assert.equal(Object.keys(pos).length, members.length);

  // Partners share the exact same top row y and sit side-by-side without overlapping
  assert.equal(pos['1'].y, pos['2'].y);
  assert.ok(pos['2'].x >= pos['1'].x + ORG_CARD_WIDTH);

  // Direct reports sit strictly below their managers
  assert.ok(pos['3'].y >= pos['1'].y + ORG_CARD_HEIGHT);
  assert.ok(pos['5'].y >= pos['3'].y + ORG_CARD_HEIGHT);
  assert.ok(pos['7'].y >= pos['5'].y + ORG_CARD_HEIGHT);

  // Verify pairwise zero overlap across every placed card
  const entries = Object.entries(pos);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      const overlapsX = a.x < b.x + ORG_CARD_WIDTH && a.x + ORG_CARD_WIDTH > b.x;
      const overlapsY = a.y < b.y + ORG_CARD_HEIGHT && a.y + ORG_CARD_HEIGHT > b.y;
      assert.equal(
        overlapsX && overlapsY,
        false,
        `Nodes ${idA} and ${idB} overlap: (${a.x},${a.y}) vs (${b.x},${b.y})`
      );
    }
  }
});

test('matchesMemberSearch: matches name, roleTitle, and What they handle across generic terms', () => {
  const m = member('1', 'Rohan Mehta', {
    roleTitle: 'Warehouse Coordinator',
    responsibilities: 'Vendor dispatches, cold-room checks, inventory counts',
  });

  assert.equal(matchesMemberSearch(m, ''), true);
  assert.equal(matchesMemberSearch(m, 'rohan'), true);
  assert.equal(matchesMemberSearch(m, 'warehouse'), true);
  assert.equal(matchesMemberSearch(m, 'cold-room dispatches'), true);
  assert.equal(matchesMemberSearch(m, 'rohan inventory'), true);
  assert.equal(matchesMemberSearch(m, 'plumbing'), false);
});

test('getPersonSopAssignments + applyPersonRemovalWithSops: requires explicit SOP owner/backup replacements and prevents silent clearing', () => {
  const members: Record<string, TeamMember> = {
    '1': member('1', 'Asha'),
    '2': member('2', 'Vikram'),
    '3': member('3', 'Meera'),
  };
  const sops: CategorySop[] = [
    {
      categoryId: 'PROCUREMENT',
      categoryName: 'Procurement',
      defaultClassification: 'MAJOR',
      sopSystemPrompt: '',
      defaultMicroSteps: [],
      defaultResponsiblePhone: '1',
      backupResponsiblePhone: '2',
    },
    {
      categoryId: 'SAFETY',
      categoryName: 'Safety',
      defaultClassification: 'MAJOR',
      sopSystemPrompt: '',
      defaultMicroSteps: [],
      defaultResponsiblePhone: '3',
      backupResponsiblePhone: '1',
    },
  ];
  const tasks = [task('T1', '1')];

  const assignments = getPersonSopAssignments('1', sops);
  assert.deepEqual(assignments, [
    { categoryId: 'PROCUREMENT', categoryName: 'Procurement', role: 'DEFAULT' },
    { categoryId: 'SAFETY', categoryName: 'Safety', role: 'BACKUP' },
  ]);

  // Remove '1': reassign open task to '3', replace PROCUREMENT default with '3', clear SAFETY backup explicitly (null)
  const out = applyPersonRemovalWithSops(
    '1',
    { kind: 'REASSIGN', targetPhone: '3' },
    {
      PROCUREMENT: { defaultResponsiblePhone: '3' },
      SAFETY: { backupResponsiblePhone: null },
    },
    members,
    tasks,
    sops,
    '2026-11-15T00:00:00Z'
  );

  assert.equal(out.members['1'], undefined);
  assert.equal(out.tasks[0].raci.R, '3');
  assert.equal(out.categorySops[0].defaultResponsiblePhone, '3');
  assert.equal(out.categorySops[0].backupResponsiblePhone, '2');
  assert.equal(out.categorySops[1].defaultResponsiblePhone, '3');
  assert.equal(out.categorySops[1].backupResponsiblePhone, null);

  // Guard: if default replacement happens to equal existing backup, backup becomes null (same person cannot hold both)
  const dedup = applyPersonRemovalWithSops(
    '1',
    { kind: 'DIRECT' },
    {
      PROCUREMENT: { defaultResponsiblePhone: '2' },
    },
    members,
    [],
    sops,
    '2026-11-15T00:00:00Z'
  );
  assert.equal(dedup.categorySops[0].defaultResponsiblePhone, '2');
  assert.equal(dedup.categorySops[0].backupResponsiblePhone, null);
});

