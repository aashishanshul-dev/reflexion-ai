/**
 * Milestone 4 — "My tasks" for the owner: Do (owner is Responsible), Decide (open owner
 * reviews) and Follow up (delegated work where the owner is Accountable that needs chasing).
 *
 * Pure and dependency-light (types only), so the scheduler tick and the UI can both use it.
 * The business "today" (YYYY-MM-DD in the business timezone) is passed in.
 */
import type {
  BossReviewItem,
  OpsDatabaseState,
  SimulatedWhatsappMessage,
  Task,
  TeamMember,
} from '../types/ops.ts';
import { describeTaskTiming, isTaskBehind, timingLabel } from './taskTiming.ts';
import { staffAddressName } from './staffNames.ts';

export const DEFAULT_FOLLOW_UP_STUCK_HOURS = 24;

export type FollowUpReason = 'OVERDUE' | 'BEHIND' | 'STUCK' | 'PARTIALLY_DONE' | 'AWAITING_DECISION';

export interface FollowUpItem {
  task: Task;
  reasons: FollowUpReason[];
  /** Whole days past the due date (0 if not overdue). */
  overdueDays: number;
  /** Clock hours since the Responsible person's last update (or since the task was sent). */
  hoursSinceUpdate: number | null;
  /** Short owner-facing text for BEHIND, e.g. "Late by 3h 9m" or "Delay reported". */
  behindLabel?: string;
}

export interface DecideItem {
  review: BossReviewItem;
  task: Task | undefined;
}

export interface MyTasksSummary {
  ownerPhones: string[];
  do: Task[];
  decide: DecideItem[];
  followUp: FollowUpItem[];
  counts: { do: number; decide: number; followUp: number; total: number };
}

/** People with authority level OWNER. */
export function getOwnerPhones(teamMembers: Record<string, TeamMember> | TeamMember[]): string[] {
  const list = Array.isArray(teamMembers) ? teamMembers : Object.values(teamMembers || {});
  return list.filter((m) => m.authorityLevel === 'OWNER').map((m) => m.phone);
}

function isOpenTask(t: Task): boolean {
  return (
    t.status !== 'STAGING_DRAFT' &&
    t.status !== 'COMPLETED' &&
    t.status !== 'EXPIRED_MISSED' &&
    t.status !== 'CANCELLED' &&
    !t.archivedAt
  );
}

function isSentTask(t: Task): boolean {
  return (
    t.status === 'PENDING' ||
    t.status === 'IN_PROGRESS' ||
    t.status === 'PARTIALLY_DONE' ||
    t.status === 'AWAITING_BOSS_DECISION'
  );
}

/** Latest update from the Responsible person about this task, or when it was sent. */
export function getLastProgressAt(
  task: Pick<Task, 'taskCode' | 'raci' | 'release' | 'lastOutboundAt'>,
  whatsappMessages: SimulatedWhatsappMessage[] = []
): number | null {
  let latest: number | null = null;
  for (const m of whatsappMessages) {
    if (m.direction !== 'INBOUND' || m.taskCode !== task.taskCode || m.employeePhone !== task.raci.R) continue;
    const ms = Date.parse(m.timestamp);
    if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
  }
  if (latest !== null) return latest;
  const sent = Date.parse(task.release?.releasedAt || task.lastOutboundAt || '');
  return Number.isNaN(sent) ? null : sent;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export function buildMyTasks(
  state: Pick<OpsDatabaseState, 'tasks' | 'team_members' | 'boss_review_queue' | 'whatsapp_messages' | 'owner_profile'>,
  options: { nowIso: string; todayStr: string; timezone?: string | null }
): MyTasksSummary {
  const ownerPhones = getOwnerPhones(state.team_members);
  const owners = new Set(ownerPhones);
  const nowMs = Date.parse(options.nowIso);
  const stuckHoursSetting = Number(state.owner_profile?.followUpStuckHours);
  const stuckHours =
    Number.isFinite(stuckHoursSetting) && stuckHoursSetting > 0 ? stuckHoursSetting : DEFAULT_FOLLOW_UP_STUCK_HOURS;
  const openTasks = (state.tasks || []).filter(isOpenTask);

  const doTasks = openTasks
    .filter((t) => owners.has(t.raci?.R))
    .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));

  const openByCode = new Map(openTasks.map((t) => [t.taskCode, t]));
  const decide = (state.boss_review_queue || [])
    .filter((r) => r.status === 'OPEN' && openByCode.has(r.taskCode))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    .map((review) => ({ review, task: openByCode.get(review.taskCode) }));

  const followUp: FollowUpItem[] = [];
  for (const t of openTasks) {
    if (!owners.has(t.raci?.A) || owners.has(t.raci?.R)) continue;
    const reasons: FollowUpReason[] = [];
    const overdueDays = t.dueDate && t.dueDate < options.todayStr ? daysBetween(t.dueDate, options.todayStr) : 0;
    if (overdueDays > 0) reasons.push('OVERDUE');
    // Behind: past the due time today, or a reply said the work will finish late.
    let behindLabel: string | undefined;
    if (overdueDays === 0 && !Number.isNaN(nowMs) && isTaskBehind(t, nowMs, options.timezone)) {
      reasons.push('BEHIND');
      const timing = describeTaskTiming(t, nowMs, options.timezone);
      behindLabel = timing.state === 'LATE' ? timingLabel(timing) : 'Delay reported';
    }
    let hoursSinceUpdate: number | null = null;
    if (isSentTask(t)) {
      const last = getLastProgressAt(t, state.whatsapp_messages);
      if (last !== null && !Number.isNaN(nowMs)) {
        hoursSinceUpdate = Math.max(0, Math.floor((nowMs - last) / 3_600_000));
        if (t.status !== 'AWAITING_BOSS_DECISION' && hoursSinceUpdate >= stuckHours) reasons.push('STUCK');
      }
    }
    if (t.status === 'PARTIALLY_DONE') reasons.push('PARTIALLY_DONE');
    if (t.status === 'AWAITING_BOSS_DECISION') reasons.push('AWAITING_DECISION');
    if (reasons.length > 0) followUp.push({ task: t, reasons, overdueDays, hoursSinceUpdate, behindLabel });
  }
  followUp.sort(
    (a, b) =>
      b.overdueDays - a.overdueDays ||
      (b.hoursSinceUpdate ?? -1) - (a.hoursSinceUpdate ?? -1) ||
      a.task.taskCode.localeCompare(b.task.taskCode)
  );

  return {
    ownerPhones,
    do: doTasks,
    decide,
    followUp,
    counts: {
      do: doTasks.length,
      decide: decide.length,
      followUp: followUp.length,
      total: doTasks.length + decide.length + followUp.length,
    },
  };
}

