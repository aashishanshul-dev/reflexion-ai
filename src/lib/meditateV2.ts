import { isTaskClosed } from './releaseEngine.ts';
import type {
  BusinessProfileConfig,
  CategorySop,
  Classification,
  MeditateAiResponse,
  MeditateConfirmChip,
  MeditateIntentStageOutput,
  MeditateV2IntentKind,
  MeditateV2Lane,
  MeditateV2RouteOutcome,
  OwnerProfileConfig,
  PrincipalPrompts,
  Quadrant,
  RecurrenceRule,
  SampleBrainDumpItem,
  SystemMemoryCategory,
  SystemMemoryRule,
  Task,
  TaskFrequency,
  TaskSplittingConfig,
  TeamMember,
  WbsHead,
} from '../types/ops.ts';
import { computeDueDate, computeStartDateFromDeadline } from './opsEngine.ts';
import {
  anonymizeActiveHeadForPrompt,
  buildRosterLine,
  buildSlotDirectory,
  buildTaskTypeLine,
  countOpenTasksByPhone,
  RESPONSIBLE_SELECTION_RULES,
  ACCOUNTABLE_SELECTION_RULE,
  buildOwnerReaderLine,
  capConversationHistory,
  MAX_CONVERSATION_TURNS_CAP,
  PROMPT_VERSION,
  restoreDisplayNamesFromSlots,
  scrubPiiToSlots,
  type SlotDirectory,
  verifyZeroPiiInPrompt,
  OWNER_EDIT_REFINEMENT_RULES,
} from './promptBuilder.ts';
import { PLAN_ORDER_RULES } from './planOrder.ts';

export const DEFAULT_INTENT_CONFIDENCE_THRESHOLD = 0.75;

export const MEDITATE_CONFIRM_CHIPS: MeditateConfirmChip[] = [
  { label: 'Make it a task', kind: 'TASK' },
  { label: 'Save as note', kind: 'NOTE' },
  { label: 'Add as rule', kind: 'RULE' },
  { label: 'Just chatting', kind: 'CASUAL' },
];

const WEEKDAY_LOOKUP: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * Normalizes and clamps the configurable Meditate v2 intent confidence threshold (default 0.75).
 */
export function resolveIntentConfidenceThreshold(threshold?: number | null): number {
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    return DEFAULT_INTENT_CONFIDENCE_THRESHOLD;
  }
  return Math.max(0, Math.min(1, Number(threshold.toFixed(2))));
}

/**
 * Ensures TASK requests with missingCritical ask ONE combined question without planning.
 */
export function buildCombinedClarifyingQuestion(
  missingCritical: string[],
  modelReply?: string | null
): string {
  const cleanedItems = (missingCritical || [])
    .map((m) => String(m || '').trim().replace(/[?.!]+$/, ''))
    .filter(Boolean);

  const trimmedReply = typeof modelReply === 'string' ? modelReply.trim() : '';
  const questionMarkCount = (trimmedReply.match(/\?/g) || []).length;

  // If the model already produced a single concise question, preserve it
  if (trimmedReply && questionMarkCount === 1) {
    return trimmedReply;
  }

  if (cleanedItems.length === 0) {
    return trimmedReply
      ? `${trimmedReply.replace(/[?.!]+$/, '')}?`
      : 'Could you share the missing details needed before staging this task?';
  }

  if (cleanedItems.length === 1) {
    return `Before staging this task, could you confirm ${cleanedItems[0]}?`;
  }

  const allButLast = cleanedItems.slice(0, -1).join(', ');
  const last = cleanedItems[cleanedItems.length - 1];
  return `Before staging this task, could you confirm ${allButLast} and ${last}?`;
}

/**
 * Pure router for Meditate v2 INTENT stage output.
 * - Confidence below threshold (without explicit owner chip confirmation) -> confirm chips
 * - TASK with missingCritical -> ONE combined question, no planning
 * - TASK without missingCritical -> RUN_PLANNER
 * - NOTE -> SAVE_NOTE
 * - RULE -> STAGE_PENDING_RULE (approved=false)
 * - QUESTION -> ANSWER_QUESTION
 * - CASUAL -> CASUAL_REPLY
 */
