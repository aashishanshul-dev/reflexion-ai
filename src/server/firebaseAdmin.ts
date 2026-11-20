/**
 * Server-side Firebase (firebase-admin): verifies sign-in tokens and reads/writes the
 * per-record workspace under tenants/{uid}/... for the scheduler tick.
 * Credentials come only from environment variables (see firebaseAdminEnv.ts).
 */
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  checkVersions,
  CLOUD_COLLECTIONS,
  type CloudRecord,
  recordKey,
  type RecordChange,
  type VersionConflict,
} from '../lib/cloudRecords.ts';
import {
  normalizeDemoVisitorRecord,
  sortVisitorsNewestFirst,
  type DemoVisitorRecord,
} from '../lib/demoLeadsAnalytics.ts';
import {
  checkEmailAccess,
  describeServiceAccountSetup,
  type EmailAccess,
  parseAllowedEmails,
  parseServiceAccountEnv,
  readBearerToken,
} from './firebaseAdminEnv.ts';

let cached: { app: App; db: Firestore } | null | undefined;

/** Null when the FIREBASE_* values are not set (the server then runs in local mode). */
export function getAdminServices(): { app: App; db: Firestore } | null {
  if (cached !== undefined) return cached;
  const parsed = parseServiceAccountEnv(process.env);
  if (!parsed.ok) {
    const anySet = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].some((k) => process.env[k]);
    if (anySet) {
      console.warn(`[firebase-admin] Not started — missing or invalid: ${parsed.missing.join(', ')}.`);
    }
    cached = null;
    return cached;
  }
  const app =
    getApps().find((a) => a.name === 'opscommand-admin') ||
    initializeApp(
      {
        credential: cert({
          projectId: parsed.value.projectId,
          clientEmail: parsed.value.clientEmail,
          privateKey: parsed.value.privateKey,
        }),
        projectId: parsed.value.projectId,
      },
      'opscommand-admin'
    );
  cached = { app, db: getFirestore(app) };
  console.log(`[firebase-admin] Cloud mode: ${describeServiceAccountSetup(parsed.value, process.env.VITE_FIREBASE_PROJECT_ID)}.`);
  const allowedCount = parseAllowedEmails(process.env.ALLOWED_EMAILS).length;
  if (allowedCount === 0) {
    console.warn('[firebase-admin] ALLOWED_EMAILS is empty — nobody can sign in. Add ALLOWED_EMAILS="you@example.com" to .env and restart.');
  } else {
    console.log(`[firebase-admin] Sign-in allowed for ${allowedCount} email(s) from ALLOWED_EMAILS.`);
  }
  // One harmless read so setup problems show up in the log at startup, not on first use.
  // Reads and writes are checked separately (a read-only IAM role passes the first only).
  // The write is a tiny probe outside any workspace and is deleted straight away.
  const probe = cached.db.doc('_server_access_check/probe');
  void probe
    .get()
    .then(() => console.log('[firebase-admin] Firestore read check: OK.'))
    .catch((err) => console.warn(`[firebase-admin] Firestore read check FAILED: ${String(err?.message || err)}`))
    .then(() => probe.set({ checkedAt: FieldValue.serverTimestamp() }))
    .then(() => probe.delete())
    .then(() => console.log('[firebase-admin] Firestore write check: OK.'))
    .catch((err) => console.warn(`[firebase-admin] Firestore write check FAILED: ${String(err?.message || err)}`));
  return cached;
}

export function isCloudServerMode(): boolean {
  return getAdminServices() !== null;
}

export type RequestUser =
  | { status: 'SIGNED_OUT' }
  | { status: 'NOT_AUTHORISED'; uid: string; reason: Exclude<EmailAccess, { ok: true }>['reason'] }
  | { status: 'OK'; uid: string };

/**
 * Checks "Authorization: Bearer <ID token>" and the ALLOWED_EMAILS list (read on every
 * request, so it always matches the server's current environment).
 */
export async function verifyRequestUser(authorizationHeader: string | undefined): Promise<RequestUser> {
  const services = getAdminServices();
  const token = readBearerToken(authorizationHeader);
  if (!services || !token) return { status: 'SIGNED_OUT' };
  let decoded: { uid?: string; email?: string; email_verified?: boolean };
  try {
    decoded = await getAuth(services.app).verifyIdToken(token);
  } catch {
    return { status: 'SIGNED_OUT' };
  }
  if (!decoded.uid) return { status: 'SIGNED_OUT' };
  const access = checkEmailAccess(
    { email: decoded.email, emailVerified: decoded.email_verified },
    parseAllowedEmails(process.env.ALLOWED_EMAILS)
  );
  if (!access.ok) return { status: 'NOT_AUTHORISED', uid: decoded.uid, reason: access.reason };
  return { status: 'OK', uid: decoded.uid };
}

