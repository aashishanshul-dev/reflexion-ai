/** Browser Firebase config from Vite env vars (VITE_FIREBASE_*). Null when not set (local mode). */
export interface ClientFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
}

export function readClientFirebaseConfig(env: Record<string, unknown> | undefined | null): ClientFirebaseConfig | null {
  const get = (k: string) => String((env || {})[k] ?? '').trim();
  const config: ClientFirebaseConfig = {
    apiKey: get('VITE_FIREBASE_API_KEY'),
    authDomain: get('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: get('VITE_FIREBASE_PROJECT_ID'),
    storageBucket: get('VITE_FIREBASE_STORAGE_BUCKET') || undefined,
    messagingSenderId: get('VITE_FIREBASE_MESSAGING_SENDER_ID') || undefined,
    appId: get('VITE_FIREBASE_APP_ID'),
  };
  if (!config.apiKey || !config.authDomain || !config.projectId || !config.appId) return null;
  return config;
}

export interface FormattedSignInError {
  message: string;
  unauthorizedDomain: string | null;
  consoleUrl: string | null;
}

export function formatFirebaseSignInError(
  err: unknown,
  currentHostname?: string | null,
  projectId?: string | null
): FormattedSignInError {
  const code = typeof (err as any)?.code === 'string' ? (err as any).code : '';
  const rawMessage = typeof (err as any)?.message === 'string' ? (err as any).message : String(err || '');
  const isUnauthorizedDomain =
    code === 'auth/unauthorized-domain' || rawMessage.includes('auth/unauthorized-domain');
  if (isUnauthorizedDomain) {
    const cleanHost = (currentHostname || '').trim() || 'this app domain';
    const cleanProject = (projectId || '').trim() || null;
    const consoleUrl = cleanProject
      ? `https://console.firebase.google.com/project/${encodeURIComponent(cleanProject)}/authentication/settings`
      : 'https://console.firebase.google.com/';
    return {
      message: `This app domain (${cleanHost}) is not listed in Firebase Authorized Domains${cleanProject ? ` for project "${cleanProject}"` : ''}. Add "${cleanHost}" under Firebase Console → Authentication → Settings → Authorized domains, then try again.`,
      unauthorizedDomain: cleanHost !== 'this app domain' ? cleanHost : null,
      consoleUrl,
    };
  }
  return {
    message: rawMessage || 'Sign-in did not finish.',
    unauthorizedDomain: null,
    consoleUrl: null,
  };
}
