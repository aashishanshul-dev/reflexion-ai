import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkVersions,
  CLOUD_COLLECTIONS,
  describeConflicts,
  diffRecords,
  recordKey,
  recordsToState,
  SETTINGS_DOC_ID,
  stateToRecords,
  toSafeDocId,
} from './cloudRecords';
import { createInitialSeedState } from './seedData';
import { OpsDatabaseState } from '../types/ops';

const TENANT = 'uid-owner-1';

function seedWithExtras(): OpsDatabaseState {
  const s = createInitialSeedState('2026-11-03T06:00:00.000Z');
  const phone = Object.keys(s.team_members)[0];
  return {
    ...s,
    tenantId: TENANT,
    inbound_message_buffer: {
      [phone]: {
        tenantId: TENANT,
        employeePhone: phone,
        bufferMode: 'STANDARD_15_MIN',
        firstMessageAt: '2026-11-03T05:00:00.000Z',
        processAt: '2026-11-03T05:15:00.000Z',
        messages: [
          { id: 'b1', timestamp: '2026-11-03T05:00:00.000Z', type: 'image', fileName: 'proof.jpg', base64Data: 'AAAA' } as any,
        ],
      },
    },
  };
}

test('stateToRecords: one record per item, every record carries tenantId, media bytes dropped', () => {
  const s = seedWithExtras();
  const records = stateToRecords(s, TENANT);
  assert.equal(records.filter((r) => r.collection === 'settings').length, 1);
  assert.equal(records.find((r) => r.collection === 'settings')?.id, SETTINGS_DOC_ID);
  assert.equal(records.filter((r) => r.collection === 'tasks').length, s.tasks.length);
  assert.equal(records.filter((r) => r.collection === 'members').length, Object.keys(s.team_members).length);
  assert.equal(records.filter((r) => r.collection === 'messages').length, s.whatsapp_messages.length);
  assert.ok(records.every((r) => r.data.tenantId === TENANT));
  assert.ok(records.every((r) => CLOUD_COLLECTIONS.includes(r.collection)));
  assert.ok(records.every((r) => !r.id.includes('/')));
  const buffer = records.find((r) => r.collection === 'buffers')!;
  assert.ok(!JSON.stringify(buffer.data).includes('AAAA'));
  assert.ok(JSON.stringify(buffer.data).includes('proof.jpg'));
  // No undefined values reach Firestore.
  assert.ok(!JSON.stringify(records).includes('undefined'));
});

test('records -> state round-trip keeps the workspace; empty workspace has no state', () => {
  const s = seedWithExtras();
  const { state, setupComplete } = recordsToState(stateToRecords(s, TENANT), TENANT);
  assert.equal(setupComplete, true);
  assert.equal(state!.tenantId, TENANT);
  assert.deepEqual(state!.tasks.map((t) => t.taskCode).sort(), s.tasks.map((t) => t.taskCode).sort());
  assert.deepEqual(Object.keys(state!.team_members).sort(), Object.keys(s.team_members).sort());
  assert.equal(state!.business_profile.businessName, s.business_profile.businessName);
  assert.equal(state!.whatsapp_messages.length, s.whatsapp_messages.length);
  // Stored meta fields never leak into the app state.
  const stored = stateToRecords(s, TENANT).map((r) => ({ ...r, data: { ...r.data, version: 3, updatedAt: 'x', updatedBySession: 'y' } }));
  const rebuilt = recordsToState(stored, TENANT).state!;
  assert.ok(!JSON.stringify(rebuilt.tasks).includes('"version"'));
  assert.ok(!JSON.stringify(rebuilt.tasks).includes('updatedBySession'));

  assert.deepEqual(recordsToState([], TENANT), { state: null, setupComplete: false });
  const notDone = recordsToState(stateToRecords(s, TENANT, { setupComplete: false }), TENANT);
  assert.equal(notDone.setupComplete, false);
});

test('diffRecords: only created, changed and deleted records', () => {
  const s = seedWithExtras();
  assert.deepEqual(diffRecords(s, s, TENANT), []);

  const t0 = s.tasks[0];
  const next: OpsDatabaseState = {
    ...s,
    tasks: [{ ...t0, title: `${t0.title} (edited)` }, ...s.tasks.slice(2)],
    whatsapp_messages: [
      ...s.whatsapp_messages,
      { tenantId: TENANT, id: 'wa-new-1', employeePhone: t0.raci.R, direction: 'OUTBOUND', timestamp: '2026-11-03T07:00:00.000Z', text: 'hi' },
    ],
  };
  const changes = diffRecords(s, next, TENANT);
  const summary = changes.map((c) => `${c.kind}:${c.collection}/${c.id}`).sort();
  assert.deepEqual(summary, [
    `create:messages/wa-new-1`,
    `delete:tasks/${toSafeDocId(s.tasks[1].taskCode)}`,
    `update:tasks/${toSafeDocId(t0.taskCode)}`,
  ].sort());
  assert.equal(changes.find((c) => c.kind === 'delete')?.data, null);

  // First save of a new workspace creates everything.
  assert.equal(diffRecords(null, s, TENANT).every((c) => c.kind === 'create'), true);
});

