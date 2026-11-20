import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretAccessCheck, NOT_AUTHORISED_MESSAGE } from './accessCheck';

test('interpretAccessCheck: allowed only on 200 from a cloud-mode server', () => {
  assert.deepEqual(interpretAccessCheck({ status: 200, body: { allowed: true, storage: 'cloud' } }), { allowed: true });
});

test('interpretAccessCheck: 403 means Not authorised', () => {
  const res = interpretAccessCheck({ status: 403, body: { error: 'Not authorised' } });
  assert.equal(res.allowed, false);
  if (res.allowed) return;
  assert.equal(res.reason, 'NOT_AUTHORISED');
  assert.equal(res.message, NOT_AUTHORISED_MESSAGE);
});

test('interpretAccessCheck: fails closed for 401, local-mode server, unreachable and errors', () => {
  const reasons = [
    interpretAccessCheck({ status: 401, body: {} }),
    interpretAccessCheck({ status: 200, body: { allowed: true, storage: 'local' } }),
    interpretAccessCheck({ status: 200, body: { storage: 'cloud' } }),
    interpretAccessCheck(null),
    interpretAccessCheck({ status: 500, body: { error: 'boom' } }),
  ].map((r) => (r.allowed ? 'ALLOWED' : r.reason));
  assert.deepEqual(reasons, ['SIGNED_OUT', 'SERVER_NOT_CLOUD', 'ERROR', 'UNREACHABLE', 'ERROR']);
});
