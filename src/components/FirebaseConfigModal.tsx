import React from 'react';
import { Cloud, Database, LogOut, RotateCcw, Sparkles, X } from 'lucide-react';
import type { DemoLead } from '../lib/demoData';

interface WorkspaceStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 'CLOUD' when signed in to Firebase; 'DEMO' in guest sandbox; 'LOCAL_STORAGE' in local dev mode. */
  mode: 'LOCAL_STORAGE' | 'CLOUD' | 'DEMO';
  projectId: string | null;
  accountEmail: string | null;
  demoLead?: DemoLead | null;
  onSignOut?: () => void;
  onResetDemoData?: () => void;
  onExitDemo?: () => void;
}

/** Where the workspace is stored, who is signed in, and demo sandbox reset/exit. */
export const FirebaseConfigModal: React.FC<WorkspaceStatusModalProps> = ({
  isOpen,
  onClose,
  mode,
  projectId,
  accountEmail,
  demoLead,
  onSignOut,
  onResetDemoData,
  onExitDemo,
}) => {
  if (!isOpen) return null;
  const cloud = mode === 'CLOUD';
  const demo = mode === 'DEMO';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-status-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-surface p-6 space-y-4 shadow-[var(--shadow-modal)]">
        <div className="flex items-start justify-between gap-4 border-b border-hairline pb-3">
          <h2 id="workspace-status-title" className="text-base font-semibold text-ink">
            Workspace &amp; storage
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-lg border border-hairline p-1.5 text-slate hover:bg-paper hover:text-ink transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-hairline bg-paper p-4 text-sm">
          {cloud ? (
            <Cloud className="h-5 w-5 text-ok shrink-0" />
          ) : demo ? (
            <Sparkles className="h-5 w-5 text-signal shrink-0" />
          ) : (
            <Database className="h-5 w-5 text-slate shrink-0" />
          )}
          <div className="space-y-1">
            <p className="font-semibold text-ink">
              {cloud ? 'Cloud (Firebase)' : demo ? 'Guest Demo Sandbox (Browser Only)' : 'Local (this browser only)'}
            </p>
            {cloud ? (
              <p className="text-xs text-slate leading-relaxed">
                Signed in as <strong className="text-ink">{accountEmail || 'your Google account'}</strong>
                {projectId ? <> · project <strong className="text-ink">{projectId}</strong></> : null}. Only you can see this workspace.
              </p>
            ) : demo ? (
              <p className="text-xs text-slate leading-relaxed">
                Active guest: <strong className="text-ink">{demoLead?.name || 'Guest'}</strong>
                {demoLead?.email ? <> ({demoLead.email})</> : null}. All changes stay isolated in this browser on sample demo data.
              </p>
            ) : (
              <p className="text-xs text-slate leading-relaxed">
                Development mode: data stays in this browser. Add the VITE_FIREBASE_* values to .env and restart to use
                sign-in and cloud storage.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {cloud && onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-xs font-semibold text-ink hover:bg-paper transition-colors"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          )}
          {!cloud && onResetDemoData && (
            <button
              type="button"
              onClick={() => {
                onResetDemoData();
                onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-danger-border bg-surface px-3.5 py-2 text-xs font-semibold text-danger hover:bg-danger-soft transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset demo data
            </button>
          )}
          {demo && onExitDemo && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onExitDemo();
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-xs font-semibold text-ink hover:bg-paper transition-colors"
            >
              <LogOut className="h-3.5 w-3.5" /> Exit Demo
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
