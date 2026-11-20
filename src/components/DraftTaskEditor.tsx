import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Edit3, Plus, Trash2, X } from 'lucide-react';
import {
  Classification,
  MeditateDraftTaskInput,
  Quadrant,
  RecurrenceRule,
  Task,
  TaskFrequency,
  TaskReleaseConfig,
  TeamMember,
} from '../types/ops';
import { applyDraftEdit, DraftEditPatch, generateDraftMessage, moveStep } from '../lib/draftEditing';
import { formatDueLabel } from '../lib/taskTiming';
import { DraftIssue } from '../lib/validator';
import { DraftReleasePicker } from './DraftReleasePicker';

const QUADRANT_OPTIONS: Array<{ id: Quadrant; label: string }> = [
  { id: 'Q1_DO_FIRST', label: 'Q1 Urgent & Important' },
  { id: 'Q2_SCHEDULE', label: 'Q2 Important (Schedule)' },
  { id: 'Q3_DELEGATE', label: 'Q3 Urgent (Delegate)' },
  { id: 'Q4_LOW', label: 'Q4 Routine / Low' },
];
const DURATION_OPTIONS = [0.5, 1, 1.5, 2, 3, 4, 5, 7];

interface DraftTaskEditorProps {
  draft: MeditateDraftTaskInput;
  teamMembers: Record<string, TeamMember>;
  categories: Array<{ categoryId: string; categoryName: string }>;
  /** Problems for the saved draft (shown on the card). */
  issues: DraftIssue[];
  /** Validates a candidate while editing, before Save. */
  validate: (candidate: MeditateDraftTaskInput) => DraftIssue[];
  onSave: (patch: DraftEditPatch) => void;
  onDelete?: () => void;
  existingTasks?: Task[];
  otherDrafts?: Array<{ tempId: string; title: string; shortTag?: string }>;
  businessTimezone?: string;
  /** Start in edit mode (e.g. a task just added by hand). */
  startEditing?: boolean;
  /** Optional swimlane stage choices when editing a multi-task plan. */
  swimlaneStages?: string[];
  onStageChange?: (newStage: string) => void;
  onEditingClose?: () => void;
}

interface FormState {
  title: string;
  shortTag: string;
  microSteps: string[];
  R: string;
  A: string;
  C: string[];
  I: string[];
  categoryId: string;
  quadrant: Quadrant;
  majorOrMinor: Classification;
  dueDate: string;
  dueTime: string;
  durationDays: number;
  release: Partial<TaskReleaseConfig>;
  taskFrequency: TaskFrequency;
  recurrenceRule: RecurrenceRule;
}

function formFromDraft(d: MeditateDraftTaskInput): FormState {
  return {
    title: d.title || '',
    shortTag: d.shortTag || '',
    microSteps: [...(d.microSteps || [])],
    R: d.raci?.R || '',
    A: d.raci?.A || '',
    C: [...(d.raci?.C || [])],
    I: [...(d.raci?.I || [])],
    categoryId: d.categoryId,
    quadrant: d.quadrant,
    majorOrMinor: d.majorOrMinor,
    dueDate: d.dueDate,
    dueTime: d.dueTime || '',
    durationDays: d.durationDays || 1,
    release: d.release ? { ...d.release } : { mode: 'NOW' },
    taskFrequency: d.taskFrequency,
    recurrenceRule: d.recurrenceRule,
  };
}

function patchFromForm(f: FormState): DraftEditPatch {
  return {
    title: f.title,
    shortTag: f.shortTag,
    microSteps: f.microSteps,
    'raci.R': f.R,
    'raci.A': f.A,
    'raci.C': f.C,
    'raci.I': f.I,
    categoryId: f.categoryId,
    quadrant: f.quadrant,
    majorOrMinor: f.majorOrMinor,
    dueDate: f.dueDate,
    dueTime: f.dueTime || null,
    durationDays: f.durationDays,
    release: f.release,
    taskFrequency: f.taskFrequency,
    recurrenceRule: f.taskFrequency === 'RECURRING' ? f.recurrenceRule : 'NONE',
  };
}

