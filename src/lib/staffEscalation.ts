/**
 * Deterministic escalation detection, accountable routing, privacy scrubbing, and
 * single-language/script enforcement for staff WhatsApp replies.
 *
 * The AI model detects signals and drafts wording; code enforces the escalation
 * decision, org-chart routing, deduplication, privacy, and script consistency.
 */
import type {
  BossReviewItem,
  BossReviewType,
  BufferProcessAiResponse,
  EscalationSignal,
  OpsDatabaseState,
  OwnerProfileConfig,
  PreferredLanguage,
  SimulatedWhatsappMessage,
  Task,
  TeamMember,
} from '../types/ops.ts';
import { replacePhonesInText } from './phoneText.ts';
import { buildSlotDirectory, suggestAccountablePhone } from './promptBuilder.ts';
import { staffAddressName } from './staffNames.ts';
import { describeTaskTiming, formatDueLabel, formatDuration, getTaskDueInstantMs } from './taskTiming.ts';
import { stripWeaknessPhrases } from './weaknessPrivacy.ts';

const DEVANAGARI_RE = /[\u0900-\u097F]/;

export function hasDevanagariScript(text: unknown): boolean {
  return typeof text === 'string' && DEVANAGARI_RE.test(text);
}

/** Scrubs phone numbers and private weakness phrases from any outbound text. */
export function sanitizeOutboundText(
  text: string,
  roster: Iterable<TeamMember>
): string {
  const noPhones = replacePhonesInText(String(text || ''), [], '[number removed]');
  return stripWeaknessPhrases(noPhones, roster);
}

/**
 * Enforces that every outbound message to a person uses their single preferred
 * language AND script (HINGLISH = Roman only, HINDI = Devanagari only, ENGLISH = Roman/English only).
 */
export function enforceRecipientLanguageAndScript(params: {
  text: string;
  language: PreferredLanguage;
  fallbackText: string;
  roster?: Iterable<TeamMember>;
}): string {
  const raw = String(params.text || '').trim();
  const fallback = String(params.fallbackText || '').trim();
  let chosen = raw || fallback;

  if (params.language === 'HINGLISH' || params.language === 'ENGLISH') {
    if (hasDevanagariScript(chosen)) {
      chosen = fallback;
    }
  } else if (params.language === 'HINDI') {
    if (!hasDevanagariScript(chosen)) {
      chosen = fallback;
    }
  }

  return params.roster ? sanitizeOutboundText(chosen, params.roster) : chosen;
}

export function buildStaffNormalAck(params: {
  language: PreferredLanguage;
  recipient: (Pick<TeamMember, 'name' | 'preferredLanguage'> & { addressAs?: string | null }) | null | undefined;
}): string {
  const lang = params.language;
  if (lang === 'ENGLISH') {
    return `Thank you ${staffAddressName(params.recipient, 'ENGLISH', 'there')}, your update has been noted.`;
  }
  if (lang === 'HINDI') {
    return `धन्यवाद ${staffAddressName(params.recipient, 'HINDI', 'जी')}, आपका अपडेट नोट कर लिया गया है।`;
  }
  return `Shukriya ${staffAddressName(params.recipient, 'HINGLISH', 'ji')}, aapka update note kar liya gaya hai.`;
}

export function buildStaffEscalationAck(params: {
  language: PreferredLanguage;
  recipient: (Pick<TeamMember, 'name' | 'preferredLanguage'> & { addressAs?: string | null }) | null | undefined;
  accountableName: string;
  trigger: EscalationSignal;
}): string {
  const lang = params.language;
  const mgr = params.accountableName || (lang === 'HINDI' ? 'मैनेजर' : 'manager');
  if (lang === 'ENGLISH') {
    return `Thank you ${staffAddressName(params.recipient, 'ENGLISH', 'there')}, I've noted this and informed ${mgr} right away so they can decide the next step.`;
  }
  if (lang === 'HINDI') {
    return `ठीक है ${staffAddressName(params.recipient, 'HINDI', 'जी')}, आपकी बात नोट कर ली है और ${mgr} को तुरंत बता दिया गया है ताकि वे अगला कदम तय कर सकें।`;
  }
  return `Theek hai ${staffAddressName(params.recipient, 'HINGLISH', 'ji')}, aapki baat note kar li hai aur ${mgr} ko turant inform kar diya gaya hai taaki woh agla step decide kar sakein.`;
}