/** All stored records of a tenant, plus each record's version. */
export async function loadWorkspaceAdmin(
  uid: string
): Promise<{ records: CloudRecord[]; versions: Record<string, number> }> {
  const services = getAdminServices();
  if (!services) throw new Error('Cloud storage is not configured on the server.');
  const records: CloudRecord[] = [];
  const versions: Record<string, number> = {};
  const snaps = await Promise.all(
    CLOUD_COLLECTIONS.map((c) =>
      services.db
        .collection(`tenants/${uid}/${c}`)
        .get()
        .catch((err) => {
          throw new Error(`reading ${c}: ${String(err?.message || err)}`);
        })
    )
  );
  snaps.forEach((snap, i) => {
    const collection = CLOUD_COLLECTIONS[i];
    snap.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      records.push({ collection, id: doc.id, data });
      versions[recordKey(collection, doc.id)] = Number(data.version) || 0;
    });
  });
  return { records, versions };
}

const MAX_WRITES_PER_TRANSACTION = 450;

/**
 * Writes only the changed records in a transaction, refusing everything if any record was
 * changed elsewhere since `knownVersions` (returns the conflicts instead).
 */
export async function saveWorkspaceChangesAdmin(params: {
  uid: string;
  changes: RecordChange[];
  knownVersions: Record<string, number>;
  session: string;
}): Promise<{ conflicts: VersionConflict[]; written: number }> {
  const services = getAdminServices();
  if (!services) throw new Error('Cloud storage is not configured on the server.');
  const { uid, changes, knownVersions, session } = params;
  let written = 0;
  for (let i = 0; i < changes.length; i += MAX_WRITES_PER_TRANSACTION) {
    const chunk = changes.slice(i, i + MAX_WRITES_PER_TRANSACTION);
    const conflicts = await services.db.runTransaction(async (tx) => {
      const refs = chunk.map((c) => services.db.doc(`tenants/${uid}/${c.collection}/${c.id}`));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      const remote: Record<string, number> = {};
      snaps.forEach((s, idx) => {
        if (s.exists) remote[recordKey(chunk[idx].collection, chunk[idx].id)] = Number(s.data()?.version) || 0;
      });
      const found = checkVersions(chunk, knownVersions, remote);
      if (found.length > 0) return found;
      chunk.forEach((c, idx) => {
        if (c.kind === 'delete' || !c.data) {
          tx.delete(refs[idx]);
          return;
        }
        const key = recordKey(c.collection, c.id);
        tx.set(refs[idx], {
          ...c.data,
          tenantId: uid,
          version: (remote[key] ?? 0) + 1,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBySession: session,
        });
      });
      return [] as VersionConflict[];
    });
    if (conflicts.length > 0) return { conflicts, written };
    written += chunk.length;
  }
  return { conflicts: [], written };
}

const DEMO_LEAD_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;

/** Saves a validated demo registration into Firestore `demoLeads` via Admin SDK. */
export async function addDemoLeadAdmin(doc: {
  name: string;
  email: string;
  phone: string;
  registeredAt: string;
  userAgent: string;
}): Promise<{ id: string }> {
  const services = getAdminServices();
  if (!services) throw new Error('Cloud storage is not configured on the server.');
  const ref = await services.db.collection('demoLeads').add({
    ...doc,
    aiRequestCount: 0,
    meditateCount: 0,
    ranMeditate: false,
    createdAt: doc.registeredAt || new Date().toISOString(),
  });
  return { id: ref.id };
}

/** Increments count-only AI request / Meditate counters on `demoLeads/{leadId}` (zero content stored). */
export async function incrementDemoLeadAiUsageAdmin(
  leadId: string,
  isMeditate: boolean
): Promise<void> {
  if (!DEMO_LEAD_ID_RE.test(leadId)) return;
  const services = getAdminServices();
  if (!services) return;
  await services.db
    .collection('demoLeads')
    .doc(leadId)
    .update({
      aiRequestCount: FieldValue.increment(1),
      ...(isMeditate
        ? {
            meditateCount: FieldValue.increment(1),
            ranMeditate: true,
          }
        : {}),
      lastAiAt: new Date().toISOString(),
    })
    .catch(() => {
      // Non-blocking: missing or deleted test document must never disrupt a demo request.
    });
}

/** Lists all demo registrations from Firestore `demoLeads`, newest first (Admin SDK only). */
export async function listDemoLeadsAdmin(): Promise<DemoVisitorRecord[]> {
  const services = getAdminServices();
  if (!services) throw new Error('Cloud storage is not configured on the server.');
  const snap = await services.db.collection('demoLeads').get();
  const rows: DemoVisitorRecord[] = [];
  snap.forEach((doc) => {
    rows.push(normalizeDemoVisitorRecord(doc.id, doc.data() as Record<string, unknown>));
  });
  return sortVisitorsNewestFirst(rows);
}

/** Deletes a single entry from Firestore `demoLeads` by ID (owner cleanup). */
export async function deleteDemoLeadAdmin(leadId: string): Promise<boolean> {
  if (!DEMO_LEAD_ID_RE.test(leadId)) {
    throw new Error('Invalid visitor ID.');
  }
  const services = getAdminServices();
  if (!services) throw new Error('Cloud storage is not configured on the server.');
  const ref = services.db.collection('demoLeads').doc(leadId);
  const existing = await ref.get();
  if (!existing.exists) return false;
  await ref.delete();
  return true;
}

