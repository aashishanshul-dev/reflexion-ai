import React, { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, LogOut, Plus, Trash2 } from 'lucide-react';
import { AuthorityLevel, Classification, OpsDatabaseState, PreferredLanguage } from '../types/ops';
import {
  buildWorkspaceFromSetup,
  emptySetupAnswers,
  SETUP_STEPS,
  SetupAnswers,
  SetupPerson,
  SetupStepId,
  validateSetupStep,
} from '../lib/setupWizard';
import { ReflexionWordmark } from './BrandLogo';

interface SetupWizardProps {
  accountEmail: string | null;
  tenantId: string;
  onFinished: (workspace: OpsDatabaseState) => Promise<void>;
  onSignOut: () => void;
}

const STEP_TITLES: Record<SetupStepId, { title: string; hint: string }> = {
  BUSINESS: { title: 'Your business', hint: 'What you do and where. The AI uses this for every plan.' },
  ROLE: { title: 'Your role', hint: 'You are the owner. Your WhatsApp number receives your daily summary.' },
  PEOPLE: { title: 'Your people', hint: 'Everyone who will receive tasks on WhatsApp.' },
  TASK_TYPES: { title: 'Your task types', hint: 'Kinds of work you hand out, with usual checklist steps. You can skip this.' },
};
const LANGUAGES: Array<{ id: PreferredLanguage; label: string }> = [
  { id: 'ENGLISH', label: 'English' },
  { id: 'HINGLISH', label: 'Hinglish' },
  { id: 'HINDI', label: 'Hindi' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const AUTHORITY: AuthorityLevel[] = ['STAFF', 'SUPERVISOR', 'MANAGER'];

const input =
  'w-full rounded-xl border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-slate/60 focus:border-signal focus:outline-none transition-colors';
const label = 'block text-xs font-semibold text-ink mb-1';

function Field({ id, text, children }: { id: string; text: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={label}>{text}</label>
      {children}
    </div>
  );
}

/** Split a comma- or newline-separated field into trimmed, non-empty phrases. */
function splitPhrases(text: string): string[] {
  return String(text || '')
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function PersonFields({
  idPrefix,
  person,
  onChange,
  showAuthority,
}: {
  idPrefix: string;
  person: SetupPerson;
  onChange: (p: SetupPerson) => void;
  showAuthority: boolean;
}) {
  const set = <K extends keyof SetupPerson>(k: K, v: SetupPerson[K]) => onChange({ ...person, [k]: v });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
      <Field id={`${idPrefix}-name`} text="Name">
        <input id={`${idPrefix}-name`} className={input} value={person.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field id={`${idPrefix}-role`} text="Role">
        <input id={`${idPrefix}-role`} className={input} value={person.roleTitle} onChange={(e) => set('roleTitle', e.target.value)} />
      </Field>
      <Field id={`${idPrefix}-phone`} text="WhatsApp number (with country code)">
        <input id={`${idPrefix}-phone`} inputMode="tel" className={input} value={person.phone} onChange={(e) => set('phone', e.target.value)} />
      </Field>
      <Field id={`${idPrefix}-lang`} text="Language">
        <select id={`${idPrefix}-lang`} className={input} value={person.preferredLanguage} onChange={(e) => set('preferredLanguage', e.target.value as PreferredLanguage)}>
          {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </Field>
      <Field id={`${idPrefix}-start`} text="Shift starts">
        <input id={`${idPrefix}-start`} type="time" className={input} value={person.workShiftStart} onChange={(e) => set('workShiftStart', e.target.value)} />
      </Field>
      <Field id={`${idPrefix}-end`} text="Shift ends">
        <input id={`${idPrefix}-end`} type="time" className={input} value={person.workShiftEnd} onChange={(e) => set('workShiftEnd', e.target.value)} />
      </Field>
      {showAuthority && (
        <>
          <Field id={`${idPrefix}-cap`} text="Open tasks at a time (limit)">
            <input id={`${idPrefix}-cap`} type="number" min={1} max={20} className={`${input} tabular-nums`} value={person.maxActiveTasks} onChange={(e) => set('maxActiveTasks', Number(e.target.value) || 1)} />
          </Field>
          <Field id={`${idPrefix}-auth`} text="Authority">
            <select id={`${idPrefix}-auth`} className={input} value={person.authorityLevel} onChange={(e) => set('authorityLevel', e.target.value as AuthorityLevel)}>
              {AUTHORITY.map((a) => <option key={a} value={a}>{a.charAt(0) + a.slice(1).toLowerCase()}</option>)}
            </select>
          </Field>
        </>
      )}
      <div className="sm:col-span-2">
        <Field id={`${idPrefix}-handles`} text="What they handle (optional)">
          <textarea
            id={`${idPrefix}-handles`}
            rows={2}
            className={input}
            placeholder="A few sentences on the work this person usually looks after. The AI uses this to choose who does a task."
            value={person.responsibilities || ''}
            onChange={(e) => set('responsibilities', e.target.value)}
          />
        </Field>
      </div>
      <Field id={`${idPrefix}-strengths`} text="Strengths (comma-separated, optional)">
        <input
          id={`${idPrefix}-strengths`}
          className={input}
          placeholder="e.g. vendor relations, calm under pressure"
          value={(person.strengths || []).join(', ')}
          onChange={(e) => set('strengths', splitPhrases(e.target.value))}
        />
      </Field>
      <Field id={`${idPrefix}-weaknesses`} text="Weaknesses — private (comma-separated, optional)">
        <input
          id={`${idPrefix}-weaknesses`}
          className={input}
          placeholder="e.g. slow at paperwork"
          value={(person.weaknesses || []).join(', ')}
          onChange={(e) => set('weaknesses', splitPhrases(e.target.value))}
        />
      </Field>
    </div>
  );
}

/** First-run setup for a new cloud workspace: business → role → people → task types → first tasks. */
export const SetupWizard: React.FC<SetupWizardProps> = ({ accountEmail, tenantId, onFinished, onSignOut }) => {
  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);
  const [answers, setAnswers] = useState<SetupAnswers>(() => emptySetupAnswers(timezone));
  const [stepIndex, setStepIndex] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const step = SETUP_STEPS[stepIndex];
  const isLast = stepIndex === SETUP_STEPS.length - 1;

  const newPerson = (): SetupPerson => ({
    name: '',
    roleTitle: '',
    phone: '',
    preferredLanguage: answers.business.defaultStaffLanguage,
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    maxActiveTasks: 3,
    responsibilities: '',
    strengths: [],
    weaknesses: [],
    authorityLevel: 'STAFF',
  });

  const next = async () => {
    const problems = validateSetupStep(step, answers);
    setErrors(problems);
    if (problems.length > 0) return;
    if (!isLast) {
      setStepIndex((i) => i + 1);
      if (SETUP_STEPS[stepIndex + 1] === 'PEOPLE' && answers.people.length === 0) {
        setAnswers((a) => ({ ...a, people: [newPerson()] }));
      }
      return;
    }
    setSaving(true);
    try {
      await onFinished(buildWorkspaceFromSetup(answers, tenantId, new Date().toISOString()));
    } catch (err: any) {
      setErrors([`Could not save your workspace: ${err?.message || 'unknown error'}`]);
      setSaving(false);
    }
  };

  const b = answers.business;
  const setBiz = <K extends keyof SetupAnswers['business']>(k: K, v: SetupAnswers['business'][K]) =>
    setAnswers((a) => ({ ...a, business: { ...a.business, [k]: v } }));

  return (
    <main className="min-h-screen bg-paper p-4 sm:p-8">
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-hairline">
          <div className="flex flex-wrap items-center gap-3">
            <ReflexionWordmark size="sm" />
            <span aria-hidden="true" className="text-hairline-strong">·</span>
            <p className="text-xs text-slate">
              Workspace for <strong className="text-ink">{accountEmail || 'your account'}</strong>
            </p>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate hover:text-ink hover:bg-surface-muted transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>

        <ol className="flex flex-wrap gap-1.5" aria-label="Setup steps">
          {SETUP_STEPS.map((s, i) => (
            <li
              key={s}
              className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold border transition-colors ${
                i === stepIndex
                  ? 'bg-ink text-white border-ink'
                  : i < stepIndex
                    ? 'bg-ok-soft text-ok border-ok-border'
                    : 'bg-surface text-slate border-hairline'
              }`}
            >
              <span className="tabular-nums">{i + 1}.</span> {STEP_TITLES[s].title}
            </li>
          ))}
          <li className="rounded-lg border border-hairline bg-surface px-3 py-1.5 text-[11px] font-semibold text-slate">
            <span className="tabular-nums">5.</span> Your first tasks
          </li>
        </ol>

        <section
          className="rounded-2xl border border-hairline bg-surface p-5 sm:p-6 shadow-[var(--shadow-card)] space-y-5"
          aria-label={STEP_TITLES[step].title}
        >
          <div>
            <h1 className="text-lg font-semibold text-ink">{STEP_TITLES[step].title}</h1>
            <p className="text-sm text-slate mt-0.5">{STEP_TITLES[step].hint}</p>
          </div>

          {step === 'BUSINESS' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <Field id="biz-name" text="Business name">
                <input id="biz-name" className={input} value={b.businessName} onChange={(e) => setBiz('businessName', e.target.value)} />
              </Field>
              <Field id="biz-type" text="Kind of business">
                <input id="biz-type" className={input} value={b.businessType} onChange={(e) => setBiz('businessType', e.target.value)} />
              </Field>
              <div className="sm:col-span-2">
                <Field id="biz-desc" text="What you do (a few sentences)">
                  <textarea id="biz-desc" rows={3} className={input} value={b.businessDescription} onChange={(e) => setBiz('businessDescription', e.target.value)} />
                </Field>
              </div>
              <Field id="biz-loc" text="Work locations (comma separated)">
                <input id="biz-loc" className={input} value={b.workLocations} onChange={(e) => setBiz('workLocations', e.target.value)} />
              </Field>
              <Field id="biz-lang" text="Usual staff language">
                <select id="biz-lang" className={input} value={b.defaultStaffLanguage} onChange={(e) => setBiz('defaultStaffLanguage', e.target.value as PreferredLanguage)}>
                  {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </Field>
              <Field id="biz-tz" text="Timezone">
                <input id="biz-tz" className={input} value={b.timezone} onChange={(e) => setBiz('timezone', e.target.value)} />
              </Field>
              <fieldset>
                <legend className={label}>Working days</legend>
                <div className="flex flex-wrap gap-1.5">
                  {DAYS.map((d, i) => {
                    const on = b.workingDays.includes(i);
                    return (
                      <label
                        key={d}
                        className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                          on
                            ? 'border-signal-border bg-signal-soft text-signal-ink'
                            : 'border-hairline bg-surface text-slate hover:bg-paper'
                        }`}
                      >
                        <input type="checkbox" className="sr-only" checked={on} onChange={() => setBiz('workingDays', on ? b.workingDays.filter((x) => x !== i) : [...b.workingDays, i])} />
                        {d}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <div className="sm:col-span-2">
                <Field id="biz-rules" text="Rules everyone must follow (optional)">
                  <textarea id="biz-rules" rows={2} className={input} value={b.hardRules} onChange={(e) => setBiz('hardRules', e.target.value)} />
                </Field>
              </div>
            </div>
          )}

          {step === 'ROLE' && (
            <div className="space-y-3.5">
              <PersonFields idPrefix="owner" person={answers.owner} showAuthority={false} onChange={(p) => setAnswers((a) => ({ ...a, owner: { ...a.owner, ...p } }))} />
              <Field id="owner-how" text="How you work (what you keep, what you delegate, when to ask you)">
                <textarea id="owner-how" rows={3} className={input} value={answers.owner.howIWork} onChange={(e) => setAnswers((a) => ({ ...a, owner: { ...a.owner, howIWork: e.target.value } }))} />
              </Field>
            </div>
          )}

          {step === 'PEOPLE' && (
            <div className="space-y-3.5">
              {answers.people.map((p, i) => (
                <div key={i} className="rounded-xl border border-hairline bg-paper/50 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-ink tabular-nums">Person {i + 1}</p>
                    <button
                      type="button"
                      aria-label={`Remove person ${i + 1}`}
                      onClick={() => setAnswers((a) => ({ ...a, people: a.people.filter((_, j) => j !== i) }))}
                      className="rounded-lg border border-danger-border bg-surface p-1.5 text-danger hover:bg-danger-soft transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <PersonFields idPrefix={`person-${i}`} person={p} showAuthority onChange={(np) => setAnswers((a) => ({ ...a, people: a.people.map((x, j) => (j === i ? np : x)) }))} />
                </div>
              ))}
              <button
                type="button"
                onClick={() => setAnswers((a) => ({ ...a, people: [...a.people, newPerson()] }))}
                className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-xs font-semibold text-white hover:bg-ink-hover transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Add a person
              </button>
            </div>
          )}

          {step === 'TASK_TYPES' && (
            <div className="space-y-3.5">
              {answers.taskTypes.map((t, i) => (
                <div key={i} className="rounded-xl border border-hairline bg-paper/50 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <Field id={`type-${i}-name`} text="Task type">
                    <input id={`type-${i}-name`} className={input} value={t.name} onChange={(e) => setAnswers((a) => ({ ...a, taskTypes: a.taskTypes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))} />
                  </Field>
                  <Field id={`type-${i}-class`} text="Usually">
                    <select id={`type-${i}-class`} className={input} value={t.defaultClassification} onChange={(e) => setAnswers((a) => ({ ...a, taskTypes: a.taskTypes.map((x, j) => (j === i ? { ...x, defaultClassification: e.target.value as Classification } : x)) }))}>
                      <option value="MINOR">Minor</option>
                      <option value="MAJOR">Major</option>
                    </select>
                  </Field>
                  <div className="sm:col-span-2">
                    <Field id={`type-${i}-steps`} text="Usual checklist steps (one per line)">
                      <textarea id={`type-${i}-steps`} rows={3} className={input} value={t.defaultSteps.join('\n')} onChange={(e) => setAnswers((a) => ({ ...a, taskTypes: a.taskTypes.map((x, j) => (j === i ? { ...x, defaultSteps: e.target.value.split('\n') } : x)) }))} />
                    </Field>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAnswers((a) => ({ ...a, taskTypes: a.taskTypes.filter((_, j) => j !== i) }))}
                    className="justify-self-start text-xs font-semibold text-danger hover:underline"
                  >
                    Remove this type
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setAnswers((a) => ({ ...a, taskTypes: [...a.taskTypes, { name: '', defaultClassification: 'MINOR', defaultSteps: [] }] }))}
                className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-xs font-semibold text-white hover:bg-ink-hover transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Add a task type
              </button>
              {answers.taskTypes.length === 0 && (
                <p className="text-xs text-slate">No task types yet — a general type is added for you. You can add more later in AI Brain &amp; Setup.</p>
              )}
            </div>
          )}

          {errors.length > 0 && (
            <ul role="alert" className="space-y-1.5">
              {errors.map((e, i) => (
                <li key={i} className="rounded-xl border border-danger-border bg-danger-soft px-3 py-2 text-xs font-medium text-danger">{e}</li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap justify-between gap-2 border-t border-hairline pt-4">
            <button
              type="button"
              onClick={() => {
                setErrors([]);
                setStepIndex((i) => Math.max(0, i - 1));
              }}
              disabled={stepIndex === 0 || saving}
              className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-paper transition-colors disabled:opacity-40"
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </button>
            <button
              type="button"
              onClick={() => void next()}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink-hover transition-colors disabled:opacity-60"
            >
              {isLast ? (
                <>
                  <Check className="h-4 w-4" /> {saving ? 'Saving…' : 'Finish and create my first tasks'}
                </>
              ) : (
                <>
                  Next <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
};
