/**
 * Reads the server's Firebase service-account values from environment variables
 * (never from files in the repo). Pure, so it can be unit-tested.
 */
export interface ServiceAccountEnv {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export type ServiceAccountEnvResult =
  | { ok: true; value: ServiceAccountEnv }
  | { ok: false; missing: string[] };

function clean(value: string | undefined): string {
  let v = (value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

export function parseServiceAccountEnv(env: Record<string, string | undefined>): ServiceAccountEnvResult {
  const projectId = clean(env.FIREBASE_PROJECT_ID);
  const clientEmail = clean(env.FIREBASE_CLIENT_EMAIL);
  // .env files keep the key on one line with literal "\n"; turn them back into newlines.
  const privateKey = clean(env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n');
  const missing: string[] = [];
  if (!projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!privateKey) missing.push('FIREBASE_PRIVATE_KEY');
  else if (!privateKey.includes('BEGIN PRIVATE KEY')) missing.push('FIREBASE_PRIVATE_KEY (not a private key)');
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, value: { projectId, clientEmail, privateKey } };
}

/** "Bearer <token>" -> token, else null. */
export function readBearerToken(header: string | undefined | null): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return m ? m[1].trim() || null : null;
}

/**
 * Non-secret startup facts to help fix setup problems: the project the server key is for,
 * whether its service account belongs to that project, and whether it matches the browser's
 * project. Never includes the private key or the full service-account email.
 */
export function describeServiceAccountSetup(
  value: ServiceAccountEnv,
  browserProjectId: string | undefined
): string {
  const emailProject = /@([^.]+)\.iam\.gserviceaccount\.com$/i.exec(value.clientEmail)?.[1] || null;
  const parts = [
    `project "${value.projectId}"`,
    emailProject
      ? `service account from project "${emailProject}"${emailProject === value.projectId ? ' (matches)' : ' (DIFFERENT — use a key from this project)'}`
      : 'service account email is not a standard key email',
  ];
  const browser = (browserProjectId || '').trim();
  if (browser) {
    parts.push(browser === value.projectId ? 'browser project matches' : `browser project "${browser}" is DIFFERENT`);
  }
  return parts.join('; ');
}

/**
 * ALLOWED_EMAILS="a@x.com, b@y.com" -> ["a@x.com", "b@y.com"] (trimmed, lower-case, no
 * duplicates). Commas, semicolons, spaces and newlines all separate entries. Empty or
 * missing gives an empty list, which means nobody may sign in (fail closed).
 */
export function parseAllowedEmails(raw: string | undefined | null): string[] {
  const seen = new Set<string>();
  for (const part of clean(raw ?? '').split(/[\s,;]+/)) {
    const email = part.replace(/^["']|["']$/g, '').trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

export type EmailAccess = { ok: true } | { ok: false; reason: 'NO_LIST' | 'NO_EMAIL' | 'NOT_VERIFIED' | 'NOT_LISTED' };

/** Whether a signed-in identity may use the app. The email must be verified and listed. */
export function checkEmailAccess(
  identity: { email?: string | null; emailVerified?: boolean | null },
  allowed: string[]
): EmailAccess {
  if (allowed.length === 0) return { ok: false, reason: 'NO_LIST' };
  const email = String(identity.email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'NO_EMAIL' };
  if (identity.emailVerified !== true) return { ok: false, reason: 'NOT_VERIFIED' };
  return allowed.includes(email) ? { ok: true } : { ok: false, reason: 'NOT_LISTED' };
}