const inputClass =
  'w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-sm text-ink focus:border-signal focus:outline-none';
const labelClass = 'block text-[11px] font-bold text-ink mb-1';

function IssueList({ issues }: { issues: DraftIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Problems with this task">
      {issues.map((issue, i) => (
        <li
          key={`${issue.field}-${i}`}
          className={`flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
            issue.severity === 'error'
              ? 'bg-danger-soft text-danger border border-danger-border'
              : 'bg-warn-soft text-warn border border-warn-border'
          }`}
        >
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            <strong>{issue.severity === 'error' ? 'Fix:' : 'Note:'}</strong> {issue.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export const DraftTaskEditor: React.FC<DraftTaskEditorProps> = ({
  draft,
  teamMembers,
  categories,
  issues,
  validate,
  onSave,
  onDelete,
  existingTasks = [],
  otherDrafts = [],
  businessTimezone,
  startEditing = false,
  swimlaneStages,
  onStageChange,
  onEditingClose,
}) => {
  const [editing, setEditing] = useState(startEditing);
  const [form, setForm] = useState<FormState>(() => formFromDraft(draft));
  const [stage, setStage] = useState(draft.swimlaneStage || swimlaneStages?.[0] || '');
  const [message, setMessage] = useState<string>(draft.outboundWhatsappPreview || '');
  const [messageTouched, setMessageTouched] = useState(false);
  const [messageReset, setMessageReset] = useState(false);
  const [newStep, setNewStep] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const members = useMemo(() => Object.values(teamMembers), [teamMembers]);
  const nameOf = (phone: string) => teamMembers[phone]?.name || (phone ? 'Unknown person' : '');
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  const customAfterSave = draft.messageIsCustom && !messageReset;

  const openEditor = () => {
    setForm(formFromDraft(draft));
    setStage(draft.swimlaneStage || swimlaneStages?.[0] || '');
    setMessage(draft.outboundWhatsappPreview || '');
    setMessageTouched(false);
    setMessageReset(false);
    setNewStep('');
    setEditing(true);
  };

  useEffect(() => {
    if (startEditing) {
      openEditor();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEditing]);

  const buildPatch = (): DraftEditPatch => {
    const patch = patchFromForm(form);
    if (messageReset && !messageTouched) patch.outboundWhatsappPreview = null;
    else if (messageTouched) patch.outboundWhatsappPreview = message;
    return patch;
  };

  // Live preview of the edited draft (fields + regenerated or custom message) and its problems.
  const candidate = useMemo(
    () => (editing ? applyDraftEdit(draft, buildPatch(), teamMembers).draft : draft),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, draft, form, message, messageTouched, messageReset, teamMembers]
  );
  const liveIssues = useMemo(() => (editing ? validate(candidate) : []), [editing, candidate, validate]);
  const shownMessage = messageTouched
    ? message
    : messageReset || !draft.messageIsCustom
      ? generateDraftMessage(candidate, teamMembers)
      : draft.outboundWhatsappPreview || '';

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const toggleIn = (key: 'C' | 'I', phone: string) =>
    setForm((prev) => ({
      ...prev,
      [key]: prev[key].includes(phone) ? prev[key].filter((p) => p !== phone) : [...prev[key], phone],
    }));

  const addStep = () => {
    const text = newStep.trim();
    if (!text) return;
    set('microSteps', [...form.microSteps, text]);
    setNewStep('');
  };

  const save = () => {
    onSave(buildPatch());
    if (onStageChange && stage && stage !== draft.swimlaneStage) {
      onStageChange(stage);
    }
    setEditing(false);
    onEditingClose?.();
  };

  const categoryOptions = categories.some((c) => c.categoryId === form.categoryId)
    ? categories
    : [{ categoryId: form.categoryId, categoryName: `${form.categoryId} (not in list)` }, ...categories];

  if (!editing) {
    return (
      <div
        className="rounded-xl border border-hairline bg-surface p-3.5 space-y-2 shadow-[var(--shadow-card)]"
        data-testid="draft-task-card"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-md bg-ink px-2 py-0.5 text-[11px] font-bold text-white font-mono">
                {draft.shortTag || 'No tag'}
              </span>
              {draft.ownerAdded && (
                <span className="rounded-md bg-info-soft border border-info-border px-1.5 py-0.5 text-[10px] font-semibold text-info">
                  Added by you
                </span>
              )}
              {(draft.ownerEditedFields?.length || 0) > 0 && (
                <span className="rounded-md bg-signal-soft border border-signal-border px-1.5 py-0.5 text-[10px] font-semibold text-signal-ink">
                  Edited by you
                </span>
              )}
              {draft.messageIsCustom && (
                <span className="rounded-md bg-ok-soft border border-ok-border px-1.5 py-0.5 text-[10px] font-semibold text-ok">
                  Your message
                </span>
              )}
              {errorCount > 0 && (
                <span className="rounded-md bg-danger-soft border border-danger-border px-1.5 py-0.5 text-[10px] font-bold text-danger tabular-nums">
                  {errorCount} to fix
                </span>
              )}
              {warningCount > 0 && (
                <span className="rounded-md bg-warn-soft border border-warn-border px-1.5 py-0.5 text-[10px] font-bold text-warn tabular-nums">
                  {warningCount} note{warningCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <p className="text-sm font-bold text-ink break-words">{draft.title || 'Untitled task'}</p>
            <p className="text-[11px] text-slate tabular-nums">
              Responsible: <strong className="text-ink">{nameOf(draft.raci?.R) || 'not chosen'}</strong> · Due {formatDueLabel(draft)}
              {draft.dueDateAssumed ? (
                <span className="ml-1 rounded bg-warning-soft border border-warning-border px-1 py-0.2 text-[10px] font-semibold text-warning">
                  assumed
                </span>
              ) : null}{' '}
              · {draft.microSteps?.length || 0} step{(draft.microSteps?.length || 0) === 1 ? '' : 's'}
            </p>
            {draft.assignmentReason ? (
              <p className="mt-1 text-[11px] leading-snug text-slate">
                <span className="font-semibold text-ink">Why: </span>
                {draft.assignmentReason}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={openEditor}
              className="inline-flex items-center gap-1 rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-paper transition-colors"
            >
              <Edit3 className="h-3.5 w-3.5" /> Edit
            </button>
            {onDelete && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-danger-border bg-surface px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger-soft transition-colors"
                aria-label="Delete this draft task"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
          </div>
        </div>
        {confirmDelete && onDelete && (
          <div role="alertdialog" className="flex flex-wrap items-center gap-2 rounded-lg border border-danger-border bg-danger-soft px-2.5 py-1.5">
            <span className="text-xs font-medium text-danger">Delete this draft task? Nothing is sent.</span>
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(false);
                onDelete();
              }}
              className="rounded-md bg-danger-solid px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90"
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded-md border border-hairline-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink"
            >
              Keep
            </button>
          </div>
        )}
        {(draft.aiOverrideNotes || []).map((note, i) => (
          <p key={i} className="rounded-lg bg-info-soft border border-info-border px-2.5 py-1 text-[11px] text-info">
            Meditate: {note}
          </p>
        ))}
        <IssueList issues={issues} />
      </div>
    );
  }

  return (
    <form
      className="rounded-xl border-2 border-signal bg-surface p-3.5 space-y-3 shadow-[var(--shadow-card)]"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      aria-label="Edit draft task"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor={`${draft.tempId}-title`}>Title</label>
          <input id={`${draft.tempId}-title`} className={inputClass} value={form.title} onChange={(e) => set('title', e.target.value)} />
        </div>
        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-tag`}>Short tag</label>
          <input id={`${draft.tempId}-tag`} className={inputClass} value={form.shortTag} onChange={(e) => set('shortTag', e.target.value)} />
        </div>
        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-cat`}>Category</label>
          <select id={`${draft.tempId}-cat`} className={inputClass} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            {categoryOptions.map((c) => (
              <option key={c.categoryId} value={c.categoryId}>{c.categoryName}</option>
            ))}
          </select>
        </div>

        {swimlaneStages && swimlaneStages.length > 0 && (
          <div>
            <label className={labelClass} htmlFor={`${draft.tempId}-stage`}>Stage</label>
            <select
              id={`${draft.tempId}-stage`}
              className={inputClass}
              value={stage}
              onChange={(e) => setStage(e.target.value)}
            >
              {swimlaneStages.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-r`}>Responsible (R)</label>
          <select id={`${draft.tempId}-r`} className={inputClass} value={form.R} onChange={(e) => set('R', e.target.value)}>
            <option value="">— choose —</option>
            {members.map((m) => (
              <option key={m.phone} value={m.phone}>{m.name} ({m.roleTitle})</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-a`}>Accountable (A)</label>
          <select id={`${draft.tempId}-a`} className={inputClass} value={form.A} onChange={(e) => set('A', e.target.value)}>
            <option value="">— none —</option>
            {members.map((m) => (
              <option key={m.phone} value={m.phone}>{m.name} ({m.roleTitle})</option>
            ))}
          </select>
        </div>
        {(['C', 'I'] as const).map((key) => (
          <fieldset key={key}>
            <legend className={labelClass}>{key === 'C' ? 'Consulted (C)' : 'Informed (I)'}</legend>
            <div className="flex flex-wrap gap-1.5">
              {members.map((m) => {
                const on = form[key].includes(m.phone);
                return (
                  <label
                    key={m.phone}
                    className={`cursor-pointer rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                      on
                        ? 'border-signal-border bg-signal-soft text-signal-ink'
                        : 'border-hairline bg-surface text-slate hover:border-hairline-strong'
                    }`}
                  >
                    <input type="checkbox" className="sr-only" checked={on} onChange={() => toggleIn(key, m.phone)} />
                    {m.name}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}

        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-q`}>Quadrant</label>
          <select id={`${draft.tempId}-q`} className={inputClass} value={form.quadrant} onChange={(e) => set('quadrant', e.target.value as Quadrant)}>
            {QUADRANT_OPTIONS.map((q) => (
              <option key={q.id} value={q.id}>{q.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-mm`}>Major / minor</label>
          <select id={`${draft.tempId}-mm`} className={inputClass} value={form.majorOrMinor} onChange={(e) => set('majorOrMinor', e.target.value as Classification)}>
            <option value="MAJOR">Major</option>
            <option value="MINOR">Minor</option>
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-due`}>Due date</label>
          <input id={`${draft.tempId}-due`} type="date" className={inputClass} value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
        </div>
        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-due-time`}>Due by (time, optional)</label>
          <input id={`${draft.tempId}-due-time`} type="time" className={inputClass} value={form.dueTime} onChange={(e) => set('dueTime', e.target.value)} />
        </div>
        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-dur`}>Duration</label>
          <select id={`${draft.tempId}-dur`} className={inputClass} value={form.durationDays} onChange={(e) => set('durationDays', Number(e.target.value))}>
            {(DURATION_OPTIONS.includes(form.durationDays) ? DURATION_OPTIONS : [form.durationDays, ...DURATION_OPTIONS]).map((d) => (
              <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${draft.tempId}-freq`}>One-time or recurring</label>
          <select id={`${draft.tempId}-freq`} className={inputClass} value={form.taskFrequency} onChange={(e) => set('taskFrequency', e.target.value as TaskFrequency)}>
            <option value="ONE_TIME">One-time</option>
            <option value="RECURRING">Recurring</option>
          </select>
        </div>
        {form.taskFrequency === 'RECURRING' && (
          <div>
            <label className={labelClass} htmlFor={`${draft.tempId}-rule`}>Repeats</label>
            <select
              id={`${draft.tempId}-rule`}
              className={inputClass}
              value={form.recurrenceRule === 'NONE' ? 'DAILY' : form.recurrenceRule}
              onChange={(e) => set('recurrenceRule', e.target.value as RecurrenceRule)}
            >
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
            </select>
          </div>
        )}
      </div>

      <div>
        <span className={labelClass}>Checklist steps ({form.microSteps.length})</span>
        <ol className="space-y-1.5">
          {form.microSteps.map((step, idx) => (
            <li key={idx} className="flex items-center gap-1.5">
              <span className="w-5 text-right text-xs font-semibold text-slate tabular-nums">{idx + 1}.</span>
              <input
                className={`${inputClass} py-1.5`}
                value={step}
                aria-label={`Step ${idx + 1}`}
                onChange={(e) => set('microSteps', form.microSteps.map((s, i) => (i === idx ? e.target.value : s)))}
              />
              <button type="button" aria-label={`Move step ${idx + 1} up`} disabled={idx === 0} onClick={() => set('microSteps', moveStep(form.microSteps, idx, idx - 1))} className="rounded-md border border-hairline p-1.5 text-slate hover:text-ink disabled:opacity-30">
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" aria-label={`Move step ${idx + 1} down`} disabled={idx === form.microSteps.length - 1} onClick={() => set('microSteps', moveStep(form.microSteps, idx, idx + 1))} className="rounded-md border border-hairline p-1.5 text-slate hover:text-ink disabled:opacity-30">
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button type="button" aria-label={`Remove step ${idx + 1}`} onClick={() => set('microSteps', form.microSteps.filter((_, i) => i !== idx))} className="rounded-md border border-danger-border p-1.5 text-danger hover:bg-danger-soft">
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ol>
        <div className="mt-1.5 flex gap-1.5">
          <input
            className={`${inputClass} py-1.5`}
            value={newStep}
            placeholder="Add a step…"
            aria-label="New step"
            onChange={(e) => setNewStep(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addStep();
              }
            }}
          />
          <button type="button" onClick={addStep} className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 text-xs font-semibold text-white hover:bg-ink-hover">
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className={labelClass} htmlFor={`${draft.tempId}-msg`}>Message to send on WhatsApp</label>
          {(messageTouched || customAfterSave) && (
            <button
              type="button"
              onClick={() => {
                setMessageTouched(false);
                setMessageReset(true);
              }}
              className="text-[11px] font-semibold text-signal-ink underline"
            >
              Reset to generated
            </button>
          )}
        </div>
        <textarea
          id={`${draft.tempId}-msg`}
          rows={5}
          className={inputClass}
          value={shownMessage}
          onChange={(e) => {
            setMessage(e.target.value);
            setMessageTouched(true);
            setMessageReset(false);
          }}
        />
        <p className="mt-0.5 text-[10px] text-slate">
          {messageTouched || customAfterSave
            ? 'Your own text — sent exactly as written.'
            : 'Generated from the fields above. Type here to write your own.'}
        </p>
      </div>

      <DraftReleasePicker
        release={form.release}
        onChange={(next) => set('release', next)}
        existingTasks={existingTasks}
        otherDrafts={otherDrafts}
        currentTempId={draft.tempId}
        fallbackAfterCode={draft.dependsOnTempIdOrTaskCode}
        businessTimezone={businessTimezone}
        compact
      />

      <IssueList issues={liveIssues} />

      <div className="flex flex-wrap justify-end gap-2 border-t border-hairline pt-2.5">
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            onEditingClose?.();
          }}
          className="rounded-lg border border-hairline-strong bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-paper"
        >
          Cancel
        </button>
        <button type="submit" className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-white hover:bg-ink-hover">
          Save
        </button>
      </div>
    </form>
  );
};
