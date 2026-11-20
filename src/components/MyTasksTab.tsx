import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, ClipboardCheck, Gavel, Send, ShieldAlert, UserCheck } from 'lucide-react';
import { OpsDatabaseState, Task } from '../types/ops';
import { describeFollowUpReason, FollowUpReason, MyTasksSummary } from '../lib/myTasks';
import { formatTimestampInTimezone } from '../lib/releaseEngine';
import { SECTION_EXPLAINERS, TASK_STATUS_LABELS } from '../lib/plainLabels';
import { BrandEmptyState } from './BrandLogo';

interface MyTasksTabProps {
  state: OpsDatabaseState;
  summary: MyTasksSummary;
  stuckHours: number;
  onToggleMicroStepManual: (taskCode: string, stepId: string) => void;
  onInstantNudge: (taskCode: string) => void;
  onOpenBossReviews: () => void;
  onOpenLiveOps: () => void;
}

const STATUS_LABEL: Partial<Record<Task['status'], string>> = {
  SCHEDULED: TASK_STATUS_LABELS.SCHEDULED,
  LOCKED_BY_DEPENDENCY: TASK_STATUS_LABELS.LOCKED_BY_DEPENDENCY,
  PENDING: 'To start',
  IN_PROGRESS: TASK_STATUS_LABELS.IN_PROGRESS,
  PARTIALLY_DONE: TASK_STATUS_LABELS.PARTIALLY_DONE,
  AWAITING_BOSS_DECISION: TASK_STATUS_LABELS.AWAITING_BOSS_DECISION,
};

const REASON_CLASS: Record<FollowUpReason, string> = {
  OVERDUE: 'bg-danger-soft text-danger border border-danger-border',
  BEHIND: 'bg-danger-soft text-danger border border-danger-border',
  STUCK: 'bg-warn-soft text-warn border border-warn-border',
  PARTIALLY_DONE: 'bg-info-soft text-info border border-info-border',
  AWAITING_DECISION: 'bg-signal-soft text-signal-ink border border-signal-border',
};

