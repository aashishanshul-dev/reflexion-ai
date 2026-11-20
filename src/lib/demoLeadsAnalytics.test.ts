import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDemoVisitorsCsv,
  computeDemoVisitorMetrics,
  filterDemoVisitors,
  normalizeDemoVisitorRecord,
  type DemoVisitorRecord,
} from './demoLeadsAnalytics';

test('computeDemoVisitorMetrics computes total, today, 7d, 30d counts and 30 daily bars newest-first', () => {
  // Reference "now": 2026-11-15T12:00:00Z -> 2026-11-15 in Asia/Kolkata
  const now = new Date('2026-11-15T12:00:00.000Z');
  const visitors: DemoVisitorRecord[] = [
    normalizeDemoVisitorRecord('v1', {
      name: 'Older Guest',
      email: 'older@example.com',
      phone: '919820100001',
      registeredAt: '2026-10-01T10:00:00.000Z', // 45 days ago
      aiRequestCount: 4,
      meditateCount: 1,
      ranMeditate: true,
    }),
    normalizeDemoVisitorRecord('v2', {
      name: 'Three Week Guest',
      email: 'week3@example.com',
      phone: '919820100002',
      registeredAt: '2026-10-28T10:00:00.000Z', // 18 days ago (inside 30d, outside 7d)
    }),
    normalizeDemoVisitorRecord('v3', {
      name: 'Recent Guest',
      email: 'recent@example.com',
      phone: '919820100003',
      registeredAt: '2026-11-12T10:00:00.000Z', // 3 days ago (inside 7d & 30d)
      aiRequestCount: 2,
      meditateCount: 0,
      ranMeditate: false,
    }),
    normalizeDemoVisitorRecord('v4', {
      name: 'Today Guest',
      email: 'today@example.com',
      phone: '919820100004',
      registeredAt: '2026-11-15T06:00:00.000Z', // today
      aiRequestCount: 5,
      meditateCount: 3,
      ranMeditate: true,
    }),
  ];

  const metrics = computeDemoVisitorMetrics(visitors, now, 'Asia/Kolkata');

  assert.equal(metrics.total, 4);
  assert.equal(metrics.today, 1);
  assert.equal(metrics.last7Days, 2);
  assert.equal(metrics.last30Days, 3);
  assert.equal(metrics.dailySeries.length, 30);
  assert.equal(metrics.dailySeries[29].dateIso, '2026-11-15');
  assert.equal(metrics.dailySeries[29].count, 1);
  assert.equal(metrics.dailySeries[26].dateIso, '2026-11-12');
  assert.equal(metrics.dailySeries[26].count, 1);

  assert.deepEqual(
    metrics.sortedVisitors.map((v) => v.leadId),
    ['v4', 'v3', 'v2', 'v1']
  );
  // Legacy doc missing counter fields defaults cleanly to 0 / false
  assert.equal(metrics.sortedVisitors[2].aiRequestCount, 0);
  assert.equal(metrics.sortedVisitors[2].ranMeditate, false);
});

test('filterDemoVisitors searches name, email, and phone digits cleanly', () => {
  const list: DemoVisitorRecord[] = [
    normalizeDemoVisitorRecord('a', {
      name: 'Asha Kulkarni',
      email: 'asha@bluedrop.in',
      phone: '919820111222',
      registeredAt: '2026-11-15T06:00:00.000Z',
    }),
    normalizeDemoVisitorRecord('b', {
      name: 'Vikram Rao',
      email: 'vikram@acme.io',
      phone: '+91 98111 44556',
      registeredAt: '2026-11-14T06:00:00.000Z',
    }),
  ];

  assert.equal(filterDemoVisitors(list, '').length, 2);
  assert.deepEqual(filterDemoVisitors(list, 'asha').map((v) => v.leadId), ['a']);
  assert.deepEqual(filterDemoVisitors(list, 'ACME.IO').map((v) => v.leadId), ['b']);
  assert.deepEqual(filterDemoVisitors(list, '9811144556').map((v) => v.leadId), ['b']);
});

test('buildDemoVisitorsCsv quotes fields safely and prevents formula injection while preserving +phones', () => {
  const csv = buildDemoVisitorsCsv(
    [
      normalizeDemoVisitorRecord('x', {
        name: '=HYPERLINK("bad")',
        email: 'test@example.com',
        phone: '+91 98201 55443',
        registeredAt: '2026-11-15T06:00:00.000Z',
        aiRequestCount: 3,
        meditateCount: 1,
        ranMeditate: true,
      }),
    ],
    'Asia/Kolkata'
  );

  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'Registered At,Name,Email,Phone,Ran Meditate,AI Requests');
  assert.ok(lines[1].includes(`"'=HYPERLINK(""bad"")"`));
  assert.ok(lines[1].includes('"+91 98201 55443"'));
  assert.ok(lines[1].endsWith('"Yes",3'));
});
