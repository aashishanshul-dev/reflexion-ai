/**
 * Batch 2 — close the tracking loop: when work falls behind, tell the Accountable
 * person once, with the AI's suggested fix and any open approval in the same project
 * that may be holding it up. Code decides "behind" (clock + reply flag); language
 * words only — names come from the team profile.
 */
import type { OpsDatabaseState, PreferredLanguage, Task, TeamMember } from '../types/ops.ts';
import { staffAddressName } from './staffNames.ts';
import { describeTaskTiming, formatDueLabel, formatDuration, isTaskBehind, isTaskOpenForTiming } from './taskTiming.ts';
import {
  buildEscalationArtifacts,
  resolveAccountableRecipient,
  sanitizeOutboundText,
  upsertOpenEscalationReview,
} from './staffEscalation.ts';

const DEFAULT_TENANT = 'default';

export interface RelatedOpenItem {
  reviewId: string;
  taskCode: string;
  tag: string;
  personName: string;
  summary: string;
}

/** Open owner decisions on other tasks in the same project (plan or agenda) as `task`. */
export function findRelatedOpenItems(
  state: Pick<OpsDatabaseState, 'tasks' | 'boss_review_queue' | 'team_members'>,
  task: Pick<Task, 'taskCode' | 'wbsHeadId' | 'agendaId'>
): RelatedOpenItem[] {
  const sameProject = new Map(
    (state.tasks || [])
      .filter(
        (t) =>
          t.taskCode !== task.taskCode &&
          ((task.wbsHeadId && t.wbsHeadId === task.wbsHeadId) || (task.agendaId && t.agendaId === task.agendaId))
      )
      .map((t) => [t.taskCode, t])
  );
  return (state.boss_review_queue || [])
    .filter((r) => r.status === 'OPEN' && sameProject.has(r.taskCode))
    .map((r) => {
      const t = sameProject.get(r.taskCode)!;
      return {
        reviewId: r.reviewId,
        taskCode: r.taskCode,
        tag: t.shortTag || t.taskCode,
        personName: state.team_members[r.employeePhone]?.name || state.team_members[t.raci.R]?.name || 'Team member',
        summary: r.employeeMessageSummary,
      };
    });
}

/** Tasks in the same project that are behind (for showing on an approval card). */
export function findBehindTasksInProject(
  state: Pick<OpsDatabaseState, 'tasks' | 'business_profile'>,
  reviewTask: Pick<Task, 'taskCode' | 'wbsHeadId' | 'agendaId'>,
  nowMs: number
): Task[] {
  return (state.tasks || []).filter(
    (t) =>
      t.taskCode !== reviewTask.taskCode &&
      ((reviewTask.wbsHeadId && t.wbsHeadId === reviewTask.wbsHeadId) ||
        (reviewTask.agendaId && t.agendaId === reviewTask.agendaId)) &&
      isTaskBehind(t, nowMs, state.business_profile?.timezone)
  );
}

