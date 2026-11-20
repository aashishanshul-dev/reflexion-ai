import type {
  OpsDatabaseState,
  SystemMemoryRule,
  Task,
  TeamMember,
} from '../../../src/types/ops.ts';

export const TEST_CLOCK_ISO = '2026-11-16T04:30:00.000Z'; // Mon 16 Nov 2026, 10:00 Asia/Kolkata
export const TEST_TODAY_ISO = '2026-11-16';

export type FixtureId = 'F1' | 'F2' | 'F3' | 'EMPTY' | 'DEMO';

export interface FixtureMemberExtra {
  /** Human-readable contact display in Section 5 (`90000 1xxxx`). */
  rawPhoneDisplay: string;
  /** Date-ranged leave dates (YYYY-MM-DD) — tracked as fixture ground truth even though TeamMember only has boolean isOnLeave. */
  scheduledLeaveDates?: string[];
  /** Per-person working days (0=Sun..6=Sat) when restricted (e.g. Sunil Mon/Wed/Fri). */
  workingDaysOverride?: number[];
  /** Communication channel preference (Voice | Text) from Section 5. */
  prefersChannel?: 'Voice' | 'Text';
}

export interface FixtureBusinessRecord {
  id: string;
  title: string;
  date?: string;
  time?: string;
  details: string;
}

export interface TuningFixture {
  id: FixtureId;
  holdoutOnly: boolean;
  label: string;
  ownerName: string;
  ownerLanguageNote: string;
  state: OpsDatabaseState;
  memberExtras: Record<string, FixtureMemberExtra>;
  records: FixtureBusinessRecord[];
  vendors: string[];
  /** Name -> canonical normalized phone lookup for preconditions & assertions. */
  phoneByName: Record<string, string>;
}

export function makeStats() {
  return {
    assigned: 0,
    completed: 0,
    partial: 0,
    overdueCount: 0,
    totalWorkHoursReplyMins: 0,
    replyCount: 0,
  };
}

export function buildBaseMemoryRule(
  id: string,
  category: SystemMemoryRule['category'],
  fact: string
): SystemMemoryRule {
  return {
    tenantId: 'tuning',
    memoryId: id,
    category,
    fact,
    active: true,
    approved: true,
  };
}

export function makeOpenTask(params: {
  taskCode: string;
  shortTag: string;
  title: string;
  responsiblePhone: string;
  accountablePhone: string;
  categoryId?: string;
  dueDate?: string;
  status?: Task['status'];
  quadrant?: Task['quadrant'];
  microSteps?: string[];
  lastOutboundAt?: string;
  requireOwnerConfirm?: boolean;
  releasedAt?: string | null;
}): Task {
  const steps = (params.microSteps && params.microSteps.length > 0
    ? params.microSteps
    : ['Complete requested work and share update']
  ).map((label, idx) => ({
    id: `ms-${params.taskCode.toLowerCase()}-${idx + 1}`,
    label,
    status: 'PENDING' as const,
  }));

  const releasedAt =
    params.releasedAt !== undefined ? params.releasedAt : '2026-11-16T04:00:00.000Z';

  return {
    tenantId: 'tuning',
    taskCode: params.taskCode,
    shortTag: params.shortTag,
    agendaId: null,
    title: params.title,
    categoryId: params.categoryId || 'AD_HOC',
    quadrant: params.quadrant || 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    isFrozen: true,
    raci: {
      R: params.responsiblePhone,
      A: params.accountablePhone,
      C: [],
      I: [],
    },
    status: params.status || 'PENDING',
    completionPercent: 0,
    microSteps: steps,
    missingStepsAlert: '',
    dependency: {
      dependsOnTaskCode: null,
      triggerCondition: 'FULL_COMPLETION',
    },
    release: {
      mode: 'NOW',
      releaseAt: null,
      afterTaskCode: null,
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: Boolean(params.requireOwnerConfirm),
      ownerConfirmed: params.requireOwnerConfirm ? false : undefined,
      releasedAt,
      holdReason: params.requireOwnerConfirm ? 'Waiting for owner confirmation' : null,
    },
    reminderConfig: {
      includeInDailyOverview: true,
      customIntervalHours: null,
      lastNudgedAt: params.lastOutboundAt || releasedAt,
      nudgeCount: 0,
    },
    startDate: TEST_TODAY_ISO,
    durationDays: 1,
    dueDate: params.dueDate || TEST_TODAY_ISO,
    isForcedDeadline: true,
    forcedDeadlineDate: params.dueDate || TEST_TODAY_ISO,
    outboundWhatsappPreview: `Task [${params.shortTag}] ${params.title}`,
    latestAiSummary: '',
    auditLogs: [],
    lastOutboundAt: params.lastOutboundAt || releasedAt || undefined,
  };
}
