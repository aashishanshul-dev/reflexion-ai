/**
 * Interprets the server's answer to GET /api/auth/check (run right after Google sign-in).
 * Pure, so the browser's decision can be unit-tested. Anything other than a clear
 * "allowed" from a cloud-mode server keeps the user out (fail closed).
 */
export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'NOT_AUTHORISED' | 'SIGNED_OUT' | 'SERVER_NOT_CLOUD' | 'UNREACHABLE' | 'ERROR'; message: string };

export const NOT_AUTHORISED_MESSAGE = 'Not authorised. This Google account is not on the list of allowed users.';

export function interpretAccessCheck(
  response: { status: number; body: any } | null
): AccessDecision {
  if (!response) {
    return { allowed: false, reason: 'UNREACHABLE', message: 'Could not reach the server to check your access. Please try again.' };
  }
  const { status, body } = response;
  if (status === 403) return { allowed: false, reason: 'NOT_AUTHORISED', message: NOT_AUTHORISED_MESSAGE };
  if (status === 401) return { allowed: false, reason: 'SIGNED_OUT', message: 'Please sign in again.' };
  if (status >= 200 && status < 300) {
    if (body?.storage !== 'cloud') {
      return {
        allowed: false,
        reason: 'SERVER_NOT_CLOUD',
        message: 'The server cannot check sign-ins (its FIREBASE_* values are missing). Ask the administrator to fix the setup.',
      };
    }
    if (body?.allowed === true) return { allowed: true };
  }
  return {
    allowed: false,
    reason: 'ERROR',
    message: String(body?.error || 'Could not check your access. Please try again.'),
  };
}
