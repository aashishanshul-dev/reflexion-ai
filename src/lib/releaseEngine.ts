import {
  type BusinessProfileConfig,
  DEFAULT_TENANT_ID,
  type DependencyTrigger,
  type OpsDatabaseState,
  type PreferredLanguage,
  type SimulatedWhatsappMessage,
  type Task,
  type TaskReleaseConfig,
  type TaskReleaseMode,
  type TeamMember,
} from '../types/ops.ts';

import { buildShortTaskBrief } from './taskBrief.ts';
import { sendBehindAlerts } from './behindAlerts.ts';
import { sendOwnerDecisionPrompts } from './ownerWhatsapp.ts';
import { staffAddressName } from './staffNames.ts';
import { buildMyTasks, buildOwnerDigestText, getOwnerPhones } from './myTasks.ts';

export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_WORKING_DAYS: number[] = [0, 1, 2, 3, 4, 5, 6];
/** Hold reason shown on tasks whose prerequisite task was cancelled. */
export const PARENT_CANCELLED_HOLD_REASON = 'Waiting: parent task cancelled';
export const DEFAULT_WHATSAPP_OUT_OF_WINDOW_TEMPLATE =
  '📋 [Approved Template] Hello {{name}}, operational update for [{{shortTag}}] ({{title}}) — Due: {{dueDate}}.\n{{body}}\nReply to this message to re-open your 24-hour session window.';

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0 (Sun) .. 6 (Sat)
  hour: number;
  minute: number;
  dateStr: string; // YYYY-MM-DD
  hhmm: string; // HH:mm
}

export interface ReleaseEngineSettings {
  timezone?: string;
  workingDays?: number[];
  defaultMaxActiveTasksPerPerson?: number;
  activeReleasedTaskCount?: number;
  allTasks?: Task[];
  batchNonUrgentIntoDigest?: boolean;
  isDigestFlush?: boolean;
  enforceWhatsapp24hWindow?: boolean;
  whatsappTemplateText?: string;
}

export interface CanReleaseResult {
  allowed: boolean;
  reasonCode?:
    | 'MISSING_PERSON'
    | 'REQUIRES_OWNER_CONFIRM'
    | 'AT_TIME_FUTURE'
    | 'AFTER_TASK_LOCKED'
    | 'WHEN_FREE_BUSY'
    | 'ON_LEAVE'
    | 'OUTSIDE_SHIFT_OR_WORKING_DAY'
    | 'AT_CAPACITY_CAP'
    | 'BATCHED_FOR_DIGEST'
    | 'INCOMPLETE_RELEASE_CHOICE';
  holdReason: string | null;
  nextEligibleAt?: string | null;
}

export interface ReleaseDueTasksOptions {
  messageOverrides?: Record<string, string>;
  digestFlushPhones?: Set<string>;
  suppressIndividualWhatsappForPhones?: Set<string>;
}

export function resolveSafeTimezone(tz?: string | null): string {
  const candidate = (tz || '').trim() || DEFAULT_BUSINESS_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return 'UTC';
  }
}

export function resolveNowMs(now?: Date | string): { nowMs: number; nowIso: string } {
  if (now instanceof Date && !Number.isNaN(now.getTime())) {
    return { nowMs: now.getTime(), nowIso: now.toISOString() };
  }
  if (typeof now === 'string' && now.trim()) {
    const parsed = Date.parse(now);
    if (!Number.isNaN(parsed)) {
      return { nowMs: parsed, nowIso: new Date(parsed).toISOString() };
    }
  }
  const current = new Date();
  return { nowMs: current.getTime(), nowIso: current.toISOString() };
}

