import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEmailAccess, parseAllowedEmails, parseServiceAccountEnv, readBearerToken } from './firebaseAdminEnv';

const KEY = '-----BEGIN PRIVATE KEY-----\\nABC\\nDEF\\n-----END PRIVATE KEY-----\\n';

test('parseServiceAccountEnv: turns "\\n" into newlines and strips quotes', () => {
  const res = parseServiceAccountEnv({
    FIREBASE_PROJECT_ID: ' demo-project ',
    FIREBASE_CLIENT_EMAIL: '"svc@demo-project.iam.gserviceaccount.com"',
    FIREBASE_PRIVATE_KEY: `"${KEY}"`,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.projectId, 'demo-project');
  assert.equal(res.value.clientEmail, 'svc@demo-project.iam.gserviceaccount.com');
  assert.equal(res.value.privateKey, '-----BEGIN PRIVATE KEY-----\nABC\nDEF\n-----END PRIVATE KEY-----\n');
});

test('parseServiceAccountEnv: names what is missing or wrong', () => {
  assert.deepEqual(parseServiceAccountEnv({}), {
    ok: false,
    missing: ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'],
  });
  assert.deepEqual(
    parseServiceAccountEnv({ FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'e', FIREBASE_PRIVATE_KEY: 'not-a-key' }),
    { ok: false, missing: ['FIREBASE_PRIVATE_KEY (not a private key)'] }
  );
});

test('readBearerToken', () => {
  assert.equal(readBearerToken('Bearer abc.def'), 'abc.def');
  assert.equal(readBearerToken('bearer   xyz '), 'xyz');
  assert.equal(readBearerToken('Basic abc'), null);
  assert.equal(readBearerToken(undefined), null);
});

test('describeServiceAccountSetup: names mismatches without secrets', async () => {
  const { describeServiceAccountSetup } = await import('./firebaseAdminEnv');
  const v = { projectId: 'proj-a', clientEmail: 'firebase-adminsdk-x1@proj-a.iam.gserviceaccount.com', privateKey: 'SECRET' };
  assert.equal(describeServiceAccountSetup(v, 'proj-a'), 'project "proj-a"; service account from project "proj-a" (matches); browser project matches');
  assert.match(describeServiceAccountSetup({ ...v, clientEmail: 'svc@proj-b.iam.gserviceaccount.com' }, 'proj-a'), /from project "proj-b" \(DIFFERENT/);
  assert.match(describeServiceAccountSetup(v, 'proj-c'), /browser project "proj-c" is DIFFERENT/);
  assert.ok(!describeServiceAccountSetup(v, 'proj-a').includes('SECRET'));
  assert.ok(!describeServiceAccountSetup(v, 'proj-a').includes('firebase-adminsdk-x1'));
});

test('parseAllowedEmails: trims, lower-cases, removes duplicates and quotes', () => {
  assert.deepEqual(parseAllowedEmails('"Owner@Example.com, second@example.org ,owner@example.com"'), [
    'owner@example.com',
    'second@example.org',
  ]);
  assert.deepEqual(parseAllowedEmails('a@x.com;b@x.com\nc@x.com  d@x.com'), ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
});

test('parseAllowedEmails: empty or missing gives an empty list', () => {
  assert.deepEqual(parseAllowedEmails(undefined), []);
  assert.deepEqual(parseAllowedEmails(''), []);
  assert.deepEqual(parseAllowedEmails(' , ; '), []);
  assert.deepEqual(parseAllowedEmails('""'), []);
});

test('checkEmailAccess: listed and verified emails are allowed, case-insensitively', () => {
  const allowed = parseAllowedEmails('owner@example.com');
  assert.deepEqual(checkEmailAccess({ email: 'Owner@Example.com', emailVerified: true }, allowed), { ok: true });
});

test('checkEmailAccess: refuses unlisted, unverified, missing email and an empty list', () => {
  const allowed = ['owner@example.com'];
  assert.deepEqual(checkEmailAccess({ email: 'other@example.com', emailVerified: true }, allowed), {
    ok: false,
    reason: 'NOT_LISTED',
  });
  assert.deepEqual(checkEmailAccess({ email: 'owner@example.com', emailVerified: false }, allowed), {
    ok: false,
    reason: 'NOT_VERIFIED',
  });
  assert.deepEqual(checkEmailAccess({ email: 'owner@example.com' }, allowed), { ok: false, reason: 'NOT_VERIFIED' });
  assert.deepEqual(checkEmailAccess({ email: null, emailVerified: true }, allowed), { ok: false, reason: 'NO_EMAIL' });
  assert.deepEqual(checkEmailAccess({ email: 'owner@example.com', emailVerified: true }, []), {
    ok: false,
    reason: 'NO_LIST',
  });
});

test('checkEmailAccess: a listed address inside a longer one does not match', () => {
  assert.deepEqual(checkEmailAccess({ email: 'xowner@example.com', emailVerified: true }, ['owner@example.com']), {
    ok: false,
    reason: 'NOT_LISTED',
  });
});
