import React, { useMemo, useState } from 'react';
import { AlertTriangle, Download, RotateCcw, Upload, X } from 'lucide-react';
import { OpsDatabaseState } from '../types/ops';
import {
  applyImport,
  buildImportPreview,
  canConfirmImport,
  isValidIndianPhone,
  ImportResult,
  parseTeamSetupFile,
  TeamSetupFile,
} from '../lib/teamImport';

interface TeamImportModalProps {
  state: OpsDatabaseState;
  accountEmail: string | null;
  onClose: () => void;
  onImport: (result: ImportResult) => void;
  onUndo?: () => void;
  lastBackupSummary?: string | null;
  lastBackupSavedAt?: string | null;
}

function downloadJson(filename: string, data: unknown) {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* download is a convenience; ignore failures */
  }
}

export const TeamImportModal: React.FC<TeamImportModalProps> = ({
  state,
  accountEmail,
  onClose,
  onImport,
  onUndo,
  lastBackupSummary,
  lastBackupSavedAt,
}) => {
  const [file, setFile] = useState<TeamSetupFile | null>(null);
  const [parseError, setParseError] = useState('');
  const [phones, setPhones] = useState<Record<number, string>>({});
  const [skipped, setSkipped] = useState<Set<number>>(new Set());

  const preview = useMemo(
    () => (file ? buildImportPreview(file, state, phones, skipped) : null),
    [file, state, phones, skipped]
  );
  const confirmable = file && preview ? canConfirmImport(preview, phones, skipped) : false;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    const parsed = parseTeamSetupFile(text);
    if (!parsed.ok) {
      setParseError(parsed.error);
      setFile(null);
      return;
    }
    setParseError('');
    setFile(parsed.data);
    setPhones({});
    setSkipped(new Set());
  };

  const setPhone = (idx: number, val: string) => setPhones((p) => ({ ...p, [idx]: val }));
  const toggleSkip = (idx: number) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  const confirm = () => {
    if (!file || !confirmable) return;
    const result = applyImport(file, state, phones, skipped, { email: accountEmail ?? undefined });
    // Offer the pre-import snapshot as a downloadable JSON backup.
    downloadJson(`opscommand-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, result.backup);
    onImport(result);
  };

  const created = preview?.people.filter((p) => p.action === 'create') ?? [];
  const updated = preview?.people.filter((p) => p.action === 'update') ?? [];
  const skippedRows = created.filter((p) => skipped.has(p.index));
  const typesCreated = preview?.taskTypes.filter((t) => t.action === 'create') ?? [];
  const typesUpdated = preview?.taskTypes.filter((t) => t.action === 'update') ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/35 backdrop-blur-xs p-4" role="dialog" aria-modal="true">
      <div className="my-6 w-full max-w-3xl rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-modal)]">
        <div className="mb-4 flex items-center justify-between border-b border-hairline pb-3">
          <div>
            <h3 className="text-base font-semibold text-ink">Import team setup</h3>
            <p className="text-xs text-slate mt-0.5">Preview first — nothing is saved until you click Confirm.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg border border-hairline p-1.5 text-slate hover:bg-paper hover:text-ink transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Undo / last backup */}
        {onUndo && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline bg-paper px-3.5 py-2.5">
            <span className="text-xs text-slate tabular-nums">
              Last import: {lastBackupSummary || '—'}
              {lastBackupSavedAt ? ` · ${new Date(lastBackupSavedAt).toLocaleString()}` : ''}
            </span>
            <button
              type="button"
              onClick={onUndo}
              className="inline-flex items-center gap-1 rounded-lg border border-warn-border bg-warn-soft px-2.5 py-1 text-xs font-semibold text-warn hover:bg-surface transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Undo last import
            </button>
          </div>
        )}

        {/* File picker */}
        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-dashed border-hairline-strong bg-paper px-4 py-3.5 text-xs text-ink hover:bg-surface-muted transition-colors">
          <Upload className="h-4 w-4 text-signal shrink-0" />
          <span className="font-medium">{file ? 'Choose a different file…' : 'Choose a team setup JSON file…'}</span>
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </label>
        {parseError && <p className="mt-2 text-xs font-medium text-danger">{parseError}</p>}

        {file && preview && (
          <div className="mt-4 space-y-4">
            {/* Problems */}
            {preview.problems.length > 0 && (
              <div className="rounded-xl border border-danger-border bg-danger-soft p-3.5">
                <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" /> {preview.problems.length} problem(s)
                </div>
                <ul className="space-y-0.5 text-xs text-danger">
                  {preview.problems.map((p, i) => (
                    <li key={i}>
                      <strong>{p.where}:</strong> {p.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* New people — need phones */}
            {created.length > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold text-slate">
                  Create {created.length} {created.length === 1 ? 'person' : 'people'} — add WhatsApp numbers
                </h4>
                <div className="space-y-2">
                  {created.map((row) => {
                    const skip = skipped.has(row.index);
                    const valid = isValidIndianPhone(phones[row.index] || '');
                    return (
                      <div key={row.index} className="flex flex-wrap items-center gap-2 rounded-xl border border-hairline bg-surface p-2.5">
                        <span className="min-w-28 text-xs font-semibold text-ink">{row.name}</span>
                        <div className={`flex items-center overflow-hidden rounded-lg border ${skip ? 'opacity-40 border-hairline' : valid ? 'border-ok-border' : 'border-hairline-strong'}`}>
                          <span className="bg-paper px-2 py-1 text-xs text-slate font-mono">+91</span>
                          <input
                            inputMode="tel"
                            disabled={skip}
                            placeholder="10-digit mobile"
                            value={phones[row.index] || ''}
                            onChange={(e) => setPhone(row.index, e.target.value)}
                            className="w-36 px-2.5 py-1 text-xs text-ink bg-surface focus:outline-none tabular-nums"
                          />
                        </div>
                        {!skip && !valid && (phones[row.index] || '').length > 0 && (
                          <span className="text-[11px] font-medium text-danger">Enter a valid Indian mobile</span>
                        )}
                        <label className="ml-auto flex items-center gap-1.5 text-xs font-medium text-slate cursor-pointer">
                          <input type="checkbox" checked={skip} onChange={() => toggleSkip(row.index)} className="h-3.5 w-3.5 rounded border-hairline-strong accent-signal" />
                          Skip this person
                        </label>
                      </div>
                    );
                  })}
                </div>
                {skippedRows.length > 0 && (
                  <p className="mt-1 text-[11px] text-slate">{skippedRows.length} will be skipped (not created).</p>
                )}
              </section>
            )}

            {/* Updates */}
            {updated.length > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold text-slate">
                  Update {updated.length} existing {updated.length === 1 ? 'person' : 'people'}
                </h4>
                <div className="space-y-1.5">
                  {updated.map((row) => (
                    <div key={row.index} className="rounded-xl border border-hairline bg-surface p-3 text-xs">
                      <div className="font-semibold text-ink flex flex-wrap items-center gap-2">
                        <span>{row.name}</span>
                        {row.isOwnerMapping && <span className="text-[11px] font-medium text-slate">· your account · kept as OWNER</span>}
                      </div>
                      {row.changes.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-xs text-slate">
                          {row.changes.map((c, i) => (
                            <li key={i}>
                              <span className="font-medium text-ink">{c.field}:</span> {c.from || '—'} → {c.to || '—'}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-0.5 text-xs text-slate">No field changes.</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Task types */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold text-slate tabular-nums">
                Task types: create {typesCreated.length}, update {typesUpdated.length}
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {typesCreated.map((t) => (
                  <span key={`c-${t.index}`} className="rounded-lg border border-ok-border bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">
                    + {t.name}
                  </span>
                ))}
                {typesUpdated.map((t) => (
                  <span key={`u-${t.index}`} className="rounded-lg border border-hairline bg-paper px-2 py-0.5 text-xs font-medium text-slate">
                    ↻ {t.name}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-slate">Nothing is deleted — existing task types (including “General”) and all tasks stay as they are.</p>
            </section>
          </div>
        )}

        {/* Footer */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-4">
          <p className="text-xs text-slate">
            {file ? (confirmable ? 'A backup is saved and downloaded before anything changes.' : 'Add a valid number for each new person, or skip them.') : ''}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-xl border border-hairline bg-surface px-3.5 py-2 text-xs font-semibold text-ink hover:bg-paper transition-colors">
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={!confirmable}
              className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink-hover transition-colors disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" /> Confirm &amp; import
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