export function getZonedDateParts(instantMs: number, timeZoneInput?: string): ZonedDateTimeParts {
  const timeZone = resolveSafeTimezone(timeZoneInput);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  const parts = dtf.formatToParts(new Date(instantMs));
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }

  const year = Number.parseInt(map.year || '1970', 10);
  const month = Number.parseInt(map.month || '1', 10);
  const day = Number.parseInt(map.day || '1', 10);
  const rawHour = Number.parseInt(map.hour || '0', 10);
  const hour = Number.isNaN(rawHour) ? 0 : rawHour % 24;
  const minute = Number.parseInt(map.minute || '0', 10) || 0;
  const weekday = WEEKDAY_MAP[map.weekday || 'Sun'] ?? 0;

  const dateStr = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
    day
  ).padStart(2, '0')}`;
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  return { year, month, day, weekday, hour, minute, dateStr, hhmm };
}

/**
 * Resolves a calendar wall-clock time (YYYY, M, D, H, m) in an IANA timezone to exact UTC epoch ms.
 */
export function zonedWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZoneInput?: string
): number {
  const timeZone = resolveSafeTimezone(timeZoneInput);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let guess = targetAsUtc;
  for (let i = 0; i < 2; i++) {
    const observed = getZonedDateParts(guess, timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      0,
      0
    );
    const diffMs = targetAsUtc - observedAsUtc;
    guess += diffMs;
  }
  return guess;
}

/**
 * Parses a scheduled release timestamp. Supports full ISO strings with offset/Z as well as
 * timezone-local wall-clock inputs (e.g. "2026-11-09T10:30" from datetime-local controls).
 */
export function parseScheduledReleaseInstantMs(
  releaseAt: string | null | undefined,
  timeZoneInput?: string
): number | null {
  if (!releaseAt || !releaseAt.trim()) return null;
  const raw = releaseAt.trim();

  // Explicit UTC or numeric offset
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }

  // Wall-clock YYYY-MM-DDTHH:mm(:ss)? interpreted in business timezone
  const localMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::\d{2})?$/
  );
  if (localMatch) {
    return zonedWallClockToUtcMs(
      Number.parseInt(localMatch[1], 10),
      Number.parseInt(localMatch[2], 10),
      Number.parseInt(localMatch[3], 10),
      Number.parseInt(localMatch[4], 10),
      Number.parseInt(localMatch[5], 10),
      timeZoneInput
    );
  }

  const fallback = Date.parse(raw);
  return Number.isNaN(fallback) ? null : fallback;
}

export function formatTimestampInTimezone(instantMs: number, timeZoneInput?: string): string {
  const timeZone = resolveSafeTimezone(timeZoneInput);
  return new Date(instantMs).toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function parseHhMmToMinutes(hhmm: string | undefined, fallbackMinutes: number): number {
  if (!hhmm || !hhmm.includes(':')) return fallbackMinutes;
  const [hRaw, mRaw] = hhmm.split(':');
  const h = Number.parseInt(hRaw || '', 10);
  const m = Number.parseInt(mRaw || '', 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return fallbackMinutes;
  return Math.max(0, Math.min(23, h)) * 60 + Math.max(0, Math.min(59, m));
}

export function isInsideShiftWindow(
  currentMinutes: number,
  workShiftStart?: string,
  workShiftEnd?: string
): boolean {
  const startMin = parseHhMmToMinutes(workShiftStart, 9 * 60);
  const endMin = parseHhMmToMinutes(workShiftEnd, 19 * 60);
  if (startMin === endMin) return true;
  if (endMin > startMin) {
    return currentMinutes >= startMin && currentMinutes < endMin;
  }
  // Overnight shift (e.g., 22:00 to 06:00)
  return currentMinutes >= startMin || currentMinutes < endMin;
}

export function computeNextShiftStart(
  nowMs: number,
  workShiftStart: string | undefined,
  workingDaysInput: number[] | undefined,
  timeZoneInput?: string
): { nextShiftIso: string | null; displayLabel: string } {
  const timeZone = resolveSafeTimezone(timeZoneInput);
  const workingDays =
    Array.isArray(workingDaysInput) && workingDaysInput.length > 0
      ? workingDaysInput
      : DEFAULT_WORKING_DAYS;
  const validDays = new Set(workingDays.filter((d) => d >= 0 && d <= 6));
  if (validDays.size === 0) {
    return { nextShiftIso: null, displayLabel: 'no configured working days' };
  }

  const startMin = parseHhMmToMinutes(workShiftStart, 9 * 60);
  const startHour = Math.floor(startMin / 60);
  const startMinute = startMin % 60;

  const currentZoned = getZonedDateParts(nowMs, timeZone);
  const currentMins = currentZoned.hour * 60 + currentZoned.minute;

  for (let offsetDays = 0; offsetDays <= 7; offsetDays++) {
    if (offsetDays === 0) {
      if (validDays.has(currentZoned.weekday) && currentMins < startMin) {
        const nextMs = zonedWallClockToUtcMs(
          currentZoned.year,
          currentZoned.month,
          currentZoned.day,
          startHour,
          startMinute,
          timeZone
        );
        const label = new Date(nextMs).toLocaleString('en-US', {
          timeZone,
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        });
        return { nextShiftIso: new Date(nextMs).toISOString(), displayLabel: label };
      }
      continue;
    }

    const baseUtcNoon = Date.UTC(
      currentZoned.year,
      currentZoned.month - 1,
      currentZoned.day + offsetDays,
      12,
      0,
      0
    );
    const futureDayParts = getZonedDateParts(baseUtcNoon, timeZone);
    if (validDays.has(futureDayParts.weekday)) {
      const nextMs = zonedWallClockToUtcMs(
        futureDayParts.year,
        futureDayParts.month,
        futureDayParts.day,
        startHour,
        startMinute,
        timeZone
      );
      const label = new Date(nextMs).toLocaleString('en-US', {
        timeZone,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
      return { nextShiftIso: new Date(nextMs).toISOString(), displayLabel: label };
    }
  }

  return { nextShiftIso: null, displayLabel: 'next working shift' };
}

export function isTaskReleasedStatus(status: Task['status']): boolean {
  return (
    status === 'PENDING' ||
    status === 'IN_PROGRESS' ||
    status === 'PARTIALLY_DONE' ||
    status === 'AWAITING_BOSS_DECISION'
  );
}

export function getActiveReleasedTaskCount(
  tasks: Task[],
  phone: string,
  excludeTaskCode?: string
): number {
  if (!phone) return 0;
  return tasks.filter(
    (t) =>
      t.raci?.R === phone &&
      t.taskCode !== excludeTaskCode &&
      t.isFrozen &&
      isTaskReleasedStatus(t.status)
  ).length;
}

/**
 * Migrates any existing task without a `release` configuration to `mode: 'NOW'`.
 */
export function migrateTaskReleaseConfig(
  task: Partial<Task>,
  fallbackNowIso: string = new Date().toISOString()
): TaskReleaseConfig {
  const existing = task.release;
  const depCode = task.dependency?.dependsOnTaskCode || null;
  const depTrigger: DependencyTrigger = task.dependency?.triggerCondition || 'FULL_COMPLETION';

  const alreadyDispatched =
    task.status !== undefined &&
    task.status !== 'STAGING_DRAFT' &&
    task.status !== 'SCHEDULED' &&
    task.status !== 'LOCKED_BY_DEPENDENCY';

  if (!existing || typeof existing !== 'object') {
    return {
      mode: 'NOW',
      releaseAt: null,
      afterTaskCode: depCode,
      afterTrigger: depTrigger,
      delayMinutes: 0,
      requireOwnerConfirm: false,
      ownerConfirmed: false,
      releasedAt: alreadyDispatched ? task.lastOutboundAt || fallbackNowIso : null,
      holdReason:
        task.status === 'LOCKED_BY_DEPENDENCY' && depCode
          ? `Waiting on prerequisite ${depCode}`
          : null,
      batchedForDigest: false,
      unlockNoticeText: null,
    };
  }

  const validModes: TaskReleaseMode[] = ['NOW', 'AT_TIME', 'AFTER_TASK', 'WHEN_FREE'];
  const mode: TaskReleaseMode = validModes.includes(existing.mode) ? existing.mode : 'NOW';

  return {
    mode,
    releaseAt: existing.releaseAt ?? null,
    afterTaskCode: existing.afterTaskCode ?? depCode,
    afterTrigger: existing.afterTrigger || depTrigger,
    delayMinutes:
      typeof existing.delayMinutes === 'number' && existing.delayMinutes > 0
        ? Math.round(existing.delayMinutes)
        : 0,
    requireOwnerConfirm: Boolean(existing.requireOwnerConfirm),
    ownerConfirmed: Boolean(existing.ownerConfirmed),
    releasedAt:
      existing.releasedAt !== undefined
        ? existing.releasedAt
        : alreadyDispatched
          ? task.lastOutboundAt || fallbackNowIso
          : null,
    holdReason: existing.holdReason ?? null,
    nextEligibleAt: existing.nextEligibleAt ?? null,
    batchedForDigest: Boolean(existing.batchedForDigest),
    unlockNoticeText: existing.unlockNoticeText ?? null,
  };
}

export function buildReleaseSettingsFromState(
  state: OpsDatabaseState,
  overrides?: Partial<ReleaseEngineSettings>
): ReleaseEngineSettings {
  const bp = state.business_profile;
  return {
    timezone: bp?.timezone || DEFAULT_BUSINESS_TIMEZONE,
    workingDays:
      Array.isArray(bp?.workingDays) && bp!.workingDays!.length > 0
        ? bp!.workingDays
        : DEFAULT_WORKING_DAYS,
    defaultMaxActiveTasksPerPerson:
      state.task_splitting_rules?.defaultMaxActiveTasksPerPerson ?? 3,
    allTasks: state.tasks,
    batchNonUrgentIntoDigest: Boolean(bp?.batchNonUrgentIntoDigest),
    enforceWhatsapp24hWindow: bp?.enforceWhatsapp24hWindow !== false,
    whatsappTemplateText: bp?.whatsappTemplateText || DEFAULT_WHATSAPP_OUT_OF_WINDOW_TEMPLATE,
    ...overrides,
  };
}

function isAfterTaskSatisfied(
  afterTaskCode: string | null | undefined,
  afterTrigger: DependencyTrigger,
  allTasks?: Task[]
): boolean {
  if (!afterTaskCode) return true;
  if (!Array.isArray(allTasks)) return true;
  const prereq = allTasks.find((t) => t.taskCode === afterTaskCode);
  if (!prereq) return false;
  if (afterTrigger === 'PARTIAL_OR_BOSS_APPROVAL') {
    return prereq.status === 'COMPLETED' || prereq.status === 'PARTIALLY_DONE';
  }
  return prereq.status === 'COMPLETED';
}

/**
 * Pure release eligibility gate.
 * Checks:
 * - owner confirmation given if required
 * - schedule readiness (AT_TIME, AFTER_TASK + delayMinutes, WHEN_FREE)
 * - person exists and is not on leave
 * - inside person's shift and business working days (using business timezone; holds until next shift start)
 * - active released tasks below the person's cap (urgent Q1_DO_FIRST tasks bypass the cap)
 * - optional non-urgent daily digest batching
 */
export function canRelease(
  task: Task,
  person: TeamMember | undefined | null,
  now: Date | string,
  settings: ReleaseEngineSettings = {}
): CanReleaseResult {
  const { nowMs } = resolveNowMs(now);
  const timeZone = resolveSafeTimezone(settings.timezone);
  const workingDays =
    Array.isArray(settings.workingDays) && settings.workingDays.length > 0
      ? settings.workingDays
      : DEFAULT_WORKING_DAYS;

  if (!person) {
    return {
      allowed: false,
      reasonCode: 'MISSING_PERSON',
      holdReason: 'Assigned person is not in roster',
    };
  }

  const release = migrateTaskReleaseConfig(task, new Date(nowMs).toISOString());

  // 1. Owner confirmation check
  if (release.requireOwnerConfirm && !release.ownerConfirmed) {
    return {
      allowed: false,
      reasonCode: 'REQUIRES_OWNER_CONFIRM',
      holdReason: 'Awaiting owner confirmation before release',
    };
  }

  // 2. Dependency / AFTER_TASK check
  const effectiveAfterCode = release.afterTaskCode || task.dependency?.dependsOnTaskCode || null;

  // 2a. An unfinished release choice is never sent straight away.
  const incompleteChoice = findIncompleteReleaseChoice(release, effectiveAfterCode, timeZone);
  if (incompleteChoice) {
    return {
      allowed: false,
      reasonCode: 'INCOMPLETE_RELEASE_CHOICE',
      holdReason: incompleteChoice,
    };
  }

  const prereqCancelled = Boolean(
    effectiveAfterCode &&
      settings.allTasks?.some((t) => t.taskCode === effectiveAfterCode && t.status === 'CANCELLED')
  );
  if (task.status === 'LOCKED_BY_DEPENDENCY') {
    return {
      allowed: false,
      reasonCode: 'AFTER_TASK_LOCKED',
      holdReason: prereqCancelled
        ? PARENT_CANCELLED_HOLD_REASON
        : `Waiting on prerequisite ${effectiveAfterCode || 'task'}`,
    };
  }

  if (release.mode === 'AFTER_TASK' && prereqCancelled) {
    return {
      allowed: false,
      reasonCode: 'AFTER_TASK_LOCKED',
      holdReason: PARENT_CANCELLED_HOLD_REASON,
    };
  }

  if (
    release.mode === 'AFTER_TASK' &&
    effectiveAfterCode &&
    !isAfterTaskSatisfied(effectiveAfterCode, release.afterTrigger, settings.allTasks)
  ) {
    return {
      allowed: false,
      reasonCode: 'AFTER_TASK_LOCKED',
      holdReason: `Waiting on ${effectiveAfterCode} (${release.afterTrigger})`,
    };
  }

  // 3. Scheduled time / delayMinutes timer check
  if (release.releaseAt) {
    const releaseAtMs = parseScheduledReleaseInstantMs(release.releaseAt, timeZone);
    if (releaseAtMs !== null && releaseAtMs > nowMs) {
      const formattedTime = formatTimestampInTimezone(releaseAtMs, timeZone);
      return {
        allowed: false,
        reasonCode: 'AT_TIME_FUTURE',
        holdReason: `Scheduled for ${formattedTime}`,
        nextEligibleAt: new Date(releaseAtMs).toISOString(),
      };
    }
  }

  // 4. Leave check
  if (person.isOnLeave) {
    return {
      allowed: false,
      reasonCode: 'ON_LEAVE',
      holdReason: 'On leave — held until return',
    };
  }

  // 5. Working day & shift window check in business timezone
  const zonedNow = getZonedDateParts(nowMs, timeZone);
  const currentMins = zonedNow.hour * 60 + zonedNow.minute;
  const isWorkingDay = workingDays.includes(zonedNow.weekday);
  const inShift = isInsideShiftWindow(currentMins, person.workShiftStart, person.workShiftEnd);

  // Urgent Q1_DO_FIRST tasks bypass outside-shift / non-working-day holds.
  if (task.quadrant !== 'Q1_DO_FIRST' && (!isWorkingDay || !inShift)) {
    const nextShift = computeNextShiftStart(
      nowMs,
      person.workShiftStart,
      workingDays,
      timeZone
    );
    return {
      allowed: false,
      reasonCode: 'OUTSIDE_SHIFT_OR_WORKING_DAY',
      holdReason: `Held until next shift (${nextShift.displayLabel})`,
      nextEligibleAt: nextShift.nextShiftIso,
    };
  }

  // Compute active released tasks count
  const activeCount =
    typeof settings.activeReleasedTaskCount === 'number'
      ? settings.activeReleasedTaskCount
      : Array.isArray(settings.allTasks)
        ? getActiveReleasedTaskCount(settings.allTasks, person.phone, task.taskCode)
        : 0;

  // 6. WHEN_FREE check (holds while person has any active released task)
  if (release.mode === 'WHEN_FREE' && activeCount > 0) {
    return {
      allowed: false,
      reasonCode: 'WHEN_FREE_BUSY',
      holdReason: `Waiting until person is free (${activeCount} active task${activeCount === 1 ? '' : 's'})`,
    };
  }

  // 7. Active task cap check (urgent Q1_DO_FIRST tasks bypass the cap)
  const cap = Math.max(
    1,
    person.maxActiveTasks ?? settings.defaultMaxActiveTasksPerPerson ?? 3
  );
  if (task.quadrant !== 'Q1_DO_FIRST' && activeCount >= cap) {
    return {
      allowed: false,
      reasonCode: 'AT_CAPACITY_CAP',
      holdReason: `At active task cap (${activeCount}/${cap}) — held until capacity frees up`,
    };
  }

  // 8. Optional non-urgent daily digest batching
  if (
    settings.batchNonUrgentIntoDigest &&
    !settings.isDigestFlush &&
    task.quadrant !== 'Q1_DO_FIRST'
  ) {
    return {
      allowed: false,
      reasonCode: 'BATCHED_FOR_DIGEST',
      holdReason: `Batched for next daily digest (${person.dailyOverviewTime || '09:30'})`,
    };
  }

  return {
    allowed: true,
    holdReason: null,
  };
}

export function isWithinWhatsapp24hWindow(
  lastInboundIso: string | undefined | null,
  nowIso: string
): boolean {
  if (!lastInboundIso) return false;
  const lastMs = Date.parse(lastInboundIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(lastMs) || Number.isNaN(nowMs)) return false;
  const diffHours = (nowMs - lastMs) / (1000 * 60 * 60);
  return diffHours >= 0 && diffHours < 24;
}

export function applyWhatsapp24hWindowPolicy(params: {
  rawText: string;
  person?: TeamMember | null;
  shortTag?: string;
  title?: string;
  dueDate?: string;
  businessProfile?: BusinessProfileConfig;
  nowIso: string;
}): { text: string; isTemplateMessage: boolean } {
  const enforceFlag = Boolean(params.businessProfile?.enforceWhatsapp24hWindow);
  if (!enforceFlag) {
    return { text: params.rawText, isTemplateMessage: false };
  }

  if (isWithinWhatsapp24hWindow(params.person?.lastInboundAt, params.nowIso)) {
    return { text: params.rawText, isTemplateMessage: false };
  }

  const template =
    params.businessProfile?.whatsappTemplateText?.trim() ||
    DEFAULT_WHATSAPP_OUT_OF_WINDOW_TEMPLATE;

  const safeName = params.person?.name || 'Team Member';
  const safeTag = params.shortTag || params.title || 'Task';
  const safeTitle = params.title || safeTag;
  const safeDue = params.dueDate || 'As scheduled';

  let rendered = template
    .replace(/\{\{\s*name\s*\}\}/gi, safeName)
    .replace(/\{\{\s*shortTag\s*\}\}/gi, safeTag)
    .replace(/\{\{\s*title\s*\}\}/gi, safeTitle)
    .replace(/\{\{\s*dueDate\s*\}\}/gi, safeDue)
    .replace(/\{\{\s*body\s*\}\}/gi, params.rawText);

  if (!rendered.includes(safeTag) && params.rawText.includes(`[${safeTag}]`)) {
    rendered = `${rendered}\n\n${params.rawText}`;
  }

  return {
    text: rendered,
    isTemplateMessage: true,
  };
}

/**
 * Plain deterministic fallback template for WhatsApp task release messages.
 */
export function buildPlainReleaseWhatsappMessage(
  task: Pick<
    Task,
    | 'taskCode'
    | 'shortTag'
    | 'title'
    | 'microSteps'
    | 'dueDate'
    | 'taskFrequency'
    | 'recurrenceRule'
  > & { quadrant?: Task['quadrant']; dueTime?: string | null },
  responsible?: TeamMember | null,
  /** Kept for callers; the short brief no longer prints a supervisor field. */
  _accountable?: TeamMember | null,
  unlockNoticeText?: string | null
): string {
  // Same short brief as drafts: who/what/by when, steps on one line, one closing line.
  const baseBody = buildShortTaskBrief(task, responsible);

  if (unlockNoticeText && unlockNoticeText.trim()) {
    return `${unlockNoticeText.trim()}\n\n${baseBody}`;
  }
  return baseBody;
}

/**
 * Transitions qualifying LOCKED_BY_DEPENDENCY tasks into SCHEDULED (applying delayMinutes if set)
 * so `releaseDueTasks` can release or hold them according to shift/leave/cap rules.
 */
export function promoteUnlockedDependentsToScheduled(
  state: OpsDatabaseState,
  prerequisiteTaskCode: string,
  options: {
    nowIso?: string;
    reasonLabel?: string;
    allowPartialHandover?: boolean;
  } = {}
): OpsDatabaseState {
  const { nowMs, nowIso } = resolveNowMs(options.nowIso);
  const parentTask = state.tasks.find((t) => t.taskCode === prerequisiteTaskCode);

  const nextTasks = state.tasks.map((t) => {
    if (t.status !== 'LOCKED_BY_DEPENDENCY') return t;

    const release = migrateTaskReleaseConfig(t, nowIso);
    const waitingOn = release.afterTaskCode || t.dependency?.dependsOnTaskCode;
    if (waitingOn !== prerequisiteTaskCode) return t;

    const trigger = release.afterTrigger || t.dependency?.triggerCondition || 'FULL_COMPLETION';
    const parentCompleted = parentTask?.status === 'COMPLETED';
    const partialSatisfied =
      trigger === 'PARTIAL_OR_BOSS_APPROVAL' &&
      (options.allowPartialHandover ||
        parentCompleted ||
        parentTask?.status === 'PARTIALLY_DONE');

    if (!parentCompleted && !partialSatisfied) {
      return t;
    }

    const rMember = state.team_members[t.raci.R];
    const displayTag = t.shortTag || t.taskCode;
    const unlockNotice =
      rMember?.preferredLanguage === 'ENGLISH'
        ? `🔓 Prerequisite Cleared [${displayTag}]: Hello ${rMember?.name || 'Team'}, upstream handover is complete. You may now begin "${t.title}".`
        : `🔓 Task Unlocked [${displayTag}]: Namaste ${staffAddressName(rMember, rMember?.preferredLanguage, 'ji')}, pichla step clear ho gaya hai. Ab aap "${t.title}" shuru kar sakte hain!`;

    const delayMs = (release.delayMinutes || 0) * 60_000;
    const computedReleaseAt =
      delayMs > 0 ? new Date(nowMs + delayMs).toISOString() : release.releaseAt;

    return {
      ...t,
      status: 'SCHEDULED' as const,
      release: {
        ...release,
        mode: delayMs > 0 ? ('AT_TIME' as const) : ('NOW' as const),
        releaseAt: computedReleaseAt,
        holdReason: delayMs > 0 ? `Delayed ${release.delayMinutes}m after ${prerequisiteTaskCode}` : null,
        unlockNoticeText: unlockNotice,
      },
      auditLogs: [
        ...t.auditLogs,
        {
          timestamp: nowIso,
          sender: 'DEPENDENCY_UNLOCK',
          rawInputSummary:
            options.reasonLabel || `Prerequisite ${prerequisiteTaskCode} satisfied.`,
          aiDecision:
            delayMs > 0
              ? `Dependency cleared -> SCHEDULED (+${release.delayMinutes}m delay).`
              : 'Dependency cleared -> SCHEDULED for release evaluation.',
        },
      ],
    };
  });

  return {
    ...state,
    tasks: nextTasks,
  };
}

/**
 * Evaluates all due SCHEDULED tasks (and any dependency-satisfied LOCKED_BY_DEPENDENCY tasks),
 * releasing eligible tasks to WhatsApp and updating hold reasons on held tasks.
 */
export function releaseDueTasks(
  state: OpsDatabaseState,
  now: Date | string = new Date().toISOString(),
  options: ReleaseDueTasksOptions = {}
): { nextState: OpsDatabaseState; releasedTaskCodes: string[] } {
  const { nowMs, nowIso } = resolveNowMs(now);
  const tenantId = state.tenantId || DEFAULT_TENANT_ID;
  const baseSettings = buildReleaseSettingsFromState(state);

  // Step 1: Promote any LOCKED_BY_DEPENDENCY task whose prerequisite is already COMPLETED in state
  let workingState = state;
  const completedCodes = new Set(
    state.tasks.filter((t) => t.status === 'COMPLETED').map((t) => t.taskCode)
  );
  for (const code of completedCodes) {
    const hasLockedDependent = workingState.tasks.some(
      (t) =>
        t.status === 'LOCKED_BY_DEPENDENCY' &&
        (t.release?.afterTaskCode === code || t.dependency?.dependsOnTaskCode === code)
    );
    if (hasLockedDependent) {
      workingState = promoteUnlockedDependentsToScheduled(workingState, code, {
        nowIso,
        reasonLabel: `Prerequisite ${code} completed`,
      });
    }
  }

  const nextMembers = structuredClone(workingState.team_members);
  const nextTasks = workingState.tasks.map((t) => ({
    ...t,
    release: migrateTaskReleaseConfig(t, nowIso),
  }));
  const nextWhatsapp: SimulatedWhatsappMessage[] = [...workingState.whatsapp_messages];
  const releasedTaskCodes: string[] = [];

  // Process Q1_DO_FIRST scheduled tasks before lower-priority ones so urgent work claims slots cleanly
  const scheduledIndices = nextTasks
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => t.status === 'SCHEDULED')
    .sort((a, b) => {
      const aUrgent = a.t.quadrant === 'Q1_DO_FIRST' ? 0 : 1;
      const bUrgent = b.t.quadrant === 'Q1_DO_FIRST' ? 0 : 1;
      return aUrgent - bUrgent || a.idx - b.idx;
    });

  for (const { idx } of scheduledIndices) {
    const candidate = nextTasks[idx];
    const rPhone = candidate.raci.R;
    const person = nextMembers[rPhone];
    const accPerson = nextMembers[candidate.raci.A];
    const isDigestFlush = Boolean(options.digestFlushPhones?.has(rPhone));

    const activeCount = getActiveReleasedTaskCount(nextTasks, rPhone, candidate.taskCode);
    const check = canRelease(candidate, person, new Date(nowMs), {
      ...baseSettings,
      allTasks: nextTasks,
      activeReleasedTaskCount: activeCount,
      isDigestFlush,
    });

    if (!check.allowed) {
      nextTasks[idx] = {
        ...candidate,
        status: 'SCHEDULED',
        release: {
          ...candidate.release!,
          holdReason: check.holdReason,
          nextEligibleAt: check.nextEligibleAt ?? null,
          batchedForDigest: check.reasonCode === 'BATCHED_FOR_DIGEST',
        },
        latestAiSummary: `Scheduled (Held): ${check.holdReason || 'Awaiting release window'}`,
      };
      continue;
    }

    // Release task!
    const unlockNotice = candidate.release?.unlockNoticeText || null;
    const overrideMsg = options.messageOverrides?.[candidate.taskCode];
    const ownerMessage = candidate.messageIsCustom ? (candidate.outboundWhatsappPreview || '').trim() : '';
    // The owner's own message is sent exactly as written (an unlock notice may go first).
    const baseOutboundText = ownerMessage
      ? unlockNotice
        ? `${unlockNotice}\n\n${ownerMessage}`
        : ownerMessage
      : overrideMsg
      ? unlockNotice && !overrideMsg.includes(unlockNotice)
        ? `${unlockNotice}\n\n${overrideMsg}`
        : overrideMsg
      : unlockNotice
        ? `${unlockNotice}\n\n${
            candidate.outboundWhatsappPreview ||
            buildPlainReleaseWhatsappMessage(candidate, person, accPerson)
          }`
        : buildPlainReleaseWhatsappMessage(candidate, person, accPerson);

    const windowFormatted = applyWhatsapp24hWindowPolicy({
      rawText: baseOutboundText,
      person,
      shortTag: candidate.shortTag || candidate.taskCode,
      title: candidate.title,
      dueDate: candidate.dueDate,
      businessProfile: workingState.business_profile,
      nowIso,
    });

    nextTasks[idx] = {
      ...candidate,
      status: 'PENDING',
      isFrozen: true,
      lastOutboundAt: nowIso,
      outboundWhatsappPreview: windowFormatted.text,
      release: {
        ...candidate.release!,
        releasedAt: nowIso,
        holdReason: null,
        nextEligibleAt: null,
        batchedForDigest: false,
        unlockNoticeText: null,
      },
      latestAiSummary: `Released to ${person?.name || rPhone} on WhatsApp.`,
      auditLogs: [
        ...candidate.auditLogs,
        {
          timestamp: nowIso,
          sender: 'RELEASE_ENGINE',
          rawInputSummary: `Released (${candidate.release?.mode || 'NOW'})${
            windowFormatted.isTemplateMessage ? ' via 24h template' : ''
          }.`,
          aiDecision: 'Status -> PENDING & WhatsApp message dispatched.',
        },
      ],
    };

    if (person) {
      person.stats.assigned += 1;
    }

    if (!options.suppressIndividualWhatsappForPhones?.has(rPhone)) {
      nextWhatsapp.push({
        tenantId,
        id: `wa-rel-${candidate.taskCode}-${nowMs}-${releasedTaskCodes.length}`,
        employeePhone: rPhone,
        direction: 'OUTBOUND',
        timestamp: nowIso,
        tag: unlockNotice ? 'DEPENDENCY_UNLOCKED' : 'TASK_DISPATCH',
        taskCode: candidate.taskCode,
        text: windowFormatted.text,
        isTemplateMessage: windowFormatted.isTemplateMessage,
      });
    }

    releasedTaskCodes.push(candidate.taskCode);
  }

  return {
    nextState: {
      ...workingState,
      team_members: nextMembers,
      tasks: nextTasks,
      whatsapp_messages: nextWhatsapp,
    },
    releasedTaskCodes,
  };
}

/**
 * Runs a full background/manual scheduler tick:
 * 1. Auto-expires past-due recurring tasks and stages today's recurring clones as SCHEDULED.
 * 2. Identifies teammates whose `dailyOverviewTime` has passed today in the business timezone
 *    and who have not yet received today's digest.
 * 3. Calls `releaseDueTasks` (flushing digest-batched tasks for digest recipients).
 * 4. Sends consolidated daily digests (respecting the 24-hour WhatsApp template policy).
 */
export function runScheduledJobsTick(
  state: OpsDatabaseState,
  now: Date | string = new Date().toISOString(),
  messageOverrides?: Record<string, string>
): {
  nextState: OpsDatabaseState;
  releasedTaskCodes: string[];
  digestsSent: number;
  expiredCount: number;
  remindersSent: number;
  /** Behind alerts sent to Accountable people in this tick. */
  behindAlertsSent?: number;
  tickTimestamp: string;
} {
  const { nowMs, nowIso } = resolveNowMs(now);
  const tenantId = state.tenantId || DEFAULT_TENANT_ID;
  const settings = buildReleaseSettingsFromState(state);
  const timeZone = resolveSafeTimezone(settings.timezone);
  const zonedNow = getZonedDateParts(nowMs, timeZone);
  const todayStr = zonedNow.dateStr;
  const workingDays =
    Array.isArray(settings.workingDays) && settings.workingDays.length > 0
      ? settings.workingDays
      : DEFAULT_WORKING_DAYS;
  const isWorkingDay = workingDays.includes(zonedNow.weekday);

  const nextMembers = structuredClone(state.team_members);
  let expiredCount = 0;
  const expiredRecurringTasks: Task[] = [];

  const updatedExistingTasks = state.tasks.map((t) => {
    if (
      t.taskFrequency === 'RECURRING' &&
      t.dueDate < todayStr &&
      !isTaskClosed(t.status) &&
      !t.archivedAt &&
      t.status !== 'AWAITING_BOSS_DECISION' &&
      t.status !== 'STAGING_DRAFT'
    ) {
      expiredCount += 1;
      const owner = nextMembers[t.raci.R];
      if (owner) {
        owner.stats.overdueCount += 1;
      }
      expiredRecurringTasks.push(t);
      return {
        ...t,
        status: 'EXPIRED_MISSED' as const,
        latestAiSummary: `Auto-expired by scheduler tick (uncompleted recurring instance from ${t.dueDate}).`,
        auditLogs: [
          ...t.auditLogs,
          {
            timestamp: nowIso,
            sender: 'JOBS_TICK',
            rawInputSummary: `Uncompleted recurring task past due date (${t.dueDate}).`,
            aiDecision: 'Status -> EXPIRED_MISSED',
          },
        ],
      };
    }
    return t;
  });

  const stagedTasks = [...updatedExistingTasks];
  for (const exp of expiredRecurringTasks) {
    const alreadyExists = stagedTasks.some(
      (t) =>
        t.title === exp.title &&
        t.raci.R === exp.raci.R &&
        t.dueDate === todayStr &&
        t.status !== 'EXPIRED_MISSED'
    );
    if (!alreadyExists) {
      let maxNum = 100;
      for (const existing of stagedTasks) {
        const m = existing.taskCode.match(/^T-(\d+)$/);
        if (m) maxNum = Math.max(maxNum, Number.parseInt(m[1], 10));
      }
      const spawnedCode = `T-${maxNum + 1}`;
      const freshSteps = exp.microSteps.map((s, idx) => ({
        id: `ms-${spawnedCode.toLowerCase().replace(/[^a-z0-9]/g, '')}-${idx + 1}`,
        label: s.label,
        status: 'PENDING' as const,
      }));

      stagedTasks.push({
        ...exp,
        tenantId,
        taskCode: spawnedCode,
        dueDate: todayStr,
        startDate: todayStr,
        status: 'SCHEDULED',
        completionPercent: 0,
        microSteps: freshSteps,
        release: {
          mode: 'NOW',
          releaseAt: null,
          afterTaskCode: null,
          afterTrigger: 'FULL_COMPLETION',
          delayMinutes: 0,
          requireOwnerConfirm: false,
          ownerConfirmed: false,
          releasedAt: null,
          holdReason: null,
          batchedForDigest: false,
        },
        reminderConfig: {
          ...exp.reminderConfig,
          lastNudgedAt: null,
          nudgeCount: 0,
          includeInDailyOverview: true,
        },
        isFrozen: true,
        latestAiSummary: `Spawned recurring cycle for ${todayStr}.`,
        auditLogs: [
          {
            timestamp: nowIso,
            sender: 'JOBS_TICK',
            rawInputSummary: `Spawned recurring instance for ${todayStr} from ${exp.taskCode}.`,
            aiDecision: `Created ${spawnedCode} as SCHEDULED.`,
          },
        ],
      });
    }
  }

  // Determine which members are due for their daily digest right now
  const digestDuePhones = new Set<string>();
  if (isWorkingDay) {
    const nowMins = zonedNow.hour * 60 + zonedNow.minute;
    for (const member of Object.values(nextMembers)) {
      if (member.isOnLeave) continue;
      if (member.lastDailyDigestDate === todayStr) continue;
      const overviewMins = parseHhMmToMinutes(member.dailyOverviewTime || '09:30', 9 * 60 + 30);
      const shiftEndMins = parseHhMmToMinutes(member.workShiftEnd || '19:00', 19 * 60);
      if (nowMins >= overviewMins && nowMins < shiftEndMins) {
        digestDuePhones.add(member.phone);
      }
    }
  }

  // Identify tasks that were specifically held for digest so we can bundle them into the digest message
  const preDigestBatchedTaskCodesByPhone = new Map<string, Set<string>>();
  for (const t of stagedTasks) {
    if (
      t.status === 'SCHEDULED' &&
      digestDuePhones.has(t.raci.R) &&
      (t.release?.batchedForDigest ||
        (settings.batchNonUrgentIntoDigest && t.quadrant !== 'Q1_DO_FIRST'))
    ) {
      if (!preDigestBatchedTaskCodesByPhone.has(t.raci.R)) {
        preDigestBatchedTaskCodesByPhone.set(t.raci.R, new Set());
      }
      preDigestBatchedTaskCodesByPhone.get(t.raci.R)!.add(t.taskCode);
    }
  }

  // Suppress separate individual WhatsApp sends for tasks that are being bundled into a digest right now
  const suppressPhones =
    settings.batchNonUrgentIntoDigest && preDigestBatchedTaskCodesByPhone.size > 0
      ? new Set(preDigestBatchedTaskCodesByPhone.keys())
      : undefined;

  //Wait: only suppress for the batched tasks, not urgent Q1 tasks! Let's handle suppression per-task cleanly:
  const releaseRes = releaseDueTasks(
    {
      ...state,
      team_members: nextMembers,
      tasks: stagedTasks,
    },
    new Date(nowMs),
    {
      messageOverrides,
      digestFlushPhones: digestDuePhones,
      suppressIndividualWhatsappForPhones: suppressPhones,
    }
  );

  // If suppressPhones suppressed an urgent Q1 task that also released in the same tick, send its individual message
  const postReleaseMessages = [...releaseRes.nextState.whatsapp_messages];
  if (suppressPhones && suppressPhones.size > 0) {
    for (const code of releaseRes.releasedTaskCodes) {
      const releasedTask = releaseRes.nextState.tasks.find((t) => t.taskCode === code);
      if (!releasedTask) continue;
      const rPhone = releasedTask.raci.R;
      const wasDigestBatched = preDigestBatchedTaskCodesByPhone.get(rPhone)?.has(code);
      if (suppressPhones.has(rPhone) && !wasDigestBatched) {
        postReleaseMessages.push({
          tenantId,
          id: `wa-rel-urgent-${code}-${nowMs}`,
          employeePhone: rPhone,
          direction: 'OUTBOUND',
          timestamp: nowIso,
          tag: 'TASK_DISPATCH',
          taskCode: code,
          text: releasedTask.outboundWhatsappPreview,
        });
      }
    }
  }

  const finalMembers = structuredClone(releaseRes.nextState.team_members);
  let digestsSent = 0;

  const ownerPhones = new Set(getOwnerPhones(finalMembers));
  for (const phone of digestDuePhones) {
    const member = finalMembers[phone];
    if (!member || member.isOnLeave) continue;

    // The owner gets "My tasks" (own tasks, decisions waiting, follow-ups) instead of a staff list.
    if (ownerPhones.has(phone)) {
      const summary = buildMyTasks(
        { ...releaseRes.nextState, team_members: finalMembers, whatsapp_messages: postReleaseMessages },
        { nowIso, todayStr, timezone: timeZone }
      );
      const ownerText = buildOwnerDigestText(summary, member, finalMembers);
      member.lastDailyDigestDate = todayStr;
      if (!ownerText) continue;
      const formattedOwner = applyWhatsapp24hWindowPolicy({
        rawText: ownerText,
        person: member,
        shortTag: 'Daily Summary',
        title: `My tasks (${todayStr})`,
        dueDate: todayStr,
        businessProfile: state.business_profile,
        nowIso,
      });
      postReleaseMessages.push({
        tenantId,
        id: `wa-digest-${phone}-${nowMs}`,
        employeePhone: phone,
        direction: 'OUTBOUND',
        timestamp: nowIso,
        tag: 'DAILY_DIGEST',
        text: formattedOwner.text,
        isTemplateMessage: formattedOwner.isTemplateMessage,
      });
      digestsSent += 1;
      continue;
    }

    const openTasks = releaseRes.nextState.tasks.filter(
      (t) =>
        t.raci.R === phone &&
        t.isFrozen &&
        t.reminderConfig.includeInDailyOverview &&
        (t.status === 'PENDING' || t.status === 'IN_PROGRESS' || t.status === 'PARTIALLY_DONE')
    );

    if (openTasks.length === 0) {
      member.lastDailyDigestDate = todayStr;
      continue;
    }

    const batchedSet = preDigestBatchedTaskCodesByPhone.get(phone);
    const bulletLines = openTasks
      .map((t) => {
        const newBadge = batchedSet?.has(t.taskCode) ? ' [NEW]' : '';
        return `• [${t.shortTag || t.taskCode}]${newBadge} ${t.title} (${t.completionPercent}% | Due: ${t.dueDate})`;
      })
      .join('\n');

    const rawDigest =
      member.preferredLanguage === 'ENGLISH'
        ? `☀️ Daily Shift Digest for ${member.name} (${member.workShiftStart}–${member.workShiftEnd}):\n${bulletLines}\nNote: Any items awaiting Boss Review remain paused.`
        : `☀️ Namaste ${staffAddressName(member, member.preferredLanguage)}, Aaj ke active tasks (${member.workShiftStart}–${member.workShiftEnd}):\n${bulletLines}\nKripya kaam shuru karke updates WhatsApp par bhejein.`;

    const formattedDigest = applyWhatsapp24hWindowPolicy({
      rawText: rawDigest,
      person: member,
      shortTag: 'Daily Shift Digest',
      title: `Daily Overview (${todayStr})`,
      dueDate: todayStr,
      businessProfile: state.business_profile,
      nowIso,
    });

    postReleaseMessages.push({
      tenantId,
      id: `wa-digest-${phone}-${nowMs}`,
      employeePhone: phone,
      direction: 'OUTBOUND',
      timestamp: nowIso,
      tag: 'DAILY_DIGEST',
      text: formattedDigest.text,
      isTemplateMessage: formattedDigest.isTemplateMessage,
    });

    member.lastDailyDigestDate = todayStr;
    digestsSent += 1;
  }

  // Automatic reminders run last, so tasks released in this tick are not nudged yet.
  const reminderRes = sendDueReminders(
    {
      ...releaseRes.nextState,
      team_members: finalMembers,
      whatsapp_messages: postReleaseMessages,
    },
    new Date(nowMs)
  );

  // Work that is behind (late by the clock, or a reply said so): tell the Accountable once.
  const behindRes = sendBehindAlerts(reminderRes.nextState, nowIso);
  // Any open decision the owner has not been asked about on WhatsApp yet.
  const decisionRes = sendOwnerDecisionPrompts(behindRes.nextState, nowIso);

  return {
    nextState: decisionRes.nextState,
    releasedTaskCodes: releaseRes.releasedTaskCodes,
    digestsSent,
    expiredCount,
    remindersSent: reminderRes.remindedTaskCodes.length,
    behindAlertsSent: behindRes.alertedTaskCodes.length,
    tickTimestamp: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Milestone 3 review fixes: picker defaults, release-choice checks, step text,
// planned send time and freeze outcome notices.
// ---------------------------------------------------------------------------

/**
 * Default value for an "At a time" picker: now + offset, written as a wall-clock
 * "YYYY-MM-DDTHH:mm" in the business timezone (the format the engine reads back).
 */
export function defaultReleaseAtLocal(
  nowMs: number,
  timeZoneInput?: string,
  offsetMinutes: number = 60
): string {
  const parts = getZonedDateParts(nowMs + offsetMinutes * 60_000, timeZoneInput);
  return `${parts.dateStr}T${parts.hhmm}`;
}

/**
 * Returns a plain-language message when a release choice is unfinished
 * ("At a time" with no valid time, or "After task" with no task), else null.
 * `fallbackAfterCode` is a dependency set some other way (e.g. by the AI plan).
 */
export function findIncompleteReleaseChoice(
  release: Partial<TaskReleaseConfig> | null | undefined,
  fallbackAfterCode?: string | null,
  timeZoneInput?: string
): string | null {
  if (!release) return null;
  if (release.mode === 'AT_TIME') {
    const raw = typeof release.releaseAt === 'string' ? release.releaseAt.trim() : '';
    if (!raw || parseScheduledReleaseInstantMs(raw, timeZoneInput) === null) {
      return 'Pick a date and time for "At a time", or choose another option.';
    }
  }
  if (release.mode === 'AFTER_TASK') {
    const code = (release.afterTaskCode || fallbackAfterCode || '').trim();
    if (!code) {
      return 'Choose which task this one should wait for, or choose another option.';
    }
  }
  return null;
}

export interface DraftReleaseProblem {
  tempId: string;
  title: string;
  message: string;
}

/** Checks every draft's release choice before freezing. Empty array = all complete. */
export function validateDraftReleaseChoices(
  drafts: Array<{
    tempId: string;
    title: string;
    release?: Partial<TaskReleaseConfig>;
    dependsOnTempIdOrTaskCode?: string | null;
  }>,
  timeZoneInput?: string,
  now: Date | string = new Date().toISOString()
): DraftReleaseProblem[] {
  const problems: DraftReleaseProblem[] = [];
  for (const d of drafts) {
    const message =
      findIncompleteReleaseChoice(d.release, d.dependsOnTempIdOrTaskCode ?? null, timeZoneInput) ||
      findPastReleaseTime(d.release, timeZoneInput, now);
    if (message) {
      problems.push({ tempId: d.tempId, title: d.title, message });
    }
  }
  return problems;
}

/** One owner-facing message for a blocked freeze. */
export function buildIncompleteReleaseNotice(problems: DraftReleaseProblem[]): string {
  if (problems.length === 0) return '';
  const first = problems[0];
  const more = problems.length > 1 ? ` (${problems.length - 1} more task(s) need the same)` : '';
  return `Not sent: finish the release choice for "${first.title}". ${first.message}${more}`;
}

/**
 * Numbered steps section for WhatsApp text. Accepts step objects or plain strings,
 * skips empty labels, and returns '' (no "Steps:" heading) when there are none.
 */
export function formatNumberedStepsBlock(
  steps: ReadonlyArray<{ label?: string | null; status?: string } | string | null | undefined> | null | undefined,
  heading: string,
  options: { withStatus?: boolean } = {}
): string {
  const lines: string[] = [];
  for (const s of steps || []) {
    const label = typeof s === 'string' ? s : s?.label;
    if (typeof label !== 'string' || !label.trim()) continue;
    const status =
      options.withStatus && s && typeof s === 'object' && s.status ? ` [${s.status}]` : '';
    lines.push(`${lines.length + 1}. ${label.trim()}${status}`);
  }
  if (lines.length === 0) return '';
  return `${heading}:\n${lines.join('\n')}\n`;
}

/**
 * Plain words for when a held task is expected to be sent, for the Scheduled lane.
 */
export function describePlannedSendTime(
  task: Pick<Task, 'status' | 'release' | 'dependency' | 'raci' | 'taskCode'>,
  state: Pick<OpsDatabaseState, 'team_members' | 'business_profile'>,
  now: Date | string = new Date().toISOString()
): string {
  const tz = resolveSafeTimezone(state.business_profile?.timezone);
  const { nowMs } = resolveNowMs(now);
  const release = task.release;
  const person = state.team_members?.[task.raci?.R];
  const personName = person?.name || 'the assignee';

  if (release?.holdReason === PARENT_CANCELLED_HOLD_REASON) {
    return 'Not planned — the task it waits for was cancelled';
  }
  if (task.status === 'LOCKED_BY_DEPENDENCY') {
    const code = release?.afterTaskCode || task.dependency?.dependsOnTaskCode || 'the earlier task';
    const delay =
      release?.delayMinutes && release.delayMinutes > 0 ? `${release.delayMinutes} min after ` : 'When ';
    return `${delay}${code} is done`;
  }
  if (release?.requireOwnerConfirm && !release.ownerConfirmed) {
    return 'When you confirm it';
  }
  const incomplete = findIncompleteReleaseChoice(
    release,
    task.dependency?.dependsOnTaskCode ?? null,
    tz
  );
  if (incomplete) {
    return 'Not planned — release choice is incomplete';
  }
  // A set time or next-shift time is only shown while it is still ahead; once it has
  // passed, the real reason the task is held (limit, leave, digest...) is what matters.
  const releaseAtMs =
    release?.mode === 'AT_TIME' && release.releaseAt
      ? parseScheduledReleaseInstantMs(release.releaseAt, tz)
      : null;
  const eligibleMs = release?.nextEligibleAt ? Date.parse(release.nextEligibleAt) : NaN;
  const futureTimes = [releaseAtMs, Number.isNaN(eligibleMs) ? null : eligibleMs].filter(
    (ms): ms is number => ms !== null && ms > nowMs
  );
  if (futureTimes.length > 0) {
    return formatTimestampInTimezone(Math.max(...futureTimes), tz);
  }
  const hold = release?.holdReason || '';
  if (/active task cap/i.test(hold)) return `When one of ${personName}'s tasks closes`;
  if (release?.mode === 'WHEN_FREE' || /until person is free/i.test(hold)) {
    return `When ${personName} has no open tasks`;
  }
  if (/digest/i.test(hold)) {
    return `With ${personName}'s daily digest (${person?.dailyOverviewTime || '09:30'})`;
  }
  if (/on leave/i.test(hold)) return `When ${personName} is back from leave`;
  return 'At the next scheduler check';
}

