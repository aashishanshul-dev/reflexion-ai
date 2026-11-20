/**
 * Batch 3 — the owner on WhatsApp. Owners who work from their phone get decision
 * prompts in their own chat and answer them with "1", "2" or "3"; "brief" sends
 * today's summary; any other note goes to Meditate to be planned. The reply
 * parsing is deterministic code (language words only, no business words).
 */
import type { BossReviewItem, OpsDatabaseState, PreferredLanguage, TeamMember } from '../types/ops.ts';
import { buildMyTasks, buildOwnerDigestText, getOwnerPhones } from './myTasks.ts';
import { resolveBossReviewItem } from './opsEngine.ts';
import { getZonedDateParts } from './releaseEngine.ts';
import { staffAddressName } from './staffNames.ts';
import { resolveAccountableRecipient, sanitizeOutboundText } from './staffEscalation.ts';

const DEFAULT_TENANT = 'default';

export type OwnerWhatsappAction =
  | { kind: 'DECIDE'; reviewId: string; optionIndex: number }
  | { kind: 'BRIEF' }
  | { kind: 'PLAN'; text: string }
  | { kind: 'NO_DECISION_WAITING' }
  | { kind: 'NONE' };

const BRIEF_WORDS =
  /^(brief|summary|update|status|today|my tasks|aaj ka (brief|summary|update|kaam)|aaj kya hai|आज का (सार|अपडेट|काम))[\s.!?]*$/i;

