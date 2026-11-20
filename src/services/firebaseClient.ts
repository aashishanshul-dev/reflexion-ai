/**
 * Browser Firebase: Google sign-in and the Firestore handle for the signed-in owner.
 * Configured only from VITE_FIREBASE_* env values; without them the app stays in local mode.
 */
import { FirebaseApp, getApps, initializeApp } from 'firebase/app';
import {
  Auth,
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import { Firestore, getFirestore } from 'firebase/firestore';
import { readClientFirebaseConfig } from '../lib/firebaseClientConfig';

const config = readClientFirebaseConfig(import.meta.env as unknown as Record<string, unknown>);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

export function isCloudConfigured(): boolean {
  return config !== null;
}

export function cloudProjectId(): string | null {
  return config?.projectId ?? null;
}

function ensure(): { auth: Auth; db: Firestore } {
  if (!config) throw new Error('Cloud storage is not configured (VITE_FIREBASE_* values are missing).');
  if (!app) {
    app = getApps().find((a) => a.name === 'opscommand-cloud') || initializeApp(config, 'opscommand-cloud');
    auth = getAuth(app);
    db = getFirestore(app);
  }
  return { auth: auth!, db: db! };
}

export function getCloudDb(): Firestore {
  return ensure().db;
}

export function watchSignedInUser(onChange: (user: User | null) => void): () => void {
  return onAuthStateChanged(ensure().auth, onChange);
}

export async function signInWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(ensure().auth, provider);
  return result.user;
}

export async function signOutOfCloud(): Promise<void> {
  if (!config) return;
  await signOut(ensure().auth);
}

/** ID token for the signed-in user (sent to the server as "Authorization: Bearer ..."). */
export async function getIdTokenOrNull(): Promise<string | null> {
  if (!config) return null;
  const user = ensure().auth.currentUser;
  return user ? user.getIdToken() : null;
}
