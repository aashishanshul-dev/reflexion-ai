import React, { useState } from 'react';
import { Check, Copy, ExternalLink, LogIn } from 'lucide-react';
import { HourglassXMark, ReflexionWordmark } from './BrandLogo';

interface SignInScreenProps {
  busy: boolean;
  error: string | null;
  unauthorizedDomain?: string | null;
  firebaseConsoleUrl?: string | null;
  onSignIn: () => void;
  onEnterDemo?: () => void;
}

/** Cloud mode: nothing is shown until the owner signs in with Google or enters Guest Demo. */
export const SignInScreen: React.FC<SignInScreenProps> = ({
  busy,
  error,
  unauthorizedDomain,
  firebaseConsoleUrl,
  onSignIn,
  onEnterDemo,
}) => {
  const [copiedDomain, setCopiedDomain] = useState(false);

  const handleCopyDomain = () => {
    if (!unauthorizedDomain || !navigator?.clipboard?.writeText) return;
    void navigator.clipboard.writeText(unauthorizedDomain).then(() => {
      setCopiedDomain(true);
      window.setTimeout(() => setCopiedDomain(false), 2000);
    });
  };

  return (
    <main className="min-h-screen bg-paper flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-sm rounded-2xl border border-hairline bg-surface p-7 sm:p-8 shadow-[var(--shadow-card)] space-y-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-12 w-12 rounded-xl border border-hairline bg-paper flex items-center justify-center">
            <HourglassXMark variant="orange" className="h-7 w-7" />
          </div>
          <ReflexionWordmark size="lg" />
        </div>

        <div className="space-y-1.5">
          <h1 className="sr-only">reflexion.ai</h1>
          <p className="text-sm text-slate leading-relaxed">
            Sign in to open your workspace. Only you can see it.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-danger-border bg-danger-soft px-3.5 py-2.5 text-xs font-medium text-danger text-left space-y-2"
          >
            <p className="leading-relaxed">{error}</p>
            {unauthorizedDomain && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCopyDomain}
                  className="inline-flex items-center gap-1 rounded-lg border border-danger-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-paper transition-colors"
                >
                  {copiedDomain ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedDomain ? 'Copied domain' : 'Copy domain'}</span>
                </button>
                {firebaseConsoleUrl && (
                  <a
                    href={firebaseConsoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-danger-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-paper transition-colors"
                  >
                    <span>Open Firebase Console</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
          </div>
        )}

      <div className="space-y-3">
        <button
          type="button"
          onClick={onSignIn}
          disabled={busy}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-white hover:bg-ink-hover transition-colors disabled:opacity-60 whitespace-nowrap"
        >
          <LogIn className="h-4 w-4 shrink-0" />
          <span>{busy ? 'Checking…' : 'Sign in with Google'}</span>
        </button>

        {onEnterDemo && (
          <div className="pt-3 border-t border-hairline space-y-2">
            <button
              type="button"
              onClick={onEnterDemo}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-signal-border bg-signal-soft px-4 py-2.5 text-sm font-semibold text-signal-ink hover:bg-signal hover:text-white transition-colors whitespace-nowrap"
            >
              <span>Explore Interactive Demo (Guest)</span>
            </button>
            <p className="text-[11px] text-slate leading-relaxed">
              Walk through BlueDrop Water Supplies with live AI — no Google sign-in required.
            </p>
          </div>
        )}
      </div>
    </div>
  </main>
  );
};