/** Plain-English label for one follow-up reason (for the tab). */
export function describeFollowUpReason(reason: FollowUpReason, item: FollowUpItem): string {
  switch (reason) {
    case 'OVERDUE':
      return `Overdue ${item.overdueDays} day${item.overdueDays === 1 ? '' : 's'}`;
    case 'BEHIND':
      return item.behindLabel || 'Behind';
    case 'STUCK':
      return `No update for ${item.hoursSinceUpdate ?? 0} h`;
    case 'PARTIALLY_DONE':
      return 'Partly done';
    case 'AWAITING_DECISION':
      return 'Waiting for your decision';
  }
}

const tagOf = (t: Task | undefined) => (t ? t.shortTag || t.taskCode : 'task');

/**
 * The owner's daily digest: own tasks, decisions waiting, follow-ups with reasons.
 * Returns null when there is nothing in any section. No phone numbers.
 */
export function buildOwnerDigestText(
  summary: MyTasksSummary,
  owner: TeamMember,
  teamMembers: Record<string, TeamMember>
): string | null {
  if (summary.counts.total === 0) return null;
  const lang = owner.preferredLanguage || 'ENGLISH';
  const nameOf = (phone: string) => teamMembers[phone]?.name || 'team member';
  const reasonWord = (r: FollowUpReason, item: FollowUpItem): string => {
    if (lang === 'HINDI') {
      return {
        OVERDUE: `${item.overdueDays} दिन देर`,
        BEHIND: 'समय से पीछे',
        STUCK: `${item.hoursSinceUpdate ?? 0} घंटे से कोई अपडेट नहीं`,
        PARTIALLY_DONE: 'आंशिक रूप से पूरा',
        AWAITING_DECISION: 'आपके निर्णय का इंतज़ार',
      }[r];
    }
    if (lang === 'HINGLISH') {
      return {
        OVERDUE: `${item.overdueDays} din late`,
        BEHIND: 'time se peeche',
        STUCK: `${item.hoursSinceUpdate ?? 0} ghante se update nahi`,
        PARTIALLY_DONE: 'aadha hua',
        AWAITING_DECISION: 'aapke decision ka intezaar',
      }[r];
    }
    return describeFollowUpReason(r, item).toLowerCase();
  };

  const doLines = summary.do.map((t) => `• [${tagOf(t)}] ${t.title} (due ${t.dueDate})`);
  const followLines = summary.followUp.map(
    (f) => `• [${tagOf(f.task)}] — ${nameOf(f.task.raci.R)} — ${f.reasons.map((r) => reasonWord(r, f)).join(', ')}`
  );

  if (lang === 'HINDI') {
    return [
      `☀️ नमस्ते ${staffAddressName(owner, 'HINDI')}, आज का सार:`,
      `आपके कार्य (${summary.counts.do}):`,
      ...(doLines.length ? doLines : ['• कोई नहीं']),
      `आपके निर्णय का इंतज़ार: ${summary.counts.decide}`,
      `फ़ॉलो-अप (${summary.counts.followUp}):`,
      ...(followLines.length ? followLines : ['• कोई नहीं']),
    ].join('\n');
  }
  if (lang === 'HINGLISH') {
    return [
      `☀️ Namaste ${staffAddressName(owner, 'HINGLISH')}, aaj ka summary:`,
      `Aapke tasks (${summary.counts.do}):`,
      ...(doLines.length ? doLines : ['• Koi nahi']),
      `Aapke decision ka intezaar: ${summary.counts.decide}`,
      `Follow up (${summary.counts.followUp}):`,
      ...(followLines.length ? followLines : ['• Koi nahi']),
    ].join('\n');
  }
  return [
    `☀️ Good morning ${staffAddressName(owner, 'ENGLISH')}, here is your summary:`,
    `Your tasks (${summary.counts.do}):`,
    ...(doLines.length ? doLines : ['• None']),
    `Decisions waiting for you: ${summary.counts.decide}`,
    `Follow up (${summary.counts.followUp}):`,
    ...(followLines.length ? followLines : ['• None']),
  ].join('\n');
}