test('checkVersions: a stale tab is refused; two tabs editing different tasks do not conflict', () => {
  const s = seedWithExtras();
  const [a, b] = s.tasks;
  const known = { [recordKey('tasks', a.taskCode)]: 1, [recordKey('tasks', b.taskCode)]: 1 };

  // Tab 2 saved task B (version 2). Tab 1 now saves task A: no conflict.
  const remoteAfterTab2 = { ...known, [recordKey('tasks', b.taskCode)]: 2 };
  const tab1Changes = diffRecords(s, { ...s, tasks: s.tasks.map((t) => (t.taskCode === a.taskCode ? { ...t, title: 'A edited' } : t)) }, TENANT);
  assert.deepEqual(checkVersions(tab1Changes, known, remoteAfterTab2), []);

  // Tab 1 (still on version 1 of B) edits B too: refused.
  const staleChanges = diffRecords(s, { ...s, tasks: s.tasks.map((t) => (t.taskCode === b.taskCode ? { ...t, title: 'B again' } : t)) }, TENANT);
  const conflicts = checkVersions(staleChanges, known, remoteAfterTab2);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], { collection: 'tasks', id: b.taskCode, knownVersion: 1, remoteVersion: 2 });
  assert.match(describeConflicts(conflicts), new RegExp(`your change to ${b.taskCode} was not saved`));

  // A record created by another tab meanwhile, or deleted meanwhile, also conflicts.
  const create = [{ collection: 'tasks' as const, id: 'T-NEW', data: {}, kind: 'create' as const }];
  assert.equal(checkVersions(create, {}, { [recordKey('tasks', 'T-NEW')]: 1 }).length, 1);
  const update = [{ collection: 'tasks' as const, id: a.taskCode, data: {}, kind: 'update' as const }];
  assert.equal(checkVersions(update, known, {}).length, 1);
  assert.equal(describeConflicts([]), '');
});

test('toSafeDocId handles slashes and empty ids', () => {
  assert.equal(toSafeDocId('T-101'), 'T-101');
  assert.equal(toSafeDocId('a/b'), 'a_b');
  assert.match(toSafeDocId(''), /^id_/);
  assert.match(toSafeDocId('..'), /^id_/);
});

test('readClientFirebaseConfig: needs the four required VITE_ values; otherwise local mode', async () => {
  const { readClientFirebaseConfig } = await import('./firebaseClientConfig');
  assert.equal(readClientFirebaseConfig({}), null);
  assert.equal(readClientFirebaseConfig({ VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_PROJECT_ID: 'p' }), null);
  assert.deepEqual(
    readClientFirebaseConfig({
      VITE_FIREBASE_API_KEY: ' k ',
      VITE_FIREBASE_AUTH_DOMAIN: 'p.firebaseapp.com',
      VITE_FIREBASE_PROJECT_ID: 'p',
      VITE_FIREBASE_APP_ID: 'a',
    }),
    { apiKey: 'k', authDomain: 'p.firebaseapp.com', projectId: 'p', storageBucket: undefined, messagingSenderId: undefined, appId: 'a' }
  );
});

test('formatFirebaseSignInError: explains unauthorized-domain with hostname and Firebase Console link', async () => {
  const { formatFirebaseSignInError } = await import('./firebaseClientConfig');
  const formatted = formatFirebaseSignInError(
    { code: 'auth/unauthorized-domain', message: 'Firebase: Error (auth/unauthorized-domain).' },
    'example-app.asia-southeast1.run.app',
    'demo-proj-123'
  );
  assert.equal(formatted.unauthorizedDomain, 'example-app.asia-southeast1.run.app');
  assert.equal(
    formatted.consoleUrl,
    'https://console.firebase.google.com/project/demo-proj-123/authentication/settings'
  );
  assert.match(formatted.message, /example-app\.asia-southeast1\.run\.app/);
  assert.match(formatted.message, /Authorized domains/);

  const generic = formatFirebaseSignInError(new Error('Popup closed by user.'));
  assert.equal(generic.unauthorizedDomain, null);
  assert.equal(generic.message, 'Popup closed by user.');
});

test('hasTaskChangedSince: a stale edit form is detected; routine engine refreshes are ignored', async () => {
  const { hasTaskChangedSince } = await import('./cloudRecords');
  const s = createInitialSeedState('2026-11-03T06:00:00.000Z');
  const base = s.tasks[0];
  assert.equal(hasTaskChangedSince(base, { ...base }), false);
  assert.equal(hasTaskChangedSince(base, { ...base, title: 'changed elsewhere' }), true);
  assert.equal(hasTaskChangedSince(base, { ...base, status: 'COMPLETED' }), true);
  assert.equal(
    hasTaskChangedSince(base, {
      ...base,
      latestAiSummary: 'Scheduled (Held): …',
      lastOutboundAt: '2026-11-03T07:00:00.000Z',
      reminderConfig: { ...base.reminderConfig, lastNudgedAt: '2026-11-03T07:00:00.000Z' },
      release: { ...(base.release as any), holdReason: 'At active task cap', nextEligibleAt: null },
    }),
    false
  );
  assert.equal(hasTaskChangedSince(base, null), true);
});
