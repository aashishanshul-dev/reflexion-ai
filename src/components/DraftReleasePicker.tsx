import React, { useId } from 'react';
import { AlertTriangle, Clock, Link2, Play, UserCheck } from 'lucide-react';
import {
  defaultReleaseAtLocal,
  findIncompleteReleaseChoice,
  findPastReleaseTime,
} from '../lib/releaseEngine';
import {
  DependencyTrigger,
  Task,
  TaskReleaseConfig,
  TaskReleaseMode,
} from '../types/ops';

interface DraftReleasePickerProps {
  release?: Partial<TaskReleaseConfig>;
  onChange: (nextRelease: Partial<TaskReleaseConfig>) => void;
  existingTasks?: Task[];
  otherDrafts?: Array<{ tempId: string; title: string; shortTag?: string }>;
  currentTempId?: string;
  businessTimezone?: string;
  compact?: boolean;
  /** A dependency already set another way (e.g. by the AI plan), used if no task is picked. */
  fallbackAfterCode?: string | null;
}

const RELEASE_MODES: Array<{
  id: TaskReleaseMode;
  label: string;
  hint: string;
}> = [
  { id: 'NOW', label: 'Now', hint: 'Release immediately on dispatch (if on shift)' },
  { id: 'AT_TIME', label: 'At a time', hint: 'Hold until a specific date & time' },
  { id: 'AFTER_TASK', label: 'After task', hint: 'Hold until prerequisite completes' },
  { id: 'WHEN_FREE', label: 'When free', hint: 'Hold until assignee has 0 active tasks' },
];

