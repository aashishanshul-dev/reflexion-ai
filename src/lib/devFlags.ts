/**
 * Development-only controls (e.g. the "Run tick" button) are shown only in a
 * Vite development build. Pass `import.meta.env` from the app.
 */
export function isDevToolsEnabled(env: { DEV?: boolean; MODE?: string } | undefined | null): boolean {
  if (!env) return false;
  return env.DEV === true && env.MODE !== 'production';
}