/** Open decisions, oldest first. */
export function openReviewsOldestFirst(reviews: BossReviewItem[]): BossReviewItem[] {
  return (reviews || [])
    .filter((r) => r.status === 'OPEN')
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

/**
 * What an owner's WhatsApp message means:
 * "1"/"2"/"3" (or "REV-301 2") answers a waiting decision; "brief" asks for today's
 * summary; anything else is a note to plan in Meditate.
 */
export function parseOwnerWhatsappMessage(text: unknown, openReviews: BossReviewItem[]): OwnerWhatsappAction {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return { kind: 'NONE' };
  const open = openReviewsOldestFirst(openReviews);

  const targeted = t.match(/^(REV-[\w-]+)\s*[:\-–]?\s*([1-3])\s*[.)!✅👍]*$/i);
  if (targeted) {
    const review = open.find((r) => r.reviewId.toUpperCase() === targeted[1].toUpperCase());
    return review
      ? { kind: 'DECIDE', reviewId: review.reviewId, optionIndex: Number(targeted[2]) - 1 }
      : { kind: 'NO_DECISION_WAITING' };
  }
  const bare = t.match(/^(?:option\s*|opt\s*|#)?([1-3])\s*[.)!✅👍]*$/i);
  if (bare) {
    return open.length > 0
      ? { kind: 'DECIDE', reviewId: open[0].reviewId, optionIndex: Number(bare[1]) - 1 }
      : { kind: 'NO_DECISION_WAITING' };
  }
  if (BRIEF_WORDS.test(t)) return { kind: 'BRIEF' };
  return { kind: 'PLAN', text: t };
}

/** The decision prompt the owner gets on WhatsApp, with numbered answers. */
export function buildOwnerDecisionPrompt(params: {
  review: BossReviewItem;
  tag: string;
  staffName: string;
  owner: Pick<TeamMember, 'name' | 'preferredLanguage'> & { addressAs?: string };
}): string {
  const lang: PreferredLanguage = params.owner.preferredLanguage || 'ENGLISH';
  const options = (params.review.aiSuggestedReplies || []).slice(0, 3);
  const head =
    lang === 'ENGLISH'
      ? `🟠 Decision needed [${params.review.reviewId}] — [${params.tag}] (${params.staffName})`
      : lang === 'HINDI'
        ? `🟠 फ़ैसला चाहिए [${params.review.reviewId}] — [${params.tag}] (${params.staffName})`
        : `🟠 Decision chahiye [${params.review.reviewId}] — [${params.tag}] (${params.staffName})`;
  const replyWord = lang === 'ENGLISH' ? 'Reply' : lang === 'HINDI' ? 'जवाब' : 'Jawab';
  return [head, params.review.employeeMessageSummary, ...options.map((o, i) => `${replyWord} ${i + 1}: ${o}`)].join('\n');
}

/** Sends a decision prompt to the Accountable person (manager first, else owner) for every open decision not yet sent. */
export function sendOwnerDecisionPrompts(
  state: OpsDatabaseState,
  nowIso: string
): { nextState: OpsDatabaseState; sentReviewIds: string[] } {
  const owners = getOwnerPhones(state.team_members)
    .map((p) => state.team_members[p])
    .filter((m): m is TeamMember => Boolean(m));
  const roster = Object.values(state.team_members || {});
  const alreadySent = new Set(
    (state.whatsapp_messages || []).filter((m) => m.tag === 'OWNER_DECISION_PROMPT').map((m) => m.id)
  );
  const newMessages: OpsDatabaseState['whatsapp_messages'] = [];
  const sentReviewIds: string[] = [];
  for (const review of openReviewsOldestFirst(state.boss_review_queue)) {
    const task = state.tasks.find((t) => t.taskCode === review.taskCode);
    const routedMember = review.routedToPhone ? state.team_members[review.routedToPhone] : undefined;
    const recipients: TeamMember[] = routedMember ? [routedMember] : owners;
    if (recipients.length === 0) continue;

    let sentAny = false;
    for (const recipient of recipients) {
      const id = `wa-decide-${review.reviewId}-${recipient.phone}`;
      if (alreadySent.has(id)) continue;
      newMessages.push({
        tenantId: state.tenantId || DEFAULT_TENANT,
        id,
        employeePhone: recipient.phone,
        direction: 'OUTBOUND',
        timestamp: nowIso,
        tag: 'OWNER_DECISION_PROMPT',
        taskCode: review.taskCode,
        text: sanitizeOutboundText(
          buildOwnerDecisionPrompt({
            review,
            tag: task?.shortTag || review.taskCode,
            staffName: state.team_members[review.employeePhone]?.name || 'Team member',
            owner: recipient,
          }),
          roster
        ),
      });
      sentAny = true;
    }
    if (sentAny) sentReviewIds.push(review.reviewId);
  }
  if (newMessages.length === 0) return { nextState: state, sentReviewIds };
  return { nextState: { ...state, whatsapp_messages: [...state.whatsapp_messages, ...newMessages] }, sentReviewIds };
}

function ownerReply(state: OpsDatabaseState, ownerPhone: string, nowIso: string, text: string, tag: string) {
  return {
    tenantId: state.tenantId || DEFAULT_TENANT,
    id: `wa-owner-${tag.toLowerCase()}-${Date.parse(nowIso) || Date.now()}`,
    employeePhone: ownerPhone,
    direction: 'OUTBOUND' as const,
    timestamp: nowIso,
    tag,
    text,
  };
}

/**
 * Handles one message the owner sends on WhatsApp. Logs it in the owner's chat,
 * then decides a waiting approval, sends today's brief, or hands the note to Meditate
 * (returned as `planText`; the app runs Meditate with it).
 */
export function handleOwnerWhatsappMessage(
  state: OpsDatabaseState,
  ownerPhone: string,
  text: string,
  nowIso: string = new Date().toISOString()
): { nextState: OpsDatabaseState; action: OwnerWhatsappAction; planText?: string } {
  const owner = state.team_members[ownerPhone];
  // Only an owner's own chat can decide approvals; staff messages are data (rule 5).
  if (!owner || (owner.authorityLevel !== 'OWNER' && owner.authorityLevel !== 'BOSS')) {
    return { nextState: state, action: { kind: 'NONE' } };
  }
  const lang = owner.preferredLanguage || 'ENGLISH';
  const action = parseOwnerWhatsappMessage(text, state.boss_review_queue);
  if (action.kind === 'NONE') return { nextState: state, action };

  const inbound = {
    tenantId: state.tenantId || DEFAULT_TENANT,
    id: `wa-owner-in-${Date.parse(nowIso) || Date.now()}`,
    employeePhone: ownerPhone,
    direction: 'INBOUND' as const,
    timestamp: nowIso,
    text: text.trim(),
  };
  let next: OpsDatabaseState = { ...state, whatsapp_messages: [...state.whatsapp_messages, inbound] };
  const say = (msg: string, tag: string) => {
    next = { ...next, whatsapp_messages: [...next.whatsapp_messages, ownerReply(next, ownerPhone, nowIso, msg, tag)] };
  };

  if (action.kind === 'DECIDE') {
    const review = next.boss_review_queue.find((r) => r.reviewId === action.reviewId)!;
    const choice = review.aiSuggestedReplies?.[action.optionIndex];
    if (!choice) {
      say(
        lang === 'ENGLISH'
          ? `There is no option ${action.optionIndex + 1} for ${review.reviewId}. Reply 1–${review.aiSuggestedReplies.length}.`
          : `${review.reviewId} ke liye option ${action.optionIndex + 1} nahi hai. 1–${review.aiSuggestedReplies.length} mein se jawab dein.`,
        'OWNER_DECISION_ERROR'
      );
      return { nextState: next, action };
    }
    next = resolveBossReviewItem(next, review.reviewId, choice, true, nowIso);
    const staff = next.team_members[review.employeePhone]?.name || 'the team member';
    say(
      lang === 'ENGLISH'
        ? `✅ ${review.reviewId} decided: "${choice}" ${staff} has been told.`
        : `✅ ${review.reviewId} ka faisla: "${choice}" ${staff} ko bata diya hai.`,
      'OWNER_DECISION_DONE'
    );
    return { nextState: next, action };
  }

  if (action.kind === 'NO_DECISION_WAITING') {
    say(lang === 'ENGLISH' ? 'No decisions are waiting right now.' : 'Abhi koi faisla baaki nahi hai.', 'OWNER_INFO');
    return { nextState: next, action };
  }

  if (action.kind === 'BRIEF') {
    const tz = next.business_profile?.timezone;
    const nowMs = Date.parse(nowIso);
    const summary = buildMyTasks(next, {
      nowIso,
      todayStr: getZonedDateParts(Number.isNaN(nowMs) ? Date.now() : nowMs, tz).dateStr,
      timezone: tz,
    });
    say(
      buildOwnerDigestText(summary, owner, next.team_members) ||
        (lang === 'ENGLISH'
          ? `${staffAddressName(owner, 'ENGLISH')}, nothing needs you right now.`
          : `${staffAddressName(owner, lang)}, abhi aapke liye kuch baaki nahi hai.`),
      'DAILY_DIGEST'
    );
    return { nextState: next, action };
  }

  // PLAN: Meditate drafts it; the owner approves in the app.
  say(
    lang === 'ENGLISH'
      ? '📝 Got it. Planning this now — the draft will be in Meditate for you to approve.'
      : '📝 Mil gaya. Iska plan bana rahe hain — draft Meditate mein approve karne ke liye milega.',
    'OWNER_NOTE_TO_MEDITATE'
  );
  return { nextState: next, action, planText: action.text };
}