export interface FreezeOutcomeTask {
  taskCode: string;
  shortTag: string;
  outcome: 'SENT' | 'SCHEDULED' | 'WAITING';
  /** Formatted planned send time / condition for SCHEDULED and WAITING tasks. */
  when: string | null;
}

export interface FreezeOutcome {
  tasks: FreezeOutcomeTask[];
  sentCount: number;
  scheduledCount: number;
  waitingCount: number;
  notice: string;
}

/**
 * Compares state before and after a freeze and describes what really happened to the
 * new tasks: "Sent on WhatsApp" only for tasks a message actually went out for.
 */
export function summarizeFreezeOutcome(
  before: Pick<OpsDatabaseState, 'tasks'>,
  after: OpsDatabaseState,
  now: Date | string = new Date().toISOString()
): FreezeOutcome {
  const existing = new Set(before.tasks.map((t) => t.taskCode));
  const sentCodes = new Set(
    after.whatsapp_messages
      .filter((m) => m.direction === 'OUTBOUND' && m.taskCode && !existing.has(m.taskCode))
      .map((m) => m.taskCode as string)
  );
  const created = after.tasks.filter((t) => !existing.has(t.taskCode));
  const tasks: FreezeOutcomeTask[] = created.map((t) => {
    const shortTag = t.shortTag || t.taskCode;
    if (isTaskReleasedStatus(t.status) && sentCodes.has(t.taskCode)) {
      return { taskCode: t.taskCode, shortTag, outcome: 'SENT', when: null };
    }
    const when = describePlannedSendTime(t, after, now);
    return {
      taskCode: t.taskCode,
      shortTag,
      outcome: t.status === 'LOCKED_BY_DEPENDENCY' ? 'WAITING' : 'SCHEDULED',
      when,
    };
  });

  const sent = tasks.filter((t) => t.outcome === 'SENT');
  const scheduled = tasks.filter((t) => t.outcome === 'SCHEDULED');
  const waiting = tasks.filter((t) => t.outcome === 'WAITING');

  let notice: string;
  if (tasks.length === 1) {
    const only = tasks[0];
    if (only.outcome === 'SENT') {
      const person = after.team_members[created[0].raci.R]?.name;
      notice = `Sent on WhatsApp: [${only.shortTag}]${person ? ` to ${person}` : ''}.`;
    } else if (only.outcome === 'WAITING') {
      notice = `Waiting: [${only.shortTag}] will be sent ${lowerFirst(only.when || 'later')}.`;
    } else {
      const heldForShift =
        (created[0]?.release?.mode || 'NOW') === 'NOW' &&
        /^Held until next shift/i.test(created[0]?.release?.holdReason || '');
      const urgentHint = heldForShift ? ' Mark as urgent to send now.' : '';
      notice = /^[A-Z][a-z]{2}, /.test(only.when || '')
        ? `Scheduled for ${only.when}: [${only.shortTag}]. Not sent yet.${urgentHint}`
        : `Scheduled (not sent yet): [${only.shortTag}] — ${lowerFirst(only.when || 'later')}.${urgentHint}`;
    }
  } else {
    const parts: string[] = [];
    if (sent.length) parts.push(`${sent.length} sent on WhatsApp`);
    if (scheduled.length) {
      const times = Array.from(new Set(scheduled.map((t) => t.when).filter(Boolean)));
      if (times.length === 1) {
        parts.push(`${scheduled.length} scheduled for ${times[0]} (not sent yet)`);
      } else {
        // Different times: list each task with its own planned send time.
        const each = scheduled
          .map((t) => {
            const when = t.when || 'later';
            return `[${t.shortTag}] ${/^[A-Z][a-z]{2}, /.test(when) ? `for ${when}` : lowerFirst(when)}`;
          })
          .join('; ');
        parts.push(`${scheduled.length} scheduled (not sent yet): ${each}`);
      }
    }
    if (waiting.length) parts.push(`${waiting.length} waiting on another task`);
    notice = parts.length ? `${parts.join(', ')}.` : 'No tasks were created.';
  }

  return {
    tasks,
    sentCount: sent.length,
    scheduledCount: scheduled.length,
    waitingCount: waiting.length,
    notice,
  };
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Project (WBS head) release badge and past "At a time" check.
// ---------------------------------------------------------------------------

/**
 * Message when an "At a time" choice is already in the past (by at least one whole minute),
 * else null. Used only when freezing; the engine itself still releases tasks whose time
 * has arrived.
 */
export function findPastReleaseTime(
  release: Partial<TaskReleaseConfig> | null | undefined,
  timeZoneInput?: string,
  now: Date | string = new Date().toISOString()
): string | null {
  if (!release || release.mode !== 'AT_TIME' || !release.releaseAt) return null;
  const tz = resolveSafeTimezone(timeZoneInput);
  const ms = parseScheduledReleaseInstantMs(release.releaseAt, tz);
  if (ms === null) return null;
  const { nowMs } = resolveNowMs(now);
  if (ms + 60_000 > nowMs) return null;
  return `That time (${formatTimestampInTimezone(ms, tz)}) has already passed. Pick a time in the future, or choose "Now".`;
}

export interface WbsHeadReleaseSummary {
  /** Short badge text, e.g. "Sent ✓", "Scheduled · Sat, Nov 14, 9:00 AM", "Sent 1/3 · 2 scheduled". */
  label: string;
  tone: 'sent' | 'scheduled' | 'mixed' | 'staged';
  /** One line per task with its planned send time, for a tooltip. */
  details: string[];
}

/**
 * What really happened to a frozen project's tasks: sent, or only scheduled (with times).
 */
export function summarizeWbsHeadRelease(
  head: Pick<WbsHeadLike, 'headId' | 'status'>,
  state: Pick<OpsDatabaseState, 'tasks' | 'team_members' | 'business_profile'>,
  now: Date | string = new Date().toISOString()
): WbsHeadReleaseSummary {
  if (head.status !== 'FROZEN_DISPATCHED') {
    return { label: 'Staged Ready', tone: 'staged', details: [] };
  }
  const tasks = state.tasks.filter((t) => t.wbsHeadId === head.headId);
  if (tasks.length === 0) {
    return { label: 'Frozen', tone: 'staged', details: [] };
  }

  const isSent = (t: Task) =>
    t.status === 'COMPLETED' ||
    t.status === 'EXPIRED_MISSED' ||
    isTaskReleasedStatus(t.status) ||
    Boolean(t.release?.releasedAt);
  const sent = tasks.filter(isSent);
  const held = tasks.filter((t) => !isSent(t));

  const details = tasks.map((t) => {
    const tag = t.shortTag || t.taskCode;
    return isSent(t) ? `[${tag}] sent` : `[${tag}] ${describePlannedSendTime(t, state, now)}`;
  });

  if (held.length === 0) {
    return { label: 'Sent ✓', tone: 'sent', details };
  }

  // Earliest concrete planned time among held tasks, if any.
  const tz = resolveSafeTimezone(state.business_profile?.timezone);
  const { nowMs } = resolveNowMs(now);
  let earliestMs: number | null = null;
  for (const t of held) {
    const r = t.release;
    const candidates = [
      r?.mode === 'AT_TIME' && r.releaseAt ? parseScheduledReleaseInstantMs(r.releaseAt, tz) : null,
      r?.nextEligibleAt ? Date.parse(r.nextEligibleAt) : null,
    ].filter((ms): ms is number => ms !== null && !Number.isNaN(ms) && ms > nowMs);
    if (candidates.length > 0) {
      const ms = Math.max(...candidates);
      earliestMs = earliestMs === null ? ms : Math.min(earliestMs, ms);
    }
  }
  const timeText =
    earliestMs !== null
      ? `${held.length > 1 ? 'first ' : ''}${formatTimestampInTimezone(earliestMs, tz)}`
      : held.length === 1
        ? lowerFirst(describePlannedSendTime(held[0], state, now))
        : null;

  if (sent.length === 0) {
    return {
      label: `Scheduled${timeText ? ` · ${timeText}` : ''}`,
      tone: 'scheduled',
      details,
    };
  }
  return {
    label: `Sent ${sent.length}/${tasks.length} · ${held.length} scheduled${timeText ? ` (${timeText})` : ''}`,
    tone: 'mixed',
    details,
  };
}

interface WbsHeadLike {
  headId: string;
  status: 'DRAFT_HEAD' | 'SWIMLANE_READY' | 'FROZEN_DISPATCHED';
}

// ---------------------------------------------------------------------------
// Milestone 3.5: closed/archived tasks, cancel + reminder messages, automatic reminders.
// ---------------------------------------------------------------------------

/** Finished for good: completed, missed (recurring) or cancelled. */
export function isTaskClosed(status: Task['status']): boolean {
  return status === 'COMPLETED' || status === 'EXPIRED_MISSED' || status === 'CANCELLED';
}

/** Shown on the active board: frozen into the workflow (not a draft) and not archived. */
export function isTaskOnActiveBoard(task: Pick<Task, 'status' | 'archivedAt'>): boolean {
  return task.status !== 'STAGING_DRAFT' && !task.archivedAt;
}

type MessageTask = Pick<Task, 'taskCode' | 'shortTag' | 'title'>;

function taskLabel(task: MessageTask): string {
  return task.shortTag || task.taskCode;
}

/** Short, polite "you can stop" message in the person's language. */
export function buildTaskCancelledMessage(task: MessageTask, person?: TeamMember | null): string {
  const tag = taskLabel(task);
  const lang: PreferredLanguage = person?.preferredLanguage || 'HINGLISH';
  if (lang === 'ENGLISH') {
    const name = staffAddressName(person, 'ENGLISH', 'there');
    return `Hello ${name}, task [${tag}] "${task.title}" has been cancelled. Please stop work on it. Thank you.`;
  }
  if (lang === 'HINDI') {
    const name = staffAddressName(person, 'HINDI', 'जी');
    return `नमस्ते ${name}, कार्य [${tag}] "${task.title}" रद्द कर दिया गया है। कृपया इस पर काम रोक दें। धन्यवाद।`;
  }
  const name = staffAddressName(person, 'HINGLISH', 'ji');
  return `Namaste ${name}, task [${tag}] "${task.title}" cancel ho gaya hai. Kripya is par kaam rok dein. Dhanyavaad.`;
}

/** Short, polite automatic reminder in the person's language. */
export function buildAutoReminderMessage(task: MessageTask, person?: TeamMember | null): string {
  const tag = taskLabel(task);
  const lang: PreferredLanguage = person?.preferredLanguage || 'HINGLISH';
  if (lang === 'ENGLISH') {
    const name = staffAddressName(person, 'ENGLISH', 'there');
    return `Hello ${name}, a gentle reminder about task [${tag}] "${task.title}". Please share a quick update when you can. Thank you.`;
  }
  if (lang === 'HINDI') {
    const name = staffAddressName(person, 'HINDI', 'जी');
    return `नमस्ते ${name}, कार्य [${tag}] "${task.title}" की याद दिला रहे हैं। समय मिलने पर कृपया अपडेट भेज दें। धन्यवाद।`;
  }
  const name = staffAddressName(person, 'HINGLISH', 'ji');
  return `Namaste ${name}, task [${tag}] "${task.title}" ka chhota sa reminder. Jab ho sake, kripya update bhej dein. Dhanyavaad.`;
}

export const DEFAULT_REMINDER_INTERVAL_HOURS = { urgent: 2, normal: 4 } as const;
export const MAX_AUTO_REMINDERS_PER_DAY = 3;

export interface ReminderContext {
  timezone?: string;
  workingDays?: number[];
  /** All WhatsApp messages, used to find the person's last update about the task. */
  whatsappMessages?: SimulatedWhatsappMessage[];
}

export interface ReminderDecision {
  due: boolean;
  reason: string;
  /** Business-timezone date the daily cap is counted for. */
  todayStr?: string;
}

/** Latest of: released, last nudge (manual or automatic), last inbound update on the task. */
export function getReminderClockStartMs(
  task: Pick<Task, 'taskCode' | 'raci' | 'release' | 'reminderConfig' | 'lastOutboundAt'>,
  whatsappMessages: SimulatedWhatsappMessage[] = []
): number | null {
  const candidates: number[] = [];
  const push = (iso?: string | null) => {
    if (!iso) return;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) candidates.push(ms);
  };
  push(task.release?.releasedAt ?? null);
  push(task.reminderConfig?.lastNudgedAt ?? null);
  for (const m of whatsappMessages) {
    if (m.direction === 'INBOUND' && m.taskCode === task.taskCode && m.employeePhone === task.raci.R) {
      push(m.timestamp);
    }
  }
  if (candidates.length === 0) push(task.lastOutboundAt ?? null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/**
 * Pure check: is an automatic reminder due for this task right now?
 * Released and unfinished; person on shift, not on leave, not the owner; interval passed;
 * under the daily cap (Q1 tasks have no cap).
 */
export function computeReminderDecision(
  task: Task,
  person: TeamMember | undefined | null,
  ctx: ReminderContext,
  now: Date | string
): ReminderDecision {
  if (task.archivedAt || isTaskClosed(task.status)) return { due: false, reason: 'Task is closed' };
  if (task.status === 'AWAITING_BOSS_DECISION') return { due: false, reason: 'Paused for owner decision' };
  if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS' && task.status !== 'PARTIALLY_DONE') {
    return { due: false, reason: 'Not sent yet' };
  }
  if (!task.isFrozen) return { due: false, reason: 'Not sent yet' };
  if (!person) return { due: false, reason: 'Person not in roster' };
  if (person.authorityLevel === 'OWNER') return { due: false, reason: 'Owner tasks are not nudged' };
  if (person.isOnLeave) return { due: false, reason: 'On leave' };

  const { nowMs } = resolveNowMs(now);
  const timeZone = resolveSafeTimezone(ctx.timezone);
  const workingDays =
    Array.isArray(ctx.workingDays) && ctx.workingDays.length > 0 ? ctx.workingDays : DEFAULT_WORKING_DAYS;
  const zoned = getZonedDateParts(nowMs, timeZone);
  if (!workingDays.includes(zoned.weekday)) return { due: false, reason: 'Not a working day' };
  if (!isInsideShiftWindow(zoned.hour * 60 + zoned.minute, person.workShiftStart, person.workShiftEnd)) {
    return { due: false, reason: 'Outside shift' };
  }

  const isUrgent = task.quadrant === 'Q1_DO_FIRST';
  const intervalHours =
    typeof task.reminderConfig?.customIntervalHours === 'number' && task.reminderConfig.customIntervalHours > 0
      ? task.reminderConfig.customIntervalHours
      : isUrgent
        ? DEFAULT_REMINDER_INTERVAL_HOURS.urgent
        : DEFAULT_REMINDER_INTERVAL_HOURS.normal;
  const startMs = getReminderClockStartMs(task, ctx.whatsappMessages);
  if (startMs === null) return { due: false, reason: 'No send time recorded' };
  if (nowMs - startMs < intervalHours * 3_600_000) {
    return { due: false, reason: `Interval (${intervalHours}h) not passed` };
  }

  const todayStr = zoned.dateStr;
  const sentToday =
    task.reminderConfig?.autoNudgeDate === todayStr ? task.reminderConfig.autoNudgesOnDate || 0 : 0;
  if (!isUrgent && sentToday >= MAX_AUTO_REMINDERS_PER_DAY) {
    return { due: false, reason: `Daily limit (${MAX_AUTO_REMINDERS_PER_DAY}) reached` };
  }

  return { due: true, reason: 'Reminder due', todayStr };
}

/** Sends every due automatic reminder (simulator), updating counters and task history. */
export function sendDueReminders(
  state: OpsDatabaseState,
  now: Date | string = new Date().toISOString()
): { nextState: OpsDatabaseState; remindedTaskCodes: string[] } {
  const { nowMs, nowIso } = resolveNowMs(now);
  const tenantId = state.tenantId || DEFAULT_TENANT_ID;
  const settings = buildReleaseSettingsFromState(state);
  const ctx: ReminderContext = {
    timezone: settings.timezone,
    workingDays: settings.workingDays,
    whatsappMessages: state.whatsapp_messages,
  };
  const remindedTaskCodes: string[] = [];
  const newMessages: SimulatedWhatsappMessage[] = [];

  const nextTasks = state.tasks.map((t) => {
    const person = state.team_members[t.raci.R];
    const decision = computeReminderDecision(t, person, ctx, new Date(nowMs));
    if (!decision.due || !decision.todayStr) return t;

    const formatted = applyWhatsapp24hWindowPolicy({
      rawText: buildAutoReminderMessage(t, person),
      person,
      shortTag: t.shortTag || t.taskCode,
      title: t.title,
      dueDate: t.dueDate,
      businessProfile: state.business_profile,
      nowIso,
    });
    newMessages.push({
      tenantId,
      id: `wa-auto-reminder-${t.taskCode}-${nowMs}`,
      employeePhone: t.raci.R,
      direction: 'OUTBOUND',
      timestamp: nowIso,
      tag: 'AUTO_REMINDER',
      taskCode: t.taskCode,
      text: formatted.text,
      isTemplateMessage: formatted.isTemplateMessage,
    });
    remindedTaskCodes.push(t.taskCode);

    const sentToday =
      t.reminderConfig.autoNudgeDate === decision.todayStr ? t.reminderConfig.autoNudgesOnDate || 0 : 0;
    return {
      ...t,
      lastOutboundAt: nowIso,
      reminderConfig: {
        ...t.reminderConfig,
        lastNudgedAt: nowIso,
        nudgeCount: (t.reminderConfig.nudgeCount || 0) + 1,
        autoNudgeDate: decision.todayStr,
        autoNudgesOnDate: sentToday + 1,
      },
      auditLogs: [
        ...t.auditLogs,
        {
          timestamp: nowIso,
          sender: 'AUTO_REMINDER',
          rawInputSummary: `Automatic reminder sent to ${person?.name || t.raci.R} (${sentToday + 1} today).`,
          aiDecision: 'Reminder only; task status unchanged.',
        },
      ],
    };
  });

  if (remindedTaskCodes.length === 0) {
    return { nextState: state, remindedTaskCodes };
  }
  return {
    nextState: {
      ...state,
      tasks: nextTasks,
      whatsapp_messages: [...state.whatsapp_messages, ...newMessages],
    },
    remindedTaskCodes,
  };
}