export function routeMeditateV2Intent(
  intent: MeditateIntentStageOutput,
  options?: {
    confidenceThreshold?: number | null;
    confirmedKind?: MeditateV2IntentKind | null;
  }
): {
  route: MeditateV2RouteOutcome;
  effectiveKind: MeditateV2IntentKind;
  confirmChips: MeditateConfirmChip[];
  replyToOwner: string;
} {
  const threshold = resolveIntentConfidenceThreshold(options?.confidenceThreshold);
  const confirmedKind = options?.confirmedKind || null;

  if (!confirmedKind && intent.confidence < threshold) {
    const baseReply = intent.replyToOwner?.trim()
      ? `${intent.replyToOwner.trim()}\n\nHow would you like me to handle this?`
      : 'I want to make sure I handle this the way you intend — please choose an option below:';
    return {
      route: 'AWAIT_OWNER_CONFIRMATION',
      effectiveKind: intent.kind,
      confirmChips: [...MEDITATE_CONFIRM_CHIPS],
      replyToOwner: baseReply,
    };
  }

  const effectiveKind: MeditateV2IntentKind = confirmedKind || intent.kind;
  const missing = Array.isArray(intent.missingCritical)
    ? intent.missingCritical.map((s) => s.trim()).filter(Boolean)
    : [];

  if (effectiveKind === 'TASK') {
    if (missing.length > 0) {
      return {
        route: 'ASK_CLARIFYING_QUESTION',
        effectiveKind: 'TASK',
        confirmChips: [],
        replyToOwner: buildCombinedClarifyingQuestion(missing, intent.replyToOwner),
      };
    }
    return {
      route: 'RUN_PLANNER',
      effectiveKind: 'TASK',
      confirmChips: [],
      replyToOwner: intent.replyToOwner || '',
    };
  }

  if (effectiveKind === 'NOTE') {
    return {
      route: 'SAVE_NOTE',
      effectiveKind: 'NOTE',
      confirmChips: [],
      replyToOwner:
        intent.replyToOwner?.trim() || 'Saved this to your Notes list in Meditate Studio.',
    };
  }

  if (effectiveKind === 'RULE') {
    return {
      route: 'STAGE_PENDING_RULE',
      effectiveKind: 'RULE',
      confirmChips: [],
      replyToOwner:
        intent.replyToOwner?.trim() ||
        'Added as a pending rule (approved=false). You can review and approve it in AI Brain & Setup → System Memory.',
    };
  }

  if (effectiveKind === 'QUESTION') {
    return {
      route: 'ANSWER_QUESTION',
      effectiveKind: 'QUESTION',
      confirmChips: [],
      replyToOwner: intent.replyToOwner?.trim() || '',
    };
  }

  return {
    route: 'CASUAL_REPLY',
    effectiveKind: 'CASUAL',
    confirmChips: [],
    replyToOwner: intent.replyToOwner?.trim() || 'Understood.',
  };
}

function parseUtcCalendarDate(isoOrDate?: string): { y: number; m: number; d: number } {
  const fallback = new Date().toISOString().slice(0, 10);
  const datePart = (isoOrDate || fallback).slice(0, 10);
  const match = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    const now = new Date();
    return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
  }
  return {
    y: Number.parseInt(match[1], 10),
    m: Number.parseInt(match[2], 10),
    d: Number.parseInt(match[3], 10),
  };
}

function formatUtcDate(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addUtcDays(baseYmd: string, deltaDays: number): string {
  const { y, m, d } = parseUtcCalendarDate(baseYmd);
  const ms = Date.UTC(y, m - 1, d) + Math.round(deltaDays) * 86_400_000;
  return formatUtcDate(ms);
}

function diffUtcDays(startYmd: string, endYmd: string): number {
  const a = parseUtcCalendarDate(startYmd);
  const b = parseUtcCalendarDate(endYmd);
  const msA = Date.UTC(a.y, a.m - 1, a.d);
  const msB = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((msB - msA) / 86_400_000);
}

function isValidIsoDateString(val: unknown): val is string {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val.trim());
}

/**
 * Short tags staff see in brackets: code-style tags from the AI ("FIRST_DELIVERY")
 * become words ("First Delivery"); anything else is kept as written.
 */