const ON_LEAVE_RE =
  /\b(on leave|chutti|chhutti|leave pe|leave par|bimaar|sick|hospital|out of town|travelling|traveling|unavailable|not available)\b/i;
const REFUSAL_RE =
  /\b(nahi ho payega|nahi kar paunga|nahi kar sakta|nahi hoga|can't do|cannot do|won't do|will not do|refuse|impossible|not possible|nahi ho sakta)\b/i;
const REASSIGN_RE =
  /\b(not my work|not my job|mera kaam nahi|kisi aur ko|someone else|give it to|assign to|dusre ko|doosre ko)\b/i;
const BLOCKER_RE =
  /\b(no material|out of stock|material nahi|samaan nahi|broken|kharab|not working|no access|locked|waiting on|waiting for)\b/i;
const CAPACITY_RE =
  /\b(too many tasks|overloaded|bahut kaam|zyada kaam|jyada kaam|full capacity|can't handle|cannot handle)\b/i;
const CONFUSION_RE =
  /\b(samajh nahi|samajh mein nahi|confused|still unclear|what to do|kya karna hai|kaise karu|kaise karna hai)\b/i;

function estimateReplyEtaMs(text: string, nowMs: number): number | null {
  const s = String(text || '').toLowerCase();
  const daysMatch = s.match(/\b(?:in\s+)?(\d+)\s*(?:din|day|days)\s*(?:baad|later)?\b/);
  if (daysMatch) {
    const days = Number(daysMatch[1]);
    if (Number.isFinite(days) && days >= 0) return nowMs + days * 86_400_000;
  }
  const weeksMatch = s.match(/\b(?:in\s+)?(\d+)\s*(?:hafte|week|weeks)\s*(?:baad|later)?\b/);
  if (weeksMatch) {
    const weeks = Number(weeksMatch[1]);
    if (Number.isFinite(weeks) && weeks >= 0) return nowMs + weeks * 7 * 86_400_000;
  }
  if (/\b(next week|agle hafte)\b/.test(s)) return nowMs + 7 * 86_400_000;
  if (/\b(parso|day after tomorrow)\b/.test(s)) return nowMs + 2 * 86_400_000;
  const isoMatch = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const parsed = Date.parse(`${isoMatch[1]}T23:59:00Z`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

export interface EscalationDecision {
  shouldEscalate: boolean;
  trigger: EscalationSignal;
  isUrgent: boolean;
  logDelayOnly: boolean;
  quote: string;
  reasonLabel: string;
  reviewType: BossReviewType;
}

/**
 * Deterministically evaluates whether a staff reply batch must escalate to the
 * task's Accountable person, weighing task urgency and deadline proximity.
 */
export function evaluateStaffReplyEscalation(params: {
  task: Task;
  batchText: string;
  aiResult: BufferProcessAiResponse;
  priorMessages: SimulatedWhatsappMessage[];
  employeePhone: string;
  nowMs: number;
  timezone?: string | null;
  allDone: boolean;
}): EscalationDecision {
  const { task, batchText, aiResult, priorMessages, employeePhone, nowMs, timezone, allDone } = params;
  const text = String(batchText || '').trim();
  const quote = (aiResult.staffQuote || text || '').trim().slice(0, 180);
  const timing = describeTaskTiming(task, nowMs, timezone, 24 * 60);
  const dueMs = getTaskDueInstantMs(task, timezone);
  const isNearOrUrgent =
    task.quadrant === 'Q1_DO_FIRST' ||
    timing.state === 'LATE' ||
    timing.state === 'DUE_SOON' ||
    (dueMs !== null && dueMs - nowMs <= 48 * 3_600_000);

  const hasPriorClarification = priorMessages.some(
    (m) =>
      m.direction === 'OUTBOUND' &&
      m.employeePhone === employeePhone &&
      m.taskCode === task.taskCode &&
      (m.tag === 'AI_CONFIRMATION' || m.tag === 'AI_BATCH_REPLY')
  );

  // 1. Check explicit or deterministic high-priority triggers (always escalate)
  let trigger: EscalationSignal = 'NONE';
  const aiSig = aiResult.escalationSignal;

  if (aiSig === 'ON_LEAVE' || ON_LEAVE_RE.test(text)) {
    trigger = 'ON_LEAVE';
  } else if (aiSig === 'REASSIGNMENT' || REASSIGN_RE.test(text)) {
    trigger = 'REASSIGNMENT';
  } else if (aiSig === 'REFUSAL' || REFUSAL_RE.test(text)) {
    trigger = 'REFUSAL';
  } else if (aiSig === 'BLOCKER' || BLOCKER_RE.test(text)) {
    trigger = 'BLOCKER';
  } else if (aiSig === 'CAPACITY' || CAPACITY_RE.test(text)) {
    trigger = 'CAPACITY';
  } else if (
    (aiSig === 'CONFUSION' || CONFUSION_RE.test(text)) &&
    hasPriorClarification
  ) {
    trigger = 'CONFUSION';
  } else if (!allDone) {
    const etaText = [aiResult.reportedEta || '', text].filter(Boolean).join(' ');
    const impliedEtaMs = estimateReplyEtaMs(etaText, nowMs);
    const slipsPastDeadline =
      dueMs !== null && impliedEtaMs !== null && impliedEtaMs > dueMs;
    const isExplicitSlip = aiSig === 'TIMELINE_SLIP' || slipsPastDeadline;

    if (isExplicitSlip) {
      // Non-urgent task with plenty of time (>72h) and ETA within deadline -> log only, no full escalation
      if (!isNearOrUrgent && !slipsPastDeadline && dueMs !== null && dueMs - nowMs > 72 * 3_600_000) {
        return {
          shouldEscalate: false,
          trigger: 'TIMELINE_SLIP',
          isUrgent: false,
          logDelayOnly: true,
          quote,
          reasonLabel: 'Timeline update logged (non-urgent, within deadline)',
          reviewType: 'BLOCKER_ESCALATION',
        };
      }
      if (slipsPastDeadline || isNearOrUrgent) {
        trigger = 'TIMELINE_SLIP';
      } else {
        return {
          shouldEscalate: false,
          trigger: 'TIMELINE_SLIP',
          isUrgent: false,
          logDelayOnly: true,
          quote,
          reasonLabel: 'Delay noted (non-urgent)',
          reviewType: 'BLOCKER_ESCALATION',
        };
      }
    } else if (aiResult.delayReported && !isNearOrUrgent && dueMs !== null && dueMs - nowMs > 72 * 3_600_000) {
      return {
        shouldEscalate: false,
        trigger: 'TIMELINE_SLIP',
        isUrgent: false,
        logDelayOnly: true,
        quote,
        reasonLabel: 'Timeline update logged (non-urgent, within deadline)',
        reviewType: 'BLOCKER_ESCALATION',
      };
    }
  }

  // Fallback to AI's explicit escalateToBossReview flag (e.g. budget/design/handover)
  if (trigger === 'NONE' && aiResult.escalateToBossReview) {
    return {
      shouldEscalate: true,
      trigger: 'BLOCKER',
      isUrgent: isNearOrUrgent,
      logDelayOnly: false,
      quote,
      reasonLabel: aiResult.englishBossSummary || 'Escalated for decision',
      reviewType: aiResult.reviewType || 'BLOCKER_ESCALATION',
    };
  }

  if (trigger === 'NONE') {
    return {
      shouldEscalate: false,
      trigger: 'NONE',
      isUrgent: isNearOrUrgent,
      logDelayOnly: false,
      quote,
      reasonLabel: '',
      reviewType: aiResult.reviewType || 'BLOCKER_ESCALATION',
    };
  }

  const reasonLabels: Record<EscalationSignal, string> = {
    NONE: '',
    ON_LEAVE: 'Staff is on leave / unavailable',
    REFUSAL: 'Staff reported they cannot / will not complete the task',
    TIMELINE_SLIP: 'Staff timeline slips past the task deadline',
    REASSIGNMENT: 'Staff requested reassignment / stated it is not their work',
    BLOCKER: 'Staff reported a blocker (missing material / equipment / access)',
    CAPACITY: 'Staff reported capacity overload',
    CONFUSION: 'Staff still confused after prior clarification',
    NO_RESPONSE: 'No response received before deadline threshold',
  };

  return {
    shouldEscalate: true,
    trigger,
    isUrgent: isNearOrUrgent,
    logDelayOnly: false,
    quote,
    reasonLabel: reasonLabels[trigger],
    reviewType: aiResult.reviewType || 'BLOCKER_ESCALATION',
  };
}

/**
 * Resolves the Accountable recipient for a task via the org chart (manager first,
 * then partner, then owner default, then any OWNER), never escalating into a vacuum.
 */
export function resolveAccountableRecipient(
  task: Pick<Task, 'raci'>,
  teamMembers: Record<string, TeamMember>,
  ownerProfile?: OwnerProfileConfig
): TeamMember | null {
  const members = Object.values(teamMembers || {});
  if (members.length === 0) return null;
  const dir = buildSlotDirectory(members, ownerProfile);

  // Explicit task.raci.A if valid and not the Responsible person (unless R is OWNER)
  const explicitA = task.raci?.A ? teamMembers[task.raci.A] : undefined;
  if (explicitA && (explicitA.phone !== task.raci?.R || explicitA.authorityLevel === 'OWNER')) {
    return explicitA;
  }

  const suggestedPhone = suggestAccountablePhone(
    task.raci?.R || '',
    dir,
    ownerProfile?.defaultAccountablePhone
  );
  if (suggestedPhone && teamMembers[suggestedPhone]) {
    return teamMembers[suggestedPhone];
  }

  return (
    members.find((m) => m.authorityLevel === 'OWNER') ||
    members.find((m) => m.authorityLevel === 'MANAGER') ||
    members[0] ||
    null
  );
}

/** Builds structured owner-facing escalation summary, suggested actions, and WhatsApp alert in Accountable's language. */
export function buildEscalationArtifacts(params: {
  task: Task;
  responsible: TeamMember | undefined;
  accountable: TeamMember | null;
  decision: EscalationDecision;
  teamMembers: Record<string, TeamMember>;
  nowMs: number;
  timezone?: string | null;
}): {
  summary: string;
  suggestedReplies: string[];
  ownerAlertText: string;
} {
  const { task, responsible, accountable, decision, teamMembers, nowMs, timezone } = params;
  const roster = Object.values(teamMembers || {});
  const tag = task.shortTag || task.taskCode;
  const staffName = responsible?.name || 'Team member';
  const timing = describeTaskTiming(task, nowMs, timezone);
  const dueStr = formatDueLabel(task) || 'unspecified';
  const timingStr =
    timing.state === 'LATE'
      ? `overdue by ${formatDuration(timing.minutesLate)}`
      : timing.state === 'NO_DUE'
        ? 'no due time'
        : `due in ${formatDuration(timing.minutesLeft)}`;
  const urgentPrefix = decision.isUrgent ? '[URGENT] ' : '';

  const backupPhone = (responsible?.worksCloselyWithPhones || []).find(
    (p) => p !== responsible?.phone && teamMembers[p] && !teamMembers[p].isOnLeave
  );
  const backupName = backupPhone ? teamMembers[backupPhone].name : null;

  const summary = sanitizeOutboundText(
    `${urgentPrefix}[${tag}] ${task.title} — ${staffName}: ${decision.reasonLabel}` +
      (decision.quote ? ` ("${decision.quote}")` : '') +
      `. Deadline: ${dueStr} (${timingStr}).`,
    roster
  );

  const suggestedReplies = [
    backupName
      ? `Reassign [${tag}] to backup ${backupName} immediately.`
      : `Reassign [${tag}] to an available team member.`,
    `Handle [${tag}] directly or approve overtime/external support.`,
    `Cancel or reschedule [${tag}] and notify the client/team.`,
  ].map((s) => sanitizeOutboundText(s, roster));

  const lang: PreferredLanguage = accountable?.preferredLanguage || 'ENGLISH';
  const addr = staffAddressName(accountable, lang, lang === 'HINDI' ? 'जी' : lang === 'HINGLISH' ? 'ji' : 'Hello');
  let alertRaw: string;
  if (lang === 'HINDI') {
    alertRaw = [
      `🚨 ${decision.isUrgent ? 'ज़रूरी ' : ''}${addr}, [${tag}] (${staffName}) पर ध्यान चाहिए।`,
      `कारण: ${decision.reasonLabel}${decision.quote ? ` ("${decision.quote}")` : ''}`,
      `समय सीमा: ${dueStr} (${timingStr})`,
      `सुझाव: 1) ${suggestedReplies[0]} 2) ${suggestedReplies[1]}`,
    ].join('\n');
  } else if (lang === 'HINGLISH') {
    alertRaw = [
      `🚨 ${decision.isUrgent ? 'URGENT ' : ''}${addr}, [${tag}] (${staffName}) par aapka decision chahiye.`,
      `Reason: ${decision.reasonLabel}${decision.quote ? ` ("${decision.quote}")` : ''}`,
      `Deadline: ${dueStr} (${timingStr})`,
      `Next step: 1) ${suggestedReplies[0]} 2) ${suggestedReplies[1]}`,
    ].join('\n');
  } else {
    alertRaw = [
      `🚨 ${decision.isUrgent ? 'URGENT ' : ''}${addr}, [${tag}] (${staffName}) needs your decision.`,
      `Reason: ${decision.reasonLabel}${decision.quote ? ` ("${decision.quote}")` : ''}`,
      `Deadline: ${dueStr} (${timingStr})`,
      `Next step: 1) ${suggestedReplies[0]} 2) ${suggestedReplies[1]}`,
    ].join('\n');
  }

  return {
    summary,
    suggestedReplies,
    ownerAlertText: sanitizeOutboundText(alertRaw, roster),
  };
}

/**
 * Upserts a BossReviewItem (deduplicated per open task so we never spam duplicate
 * open escalations for the same task) and returns the updated queue + reviewId.
 */
export function upsertOpenEscalationReview(params: {
  queue: BossReviewItem[];
  taskCode: string;
  employeePhone: string;
  routedToPhone?: string;
  trigger: EscalationSignal;
  isUrgent: boolean;
  reviewType: BossReviewType;
  summary: string;
  mediaVerificationNote: string;
  suggestedReplies: string[];
  nowIso: string;
}): { nextQueue: BossReviewItem[]; reviewId: string; isNew: boolean } {
  const existingIdx = params.queue.findIndex(
    (r) => r.taskCode === params.taskCode && r.status === 'OPEN'
  );
  if (existingIdx >= 0) {
    const existing = params.queue[existingIdx];
    const updated: BossReviewItem = {
      ...existing,
      routedToPhone: params.routedToPhone || existing.routedToPhone,
      trigger: params.trigger,
      isUrgent: existing.isUrgent || params.isUrgent,
      reviewType: params.reviewType,
      employeeMessageSummary: params.summary,
      mediaVerificationNote: params.mediaVerificationNote,
      aiSuggestedReplies: params.suggestedReplies,
    };
    const nextQueue = [...params.queue];
    nextQueue[existingIdx] = updated;
    return { nextQueue, reviewId: existing.reviewId, isNew: false };
  }

  const reviewId = `REV-${Date.now().toString().slice(-4)}`;
  const created: BossReviewItem = {
    reviewId,
    taskCode: params.taskCode,
    employeePhone: params.employeePhone,
    routedToPhone: params.routedToPhone,
    trigger: params.trigger,
    isUrgent: params.isUrgent,
    reviewType: params.reviewType,
    employeeMessageSummary: params.summary,
    mediaVerificationNote: params.mediaVerificationNote,
    aiSuggestedReplies: params.suggestedReplies,
    status: 'OPEN',
    createdAt: params.nowIso,
  };
  return { nextQueue: [created, ...params.queue], reviewId, isNew: true };
}
