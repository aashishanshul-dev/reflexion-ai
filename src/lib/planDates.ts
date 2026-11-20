/**
 * Turns the dates in an AI plan into real calendar dates (YYYY-MM-DD) in the
 * business timezone. The AI sometimes writes words ("Tomorrow", "Friday",
 * "next week") into date fields; those are converted with parseDueHintToDate,
 * counting from *today in the business timezone* (not UTC).
 */
import { parseDueHintToDate } from './meditateV2.ts';
import { getZonedDateParts, resolveSafeTimezone } from './releaseEngine.ts';
import { normalizeDueTime, parseDueTimeFromText } from './taskTiming.ts';

/** Today's date (YYYY-MM-DD) in the business timezone, e.g. "Asia/Kolkata". */
export function businessTodayIso(timezone?: string | null, now: Date = new Date()): string {
  return getZonedDateParts(now.getTime(), resolveSafeTimezone(timezone)).dateStr;
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDaysIso(baseIso: string, days: number): string {
  const [y, m, d] = baseIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + Math.round(days) * 86_400_000).toISOString().slice(0, 10);
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Returns a real YYYY-MM-DD date for `value`, or null if it can't be read.
 * - "2026-11-10" (or an ISO timestamp) → that date
 * - "tomorrow", "Friday", "next week", "in 3 days", "by Monday 5 PM" → resolved from `todayIso`
 */
export function resolvePlanDate(value: unknown, todayIso: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const isoPrefix = text.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)?.[1];
  if (isoPrefix && isRealIsoDate(isoPrefix)) return isoPrefix;
  const parsed = parseDueHintToDate(text, todayIso).dueDate;
  return parsed && isRealIsoDate(parsed) ? parsed : null;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * One line for AI prompts so the model knows today's date. Without it the
 * model writes "Tomorrow" or guesses a date from years ago.
 */
export function buildDateContextLine(todayIso: string): string {
  const [y, m, d] = todayIso.split('-').map(Number);
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return (
    `TODAY (business timezone): ${todayIso} (${weekday}). ` +
    `Write every date field as YYYY-MM-DD counted from TODAY (for example, tomorrow = ${addDaysIso(todayIso, 1)}). ` +
    `Never put words like "Tomorrow" in a date field; keep the owner's own wording in dueHint.`
  );
}

type DateFieldOwner = Record<string, any>;

/** A date usable for new work: real, and not before today. */
function resolveFutureDate(value: unknown, todayIso: string): string | null {
  const resolved = resolvePlanDate(value, todayIso);
  return resolved && resolved >= todayIso ? resolved : null;
}

function normalizeTaskDates(
  task: DateFieldOwner,
  todayIso: string,
  ownerWordsDate: string | null
): DateFieldOwner {
  const out = { ...task };
  const offset =
    typeof task.dueDateOffsetDays === 'number' && Number.isFinite(task.dueDateOffsetDays)
      ? Math.max(0, task.dueDateOffsetDays)
      : null;

  // Due date, first usable of: dueDate (date or date word), the AI's dueHint, the
  // owner's own words ("...tomorrow"), the day offset. Past dates are not used —
  // they come from the AI guessing today's date wrong.
  // A date the server already marked as assumed is a default, not something anyone said:
  // the AI's timing phrase or the owner's own words win over it.
  const serverAssumed = task.dueDateAssumed === true;
  const givenDue =
    (serverAssumed ? null : resolveFutureDate(task.dueDate, todayIso)) ??
    resolveFutureDate(task.dueHint, todayIso) ??
    ownerWordsDate;
  const due =
    givenDue ??
    (serverAssumed ? resolveFutureDate(task.dueDate, todayIso) : null) ??
    (offset !== null ? addDaysIso(todayIso, offset) : null);
  if (due) out.dueDate = due;
  else delete out.dueDate; // unreadable word: let the caller fall back to its default
  // Nobody said when: the date is code's default, so the draft shows it as "assumed".
  out.dueDateAssumed = !givenDue;

  // Time of day ("before 11 AM"): a valid HH:mm from the AI, else read from the
  // due hint or the title. Unknown stays null (end of the due date).
  out.dueTime =
    normalizeDueTime(task.dueTime) ??
    parseDueTimeFromText(task.dueHint) ??
    parseDueTimeFromText(task.title) ??
    null;

  for (const key of ['startDate', 'forcedDeadlineDate'] as const) {
    if (task[key] === undefined || task[key] === null) continue;
    const resolved = resolveFutureDate(task[key], todayIso);
    if (resolved) out[key] = resolved;
    else if (key === 'startDate') delete out[key];
    else out[key] = null;
  }
  return out;
}

/**
 * Returns a copy of a Meditate plan with every date field converted to a real
 * YYYY-MM-DD date in the business timezone. Fields that can't be read are
 * removed, so the app's normal defaults apply instead of saving a word.
 */
export function normalizeMeditatePlanDates<T extends DateFieldOwner>(
  plan: T,
  options: {
    timezone?: string | null;
    now?: Date;
    /** The owner's original message; its date words are the fallback for tasks. */
    sourceText?: string;
  } = {}
): T {
  if (!plan || typeof plan !== 'object') return plan;
  const todayIso = businessTodayIso(options.timezone, options.now);
  const ownerWordsDate = resolveFutureDate(options.sourceText, todayIso);
  const out: DateFieldOwner = { ...plan };

  if (Array.isArray(plan.draftedTasks)) {
    out.draftedTasks = plan.draftedTasks.map((t: DateFieldOwner) =>
      normalizeTaskDates(t, todayIso, ownerWordsDate)
    );
  }
  if (Array.isArray(plan.wbsHeads)) {
    out.wbsHeads = plan.wbsHeads.map((head: DateFieldOwner) => {
      const h = { ...head };
      for (const key of ['tentativeStartDate', 'tentativeDeadline'] as const) {
        if (head[key] === undefined || head[key] === null) continue;
        const resolved =
          resolveFutureDate(head[key], todayIso) ??
          (key === 'tentativeDeadline'
            ? resolveFutureDate(head.dueHint, todayIso) ?? ownerWordsDate
            : null);
        if (resolved) h[key] = resolved;
        else delete h[key];
      }
      if (Array.isArray(head.subTasks)) {
        h.subTasks = head.subTasks.map((st: DateFieldOwner) =>
          normalizeTaskDates(st, todayIso, ownerWordsDate)
        );
      }
      return h;
    });
  }
  return out as T;
}
