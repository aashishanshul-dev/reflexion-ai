/**
 * Task timing: the time of day a task is due, whether it is late, and whether it
 * is behind. Code (not the AI) decides these facts from dates, times and the
 * business timezone (rule 2).
 */
import type { Task, TaskScheduleRisk } from '../types/ops.ts';
import {
  getZonedDateParts,
  isTaskClosed,
  resolveSafeTimezone,
  zonedWallClockToUtcMs,
} from './releaseEngine.ts';

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toHhMm(hour: number, minute: number): string | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function from12h(hour: number, minute: number, meridiem: 'am' | 'pm'): string | null {
  if (hour < 1 || hour > 12) return null;
  const h24 = meridiem === 'am' ? hour % 12 : (hour % 12) + 12;
  return toHhMm(h24, minute);
}

/** A stored due time: "HH:mm" (24-hour) or null. Accepts "9:30" and pads it. */
export function normalizeDueTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(HHMM_RE);
  return m ? toHhMm(Number(m[1]), Number(m[2])) : null;
}

/**
 * Reads a time of day from free text such as a due hint or a task title.
 * Understands "11 AM", "before 5:30 pm", "17:00", "noon", and Hindi/Hinglish
 * "11 baje" (with "subah" = morning, "dopahar"/"shaam"/"raat" = afternoon/evening/night;
 * a bare "1–6 baje" is read as afternoon, the usual meaning at work).
 * Returns "HH:mm" or null when no clear time is written.
 */
export function parseDueTimeFromText(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = text.toLowerCase();

  const twelveHour = s.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (twelveHour) {
    const meridiem = twelveHour[3].startsWith('a') ? 'am' : 'pm';
    return from12h(Number(twelveHour[1]), Number(twelveHour[2] || 0), meridiem);
  }

  const baje = s.match(/(?:\b(subah|dopahar|shaam|sham|raat)\s+)?\b(\d{1,2})(?:[:.](\d{2}))?\s*baje\b/);
  if (baje) {
    const part = baje[1];
    const hour = Number(baje[2]);
    const minute = Number(baje[3] || 0);
    if (hour > 12) return toHhMm(hour, minute);
    if (part === 'subah') return from12h(hour, minute, 'am');
    if (part === 'raat' && hour === 12) return '23:59'; // "raat 12 baje" = midnight: end of that day
    if (part) return from12h(hour, minute, 'pm');
    return from12h(hour, minute, hour >= 7 && hour <= 11 ? 'am' : 'pm');
  }

  const twentyFour = s.match(/(?<![\d:-])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/);
  if (twentyFour) return toHhMm(Number(twentyFour[1]), Number(twentyFour[2]));

  if (/\b(noon|midday|dopahar\s+12)\b/.test(s)) return '12:00';
  return null;
}

type DueFields = Pick<Task, 'dueDate'> & { dueTime?: string | null };

/**
 * The exact moment a task is due, in ms. With a due time it is that time on the
 * due date (business timezone); without one, the end of the due date (23:59).
 */
export function getTaskDueInstantMs(task: DueFields, timezone?: string | null): number | null {
  const date = typeof task?.dueDate === 'string' ? task.dueDate.trim() : '';
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const time = normalizeDueTime(task.dueTime) || '23:59';
  const [hh, mm] = time.split(':').map(Number);
  return zonedWallClockToUtcMs(Number(m[1]), Number(m[2]), Number(m[3]), hh, mm, resolveSafeTimezone(timezone));
}

export type TaskTimingState = 'NO_DUE' | 'ON_TIME' | 'DUE_SOON' | 'LATE';

export interface TaskTiming {
  state: TaskTimingState;
  dueMs: number | null;
  /** Whole minutes past the due moment (0 unless LATE). */
  minutesLate: number;
  /** Whole minutes until the due moment (0 when LATE). */
  minutesLeft: number;
  hasDueTime: boolean;
}

/** Where a task stands against its deadline at `nowMs`. DUE_SOON = within `dueSoonMinutes`. */
export function describeTaskTiming(
  task: DueFields,
  nowMs: number,
  timezone?: string | null,
  dueSoonMinutes: number = 60
): TaskTiming {
  const dueMs = getTaskDueInstantMs(task, timezone);
  const hasDueTime = Boolean(normalizeDueTime(task?.dueTime));
  if (dueMs === null) return { state: 'NO_DUE', dueMs: null, minutesLate: 0, minutesLeft: 0, hasDueTime };
  const diffMin = Math.floor((dueMs - nowMs) / 60_000);
  if (nowMs > dueMs) {
    return {
      state: 'LATE',
      dueMs,
      minutesLate: Math.max(1, Math.floor((nowMs - dueMs) / 60_000)),
      minutesLeft: 0,
      hasDueTime,
    };
  }
  return {
    state: diffMin <= dueSoonMinutes ? 'DUE_SOON' : 'ON_TIME',
    dueMs,
    minutesLate: 0,
    minutesLeft: Math.max(0, diffMin),
    hasDueTime,
  };
}

