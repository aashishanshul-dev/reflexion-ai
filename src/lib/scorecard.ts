/**
 * Batch 4 — per-person scorecard: on-time rate, reply speed, what is behind now and
 * who is overloaded tomorrow. All arithmetic, done by code from tasks and stats.
 */
import type { OpsDatabaseState, Task } from '../types/ops.ts';
import { getZonedDateParts, isTaskClosed, resolveSafeTimezone } from './releaseEngine.ts';
import { addDaysIso } from './planDates.ts';
import { getTaskDueInstantMs, isTaskBehind, isTaskOpenForTiming } from './taskTiming.ts';

export interface ScorecardRow {
  phone: string;
  name: string;
  roleTitle: string;
  completed: number;
  /** Completed tasks finished by their due moment, as a percent; null when none finished yet. */
  onTimeRate: number | null;
  /** Average working-hours minutes to reply; null when no replies yet. */
  avgReplyMins: number | null;
  openNow: number;
  behindNow: number;
  /** Open tasks due by the end of tomorrow. */
  dueByTomorrow: number;
  limit: number;
  overloadedTomorrow: boolean;
}

/** When a completed task was finished: the last audit entry that completed it, else the last entry. */
export function completedAtMs(task: Pick<Task, 'auditLogs'>): number | null {
  const logs = task.auditLogs || [];
  const done = [...logs].reverse().find((l) => /COMPLETED|100%/.test(l.aiDecision || ''));
  const ts = Date.parse((done || logs[logs.length - 1])?.timestamp || '');
  return Number.isNaN(ts) ? null : ts;
}

export function buildTeamScorecard(
  state: Pick<OpsDatabaseState, 'team_members' | 'tasks' | 'business_profile'>,
  nowMs: number
): ScorecardRow[] {
  const tz = resolveSafeTimezone(state.business_profile?.timezone);
  const tomorrow = addDaysIso(getZonedDateParts(nowMs, tz).dateStr, 1);
  return Object.values(state.team_members || {})
    .map((m) => {
      const mine = (state.tasks || []).filter((t) => t.raci?.R === m.phone && !t.archivedAt);
      const finished = mine.filter((t) => t.status === 'COMPLETED');
      const timed = finished
        .map((t) => ({ doneAt: completedAtMs(t), dueAt: getTaskDueInstantMs(t, tz) }))
        .filter((x): x is { doneAt: number; dueAt: number } => x.doneAt !== null && x.dueAt !== null);
      const open = mine.filter((t) => isTaskOpenForTiming(t) && !isTaskClosed(t.status));
      const dueByTomorrow = open.filter((t) => (t.dueDate || '') <= tomorrow).length;
      const limit = Math.max(1, m.maxActiveTasks || 3);
      const replies = m.stats?.replyCount || 0;
      return {
        phone: m.phone,
        name: m.name,
        roleTitle: m.roleTitle,
        completed: Math.max(m.stats?.completed || 0, finished.length),
        onTimeRate: timed.length > 0 ? Math.round((timed.filter((x) => x.doneAt <= x.dueAt).length / timed.length) * 100) : null,
        avgReplyMins: replies > 0 ? Math.round((m.stats?.totalWorkHoursReplyMins || 0) / replies) : null,
        openNow: open.length,
        behindNow: open.filter((t) => isTaskBehind(t, nowMs, tz)).length,
        dueByTomorrow,
        limit,
        overloadedTomorrow: dueByTomorrow > limit,
      };
    })
    .sort((a, b) => b.behindNow - a.behindNow || Number(b.overloadedTomorrow) - Number(a.overloadedTomorrow) || a.name.localeCompare(b.name));
}