/** The WhatsApp alert to the Accountable person, in their language. */
export function buildBehindAlertText(params: {
  task: Pick<Task, 'taskCode' | 'shortTag' | 'title'> & { scheduleRisk?: Task['scheduleRisk'] };
  accountable: (Pick<TeamMember, 'name' | 'preferredLanguage'> & { addressAs?: string }) | null | undefined;
  responsible: Pick<TeamMember, 'name'> | null | undefined;
  related: RelatedOpenItem[];
}): string {
  const lang: PreferredLanguage = params.accountable?.preferredLanguage || 'HINGLISH';
  const tag = params.task.shortTag || params.task.taskCode;
  const who = params.responsible?.name || '';
  const reason = params.task.scheduleRisk?.reason || '';
  const fix = (params.task.scheduleRisk?.suggestedFix || '').trim();
  const linked = params.related
    .map((r) => `${r.personName} — [${r.tag}] (${r.reviewId})`)
    .join('; ');

  if (lang === 'ENGLISH') {
    return [
      `⚠️ ${staffAddressName(params.accountable, 'ENGLISH', 'Hello')}, [${tag}]${who ? ` (${who})` : ''} is behind.`,
      reason,
      fix ? `Suggested: ${fix}` : '',
      linked ? `Waiting for approval in the same job: ${linked}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (lang === 'HINDI') {
    return [
      `⚠️ ${staffAddressName(params.accountable, 'HINDI', 'जी')}, [${tag}]${who ? ` (${who})` : ''} समय से पीछे है।`,
      reason,
      fix ? `सुझाव: ${fix}` : '',
      linked ? `इसी काम में मंज़ूरी बाकी: ${linked}।` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `⚠️ ${staffAddressName(params.accountable, 'HINGLISH', 'ji')}, [${tag}]${who ? ` (${who})` : ''} time se peeche hai.`,
    reason,
    fix ? `Sujhav: ${fix}` : '',
    linked ? `Isi kaam mein approval baaki: ${linked}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function hasReplySinceSent(state: Pick<OpsDatabaseState, 'whatsapp_messages'>, task: Task): boolean {
  const sentMs = Date.parse(task.release?.releasedAt || task.lastOutboundAt || '');
  return (state.whatsapp_messages || []).some((m) => {
    if (m.direction !== 'INBOUND' || m.employeePhone !== task.raci?.R) return false;
    if (m.taskCode && m.taskCode !== task.taskCode) return false;
    const msgMs = Date.parse(m.timestamp);
    return Number.isNaN(sentMs) || Number.isNaN(msgMs) || msgMs >= sentMs;
  });
}

/**
 * Sends one alert per behind task to its Accountable person (not when they are the
 * Responsible person themself), marks it alerted, and logs it. A task that is late by
 * the clock with no reply gets a code-written reason first. Also escalates urgent
 * tasks that have received no reply by the pre-deadline threshold.
 */
export function sendBehindAlerts(
  state: OpsDatabaseState,
  nowIso: string,
  options: { onlyTaskCodes?: string[]; noResponseThresholdMinutes?: number } = {}
): { nextState: OpsDatabaseState; alertedTaskCodes: string[] } {
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) return { nextState: state, alertedTaskCodes: [] };
  const tz = state.business_profile?.timezone;
  const only = options.onlyTaskCodes ? new Set(options.onlyTaskCodes) : null;
  const thresholdMins = options.noResponseThresholdMinutes ?? 120;
  const alertedTaskCodes: string[] = [];
  const newMessages: OpsDatabaseState['whatsapp_messages'] = [];
  let nextQueue = [...(state.boss_review_queue || [])];
  const roster = Object.values(state.team_members || {});

  const tasks = state.tasks.map((t) => {
    if (only && !only.has(t.taskCode)) return t;
    if (t.scheduleRisk?.alertedAt) return t;

    const behindNow = isTaskBehind(t, nowMs, tz);
    const timing = describeTaskTiming(t, nowMs, tz, thresholdMins);
    const isUrgentNoResponse =
      !behindNow &&
      t.quadrant === 'Q1_DO_FIRST' &&
      isTaskOpenForTiming(t) &&
      (t.status === 'PENDING' || t.status === 'IN_PROGRESS' || t.status === 'PARTIALLY_DONE') &&
      timing.state === 'DUE_SOON' &&
      !hasReplySinceSent(state, t);

    if (!behindNow && !isUrgentNoResponse) return t;

    const accountable =
      (t.raci?.A ? state.team_members[t.raci.A] : undefined) ||
      resolveAccountableRecipient(t, state.team_members, state.owner_profile);
    if (!accountable || accountable.phone === t.raci?.R) return t;

    const risk = t.scheduleRisk || {
      reason: isUrgentNoResponse
        ? `No response yet with ${formatDuration(timing.minutesLeft)} left before deadline (${formatDueLabel(t)}).`
        : `Past the deadline (${formatDueLabel(t)}) by ${formatDuration(timing.minutesLate)}; no update yet.`,
      flaggedAt: nowIso,
      reportedEta: null,
    };
    const flagged = { ...t, scheduleRisk: { ...risk, alertedAt: nowIso } };
    const text = sanitizeOutboundText(
      buildBehindAlertText({
        task: flagged,
        accountable,
        responsible: state.team_members[t.raci.R],
        related: findRelatedOpenItems(state, t),
      }),
      roster
    );
    newMessages.push({
      tenantId: state.tenantId || DEFAULT_TENANT,
      id: `wa-behind-${t.taskCode}-${nowMs}`,
      employeePhone: accountable.phone,
      direction: 'OUTBOUND',
      timestamp: nowIso,
      tag: 'BEHIND_ALERT',
      taskCode: t.taskCode,
      text,
    });
    alertedTaskCodes.push(t.taskCode);

    if (isUrgentNoResponse) {
      try {
        const artifacts = buildEscalationArtifacts({
          task: flagged,
          responsible: state.team_members[t.raci.R],
          accountable,
          decision: {
            shouldEscalate: true,
            trigger: 'NO_RESPONSE',
            isUrgent: true,
            logDelayOnly: false,
            quote: '',
            reasonLabel: 'No response received before deadline threshold',
            reviewType: 'BLOCKER_ESCALATION',
          },
          teamMembers: state.team_members,
          nowMs,
          timezone: tz,
        });
        nextQueue = upsertOpenEscalationReview({
          queue: nextQueue,
          taskCode: t.taskCode,
          employeePhone: t.raci.R,
          routedToPhone: accountable.phone,
          trigger: 'NO_RESPONSE',
          isUrgent: true,
          reviewType: 'BLOCKER_ESCALATION',
          summary: artifacts.summary,
          mediaVerificationNote: 'Automated no-response escalation before deadline.',
          suggestedReplies: artifacts.suggestedReplies,
          nowIso,
        }).nextQueue;
      } catch {
        // Non-fatal: behind alert is still sent even if review upsert fails.
      }
    }

    return {
      ...flagged,
      auditLogs: [
        ...(t.auditLogs || []),
        {
          timestamp: nowIso,
          sender: 'SYSTEM_BEHIND_ALERT',
          rawInputSummary: risk.reason,
          aiDecision: `Behind: told ${accountable.name} (Accountable) on WhatsApp.`,
        },
      ],
    };
  });

  if (alertedTaskCodes.length === 0) return { nextState: state, alertedTaskCodes };
  return {
    nextState: {
      ...state,
      tasks,
      boss_review_queue: nextQueue,
      whatsapp_messages: [...state.whatsapp_messages, ...newMessages],
    },
    alertedTaskCodes,
  };
}