/** "45m", "3h 9m", "2d 4h". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** "Late by 3h 9m", "Due in 45m", or "" when there is no due date. */
export function timingLabel(timing: TaskTiming): string {
  if (timing.state === 'LATE') return `Late by ${formatDuration(timing.minutesLate)}`;
  if (timing.state === 'NO_DUE') return '';
  return `Due in ${formatDuration(timing.minutesLeft)}`;
}

/** "2026-11-19 11:00" when a time is set, else "2026-11-19". */
export function formatDueLabel(task: DueFields): string {
  const date = task?.dueDate || '';
  const time = normalizeDueTime(task?.dueTime);
  return time ? `${date} ${time}` : date;
}

/** "19 Nov, 11:00" (or "19 Nov") for messages and cards. */
export function formatDueShort(task: DueFields): string {
  const m = (task?.dueDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return task?.dueDate || '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = `${Number(m[3])} ${months[Number(m[2]) - 1] || m[2]}`;
  const time = normalizeDueTime(task?.dueTime);
  return time ? `${day}, ${time}` : day;
}

/** Current time in the business timezone, for AI prompts: "2026-11-19 14:09 (Asia/Kolkata)". */
export function formatNowForPrompt(nowMs: number, timezone?: string | null): string {
  const tz = resolveSafeTimezone(timezone);
  const p = getZonedDateParts(nowMs, tz);
  return `${p.dateStr} ${p.hhmm} (${tz})`;
}

type TimingTask = DueFields &
  Pick<Task, 'status' | 'isFrozen'> & {
    archivedAt?: string | null;
    scheduleRisk?: TaskScheduleRisk | null;
  };

/** Live work that can be late: frozen, not a draft, not closed, not archived. */
export function isTaskOpenForTiming(task: TimingTask): boolean {
  return (
    Boolean(task?.isFrozen) &&
    task.status !== 'STAGING_DRAFT' &&
    !isTaskClosed(task.status) &&
    !task.archivedAt
  );
}

/** Open work that is past its due moment, or that a reply said will finish late. */
export function isTaskBehind(task: TimingTask, nowMs: number, timezone?: string | null): boolean {
  if (!isTaskOpenForTiming(task)) return false;
  if (task.scheduleRisk) return true;
  return describeTaskTiming(task, nowMs, timezone).state === 'LATE';
}

/**
 * After a staff reply: the schedule risk to store on the task, or null when the
 * task is on time. Code decides "late" from the clock; the AI only reports whether
 * the person said part of the work will finish later, and any finish time they gave.
 */
export function assessReplyScheduleRisk(params: {
  task: DueFields;
  allDone: boolean;
  delayReported: boolean;
  reportedEta?: string | null;
  /** The AI's one-line recovery suggestion, kept with the flag. */
  suggestedFix?: string | null;
  nowMs: number;
  timezone?: string | null;
}): TaskScheduleRisk | null {
  if (params.allDone) return null;
  const fix = typeof params.suggestedFix === 'string' && params.suggestedFix.trim() ? params.suggestedFix.trim() : null;
  const timing = describeTaskTiming(params.task, params.nowMs, params.timezone);
  const eta = typeof params.reportedEta === 'string' && params.reportedEta.trim() ? params.reportedEta.trim() : null;
  const etaText = eta ? ` Expected finish: ${eta}.` : ' No finish time given yet.';
  const flaggedAt = new Date(params.nowMs).toISOString();
  if (timing.state === 'LATE') {
    return {
      reason: `Past the deadline (${formatDueLabel(params.task)}) by ${formatDuration(
        timing.minutesLate
      )} and not finished.${etaText}`,
      flaggedAt,
      reportedEta: eta,
      suggestedFix: fix,
    };
  }
  if (params.delayReported) {
    return {
      reason: `Reply says part of the work will finish later.${etaText}`,
      flaggedAt,
      reportedEta: eta,
      suggestedFix: fix,
    };
  }
  return null;
}