export function readableShortTag(tag: string): string {
  const t = String(tag || '').trim();
  if (!/^[A-Z0-9]+(?:[_-][A-Z0-9]+)+$/.test(t)) return t;
  return t
    .split(/[_-]+/)
    .map((w) => (/^\d+$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * Pure deterministic date converter for natural planner dueHint strings
 * (e.g. "before Friday", "by Monday", "tomorrow", "in 3 days", "before 5 PM", "2026-11-15").
 */
export function parseDueHintToDate(
  dueHint: string | null | undefined,
  referenceDateIso: string = new Date().toISOString().slice(0, 10)
): {
  dueDate: string | null;
  offsetDays: number | null;
  isForcedDeadline: boolean;
} {
  if (!dueHint || typeof dueHint !== 'string' || !dueHint.trim()) {
    return { dueDate: null, offsetDays: null, isForcedDeadline: false };
  }

  const refParts = parseUtcCalendarDate(referenceDateIso);
  const refMs = Date.UTC(refParts.y, refParts.m - 1, refParts.d);
  const refYmd = formatUtcDate(refMs);
  const refDow = new Date(refMs).getUTCDay();

  const hint = dueHint.trim().toLowerCase();
  const hasDeadlineMarker =
    /\b(before|by|cutoff|deadline|urgent|asap|immediately|eod|end of day|sharp)\b/.test(hint);
  const hasTimeOfDay =
    /\b(morning|afternoon|evening|night|noon|lunch|breakfast|dinner|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/.test(
      hint
    );

  // 1. Explicit YYYY-MM-DD in hint
  const isoMatch = hint.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const rawIso = isoMatch[1];
    const isStrictlyBeforeDate =
      new RegExp(`\\bbefore\\s+${rawIso}\\b`).test(hint) && !hasTimeOfDay;
    let resolved = isStrictlyBeforeDate ? addUtcDays(rawIso, -1) : rawIso;
    if (diffUtcDays(refYmd, resolved) < 0 && isStrictlyBeforeDate) {
      resolved = refYmd;
    }
    return {
      dueDate: resolved,
      offsetDays: Math.max(0, diffUtcDays(refYmd, resolved)),
      isForcedDeadline: isStrictlyBeforeDate || hasDeadlineMarker,
    };
  }

  // 2. "day after tomorrow"
  if (/\bday\s+after\s+tomorrow\b/.test(hint)) {
    const dueDate = addUtcDays(refYmd, 2);
    return { dueDate, offsetDays: 2, isForcedDeadline: hasDeadlineMarker };
  }

  // 3. "tomorrow"
  if (/\btomorrow\b/.test(hint)) {
    const dueDate = addUtcDays(refYmd, 1);
    return {
      dueDate,
      offsetDays: 1,
      isForcedDeadline: hasDeadlineMarker || hasTimeOfDay,
    };
  }

  // 4. "today" / "tonight" / "eod" / "asap" / "immediately" / "right now"
  if (/\b(today|tonight|eod|end\s+of\s+day|asap|immediately|right\s+now)\b/.test(hint)) {
    return {
      dueDate: refYmd,
      offsetDays: 0,
      isForcedDeadline: hasDeadlineMarker || /\b(tonight|asap|immediately|right\s+now)\b/.test(hint),
    };
  }

  // 5. "in N day(s)" / "within N day(s)" / "after N day(s)"
  const relDaysMatch = hint.match(/\b(?:in|within|after)\s+(\d+)\s+days?\b/);
  if (relDaysMatch) {
    const days = Math.max(0, Number.parseInt(relDaysMatch[1], 10));
    const dueDate = addUtcDays(refYmd, days);
    return { dueDate, offsetDays: days, isForcedDeadline: /\bwithin\b/.test(hint) || hasDeadlineMarker };
  }

  // 6. "in N week(s)" / "within N week(s)"
  const relWeeksMatch = hint.match(/\b(?:in|within|after)\s+(\d+)\s+weeks?\b/);
  if (relWeeksMatch) {
    const days = Math.max(0, Number.parseInt(relWeeksMatch[1], 10) * 7);
    const dueDate = addUtcDays(refYmd, days);
    return { dueDate, offsetDays: days, isForcedDeadline: /\bwithin\b/.test(hint) || hasDeadlineMarker };
  }

  // 7. "next week"
  if (/\bnext\s+week\b/.test(hint)) {
    const dueDate = addUtcDays(refYmd, 7);
    return { dueDate, offsetDays: 7, isForcedDeadline: hasDeadlineMarker };
  }

  // 8. "end of week" / "this week"
  if (/\b(end\s+of\s+(?:the\s+)?week|this\s+week)\b/.test(hint)) {
    const daysToFriday = refDow <= 5 ? 5 - refDow : 1;
    const dueDate = addUtcDays(refYmd, daysToFriday);
    return { dueDate, offsetDays: daysToFriday, isForcedDeadline: hasDeadlineMarker };
  }

  // 9. Named weekday (e.g. "before Friday", "by Monday", "on Wednesday", "Friday")
  const weekdayRegex =
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/;
  const wdMatch = hint.match(weekdayRegex);
  if (wdMatch) {
    const wdToken = wdMatch[1];
    const targetDow = WEEKDAY_LOOKUP[wdToken];
    let daysAhead = (targetDow - refDow + 7) % 7;
    if (daysAhead === 0) {
      const isExplicitThis = /\bthis\s+/.test(hint) && !/\bbefore\b/.test(hint);
      daysAhead = isExplicitThis ? 0 : 7;
    }

    const beforeWeekdayRe = new RegExp(
      `\\bbefore\\s+(?:this\\s+|next\\s+)?${wdToken}\\b`
    );
    const isStrictlyBeforeWeekday = beforeWeekdayRe.test(hint) && !hasTimeOfDay;

    if (isStrictlyBeforeWeekday) {
      daysAhead = Math.max(0, daysAhead - 1);
    }

    const dueDate = addUtcDays(refYmd, daysAhead);
    return {
      dueDate,
      offsetDays: daysAhead,
      isForcedDeadline: isStrictlyBeforeWeekday || hasDeadlineMarker,
    };
  }

  // 10. Same-day time-of-day hints (e.g. "before 5 PM", "before lunch", "this evening")
  if (hasTimeOfDay) {
    return {
      dueDate: refYmd,
      offsetDays: 0,
      isForcedDeadline: hasDeadlineMarker,
    };
  }

  return { dueDate: null, offsetDays: null, isForcedDeadline: false };
}

const VALID_QUADRANTS = new Set<Quadrant>([
  'Q1_DO_FIRST',
  'Q2_SCHEDULE',
  'Q3_DELEGATE',
  'Q4_LOW',
]);

const VALID_SIZES = new Set<Classification>(['MAJOR', 'MINOR']);

const VALID_FREQUENCIES = new Set<TaskFrequency>(['ONE_TIME', 'RECURRING']);

const VALID_RECURRENCE = new Set<RecurrenceRule>(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY']);

/**
 * Deterministically converts planner dueHints to dates and fills defaults for nullable
 * dates, durations, quadrant, and size without touching RACI R, categories, stages, or step counts.
 */
export function hydratePlannerDefaults(
  rawPlan: unknown,
  options: {
    referenceDate?: string;
    categorySops?: CategorySop[];
  } = {}
): any {
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    return rawPlan;
  }

  const plan: any = structuredClone(rawPlan);
  const refYmd = (options.referenceDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const sopMap = new Map<string, CategorySop>();
  for (const sop of options.categorySops || []) {
    if (sop?.categoryId) {
      sopMap.set(sop.categoryId.trim(), sop);
    }
  }

  const lane: MeditateV2Lane =
    plan.lane === 'PROJECT' ? 'PROJECT' : plan.lane === 'QUICK' ? 'QUICK' : 'QUICK';
  plan.lane = lane;
  plan.intentClassification = plan.intentClassification || 'ACTIONABLE_AGENDA';
  plan.suggestedMemoryRules = Array.isArray(plan.suggestedMemoryRules)
    ? plan.suggestedMemoryRules
    : [];

  if (Array.isArray(plan.draftedTasks)) {
    plan.draftedTasks = plan.draftedTasks.map((task: any) => {
      if (!task || typeof task !== 'object') return task;

      const sop = typeof task.categoryId === 'string' ? sopMap.get(task.categoryId.trim()) : undefined;
      const hintParsed = parseDueHintToDate(task.dueHint, refYmd);

      const durationDays =
        typeof task.durationDays === 'number' && Number.isFinite(task.durationDays) && task.durationDays > 0
          ? task.durationDays
          : 1;

      const explicitDue = isValidIsoDateString(task.dueDate) ? task.dueDate.trim() : null;
      const explicitStart = isValidIsoDateString(task.startDate) ? task.startDate.trim() : null;

      const isForcedDeadline =
        typeof task.isForcedDeadline === 'boolean'
          ? task.isForcedDeadline
          : hintParsed.isForcedDeadline;

      let startDate = explicitStart || refYmd;
      let dueDate = explicitDue || hintParsed.dueDate || null;

      if (dueDate && !explicitStart && durationDays > 1) {
        const backStart = computeStartDateFromDeadline(dueDate, durationDays);
        startDate = diffUtcDays(refYmd, backStart) >= 0 ? backStart : refYmd;
      }

      if (!dueDate) {
        if (typeof task.dueDateOffsetDays === 'number' && Number.isFinite(task.dueDateOffsetDays)) {
          dueDate = addUtcDays(refYmd, Math.max(0, task.dueDateOffsetDays));
        } else {
          dueDate = computeDueDate(startDate, durationDays);
        }
      }

      const dueDateOffsetDays = Math.max(0, diffUtcDays(refYmd, dueDate));
      const forcedDeadlineDate = isForcedDeadline
        ? isValidIsoDateString(task.forcedDeadlineDate)
          ? task.forcedDeadlineDate.trim()
          : dueDate
        : null;

      const majorOrMinor: Classification = VALID_SIZES.has(task.majorOrMinor)
        ? task.majorOrMinor
        : sop?.defaultClassification || 'MINOR';

      const quadrant: Quadrant = VALID_QUADRANTS.has(task.quadrant)
        ? task.quadrant
        : isForcedDeadline && dueDateOffsetDays <= 1
          ? 'Q1_DO_FIRST'
          : 'Q2_SCHEDULE';

      const taskFrequency: TaskFrequency = VALID_FREQUENCIES.has(task.taskFrequency)
        ? task.taskFrequency
        : 'ONE_TIME';

      const recurrenceRule: RecurrenceRule =
        taskFrequency === 'RECURRING'
          ? VALID_RECURRENCE.has(task.recurrenceRule) && task.recurrenceRule !== 'NONE'
            ? task.recurrenceRule
            : 'DAILY'
          : 'NONE';

      const triggerCondition =
        task.triggerCondition === 'PARTIAL_OR_BOSS_APPROVAL'
          ? 'PARTIAL_OR_BOSS_APPROVAL'
          : 'FULL_COMPLETION';

      const titleStr = typeof task.title === 'string' ? task.title.trim() : '';
      const shortTag =
        typeof task.shortTag === 'string' && task.shortTag.trim()
          ? readableShortTag(task.shortTag)
          : titleStr.split(/[:\-–]/)[0]?.trim()?.slice(0, 24) || 'Task';

      return {
        ...task,
        title: titleStr,
        shortTag,
        quadrant,
        majorOrMinor,
        taskFrequency,
        recurrenceRule,
        triggerCondition,
        startDate,
        durationDays,
        dueDate,
        // No date and no readable timing phrase from the AI: code filled one in, so the
        // draft shows it as "assumed" for the owner to check (rule 4: never invent silently).
        dueDateAssumed: !(explicitDue || hintParsed.dueDate),
        dueHint: typeof task.dueHint === 'string' ? task.dueHint.trim() : null,
        dueDateOffsetDays,
        isForcedDeadline,
        forcedDeadlineDate,
      };
    });
  }

  const hydratedTasks: any[] = Array.isArray(plan.draftedTasks) ? plan.draftedTasks : [];

  plan.agendaQuadrant = VALID_QUADRANTS.has(plan.agendaQuadrant)
    ? plan.agendaQuadrant
    : hydratedTasks[0]?.quadrant || 'Q2_SCHEDULE';

  plan.agendaMajorOrMinor = VALID_SIZES.has(plan.agendaMajorOrMinor)
    ? plan.agendaMajorOrMinor
    : hydratedTasks.some((t) => t?.majorOrMinor === 'MAJOR')
      ? 'MAJOR'
      : 'MINOR';

  plan.agendaTitle =
    typeof plan.agendaTitle === 'string' && plan.agendaTitle.trim()
      ? plan.agendaTitle.trim()
      : hydratedTasks[0]?.title || 'Operational Plan';

  if (lane === 'QUICK' && (!Array.isArray(plan.wbsHeads) || plan.wbsHeads.length === 0)) {
    plan.wbsHeads = [];
  } else if (Array.isArray(plan.wbsHeads)) {
    plan.wbsHeads = plan.wbsHeads.map((head: any) => {
      if (!head || typeof head !== 'object') return head;
      const headTasks = hydratedTasks.filter((t) => t?.wbsHeadId === head.headId);
      const headHint = parseDueHintToDate(head.dueHint, refYmd);

      const sumDur =
        headTasks.length > 0
          ? headTasks.reduce((acc, t) => acc + (t.durationDays || 1), 0)
          : 1;

      const tentativeDurationDays =
        typeof head.tentativeDurationDays === 'number' &&
        Number.isFinite(head.tentativeDurationDays) &&
        head.tentativeDurationDays > 0
          ? head.tentativeDurationDays
          : Math.max(0.5, sumDur);

      const tentativeStartDate = isValidIsoDateString(head.tentativeStartDate)
        ? head.tentativeStartDate.trim()
        : headTasks[0]?.startDate || refYmd;

      const lastTaskDue = headTasks[headTasks.length - 1]?.dueDate;
      const tentativeDeadline = isValidIsoDateString(head.tentativeDeadline)
        ? head.tentativeDeadline.trim()
        : headHint.dueDate || lastTaskDue || computeDueDate(tentativeStartDate, tentativeDurationDays);

      const isForcedDeadline =
        typeof head.isForcedDeadline === 'boolean'
          ? head.isForcedDeadline
          : headHint.isForcedDeadline || headTasks.some((t) => Boolean(t?.isForcedDeadline));

      const sop =
        typeof head.domainCategory === 'string'
          ? sopMap.get(head.domainCategory.trim())
          : undefined;

      const quadrant: Quadrant = VALID_QUADRANTS.has(head.quadrant)
        ? head.quadrant
        : headTasks[0]?.quadrant || plan.agendaQuadrant;

      const majorOrMinor: Classification = VALID_SIZES.has(head.majorOrMinor)
        ? head.majorOrMinor
        : sop?.defaultClassification || plan.agendaMajorOrMinor;

      return {
        ...head,
        quadrant,
        majorOrMinor,
        tentativeDurationDays,
        tentativeStartDate,
        tentativeDeadline,
        dueHint: typeof head.dueHint === 'string' ? head.dueHint.trim() : null,
        isForcedDeadline,
        status: head.status || 'SWIMLANE_READY',
      };
    });
  } else {
    plan.wbsHeads = [];
  }

  return plan;
}

/**
 * Deterministic fallback summary from current task data when answering a QUESTION intent.
 */
export function answerQuestionFromTasksFallback(
  tasks: Task[],
  dir: SlotDirectory
): string {
  const active = (tasks || []).filter(
    (t) => !isTaskClosed(t.status)
  );
  if (active.length === 0) {
    return 'There are currently no active open tasks on the board.';
  }
  const lines = active.slice(0, 6).map((t) => {
    const rSlot = dir.phoneToEntry.get(t.raci?.R)?.slotId || 'Team';
    return `• [${t.taskCode}] ${scrubPiiToSlots(t.title, dir)} — ${t.status} (${t.completionPercent}%, Assigned: {{${rSlot}}}, Due: ${t.dueDate})`;
  });
  return `Current active tasks (${active.length}):\n${lines.join('\n')}`;
}

/**
 * One prompt line per task type that lists facts the owner must give before planning,
 * e.g. "- DELIVERIES (Deliveries): quantity; delivery address". Types without any are left out.
 */
export function buildMustKnowFactLines(categorySops: CategorySop[], dir: SlotDirectory): string[] {
  return (categorySops || [])
    .map((sop) => {
      const facts = (sop.requiredFacts || []).map((f) => String(f || '').trim()).filter(Boolean);
      if (facts.length === 0) return null;
      return `- ${sop.categoryId} (${scrubPiiToSlots(sop.categoryName || sop.categoryId, dir)}): ${facts
        .map((f) => scrubPiiToSlots(f, dir))
        .join('; ')}`;
    })
    .filter((line): line is string => Boolean(line));
}

/**
 * Builds the zero-PII Slot-Identity prompt for Stage 1 (INTENT) of Meditate v2.
 * Judges strictly by semantic meaning (zero word-count rules).
 */
export function buildAnonymizedIntentPrompt(params: {
  brainDump: string;
  wbsHeads?: WbsHead[];
  activeHead?: WbsHead | null;
  teamMembers: TeamMember[];
  tasks: Task[];
  categorySops: CategorySop[];
  systemMemory: SystemMemoryRule[];
  businessProfile?: BusinessProfileConfig;
  ownerProfile?: OwnerProfileConfig;
  taskSplittingRules?: TaskSplittingConfig;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; text: string }>;
  maxRecentConversationTurns?: number;
  /** "TODAY ..." line so the AI can turn "tomorrow" etc. into real dates. */
  dateContext?: string;
}) {
  const defaultMaxCap = params.taskSplittingRules?.defaultMaxActiveTasksPerPerson ?? 3;
  const slotDirectory = buildSlotDirectory(params.teamMembers, params.ownerProfile, defaultMaxCap);

  const rosterSummary = slotDirectory.entries.map(
    (e) =>
      `- [${e.slotId}] Role: ${e.roleTitle} | Authority: ${e.authorityLevel} | Skills: [${
        e.skills.join(', ') || 'General'
      }] | OnLeave: ${e.isOnLeave}`
  );

  const taskDataLines = (params.tasks || []).slice(0, 25).map((t) => {
    const rSlot = slotDirectory.phoneToEntry.get(t.raci?.R)?.slotId || 'Unassigned';
    const aSlot = slotDirectory.phoneToEntry.get(t.raci?.A)?.slotId || slotDirectory.defaultAccountableSlot;
    const summary = scrubPiiToSlots(t.latestAiSummary || '', slotDirectory);
    return `- [${t.taskCode}] "${scrubPiiToSlots(t.title, slotDirectory)}" | Status: ${t.status} (${
      t.completionPercent
    }%) | R: ${rSlot}, A: ${aSlot} | Due: ${t.dueDate}${summary ? ` | Note: ${summary}` : ''}`;
  });

  const allHeads = Array.isArray(params.wbsHeads) ? params.wbsHeads : [];
  const headsSummary = allHeads.map(
    (h) =>
      `- headId: "${h.headId}" | Title: "${scrubPiiToSlots(h.title, slotDirectory)}" | Category: ${
        h.domainCategory
      } | Status: ${h.status}`
  );

  const activeRules = (params.systemMemory || [])
    .filter((r) => r.active && r.approved !== false)
    .map((r) => `- [${r.category}] ${scrubPiiToSlots(r.fact, slotDirectory)}`);

  const bp = params.businessProfile;
  const businessSummary = bp
    ? `Business: ${scrubPiiToSlots(bp.businessName || 'Operations', slotDirectory)} (${scrubPiiToSlots(
        bp.businessType || 'General',
        slotDirectory
      )}) | Locations: ${scrubPiiToSlots(bp.workLocations || 'Not specified', slotDirectory)}`
    : '';

  const validSlotList = slotDirectory.entries.map((e) => e.slotId).join(', ') || 'P1';
  const mustKnowLines = buildMustKnowFactLines(params.categorySops || [], slotDirectory);

  const systemInstruction = `You are the Meditate v2 Semantic Intent Gate for an operations command center (Prompt Version ${PROMPT_VERSION}).
Classify the owner's message strictly by semantic meaning — NEVER use word count or message length heuristics.

INTENT KINDS:
1. "TASK": The owner wants operational work executed, assigned, scheduled, inspected, procured, repaired, audited, or updated on a project head.
   - Populate "missingCritical" ONLY when essential facts required to safely assign or execute the work are genuinely unknown (e.g. missing target location/asset when ambiguous, or missing item/specification). Do NOT invent facts, and do NOT flag optional details like duration, priority quadrant, or task size as missingCritical.
   - MUST-KNOW FACTS (when a MUST-KNOW FACTS BY TASK TYPE list is given): if the work belongs to a listed task type, check each listed fact against the owner's message, the conversation so far, approved memory and the business profile. Add every fact that is still unknown to "missingCritical" in plain words. Never fill one in by guessing. This list adds to the rule above; it never replaces it.
   - If the owner says to go ahead without the missing facts (for example "plan it anyway" or "baad mein bata dunga"), set "missingCritical" to [] and plan with what is known.
   - If "missingCritical" is non-empty, write ONE concise combined clarifying question in "replyToOwner" covering the missing items.
   - Set "followUpForHeadId" ONLY if the owner is clearly following up on or modifying one of the existing WBS Heads listed in EXISTING WBS HEADS; otherwise set "followUpForHeadId" to null.
2. "NOTE": The owner is recording an observation, serial number, reference fact, or memo for future reference without requesting an active task or standing policy rule.
3. "RULE": The owner is stating a standing operational rule, policy, vendor constraint, or recurring preference ("From now on...", "Never...", "Always..."). Set "ruleCategory" to BUSINESS_RULE, VENDOR_FACT, STAFF_TRAIT, or SOP_PREFERENCE.
4. "QUESTION": The owner is asking a status or workload question about current tasks or team operations. Answer accurately in "replyToOwner" using CURRENT TASK BOARD DATA without inventing facts.
5. "CASUAL": Greeting, sign-off, acknowledgement, or casual conversation with no operational task, note, rule, or board query.

CONFIDENCE & SLOT PRIVACY:
- Set "confidence" between 0.0 and 1.0 reflecting how unambiguous the owner's intent kind is. If the message could reasonably be interpreted in multiple ways (e.g. an observation that might be a note OR an implicit repair request), set confidence below 0.75.
- Team identities are anonymized as Slot IDs (${validSlotList}). Refer to team members ONLY via Slot placeholders like {{P1}}, {{P2}} and NEVER output phone numbers.
- ${buildOwnerReaderLine(slotDirectory)}`;

  const historyCapped = capConversationHistory(
    params.conversationHistory || [],
    slotDirectory,
    params.maxRecentConversationTurns ?? MAX_CONVERSATION_TURNS_CAP
  );

  const focusedNote = params.activeHead?.headId
    ? `\nCURRENTLY SELECTED UI HEAD ID: ${params.activeHead.headId} (Only use as followUpForHeadId if the owner's message actually refers to it; otherwise return null.)`
    : '';

  const scrubbedBrainDump = scrubPiiToSlots(params.brainDump, slotDirectory);

  const prompt = `${params.dateContext ? `${params.dateContext}\n\n` : ''}OWNER MESSAGE:\n${scrubbedBrainDump}${historyCapped.formattedBlock}${focusedNote}\n\n${businessSummary}\n\nANONYMIZED TEAM SLOTS:\n${rosterSummary.join(
    '\n'
  )}\n\nEXISTING WBS HEADS:\n${
    headsSummary.length > 0 ? headsSummary.join('\n') : '(None)'
  }\n\nCURRENT TASK BOARD DATA:\n${
    taskDataLines.length > 0 ? taskDataLines.join('\n') : '(No active tasks)'
  }\n\nAPPROVED SYSTEM MEMORY:\n${activeRules.length > 0 ? activeRules.join('\n') : '(None)'}${
    // Only when a task type lists must-know facts: an empty "(None)" block reads as
    // "nothing needs asking" and stops the gate asking about other genuine gaps.
    mustKnowLines.length > 0 ? `\n\nMUST-KNOW FACTS BY TASK TYPE:\n${mustKnowLines.join('\n')}` : ''
  }`;

  const piiAudit = verifyZeroPiiInPrompt(`${systemInstruction}\n${prompt}`, slotDirectory);

  return {
    systemInstruction,
    prompt,
    slotDirectory,
    historyCapped,
    validHeadIds: allHeads.map((h) => h.headId),
    piiAudit,
  };
}

/**
 * Builds the zero-PII Slot-Identity prompt for Stage 2 (PLANNER) of Meditate v2.
 * Runs ONLY for confirmed TASK intents with empty missingCritical.
 */
export function buildAnonymizedPlannerPrompt(params: {
  brainDump: string;
  followUpHead?: WbsHead | null;
  teamMembers: TeamMember[];
  tasks: Task[];
  categorySops: CategorySop[];
  systemMemory: SystemMemoryRule[];
  principalPrompts?: PrincipalPrompts;
  businessProfile?: BusinessProfileConfig;
  ownerProfile?: OwnerProfileConfig;
  taskSplittingRules?: TaskSplittingConfig;
  sampleBrainDumps?: SampleBrainDumpItem[];
  conversationHistory?: Array<{ role: 'user' | 'assistant'; text: string }>;
  maxRecentConversationTurns?: number;
  /** "TODAY ..." line so the AI can turn "tomorrow" etc. into real dates. */
  dateContext?: string;
}) {
  const defaultMaxCap = params.taskSplittingRules?.defaultMaxActiveTasksPerPerson ?? 3;
  const maxStepsPerTask = params.taskSplittingRules?.maxChecklistStepsPerTask ?? 5;
  const slotDirectory = buildSlotDirectory(params.teamMembers, params.ownerProfile, defaultMaxCap);

  const openCounts = countOpenTasksByPhone(params.tasks || []);
  const anonymizedRosterLines = slotDirectory.entries.map((entry) =>
    buildRosterLine(entry, openCounts.get(entry.phone) || 0, slotDirectory)
  );

  const activeRules = (params.systemMemory || [])
    .filter((r) => r.active && r.approved !== false)
    .map((r) => `- [${r.category}] ${scrubPiiToSlots(r.fact, slotDirectory)}`);

  const sopContext = (params.categorySops || []).map((s) => buildTaskTypeLine(s, slotDirectory, openCounts));

  const bp = params.businessProfile;
  const businessContextText = bp
    ? `BUSINESS PROFILE:
- Name: ${scrubPiiToSlots(bp.businessName || 'Not specified', slotDirectory)}
- Type: ${scrubPiiToSlots(bp.businessType || 'Not specified', slotDirectory)}
- Operations: ${scrubPiiToSlots(bp.businessDescription || 'Not specified', slotDirectory)}
- Locations: ${scrubPiiToSlots(bp.workLocations || 'Not specified', slotDirectory)}
- Default Language: ${bp.defaultStaffLanguage || 'HINGLISH'}
- Hard Rules: ${scrubPiiToSlots(bp.hardRules || 'None', slotDirectory)}`
    : '';

  const ownerContextText = params.ownerProfile
    ? `OWNER PROFILE:
- Operating Prompt: ${scrubPiiToSlots(
        params.ownerProfile.personalOperatingPrompt || 'Delegate ground execution to specialists.',
        slotDirectory
      )}
- Accountable (A): each roster line shows the person's AccountableDefault`
    : '';

  const splittingRuleText = scrubPiiToSlots(
    params.taskSplittingRules?.taskSplittingRule ||
      'If one person can complete the work continuously without waiting on another person or approval gate, use lane = "QUICK" with 1 task. Only use lane = "PROJECT" with multiple tasks/stages when work changes hands across people or hits an external gate.',
    slotDirectory
  );

  const samples = params.sampleBrainDumps || [];
  const sampleDumpsText =
    samples.length > 0
      ? `SPLITTING EXAMPLES:\n${samples
          .map(
            (s, i) =>
              `${i + 1}. "${scrubPiiToSlots(s.text, slotDirectory)}" -> Lane: ${
                s.splitType === 'QUICK_TASK' ? 'QUICK' : 'PROJECT'
              }${s.aiInstruction ? ` (${scrubPiiToSlots(s.aiInstruction, slotDirectory)})` : ''}`
          )
          .join('\n')}`
      : '';

  const validCategoryList =
    (params.categorySops || []).map((c) => c.categoryId).join(', ') || 'AD_HOC';
  const validSlotList = slotDirectory.entries.map((e) => e.slotId).join(', ') || 'P1';

  const basePlanningDirective = scrubPiiToSlots(
    params.principalPrompts?.planningPrompt ||
      'You are the Meditate v2 Task & Project Planner.',
    slotDirectory
  );

  const systemInstruction = `${basePlanningDirective}

${businessContextText}

${ownerContextText}

LANE & SPLITTING DIRECTIVES (PROMPT VERSION ${PROMPT_VERSION}):
- Max Checklist Steps per Task: ${maxStepsPerTask}
- Default Max Active Tasks per Person: ${defaultMaxCap}
- Splitting Rule: ${splittingRuleText}
- Set lane = "QUICK" when a single person can execute the job continuously without handoffs: output EXACTLY 1 task in draftedTasks and wbsHeads = [].
- Set lane = "PROJECT" when work spans multiple people, handoffs, or approval gates: define 1 or more wbsHeads with dynamicStages and map every draftedTask to a valid wbsHeadId and swimlaneStage.

${sampleDumpsText}

NULLABLE ARITHMETIC FIELDS & DUE HINTS:
- Unknown is allowed: startDate, durationDays, dueDate, quadrant, and majorOrMinor are nullable. Leave them null if not explicitly known instead of guessing; deterministic code fills defaults.
- If the owner mentions a timing phrase (e.g. "tomorrow", "before Friday", "in 3 days", "before 5 PM"), put that natural phrase in "dueHint" (and leave startDate/dueDate null so code computes exact calendar dates).

STRICT ANONYMIZED SLOT IDENTITY:
- Valid roster Slot IDs: ${validSlotList}. Never assign a slot with OnLeave: true.
- Output ONLY valid Slot IDs in raci.R, raci.A, raci.C, raci.I, and wbsHeads[].involvedPhones.
- ${ACCOUNTABLE_SELECTION_RULE}
- ${buildOwnerReaderLine(slotDirectory)}
- Use valid categoryIds (${validCategoryList}).
- Refer to teammates in text fields ONLY via {{P1}}, {{P2}} placeholders and NEVER output phone numbers.
- Include an "assignmentReason" on every drafted task (see RESPONSIBLE (R) SELECTION ORDER), using {{P1}} placeholders for any teammate.

${PLAN_ORDER_RULES}

${RESPONSIBLE_SELECTION_RULES}`;

  const historyCapped = capConversationHistory(
    params.conversationHistory || [],
    slotDirectory,
    params.maxRecentConversationTurns ?? MAX_CONVERSATION_TURNS_CAP
  );

  const anonymizedFollowUpHead = anonymizeActiveHeadForPrompt(params.followUpHead, slotDirectory);
  const followUpText = anonymizedFollowUpHead
    ? `\n\nFOLLOW-UP TARGET WBS HEAD TO REFINE:\n${JSON.stringify(anonymizedFollowUpHead, null, 2)}\n\n${OWNER_EDIT_REFINEMENT_RULES}`
    : '';

  const scrubbedBrainDump = scrubPiiToSlots(params.brainDump, slotDirectory);

  const prompt = `${params.dateContext ? `${params.dateContext}\n\n` : ''}CONFIRMED TASK REQUEST:\n${scrubbedBrainDump}${historyCapped.formattedBlock}${followUpText}\n\nANONYMIZED TEAM SLOTS & CAPACITY:\n${anonymizedRosterLines.join(
    '\n'
  )}\n\nCATEGORY SOP PLAYBOOKS:\n${sopContext.join(
    '\n'
  )}\n\nAPPROVED SYSTEM MEMORY:\n${activeRules.join('\n')}`;

  const piiAudit = verifyZeroPiiInPrompt(`${systemInstruction}\n${prompt}`, slotDirectory);

  return {
    systemInstruction,
    prompt,
    slotDirectory,
    historyCapped,
    maxStepsPerTask,
    piiAudit,
  };
}

/**
 * Builds a clean, validator-compliant MeditateAiResponse for non-planner v2 routes
 * (confirm chips, single clarifying question, note, pending rule, question answer, casual reply).
 */
export function buildV2NonPlannerResponse(params: {
  route: Exclude<MeditateV2RouteOutcome, 'RUN_PLANNER'>;
  intent: MeditateIntentStageOutput;
  replyToOwner: string;
  confirmChips?: MeditateConfirmChip[];
  rawBrainDump: string;
  slotDirectory: SlotDirectory;
}): MeditateAiResponse {
  const { route, intent, replyToOwner, confirmChips, rawBrainDump, slotDirectory } = params;

  const isClarificationOrConfirm =
    route === 'AWAIT_OWNER_CONFIRMATION' || route === 'ASK_CLARIFYING_QUESTION';

  const intentClassification = isClarificationOrConfirm
    ? 'NEEDS_CLARIFICATION'
    : 'CASUAL_OR_TEST';

  const cleanText = rawBrainDump.trim();
  const ruleCategory: SystemMemoryCategory = intent.ruleCategory || 'BUSINESS_RULE';

  const base: MeditateAiResponse = {
    intentClassification,
    v2Intent: {
      ...intent,
      replyToOwner: restoreDisplayNamesFromSlots(intent.replyToOwner, slotDirectory),
      missingCritical: (intent.missingCritical || []).map((m) =>
        restoreDisplayNamesFromSlots(m, slotDirectory)
      ),
    },
    v2Route: route,
    confirmChips: confirmChips && confirmChips.length > 0 ? confirmChips : undefined,
    chatReplyToBoss: restoreDisplayNamesFromSlots(replyToOwner, slotDirectory),
    reasoningSummary: `Meditate v2 INTENT routed to ${route} (kind=${intent.kind}, confidence=${intent.confidence.toFixed(
      2
    )}).`,
    agendaTitle:
      route === 'SAVE_NOTE'
        ? 'Captured Note'
        : route === 'STAGE_PENDING_RULE'
          ? 'Pending Memory Rule'
          : route === 'ANSWER_QUESTION'
            ? 'Board Status Answer'
            : isClarificationOrConfirm
              ? 'Clarification Needed'
              : 'Conversational Reply',
    agendaQuadrant: 'Q4_LOW',
    agendaMajorOrMinor: 'MINOR',
    wbsHeads: [],
    suggestedMemoryRules: [],
    draftedTasks: [],
    meditateEngineUsed: 'v2',
  };

  const sanitizedOwnerText = restoreDisplayNamesFromSlots(
    scrubPiiToSlots(cleanText, slotDirectory),
    slotDirectory
  );

  if (route === 'SAVE_NOTE' && sanitizedOwnerText) {
    base.noteToSave = {
      text: sanitizedOwnerText,
    };
  }

  if (route === 'STAGE_PENDING_RULE' && sanitizedOwnerText) {
    base.pendingRuleToSave = {
      category: ruleCategory,
      fact: sanitizedOwnerText,
      approved: false,
    };
  }

  return base;
}