function Section({
  title,
  icon: Icon,
  count,
  hint,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-card)] space-y-3"
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-ink font-display">
            <Icon className="h-4 w-4 text-signal" />
            {title}
            <span className="rounded-full bg-paper border border-hairline px-2 py-0.5 text-xs font-bold text-ink tabular-nums">
              {count}
            </span>
          </h2>
          <p className="text-xs text-slate mt-0.5">{hint}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export const MyTasksTab: React.FC<MyTasksTabProps> = ({
  state,
  summary,
  stuckHours,
  onToggleMicroStepManual,
  onInstantNudge,
  onOpenBossReviews,
  onOpenLiveOps,
}) => {
  const [openTask, setOpenTask] = useState<string | null>(null);
  const nameOf = (phone: string) => state.team_members[phone]?.name || 'Unknown person';

  if (summary.ownerPhones.length === 0) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="rounded-2xl border border-warn-border bg-warn-soft p-5 text-sm text-warn">
          No one in the team has the authority level <strong>Owner</strong>, so there is no “My tasks” list yet. Set it in
          2x2 Matrix &amp; Team.
        </div>
        <BrandEmptyState
          compact
          title="No owner assigned yet"
          description="Assign the Owner authority level in 2x2 Matrix & Team to unlock your personal Do, Decide, and Follow up queue."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="border-b border-hairline pb-4">
        <h2 className="text-xl font-bold tracking-tight text-ink font-display">My Tasks</h2>
        <p className="mt-1 text-xs text-slate">{SECTION_EXPLAINERS.myTasks}</p>
      </div>
      <Section title="Do" icon={ClipboardCheck} count={summary.counts.do} hint="Tasks where you are doing the work.">
        {summary.do.length === 0 ? (
          <p className="text-xs text-slate">Nothing on your own plate right now.</p>
        ) : (
          <ul className="space-y-2.5">
            {summary.do.map((t) => {
              const expanded = openTask === t.taskCode;
              const done = t.microSteps.filter((s) => s.status === 'DONE').length;
              return (
                <li key={t.taskCode} className="rounded-xl border border-hairline bg-paper/45 p-3.5 transition-colors hover:border-hairline-strong">
                  <button
                    type="button"
                    onClick={() => setOpenTask(expanded ? null : t.taskCode)}
                    className="flex w-full items-start justify-between gap-2 text-left"
                    aria-expanded={expanded}
                  >
                    <span className="min-w-0">
                      <span className="mr-1.5 rounded-md bg-ink px-2 py-0.5 text-[11px] font-bold text-white font-mono">
                        {t.shortTag || t.taskCode}
                      </span>
                      <span className="text-sm font-semibold text-ink break-words">{t.title}</span>
                      <span className="block text-[11px] text-slate mt-1 tabular-nums">
                        {STATUS_LABEL[t.status] || t.status} · Due {t.dueDate} · {done}/{t.microSteps.length} steps
                      </span>
                    </span>
                    {expanded ? (
                      <ChevronUp className="h-4 w-4 shrink-0 text-slate" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0 text-slate" />
                    )}
                  </button>
                  {expanded && (
                    <ul className="mt-2.5 space-y-1.5 border-t border-hairline pt-2.5">
                      {t.microSteps.length === 0 && <li className="text-xs text-slate">No checklist steps.</li>}
                      {t.microSteps.map((s) => (
                        <li key={s.id}>
                          <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
                            <input
                              type="checkbox"
                              checked={s.status === 'DONE'}
                              onChange={() => onToggleMicroStepManual(t.taskCode, s.id)}
                              className="h-4 w-4 rounded border-hairline-strong text-signal focus:ring-signal"
                            />
                            <span className={s.status === 'DONE' ? 'line-through text-slate' : ''}>{s.label}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Decide" icon={Gavel} count={summary.counts.decide} hint="Approvals and decisions waiting for you.">
        {summary.decide.length === 0 ? (
          <p className="text-xs text-slate">No decisions waiting.</p>
        ) : (
          <ul className="space-y-2.5">
            {summary.decide.map(({ review, task }) => (
              <li key={review.reviewId} className="rounded-xl border border-signal-border bg-signal-soft/65 p-3.5 space-y-1">
                <p className="text-xs font-semibold text-signal-ink">
                  <ShieldAlert className="mr-1 inline h-3.5 w-3.5 text-signal" />
                  [{task?.shortTag || review.taskCode}] {task?.title || ''}
                </p>
                <p className="text-sm text-ink break-words">{review.employeeMessageSummary}</p>
                <p className="text-[11px] text-slate tabular-nums">
                  From {nameOf(review.employeePhone)} · raised{' '}
                  {Number.isNaN(Date.parse(review.createdAt))
                    ? review.createdAt
                    : formatTimestampInTimezone(Date.parse(review.createdAt), state.business_profile?.timezone)}
                </p>
              </li>
            ))}
          </ul>
        )}
        {summary.decide.length > 0 && (
          <button
            type="button"
            onClick={onOpenBossReviews}
            className="rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink-hover transition-colors"
          >
            Open Boss Reviews
          </button>
        )}
      </Section>

      <Section
        title="Follow up"
        icon={UserCheck}
        count={summary.counts.followUp}
        hint={`Delegated work you are Accountable for that is overdue, has had no update for ${stuckHours} h, is partly done, or waits for your decision.`}
      >
        {summary.followUp.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-slate">
            <CheckCircle2 className="h-3.5 w-3.5 text-ok" /> Nothing needs chasing.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {summary.followUp.map((f) => (
              <li key={f.task.taskCode} className="rounded-xl border border-hairline bg-paper/45 p-3.5 space-y-2">
                <p className="text-sm font-semibold text-ink break-words">
                  <span className="mr-1.5 rounded-md bg-ink px-2 py-0.5 text-[11px] font-bold text-white font-mono">
                    {f.task.shortTag || f.task.taskCode}
                  </span>
                  {f.task.title}
                </p>
                <p className="text-[11px] text-slate tabular-nums">
                  Responsible: <strong className="text-ink">{nameOf(f.task.raci.R)}</strong> · Due {f.task.dueDate}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {f.reasons.map((r) => (
                    <span key={r} className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${REASON_CLASS[r]}`}>
                      {describeFollowUpReason(r, f)}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {f.task.status !== 'AWAITING_BOSS_DECISION' && (
                    <button
                      type="button"
                      onClick={() => onInstantNudge(f.task.taskCode)}
                      className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink-hover transition-colors"
                    >
                      <Send className="h-3.5 w-3.5 text-signal" /> Nudge
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={f.task.status === 'AWAITING_BOSS_DECISION' ? onOpenBossReviews : onOpenLiveOps}
                    className="rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-paper transition-colors"
                  >
                    {f.task.status === 'AWAITING_BOSS_DECISION' ? 'Open Boss Reviews' : 'Open in Live Ops'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
};

