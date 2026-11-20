import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  PauseCircle,
  Send,
  ShieldAlert,
  Unlock,
  User,
} from 'lucide-react';
import { OpsDatabaseState } from '../types/ops';
import { findBehindTasksInProject } from '../lib/behindAlerts';
import { bossReviewTypeLabel, SECTION_EXPLAINERS } from '../lib/plainLabels';
import { BrandEmptyState } from './BrandLogo';

interface BossReviewQueueTabProps {
  state: OpsDatabaseState;
  onResolveReview: (reviewId: string, replyText: string, unlockDownstream: boolean) => void;
}

export const BossReviewQueueTab: React.FC<BossReviewQueueTabProps> = ({
  state,
  onResolveReview,
}) => {
  const [queueFilter, setQueueFilter] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const [customReplies, setCustomReplies] = useState<Record<string, string>>({});
  const [unlockToggles, setUnlockToggles] = useState<Record<string, boolean>>({});

  const openCount = useMemo(
    () => state.boss_review_queue.filter((r) => r.status === 'OPEN').length,
    [state.boss_review_queue]
  );
  const resolvedCount = useMemo(
    () => state.boss_review_queue.filter((r) => r.status === 'RESOLVED').length,
    [state.boss_review_queue]
  );

  const visibleItems = useMemo(
    () => state.boss_review_queue.filter((r) => r.status === queueFilter),
    [state.boss_review_queue, queueFilter]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline pb-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink font-display">
            Boss Reviews
          </h2>
          <p className="mt-1 text-sm text-slate">
            {SECTION_EXPLAINERS.bossReviews}
          </p>
        </div>

        {/* Filter Segmented Control */}
        <div className="inline-flex items-center rounded-lg border border-hairline bg-surface-muted p-1">
          <button
            type="button"
            onClick={() => setQueueFilter('OPEN')}
            className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-all tabular-nums ${
              queueFilter === 'OPEN'
                ? 'bg-surface text-danger shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            Pending Review ({openCount})
          </button>
          <button
            type="button"
            onClick={() => setQueueFilter('RESOLVED')}
            className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-all tabular-nums ${
              queueFilter === 'RESOLVED'
                ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            Resolved History ({resolvedCount})
          </button>
        </div>
      </div>

      {visibleItems.length === 0 ? (
        <BrandEmptyState
          title={
            queueFilter === 'OPEN'
              ? 'Zero bottlenecks awaiting leadership approval.'
              : 'No resolved review items in history yet.'
          }
          description="When staff ask questions regarding budgets, equipment, or handovers in the WhatsApp chat, Gemini routes them here automatically."
        />
      ) : (
        <div className="space-y-4">
          {visibleItems.map((item) => {
            const employee = state.team_members[item.employeePhone];
            const parentTask = state.tasks.find((t) => t.taskCode === item.taskCode);
            const downstreamTasks = state.tasks.filter(
              (t) =>
                t.status === 'LOCKED_BY_DEPENDENCY' &&
                t.dependency.dependsOnTaskCode === item.taskCode
            );
            const shouldUnlock = unlockToggles[item.reviewId] ?? true;

            return (
              <article
                key={item.reviewId}
                className={`rounded-2xl border bg-surface p-5 space-y-4 shadow-[var(--shadow-card)] transition-all ${
                  item.status === 'OPEN' ? 'border-danger-border' : 'border-hairline'
                }`}
              >
                {/* Header row: Short tag, review type, employee name, timestamp */}
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center rounded-md bg-ink px-2.5 py-1 text-xs font-semibold text-white font-mono">
                      {parentTask?.shortTag || parentTask?.title || 'Review Item'}
                    </span>

                    <span className="inline-flex items-center rounded-md border border-danger-border bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">
                      {bossReviewTypeLabel(item.reviewType)}
                    </span>

                    <span className="inline-flex items-center gap-1.5 text-ink font-medium">
                      <User className="h-3.5 w-3.5 text-slate" />
                      {employee?.name || item.employeePhone} ({employee?.roleTitle || 'Staff'})
                    </span>

                    <span className="text-slate/60">·</span>

                    <span className="text-slate flex items-center gap-1 tabular-nums">
                      <Clock className="h-3 w-3 text-slate" />
                      {new Date(item.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  {item.status === 'OPEN' ? (
                    <div className="inline-flex items-center gap-1.5 rounded-full border border-warn-border bg-warn-soft px-3 py-1 text-xs font-semibold text-warn">
                      <PauseCircle className="h-3.5 w-3.5 text-warn" />
                      <span>SLA Timer Paused</span>
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-md border border-ok-border bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok tabular-nums">
                      <CheckCircle2 className="h-3.5 w-3.5 text-ok" />
                      Resolved {item.resolvedAt ? new Date(item.resolvedAt).toLocaleTimeString() : ''}
                    </span>
                  )}
                </div>

                {/* Question & Context */}
                <div className="rounded-xl border border-hairline bg-paper/70 p-4">
                  <h3 className="text-sm font-bold text-ink font-display">
                    {parentTask?.title || 'Operational Task'}
                  </h3>
                  <p className="mt-2 text-xs font-medium text-ink leading-relaxed bg-surface p-3 rounded-lg border border-hairline">
                    &ldquo;{item.employeeMessageSummary}&rdquo;
                  </p>
                  {item.mediaVerificationNote && (
                    <p className="mt-2 text-xs font-medium text-warn bg-warn-soft p-2 rounded-lg border border-warn-border inline-block">
                      Attachment Inspection: {item.mediaVerificationNote}
                    </p>
                  )}
                </div>

                {/* Late work in the same job that this decision may be holding up */}
                {item.status === 'OPEN' && parentTask &&
                  findBehindTasksInProject(state, parentTask, Date.now()).map((bt) => (
                    <div
                      key={bt.taskCode}
                      className="rounded-xl border border-danger-border bg-danger-soft px-4 py-2.5 text-xs text-danger"
                    >
                      Holding up late work: <strong className="text-ink">{bt.shortTag || bt.title}</strong> (
                      {state.team_members[bt.raci.R]?.name || 'Staff'}) — {bt.scheduleRisk?.reason || 'past its deadline'}
                    </div>
                  ))}

                {/* Downstream unlock alert */}
                {downstreamTasks.length > 0 && item.status === 'OPEN' && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn-border bg-warn-soft px-4 py-2.5 text-xs">
                    <div className="flex items-center gap-2 text-warn">
                      <Unlock className="h-4 w-4 text-warn shrink-0" />
                      <span>
                        Waiting downstream: {downstreamTasks.map((dt) => (
                          <strong key={dt.taskCode} className="ml-1 font-semibold text-ink">
                            {dt.shortTag || dt.title} ({state.team_members[dt.raci.R]?.name || 'Staff'})
                          </strong>
                        ))}
                      </span>
                    </div>

                    <label className="inline-flex items-center gap-2 text-xs font-medium text-ink cursor-pointer">
                      <input
                        type="checkbox"
                        checked={shouldUnlock}
                        onChange={(e) =>
                          setUnlockToggles((prev) => ({
                            ...prev,
                            [item.reviewId]: e.target.checked,
                          }))
                        }
                        className="rounded border-hairline-strong text-signal focus:ring-signal"
                      />
                      Auto-unlock downstream step upon decision
                    </label>
                  </div>
                )}

                {/* Resolution Actions */}
                {item.status === 'OPEN' ? (
                  <div className="border-t border-hairline pt-3.5 space-y-3">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                      <ShieldAlert className="h-3.5 w-3.5 text-danger" />
                      1-Click AI Suggested Approvals (Dispatches in Hinglish):
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {item.aiSuggestedReplies.map((suggestion, idx) => (
                        <button
                          key={`${item.reviewId}-sug-${idx}`}
                          type="button"
                          onClick={() => onResolveReview(item.reviewId, suggestion, shouldUnlock)}
                          className="rounded-lg border border-hairline bg-paper px-3.5 py-2 text-left text-xs font-medium text-ink hover:border-signal-border hover:bg-signal-soft hover:text-signal-ink transition-colors"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="text"
                        value={customReplies[item.reviewId] || ''}
                        onChange={(e) =>
                          setCustomReplies((prev) => ({
                            ...prev,
                            [item.reviewId]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const val = (customReplies[item.reviewId] || '').trim();
                            if (!val) return;
                            onResolveReview(item.reviewId, val, shouldUnlock);
                            setCustomReplies((prev) => ({ ...prev, [item.reviewId]: '' }));
                          }
                        }}
                        placeholder="Or write custom instructions to send directly to WhatsApp..."
                        className="flex-1 rounded-lg border border-hairline-strong bg-paper px-3.5 py-2 text-xs text-ink placeholder:text-slate/60 focus:bg-surface focus:border-signal focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={!(customReplies[item.reviewId] || '').trim()}
                        onClick={() => {
                          const val = (customReplies[item.reviewId] || '').trim();
                          if (!val) return;
                          onResolveReview(item.reviewId, val, shouldUnlock);
                          setCustomReplies((prev) => ({ ...prev, [item.reviewId]: '' }));
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink-hover disabled:opacity-40 transition-colors"
                      >
                        <Send className="h-3.5 w-3.5 text-signal" />
                        Dispatch Decision
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-hairline pt-3 text-xs text-ok bg-ok-soft p-3 rounded-xl border border-ok-border">
                    <span className="font-semibold">Dispatched WhatsApp Resolution:</span> {item.resolutionReply}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