export const DraftReleasePicker: React.FC<DraftReleasePickerProps> = ({
  release,
  onChange,
  existingTasks = [],
  otherDrafts = [],
  currentTempId,
  businessTimezone = 'Asia/Kolkata',
  compact = false,
  fallbackAfterCode = null,
}) => {
  const groupId = useId();
  const timeInputId = useId();
  const afterSelectId = useId();
  const triggerSelectId = useId();
  const delayInputId = useId();
  const confirmCheckboxId = useId();
  const warningId = useId();

  const currentMode: TaskReleaseMode = release?.mode || 'NOW';

  const update = (patch: Partial<TaskReleaseConfig>) => {
    onChange({
      mode: currentMode,
      releaseAt: release?.releaseAt ?? null,
      afterTaskCode: release?.afterTaskCode ?? null,
      afterTrigger: release?.afterTrigger || 'FULL_COMPLETION',
      delayMinutes: release?.delayMinutes ?? 0,
      requireOwnerConfirm: Boolean(release?.requireOwnerConfirm),
      ...patch,
    });
  };

  const handleModeChange = (mode: TaskReleaseMode) => {
    if (mode === 'NOW') {
      update({ mode, releaseAt: null, afterTaskCode: null, delayMinutes: 0 });
    } else if (mode === 'AT_TIME') {
      // Default: one hour from now, as a wall-clock time in the business timezone.
      const defaultLocal =
        release?.releaseAt || defaultReleaseAtLocal(Date.now(), businessTimezone);
      update({ mode, releaseAt: defaultLocal, afterTaskCode: null, delayMinutes: 0 });
    } else if (mode === 'AFTER_TASK') {
      const firstCandidate =
        otherDrafts.find((d) => d.tempId !== currentTempId)?.tempId ||
        existingTasks.find((t) => t.status !== 'COMPLETED' && t.status !== 'EXPIRED_MISSED')
          ?.taskCode ||
        null;
      update({
        mode,
        afterTaskCode: release?.afterTaskCode || firstCandidate,
        afterTrigger: release?.afterTrigger || 'FULL_COMPLETION',
      });
    } else {
      update({ mode, releaseAt: null, afterTaskCode: null, delayMinutes: 0 });
    }
  };

  const effectiveRelease = release ? { ...release, mode: currentMode } : null;
  const incompleteMessage =
    findIncompleteReleaseChoice(effectiveRelease, fallbackAfterCode, businessTimezone) ||
    findPastReleaseTime(effectiveRelease, businessTimezone);

  const selectableOtherDrafts = otherDrafts.filter((d) => d.tempId !== currentTempId);
  const selectableExistingTasks = existingTasks.filter(
    (t) => t.status !== 'EXPIRED_MISSED' && t.status !== 'COMPLETED'
  );

  return (
    <div
      className={`rounded-xl border border-hairline bg-paper/75 ${
        compact ? 'p-2.5' : 'p-3.5'
      } space-y-2.5`}
    >
      <fieldset>
        <legend className="text-[11px] font-bold uppercase tracking-wider text-slate flex items-center gap-1.5 mb-2">
          <Clock className="h-3.5 w-3.5 text-signal" />
          Release Schedule
          {businessTimezone && (
            <span className="font-normal normal-case text-[10px] text-slate/80">
              ({businessTimezone})
            </span>
          )}
        </legend>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {RELEASE_MODES.map((opt) => {
            const radioId = `${groupId}-${opt.id}`;
            const selected = currentMode === opt.id;
            return (
              <label
                key={opt.id}
                htmlFor={radioId}
                title={opt.hint}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold cursor-pointer transition-all ${
                  selected
                    ? 'border-signal-border bg-signal-soft text-signal-ink shadow-[var(--shadow-card)]'
                    : 'border-hairline bg-surface text-slate hover:border-hairline-strong hover:text-ink'
                }`}
              >
                <input
                  id={radioId}
                  type="radio"
                  name={groupId}
                  value={opt.id}
                  checked={selected}
                  onChange={() => handleModeChange(opt.id)}
                  className="h-3 w-3 text-signal focus:ring-signal"
                />
                <span>{opt.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {currentMode === 'AT_TIME' && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
          <label htmlFor={timeInputId} className="text-[11px] font-semibold text-ink shrink-0">
            Release Date &amp; Time:
          </label>
          <input
            id={timeInputId}
            type="datetime-local"
            value={(release?.releaseAt || '').slice(0, 16)}
            onChange={(e) => update({ releaseAt: e.target.value || null })}
            aria-invalid={Boolean(incompleteMessage)}
            aria-describedby={incompleteMessage ? warningId : undefined}
            className="rounded-lg border border-hairline-strong bg-surface px-2.5 py-1 text-xs text-ink focus:border-signal focus:outline-none"
          />
        </div>
      )}

      {currentMode === 'AFTER_TASK' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
          <div>
            <label
              htmlFor={afterSelectId}
              className="block text-[10px] font-semibold text-slate mb-0.5"
            >
              <Link2 className="h-3 w-3 inline mr-1 text-slate" />
              Wait for task
            </label>
            <select
              id={afterSelectId}
              value={release?.afterTaskCode || ''}
              onChange={(e) => update({ afterTaskCode: e.target.value || null })}
              aria-invalid={Boolean(incompleteMessage)}
              aria-describedby={incompleteMessage ? warningId : undefined}
              className="w-full rounded-lg border border-hairline-strong bg-surface px-2 py-1 text-xs text-ink focus:border-signal focus:outline-none"
            >
              <option value="">-- Select task --</option>
              {selectableOtherDrafts.map((d) => (
                <option key={d.tempId} value={d.tempId}>
                  Draft: {d.shortTag || d.title}
                </option>
              ))}
              {selectableExistingTasks.map((t) => (
                <option key={t.taskCode} value={t.taskCode}>
                  {t.taskCode}: {t.shortTag || t.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor={triggerSelectId}
              className="block text-[10px] font-semibold text-slate mb-0.5"
            >
              Trigger condition
            </label>
            <select
              id={triggerSelectId}
              value={release?.afterTrigger || 'FULL_COMPLETION'}
              onChange={(e) =>
                update({ afterTrigger: e.target.value as DependencyTrigger })
              }
              className="w-full rounded-lg border border-hairline-strong bg-surface px-2 py-1 text-xs text-ink focus:border-signal focus:outline-none"
            >
              <option value="FULL_COMPLETION">Full Completion (100%)</option>
              <option value="PARTIAL_OR_BOSS_APPROVAL">Partial / Boss Approval</option>
            </select>
          </div>

          <div>
            <label
              htmlFor={delayInputId}
              className="block text-[10px] font-semibold text-slate mb-0.5"
            >
              Delay after unlock (mins)
            </label>
            <input
              id={delayInputId}
              type="number"
              min={0}
              max={1440}
              step={5}
              value={release?.delayMinutes ?? 0}
              onChange={(e) =>
                update({ delayMinutes: Math.max(0, Number(e.target.value) || 0) })
              }
              className="w-full rounded-lg border border-hairline-strong bg-surface px-2 py-1 text-xs text-ink tabular-nums focus:border-signal focus:outline-none"
            />
          </div>
        </div>
      )}

      {incompleteMessage && (
        <p
          id={warningId}
          role="alert"
          className="text-[11px] font-medium text-warn bg-warn-soft border border-warn-border rounded-lg px-2.5 py-1.5 flex items-center gap-1.5"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {incompleteMessage} This task can't be frozen until you do.
        </p>
      )}

      {currentMode === 'WHEN_FREE' && (
        <p className="text-[11px] text-info bg-info-soft border border-info-border rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
          <Play className="h-3 w-3 shrink-0" />
          Held automatically while the assignee has any active released task.
        </p>
      )}

      <label
        htmlFor={confirmCheckboxId}
        className="inline-flex items-center gap-2 text-[11px] font-medium text-slate cursor-pointer pt-0.5"
      >
        <input
          id={confirmCheckboxId}
          type="checkbox"
          checked={Boolean(release?.requireOwnerConfirm)}
          onChange={(e) => update({ requireOwnerConfirm: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-hairline-strong text-signal focus:ring-signal"
        />
        <UserCheck className="h-3 w-3 text-slate" />
        Require explicit owner confirmation before releasing
      </label>
    </div>
  );
};
