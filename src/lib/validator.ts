import type {
  BufferProcessAiResponse,
  InboundMessageBuffer,
  MeditateAiResponse,
  MeditateDraftTaskInput,
  MeditateEngineMode,
  MeditateIntentStageOutput,
  MeditateV2IntentKind,
  OwnerProfileConfig,
  SystemMemoryCategory,
  Task,
  TeamMember,
} from '../types/ops.ts';
import {
  buildSlotDirectory,
  restoreDisplayNamesFromSlots,
  suggestAccountablePhone,
  type SlotDirectory,
  type SlotEntry,
} from './promptBuilder.ts';
import { replacePhonesInText, textContainsPhone } from './phoneText.ts';
import { findIncompleteReleaseChoice, findPastReleaseTime } from './releaseEngine.ts';
import { normalizeOwnerEditOverrides } from './draftEditing.ts';
import { collectWeaknessPhrases } from './weaknessPrivacy.ts';

export type ValidationIssueCode =
  | 'INVALID_PAYLOAD'
  | 'INVALID_INTENT'
  | 'NON_TASK_HAS_DRAFTS'
  | 'EMPTY_ACTIONABLE_PLAN'
  | 'TASK_R_MISSING_OR_MULTIPLE'
  | 'TASK_A_MULTIPLE'
  | 'UNKNOWN_RACI_SLOT'
  | 'RESPONSIBLE_ON_LEAVE'
  | 'WEAKNESS_IN_STAFF_TEXT'
  | 'OWNER_DELEGATED_CATEGORY_VIOLATION'
  | 'UNKNOWN_CATEGORY_ID'
  | 'INVALID_DEPENDENCY_REF'
  | 'DEPENDENCY_CYCLE'
  | 'PROJECT_MISSING_HEAD_OR_STAGE'
  | 'QUICK_TASK_EXTRA_HEADS'
  | 'MAX_CHECKLIST_STEPS_EXCEEDED'
  | 'PHONE_NUMBER_IN_TEXT';

export interface ValidationIssue {
  code: ValidationIssueCode;
  path: string;
  message: string;
}

export interface MeditateValidationContext {
  roster: TeamMember[];
  categoryIds: string[];
  existingTasks?: Array<Pick<Task, 'taskCode' | 'dependency'>>;
  defaultAccountableSlot?: string;
  defaultAccountablePhone?: string;
  ownerProfile?: OwnerProfileConfig;
  ownerAlwaysDelegatesCategories?: string[];
  maxChecklistStepsPerTask?: number;
  allowResolvedPhonesInRaci?: boolean;
}

export interface PlanValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  normalizedPlan: any;
}

/**
 * Resolves the active Meditate engine ('legacy' | 'v2') solely from the server-side
 * environment variable (`MEDITATE_ENGINE`). Never accepts browser or stored overrides.
 * Defaults to 'v2'.
 */
export function resolveMeditateEngine(params?: {
  envEngine?: string | null;
}): MeditateEngineMode {
  const raw = params?.envEngine;
  if (raw && String(raw).trim().toLowerCase() === 'legacy') {
    return 'legacy';
  }
  return 'v2';
}

/**
 * Detects whether a text string contains any phone number (registered roster phone in any
 * formatting, or a 10-15 digit phone pattern), while ignoring ISO dates and timestamps.
 */
export function containsPhoneNumberInText(
  text: string | undefined | null,
  rosterPhones: string[] = []
): boolean {
  return textContainsPhone(text, rosterPhones);
}

function redactAnyPhoneNumbers(text: string): string {
  if (!text) return '';
  return replacePhonesInText(text, [], '[REDACTED_PHONE]');
}

/** What an unknown (non-team) number is replaced with in replies shown to the owner. */
export const OWNER_REPLY_NUMBER_PLACEHOLDER = '[number removed]';

/**
 * For text shown only to the owner/boss in the Meditate chat: replaces each team
 * member's phone (any formatting) with their name (or role if unnamed), and any
 * other phone-like number with a placeholder. Staff-facing text is NOT passed
 * through this — it stays under the hard no-phone-number rule.
 */
export function replacePhonesWithNamesForOwner(
  text: string | undefined | null,
  roster: Array<Pick<TeamMember, 'phone' | 'name' | 'roleTitle'>>
): string {
  if (!text || typeof text !== 'string') return text ?? '';
  return replacePhonesInText(
    text,
    roster
      .filter((m) => m?.phone)
      .map((m) => ({
        phone: m.phone,
        replacement: (m.name || '').trim() || (m.roleTitle || '').trim() || 'a team member',
      })),
    OWNER_REPLY_NUMBER_PLACEHOLDER
  );
}

function resolveSingleSlotOrPhoneRef(
  rawRef: unknown,
  slotDir: SlotDirectory,
  allowResolvedPhones: boolean
): {
  ok: boolean;
  normalizedRef: string;
  entry?: SlotEntry;
  isEmpty?: boolean;
  isMultiple?: boolean;
} {
  if (rawRef === undefined || rawRef === null) {
    return { ok: false, normalizedRef: '', isEmpty: true };
  }
  if (Array.isArray(rawRef)) {
    if (rawRef.length === 0) {
      return { ok: false, normalizedRef: '', isEmpty: true };
    }
    return { ok: false, normalizedRef: '', isMultiple: true };
  }
  if (typeof rawRef !== 'string') {
    return { ok: false, normalizedRef: String(rawRef) };
  }

  const trimmed = rawRef.trim();
  if (!trimmed) {
    return { ok: false, normalizedRef: '', isEmpty: true };
  }

  // Reject multi-person strings like "P1, P2", "P1/P2", "P1 & P2", "P1 P2"
  const slotTokens = trimmed.toUpperCase().match(/\bP\d+\b/g) || [];
  if (
    slotTokens.length > 1 ||
    trimmed.includes(',') ||
    trimmed.includes('/') ||
    trimmed.includes('&')
  ) {
    return { ok: false, normalizedRef: trimmed, isMultiple: true };
  }

  // Match exact slot token: P1, {{P1}}, or [P1]
  const unwrappedMatch = trimmed.match(/^(?:\{\{\s*(P\d+)\s*\}\}|\[\s*(P\d+)\s*\]|(P\d+))$/i);
  if (unwrappedMatch) {
    const slotKey = (unwrappedMatch[1] || unwrappedMatch[2] || unwrappedMatch[3]).toUpperCase();
    const entry = slotDir.slotToEntry.get(slotKey);
    if (!entry) {
      return { ok: false, normalizedRef: slotKey };
    }
    return {
      ok: true,
      normalizedRef: allowResolvedPhones ? entry.phone : entry.slotId,
      entry,
    };
  }

  if (allowResolvedPhones && slotDir.phoneToEntry.has(trimmed)) {
    const entry = slotDir.phoneToEntry.get(trimmed)!;
    return {
      ok: true,
      normalizedRef: entry.phone,
      entry,
    };
  }

  return { ok: false, normalizedRef: trimmed };
}

/**
 * Pure validator checking every Meditate plan before it reaches staging drafts or state.
 * Never auto-changes who does the work (`R`); defaults missing `A` to the owner's default accountable person.
 */
export function validateMeditatePlan(
  rawPlan: unknown,
  ctx: MeditateValidationContext
): PlanValidationResult {
  const issues: ValidationIssue[] = [];

  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    return {
      valid: false,
      issues: [
        {
          code: 'INVALID_PAYLOAD',
          path: 'root',
          message: 'Meditate response must be a JSON object.',
        },
      ],
      normalizedPlan: null,
    };
  }

  const plan: any = structuredClone(rawPlan);
  // Owner edits the AI says it changed on explicit request: keep only well-formed entries,
  // and never let a phone number through in the quoted words.
  plan.overriddenOwnerEdits = normalizeOwnerEditOverrides(plan.overriddenOwnerEdits).map((o) => ({
    ...o,
    quote: o.quote ? redactAnyPhoneNumbers(o.quote) : undefined,
  }));
  const slotDir = buildSlotDirectory(ctx.roster || [], ctx.ownerProfile);
  const rosterPhones = (ctx.roster || []).map((m) => m.phone).filter(Boolean);
  const allowResolvedPhones = Boolean(ctx.allowResolvedPhonesInRaci);
  const maxSteps = Math.max(1, ctx.maxChecklistStepsPerTask ?? 5);

  // 1. Check intent / lane validity
  const hasV2Lane = plan.lane === 'QUICK' || plan.lane === 'PROJECT';
  const validLegacyIntents = ['CASUAL_OR_TEST', 'NEEDS_CLARIFICATION', 'ACTIONABLE_AGENDA'];
  let isActionable = false;

  if (hasV2Lane) {
    isActionable = true;
    if (!Array.isArray(plan.draftedTasks) || plan.draftedTasks.length === 0) {
      issues.push({
        code: 'EMPTY_ACTIONABLE_PLAN',
        path: 'draftedTasks',
        message: `Lane "${plan.lane}" must include at least one drafted task.`,
      });
    }
  } else if (!validLegacyIntents.includes(plan.intentClassification)) {
    issues.push({
      code: 'INVALID_INTENT',
      path: 'intentClassification',
      message: `Invalid intentClassification "${String(plan.intentClassification ?? '')}".`,
    });
  } else if (
    plan.intentClassification === 'CASUAL_OR_TEST' ||
    plan.intentClassification === 'NEEDS_CLARIFICATION'
  ) {
    isActionable = false;
    const extraTasks = Array.isArray(plan.draftedTasks) ? plan.draftedTasks.length : 0;
    const extraHeads = Array.isArray(plan.wbsHeads) ? plan.wbsHeads.length : 0;
    if (extraTasks > 0 || extraHeads > 0) {
      issues.push({
        code: 'NON_TASK_HAS_DRAFTS',
        path: 'draftedTasks',
        message: `Intent "${plan.intentClassification}" must not include draftedTasks (${extraTasks}) or wbsHeads (${extraHeads}).`,
      });
    }
  } else if (plan.intentClassification === 'ACTIONABLE_AGENDA') {
    isActionable = true;
    if (!Array.isArray(plan.draftedTasks) || plan.draftedTasks.length === 0) {
      issues.push({
        code: 'EMPTY_ACTIONABLE_PLAN',
        path: 'draftedTasks',
        message: 'ACTIONABLE_AGENDA must include at least one drafted task.',
      });
    }
  }

  // 2a. Owner-facing reply text: show names, never numbers. These fields are only
  //     displayed to the owner in Meditate chat, so a phone the AI echoed is swapped
  //     for the person's name instead of blocking the whole plan.
  const roster = ctx.roster || [];
  if (typeof plan.chatReplyToBoss === 'string') {
    plan.chatReplyToBoss = replacePhonesWithNamesForOwner(plan.chatReplyToBoss, roster);
  }
  if (typeof plan.reasoningSummary === 'string') {
    plan.reasoningSummary = replacePhonesWithNamesForOwner(plan.reasoningSummary, roster);
  }
  if (plan.v2Intent && typeof plan.v2Intent === 'object') {
    if (typeof plan.v2Intent.replyToOwner === 'string') {
      plan.v2Intent.replyToOwner = replacePhonesWithNamesForOwner(plan.v2Intent.replyToOwner, roster);
    }
    if (Array.isArray(plan.v2Intent.missingCritical)) {
      plan.v2Intent.missingCritical = plan.v2Intent.missingCritical.map((m: unknown) =>
        typeof m === 'string' ? replacePhonesWithNamesForOwner(m, roster) : m
      );
    }
  }

  // 2b. Check no phone numbers inside ANY text field. Staff-facing fields (task titles,
  //     checklist steps, WhatsApp previews, WBS heads, notes, rules) are hard-blocked.
  const checkTextNoPhones = (val: unknown, fieldPath: string) => {
    if (typeof val === 'string' && containsPhoneNumberInText(val, rosterPhones)) {
      issues.push({
        code: 'PHONE_NUMBER_IN_TEXT',
        path: fieldPath,
        message: `Field "${fieldPath}" contains a raw phone number, which is prohibited.`,
      });
    }
  };

  // 2c. Weaknesses are OWNER + AI only: never allow a weakness phrase into any staff-facing
  //     field (task titles, checklist steps, WhatsApp previews). assignmentReason is
  //     owner-facing but must also never cite a weakness. Found -> hard block -> repair.
  const weaknessPhrases = collectWeaknessPhrases(ctx.roster || []);
  const checkNoWeakness = (val: unknown, fieldPath: string) => {
    if (typeof val !== 'string' || !val) return;
    const lower = val.toLowerCase();
    if (weaknessPhrases.some((w) => lower.includes(w.toLowerCase()))) {
      issues.push({
        code: 'WEAKNESS_IN_STAFF_TEXT',
        path: fieldPath,
        message: `Field "${fieldPath}" contains a private weakness phrase, which must never reach staff.`,
      });
    }
  };

  checkTextNoPhones(plan.chatReplyToBoss, 'chatReplyToBoss');
  checkTextNoPhones(plan.reasoningSummary, 'reasoningSummary');
  checkTextNoPhones(plan.agendaTitle, 'agendaTitle');
  checkTextNoPhones(plan.noteToSave?.text, 'noteToSave.text');
  checkTextNoPhones(plan.pendingRuleToSave?.fact, 'pendingRuleToSave.fact');
  checkTextNoPhones(plan.v2Intent?.replyToOwner, 'v2Intent.replyToOwner');
  if (Array.isArray(plan.v2Intent?.missingCritical)) {
    plan.v2Intent.missingCritical.forEach((mc: unknown, mIdx: number) => {
      checkTextNoPhones(mc, `v2Intent.missingCritical[${mIdx}]`);
    });
  }

  if (Array.isArray(plan.suggestedMemoryRules)) {
    plan.suggestedMemoryRules.forEach((rule: any, idx: number) => {
      checkTextNoPhones(rule?.fact, `suggestedMemoryRules[${idx}].fact`);
    });
  }

  if (Array.isArray(plan.draftedTasks)) {
    plan.draftedTasks.forEach((task: any, idx: number) => {
      checkTextNoPhones(task?.title, `draftedTasks[${idx}].title`);
      checkTextNoPhones(task?.shortTag, `draftedTasks[${idx}].shortTag`);
      checkTextNoPhones(task?.dueHint, `draftedTasks[${idx}].dueHint`);
      checkTextNoPhones(
        task?.outboundWhatsappPreview,
        `draftedTasks[${idx}].outboundWhatsappPreview`
      );
      checkNoWeakness(task?.title, `draftedTasks[${idx}].title`);
      checkNoWeakness(task?.shortTag, `draftedTasks[${idx}].shortTag`);
      checkNoWeakness(
        task?.outboundWhatsappPreview,
        `draftedTasks[${idx}].outboundWhatsappPreview`
      );
      checkNoWeakness(task?.assignmentReason, `draftedTasks[${idx}].assignmentReason`);
      if (Array.isArray(task?.microSteps)) {
        task.microSteps.forEach((step: unknown, sIdx: number) => {
          checkTextNoPhones(step, `draftedTasks[${idx}].microSteps[${sIdx}]`);
          checkNoWeakness(step, `draftedTasks[${idx}].microSteps[${sIdx}]`);
        });
      }
    });
  }

  if (Array.isArray(plan.wbsHeads)) {
    plan.wbsHeads.forEach((head: any, hIdx: number) => {
      checkTextNoPhones(head?.title, `wbsHeads[${hIdx}].title`);
      checkTextNoPhones(head?.contextSummary, `wbsHeads[${hIdx}].contextSummary`);
      checkTextNoPhones(head?.dueHint, `wbsHeads[${hIdx}].dueHint`);
      if (Array.isArray(head?.dynamicStages)) {
        head.dynamicStages.forEach((st: unknown, sIdx: number) => {
          checkTextNoPhones(st, `wbsHeads[${hIdx}].dynamicStages[${sIdx}]`);
        });
      }
    });
  }

  if (!isActionable || !Array.isArray(plan.draftedTasks) || plan.draftedTasks.length === 0) {
    return {
      valid: issues.length === 0,
      issues,
      normalizedPlan: plan,
    };
  }

  const tasks: any[] = plan.draftedTasks;
  const heads: any[] = Array.isArray(plan.wbsHeads) ? plan.wbsHeads : [];
  const validCategories = new Set(
    (ctx.categoryIds || []).map((c) => String(c).trim()).filter(Boolean)
  );

  // Milestone 4 hook: owner is not R for categories the owner always delegates (no-op when list is empty)
  const alwaysDelegatesCategories = new Set(
    (
      ctx.ownerAlwaysDelegatesCategories ??
      ctx.ownerProfile?.alwaysDelegatesCategories ??
      []
    )
      .map((c) => String(c).trim())
      .filter(Boolean)
  );

  const defaultAccountableRef = allowResolvedPhones
    ? ctx.defaultAccountablePhone || slotDir.defaultAccountablePhone
    : ctx.defaultAccountableSlot || slotDir.defaultAccountableSlot;

  // 3. Per-task RACI, leave, owner-delegation, category, and max checklist steps checks
  tasks.forEach((task: any, idx: number) => {
    const taskLabel = `Task #${idx + 1}`;
    const raci = task?.raci;

    if (!raci || typeof raci !== 'object' || Array.isArray(raci)) {
      issues.push({
        code: 'TASK_R_MISSING_OR_MULTIPLE',
        path: `draftedTasks[${idx}].raci`,
        message: `${taskLabel} is missing a valid RACI object.`,
      });
    } else {
      // Check R: exactly one, exists in roster, not on leave, never auto-changed
      const rCheck = resolveSingleSlotOrPhoneRef(raci.R, slotDir, allowResolvedPhones);
      if (rCheck.isEmpty || rCheck.isMultiple) {
        issues.push({
          code: 'TASK_R_MISSING_OR_MULTIPLE',
          path: `draftedTasks[${idx}].raci.R`,
          message: `${taskLabel} must specify exactly one Responsible (R) person.`,
        });
      } else if (!rCheck.ok || !rCheck.entry) {
        issues.push({
          code: 'UNKNOWN_RACI_SLOT',
          path: `draftedTasks[${idx}].raci.R`,
          message: `${taskLabel} Responsible (R) "${redactAnyPhoneNumbers(
            String(raci.R)
          )}" does not exist in the team roster.`,
        });
      } else {
        raci.R = rCheck.normalizedRef;

        if (rCheck.entry.isOnLeave) {
          issues.push({
            code: 'RESPONSIBLE_ON_LEAVE',
            path: `draftedTasks[${idx}].raci.R`,
            message: `${taskLabel} assigns Responsible (${rCheck.entry.slotId}) who is currently marked on leave.`,
          });
        }

        // Milestone 4 category delegation check (no-op until alwaysDelegatesCategories is non-empty)
        if (alwaysDelegatesCategories.size > 0) {
          const isOwnerRole =
            rCheck.entry.authorityLevel === 'OWNER' || rCheck.entry.authorityLevel === 'BOSS';
          const catId = String(task?.categoryId || '').trim();
          if (isOwnerRole && alwaysDelegatesCategories.has(catId)) {
            issues.push({
              code: 'OWNER_DELEGATED_CATEGORY_VIOLATION',
              path: `draftedTasks[${idx}].raci.R`,
              message: `${taskLabel} assigns the Owner (${rCheck.entry.slotId}) as Responsible for category "${catId}", which the Owner always delegates.`,
            });
          }
        }
      }

      // Check A: at most one; defaults to owner's default accountable person when omitted/blank
      const isABlank =
        raci.A === undefined ||
        raci.A === null ||
        (typeof raci.A === 'string' && raci.A.trim() === '');

      if (isABlank) {
        // Org chart first (manager, partner, ...), then the owner's default.
        const rRef = resolveSingleSlotOrPhoneRef(raci.R, slotDir, allowResolvedPhones);
        const defaultPhone = resolveSingleSlotOrPhoneRef(defaultAccountableRef, slotDir, allowResolvedPhones).entry?.phone;
        const suggestedPhone =
          rRef.ok && rRef.entry ? suggestAccountablePhone(rRef.entry.phone, slotDir, defaultPhone) : '';
        const suggestedEntry = suggestedPhone ? slotDir.phoneToEntry.get(suggestedPhone) : undefined;
        const aRef = suggestedEntry
          ? allowResolvedPhones
            ? suggestedEntry.phone
            : suggestedEntry.slotId
          : defaultAccountableRef;
        const defaultACheck = resolveSingleSlotOrPhoneRef(aRef, slotDir, allowResolvedPhones);
        if (!defaultACheck.ok || !defaultACheck.entry) {
          issues.push({
            code: 'UNKNOWN_RACI_SLOT',
            path: `draftedTasks[${idx}].raci.A`,
            message: `${taskLabel} has no Accountable (A) person and no valid default accountable roster member is configured.`,
          });
        } else {
          raci.A = defaultACheck.normalizedRef;
        }
      } else {
        const aCheck = resolveSingleSlotOrPhoneRef(raci.A, slotDir, allowResolvedPhones);
        if (aCheck.isMultiple) {
          issues.push({
            code: 'TASK_A_MULTIPLE',
            path: `draftedTasks[${idx}].raci.A`,
            message: `${taskLabel} can have at most one Accountable (A) person.`,
          });
        } else if (!aCheck.ok || !aCheck.entry) {
          issues.push({
            code: 'UNKNOWN_RACI_SLOT',
            path: `draftedTasks[${idx}].raci.A`,
            message: `${taskLabel} Accountable (A) "${redactAnyPhoneNumbers(
              String(raci.A)
            )}" does not exist in the team roster.`,
          });
        } else {
          raci.A = aCheck.normalizedRef;
        }
      }

      // Check C and I: every entry must exist in roster
      for (const listKey of ['C', 'I'] as const) {
        const rawList = raci[listKey];
        if (rawList === undefined || rawList === null) {
          raci[listKey] = [];
        } else if (!Array.isArray(rawList)) {
          issues.push({
            code: 'UNKNOWN_RACI_SLOT',
            path: `draftedTasks[${idx}].raci.${listKey}`,
            message: `${taskLabel} raci.${listKey} must be a list of roster slots.`,
          });
        } else {
          const normalizedList: string[] = [];
          rawList.forEach((item: unknown, itemIdx: number) => {
            const itemCheck = resolveSingleSlotOrPhoneRef(item, slotDir, allowResolvedPhones);
            if (!itemCheck.ok || !itemCheck.entry) {
              issues.push({
                code: 'UNKNOWN_RACI_SLOT',
                path: `draftedTasks[${idx}].raci.${listKey}[${itemIdx}]`,
                message: `${taskLabel} raci.${listKey} entry "${redactAnyPhoneNumbers(
                  String(item)
                )}" does not exist in the team roster.`,
              });
            } else {
              normalizedList.push(itemCheck.normalizedRef);
            }
          });
          raci[listKey] = normalizedList;
        }
      }
    }

    // Category check
    const catId = typeof task?.categoryId === 'string' ? task.categoryId.trim() : '';
    if (!catId || !validCategories.has(catId)) {
      issues.push({
        code: 'UNKNOWN_CATEGORY_ID',
        path: `draftedTasks[${idx}].categoryId`,
        message: `${taskLabel} categoryId "${catId}" does not match any configured SOP category.`,
      });
    }

    // Checklist steps <= configured max
    if (!Array.isArray(task?.microSteps)) {
      issues.push({
        code: 'MAX_CHECKLIST_STEPS_EXCEEDED',
        path: `draftedTasks[${idx}].microSteps`,
        message: `${taskLabel} microSteps must be an array of checklist strings.`,
      });
    } else if (task.microSteps.length > maxSteps) {
      issues.push({
        code: 'MAX_CHECKLIST_STEPS_EXCEEDED',
        path: `draftedTasks[${idx}].microSteps`,
        message: `${taskLabel} has ${task.microSteps.length} checklist steps, exceeding the configured max of ${maxSteps}.`,
      });
    }
  });

  // Also check wbsHeads involvedPhones & domainCategory
  heads.forEach((head: any, hIdx: number) => {
    const headLabel = `WBS Head "${head?.headId || `#${hIdx + 1}`}"`;
    if (head?.domainCategory && validCategories.size > 0) {
      const domCat = String(head.domainCategory).trim();
      if (!validCategories.has(domCat)) {
        issues.push({
          code: 'UNKNOWN_CATEGORY_ID',
          path: `wbsHeads[${hIdx}].domainCategory`,
          message: `${headLabel} domainCategory "${domCat}" does not match any configured SOP category.`,
        });
      }
    }
    if (Array.isArray(head?.involvedPhones)) {
      const normalizedInvolved: string[] = [];
      head.involvedPhones.forEach((p: unknown, pIdx: number) => {
        const pCheck = resolveSingleSlotOrPhoneRef(p, slotDir, allowResolvedPhones);
        if (!pCheck.ok || !pCheck.entry) {
          issues.push({
            code: 'UNKNOWN_RACI_SLOT',
            path: `wbsHeads[${hIdx}].involvedPhones[${pIdx}]`,
            message: `${headLabel} involved slot "${redactAnyPhoneNumbers(
              String(p)
            )}" does not exist in the team roster.`,
          });
        } else {
          normalizedInvolved.push(pCheck.normalizedRef);
        }
      });
      head.involvedPhones = normalizedInvolved;
    }
  });

  // 4. Quick-task mode vs. Project-mode head & stage rules
  const isQuickMode = plan.lane === 'QUICK' || (!plan.lane && tasks.length === 1);
  const isProjectMode = plan.lane === 'PROJECT' || (!plan.lane && tasks.length > 1);

  if (isQuickMode) {
    if (tasks.length > 1) {
      issues.push({
        code: 'QUICK_TASK_EXTRA_HEADS',
        path: 'draftedTasks',
        message: `Quick-task mode must contain a single task, but ${tasks.length} tasks were returned.`,
      });
    }
    if (heads.length > 1) {
      issues.push({
        code: 'QUICK_TASK_EXTRA_HEADS',
        path: 'wbsHeads',
        message: `Quick-task mode must not include extra WBS heads (got ${heads.length} heads for 1 task).`,
      });
    } else if (heads.length === 1) {
      const onlyHead = heads[0];
      const t0 = tasks[0];
      if (t0?.wbsHeadId && onlyHead?.headId && t0.wbsHeadId !== onlyHead.headId) {
        issues.push({
          code: 'PROJECT_MISSING_HEAD_OR_STAGE',
          path: 'draftedTasks[0].wbsHeadId',
          message: `Quick-task wbsHeadId "${t0.wbsHeadId}" does not match head "${onlyHead.headId}".`,
        });
      }
      if (
        t0?.swimlaneStage &&
        Array.isArray(onlyHead?.dynamicStages) &&
        onlyHead.dynamicStages.length > 0 &&
        !onlyHead.dynamicStages.includes(t0.swimlaneStage)
      ) {
        issues.push({
          code: 'PROJECT_MISSING_HEAD_OR_STAGE',
          path: 'draftedTasks[0].swimlaneStage',
          message: `Quick-task stage "${t0.swimlaneStage}" is not listed in head stages [${onlyHead.dynamicStages.join(
            ', '
          )}].`,
        });
      }
    }
  } else if (isProjectMode) {
    if (heads.length === 0) {
      issues.push({
        code: 'PROJECT_MISSING_HEAD_OR_STAGE',
        path: 'wbsHeads',
        message: `Project-mode plan with ${tasks.length} tasks must include at least one WBS head.`,
      });
    } else {
      const headStagesMap = new Map<string, string[]>();
      heads.forEach((head: any, hIdx: number) => {
        const hid = typeof head?.headId === 'string' ? head.headId.trim() : '';
        if (!hid) {
          issues.push({
            code: 'PROJECT_MISSING_HEAD_OR_STAGE',
            path: `wbsHeads[${hIdx}].headId`,
            message: `wbsHeads[${hIdx}] is missing a valid headId.`,
          });
          return;
        }
        if (headStagesMap.has(hid)) {
          issues.push({
            code: 'PROJECT_MISSING_HEAD_OR_STAGE',
            path: `wbsHeads[${hIdx}].headId`,
            message: `Duplicate WBS headId "${hid}" in wbsHeads.`,
          });
          return;
        }
        const stages = Array.isArray(head?.dynamicStages)
          ? head.dynamicStages
              .filter((s: unknown) => typeof s === 'string' && s.trim().length > 0)
              .map((s: string) => s.trim())
          : [];
        if (stages.length === 0) {
          issues.push({
            code: 'PROJECT_MISSING_HEAD_OR_STAGE',
            path: `wbsHeads[${hIdx}].dynamicStages`,
            message: `WBS Head "${hid}" must define at least one stage in dynamicStages.`,
          });
        }
        headStagesMap.set(hid, stages);
      });

      tasks.forEach((task: any, idx: number) => {
        const refHead = typeof task?.wbsHeadId === 'string' ? task.wbsHeadId.trim() : '';
        const refStage = typeof task?.swimlaneStage === 'string' ? task.swimlaneStage.trim() : '';
        if (!refHead || !headStagesMap.has(refHead)) {
          issues.push({
            code: 'PROJECT_MISSING_HEAD_OR_STAGE',
            path: `draftedTasks[${idx}].wbsHeadId`,
            message: `Task #${idx + 1} references missing or unknown WBS head "${refHead}".`,
          });
        } else {
          const allowedStages = headStagesMap.get(refHead)!;
          if (!refStage || !allowedStages.includes(refStage)) {
            issues.push({
              code: 'PROJECT_MISSING_HEAD_OR_STAGE',
              path: `draftedTasks[${idx}].swimlaneStage`,
              message: `Task #${idx + 1} stage "${refStage}" does not exist in WBS head "${refHead}" stages [${allowedStages.join(
                ', '
              )}].`,
            });
          }
        }
      });
    }
  }

  // 5. Dependency existence & cycle check
  const existingTaskCodes = new Set(
    (ctx.existingTasks || []).map((et) => et.taskCode).filter(Boolean)
  );
  const draftNodeId = (idx: number) =>
    typeof tasks[idx]?.tempId === 'string' && tasks[idx].tempId.trim()
      ? `draft:${tasks[idx].tempId.trim()}`
      : `draft:${idx}`;

  const tempIdToIdx = new Map<string, number>();
  tasks.forEach((t, i) => {
    if (typeof t?.tempId === 'string' && t.tempId.trim()) {
      tempIdToIdx.set(t.tempId.trim(), i);
    }
  });

  const depGraph = new Map<string, string | null>();
  for (const et of ctx.existingTasks || []) {
    if (et.taskCode) {
      depGraph.set(
        `existing:${et.taskCode}`,
        et.dependency?.dependsOnTaskCode ? `existing:${et.dependency.dependsOnTaskCode}` : null
      );
    }
  }

  tasks.forEach((task: any, idx: number) => {
    const node = draftNodeId(idx);
    const subIdx = task?.dependsOnSubtaskIndex;
    const refCode = task?.dependsOnTempIdOrTaskCode;

    if (subIdx !== undefined && subIdx !== null) {
      if (!Number.isInteger(subIdx) || subIdx < 0 || subIdx >= tasks.length) {
        issues.push({
          code: 'INVALID_DEPENDENCY_REF',
          path: `draftedTasks[${idx}].dependsOnSubtaskIndex`,
          message: `Task #${idx + 1} dependsOnSubtaskIndex (${String(
            subIdx
          )}) does not point to a valid drafted task (0..${tasks.length - 1}).`,
        });
        depGraph.set(node, null);
      } else if (subIdx === idx) {
        issues.push({
          code: 'DEPENDENCY_CYCLE',
          path: `draftedTasks[${idx}].dependsOnSubtaskIndex`,
          message: `Task #${idx + 1} cannot depend on itself.`,
        });
        depGraph.set(node, null);
      } else {
        depGraph.set(node, draftNodeId(subIdx));
      }
    } else if (refCode !== undefined && refCode !== null && String(refCode).trim() !== '') {
      const cleanRef = String(refCode).trim();
      if (tempIdToIdx.has(cleanRef)) {
        const targetIdx = tempIdToIdx.get(cleanRef)!;
        if (targetIdx === idx) {
          issues.push({
            code: 'DEPENDENCY_CYCLE',
            path: `draftedTasks[${idx}].dependsOnTempIdOrTaskCode`,
            message: `Task #${idx + 1} cannot depend on itself ("${cleanRef}").`,
          });
          depGraph.set(node, null);
        } else {
          depGraph.set(node, draftNodeId(targetIdx));
        }
      } else if (existingTaskCodes.has(cleanRef)) {
        depGraph.set(node, `existing:${cleanRef}`);
      } else {
        issues.push({
          code: 'INVALID_DEPENDENCY_REF',
          path: `draftedTasks[${idx}].dependsOnTempIdOrTaskCode`,
          message: `Task #${idx + 1} dependency "${cleanRef}" does not reference any real task.`,
        });
        depGraph.set(node, null);
      }
    } else {
      depGraph.set(node, null);
    }
  });

  // Detect multi-step dependency cycles via 3-color DFS
  const visitState = new Map<string, 0 | 1 | 2>();
  let cycleReported = false;

  for (let i = 0; i < tasks.length; i++) {
    const startNode = draftNodeId(i);
    if ((visitState.get(startNode) || 0) !== 0) continue;

    const trail: string[] = [];
    let curr: string | null | undefined = startNode;

    while (curr) {
      const st = visitState.get(curr) || 0;
      if (st === 1) {
        if (!cycleReported) {
          cycleReported = true;
          const cycleStart = trail.indexOf(curr);
          const cycleNodes = [...trail.slice(cycleStart >= 0 ? cycleStart : 0), curr];
          issues.push({
            code: 'DEPENDENCY_CYCLE',
            path: 'draftedTasks',
            message: `Circular task dependency detected (${cycleNodes.join(' -> ')}).`,
          });
        }
        break;
      }
      if (st === 2) break;

      visitState.set(curr, 1);
      trail.push(curr);
      curr = depGraph.get(curr) || null;
    }

    for (const visited of trail) {
      visitState.set(visited, 2);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    normalizedPlan: plan,
  };
}

export interface IntentValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  normalizedIntent: MeditateIntentStageOutput | null;
}

/**
 * Pure validator for the Meditate v2 INTENT stage output.
 */
export function validateIntentStageOutput(
  rawIntent: unknown,
  ctx: {
    roster: TeamMember[];
    validHeadIds?: string[];
  }
): IntentValidationResult {
  const issues: ValidationIssue[] = [];

  if (!rawIntent || typeof rawIntent !== 'object' || Array.isArray(rawIntent)) {
    return {
      valid: false,
      issues: [
        {
          code: 'INVALID_PAYLOAD',
          path: 'root',
          message: 'INTENT stage output must be a JSON object.',
        },
      ],
      normalizedIntent: null,
    };
  }

  const raw: any = structuredClone(rawIntent);
  const rosterPhones = (ctx.roster || []).map((m) => m.phone).filter(Boolean);

  const validKinds: MeditateV2IntentKind[] = ['TASK', 'NOTE', 'RULE', 'QUESTION', 'CASUAL'];
  if (!validKinds.includes(raw.kind)) {
    issues.push({
      code: 'INVALID_INTENT',
      path: 'kind',
      message: `Invalid INTENT kind "${String(raw.kind ?? '')}". Expected TASK | NOTE | RULE | QUESTION | CASUAL.`,
    });
  }

  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    issues.push({
      code: 'INVALID_PAYLOAD',
      path: 'confidence',
      message: `INTENT confidence must be a number between 0 and 1 (got "${String(raw.confidence)}").`,
    });
  }

  if (!Array.isArray(raw.missingCritical)) {
    issues.push({
      code: 'INVALID_PAYLOAD',
      path: 'missingCritical',
      message: 'INTENT missingCritical must be an array of strings.',
    });
  } else {
    raw.missingCritical.forEach((item: unknown, idx: number) => {
      if (typeof item !== 'string') {
        issues.push({
          code: 'INVALID_PAYLOAD',
          path: `missingCritical[${idx}]`,
          message: `missingCritical[${idx}] must be a string.`,
        });
      } else {
        // Owner-facing: swap any phone for the person's name rather than blocking.
        raw.missingCritical[idx] = replacePhonesWithNamesForOwner(item, ctx.roster || []);
      }
    });
  }

  let normalizedFollowUpHeadId: string | null = null;
  if (raw.followUpForHeadId !== null && raw.followUpForHeadId !== undefined && raw.followUpForHeadId !== '') {
    if (typeof raw.followUpForHeadId !== 'string') {
      issues.push({
        code: 'INVALID_PAYLOAD',
        path: 'followUpForHeadId',
        message: 'followUpForHeadId must be a string or null.',
      });
    } else if (containsPhoneNumberInText(raw.followUpForHeadId, rosterPhones)) {
      issues.push({
        code: 'PHONE_NUMBER_IN_TEXT',
        path: 'followUpForHeadId',
        message: 'followUpForHeadId contains a prohibited phone number.',
      });
    } else {
      const trimmedHead = raw.followUpForHeadId.trim();
      const allowedHeads = ctx.validHeadIds ? new Set(ctx.validHeadIds.map((h) => h.trim())) : null;
      normalizedFollowUpHeadId = !allowedHeads || allowedHeads.has(trimmedHead) ? trimmedHead : null;
    }
  }

  if (typeof raw.replyToOwner !== 'string' || !raw.replyToOwner.trim()) {
    issues.push({
      code: 'INVALID_PAYLOAD',
      path: 'replyToOwner',
      message: 'INTENT replyToOwner must be a non-empty string.',
    });
  } else {
    // Owner-facing: swap any phone for the person's name rather than blocking.
    raw.replyToOwner = replacePhonesWithNamesForOwner(raw.replyToOwner, ctx.roster || []);
  }

  const validRuleCats: SystemMemoryCategory[] = [
    'BUSINESS_RULE',
    'VENDOR_FACT',
    'STAFF_TRAIT',
    'SOP_PREFERENCE',
  ];
  const normalizedRuleCat: SystemMemoryCategory | null = validRuleCats.includes(raw.ruleCategory)
    ? raw.ruleCategory
    : null;

  if (issues.length > 0) {
    return {
      valid: false,
      issues,
      normalizedIntent: null,
    };
  }

  return {
    valid: true,
    issues: [],
    normalizedIntent: {
      kind: raw.kind as MeditateV2IntentKind,
      confidence: Number(Math.max(0, Math.min(1, raw.confidence)).toFixed(4)),
      missingCritical: (raw.missingCritical as string[])
        .map((s) => s.trim())
        .filter(Boolean),
      followUpForHeadId: normalizedFollowUpHeadId,
      replyToOwner: raw.replyToOwner.trim(),
      ruleCategory: normalizedRuleCat,
    },
  };
}

/**
 * Pure builder for a single-pass repair prompt when INTENT stage validation fails.
 */
export function buildIntentRepairPrompt(
  originalPrompt: string,
  invalidIntent: unknown,
  issues: ValidationIssue[]
): string {
  const issueLines = issues
    .map((iss, idx) => `${idx + 1}. [${iss.code}] (${iss.path}): ${iss.message}`)
    .join('\n');

  return `${originalPrompt}

---
INTENT VALIDATION REPAIR REQUIRED (SINGLE RETRY):
Your previous INTENT JSON failed validation:
${issueLines}

PREVIOUS INVALID JSON:
${redactAnyPhoneNumbers(JSON.stringify(invalidIntent, null, 2))}

Return valid JSON with kind (TASK | NOTE | RULE | QUESTION | CASUAL), confidence (0..1), missingCritical (string[]), followUpForHeadId (string | null), and replyToOwner (string, using only Slot IDs like {{P1}} and zero phone numbers).`;
}

/**
 * Pure builder for the single-pass model repair prompt when initial validation fails.
 */
export function buildPlanRepairPrompt(
  originalPrompt: string,
  invalidPlan: unknown,
  issues: ValidationIssue[]
): string {
  const issueLines = issues
    .map((iss, idx) => `${idx + 1}. [${iss.code}] (${iss.path}): ${iss.message}`)
    .join('\n');

  const isV2Planner =
    Boolean(invalidPlan && typeof invalidPlan === 'object' && 'lane' in (invalidPlan as any));

  const rInstruction = isV2Planner
    ? '2. NEVER auto-change who does the work (Responsible slot R) to a random person if the requested person is on leave or unknown — keep the invalid slot only if unresolvable so the system can ask the owner for clarification, and fix all structural/stage/category/step-limit issues.'
    : '2. NEVER auto-change who does the work (Responsible slot R) to a random person if the requested person is on leave or unknown — instead set intentClassification = "NEEDS_CLARIFICATION", draftedTasks = [], wbsHeads = [], and ask the owner how they want to assign it.';

  return `${originalPrompt}

---
VALIDATION REPAIR REQUIRED (SINGLE RETRY):
Your previous JSON plan failed deterministic validation with the following issue(s):
${issueLines}

PREVIOUS INVALID JSON:
${redactAnyPhoneNumbers(JSON.stringify(invalidPlan, null, 2))}

REPAIR INSTRUCTIONS:
1. Fix every validation issue listed above and return valid JSON matching the schema.
${rInstruction}
3. Never include raw phone numbers in any text field; use only valid roster Slot IDs (P1, P2, ...).
4. Ensure categoryIds, WBS head references, stages, dependencies, and checklist step counts strictly satisfy the configured rules.`;
}

/**
 * Pure builder for a NEEDS_CLARIFICATION response when validation still fails after one repair pass.
 * Lists every unresolved issue clearly for the owner without inventing or dispatching tasks.
 */
export function buildValidationFailureClarification(
  issues: ValidationIssue[],
  slotDir?: SlotDirectory
): MeditateAiResponse {
  const formattedBullets = issues.map((iss) => {
    const cleanMsg = redactAnyPhoneNumbers(iss.message);
    const displayMsg = slotDir ? restoreDisplayNamesFromSlots(cleanMsg, slotDir) : cleanMsg;
    return `• ${displayMsg}`;
  });

  const reply = `I couldn't safely finalize this plan because the following checks need your clarification:\n${formattedBullets.join(
    '\n'
  )}\n\nHow would you like to proceed?`;

  return {
    intentClassification: 'NEEDS_CLARIFICATION',
    chatReplyToBoss: reply,
    reasoningSummary: `Plan held by validator (${issues.length} unresolved issue(s)).`,
    agendaTitle: 'Clarification Required',
    agendaQuadrant: 'Q2_SCHEDULE',
    agendaMajorOrMinor: 'MINOR',
    wbsHeads: [],
    suggestedMemoryRules: [],
    draftedTasks: [],
  };
}

/**
 * Neutral WhatsApp buffer fallback when AI evaluation is unavailable.
 * Logs the batch, marks the task "Update received — needs review", sends a neutral acknowledgement,
 * and changes zero micro-step statuses and zero task statuses.
 */
export function buildNeutralBufferFallbackResponse(params: {
  employee?: Partial<TeamMember> | null;
  buffer?: Partial<InboundMessageBuffer> | null;
  activeTasks?: Task[];
}): BufferProcessAiResponse {
  const employee = params.employee || {};
  const messages = Array.isArray(params.buffer?.messages) ? params.buffer!.messages! : [];
  const activeTasks = Array.isArray(params.activeTasks) ? params.activeTasks : [];
  const targetTask = activeTasks[0] || null;

  const lang = employee.preferredLanguage || 'HINGLISH';
  const neutralAck =
    lang === 'ENGLISH'
      ? 'We received your update and logged it for review.'
      : 'Aapka update mil gaya hai aur review ke liye log kar liya gaya hai.';

  return {
    matchedTaskCode: targetTask?.taskCode || null,
    englishBossSummary: 'Update received — needs review',
    mediaVerificationNote: `Logged ${messages.length} buffered message(s) without automated step changes (AI evaluation unavailable).`,
    updatedMicroSteps: [],
    completionPercent: targetTask?.completionPercent ?? 0,
    missingStepsAlert: 'Update received — needs review',
    whatsappReplyInPreferredLanguage: neutralAck,
    escalateToBossReview: false,
    aiSuggestedReplies: [],
    isNeutralFallback: true,
    modelUsed: 'neutral-buffer-fallback',
  };
}

// ---------------------------------------------------------------------------
// Milestone 3.6: checks on owner-edited drafts (run on every edit and before freezing).
// ---------------------------------------------------------------------------

export interface DraftIssue {
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface DraftValidationContext {
  teamMembers: TeamMember[];
  categoryIds?: string[];
  ownerProfile?: OwnerProfileConfig;
  maxChecklistStepsPerTask?: number;
  timezone?: string;
  now?: Date | string;
  /** Codes of tasks already on the board (valid targets for "after task"). */
  existingTaskCodes?: string[];
  /** The plan's stages in order; enables the "goes out before the earlier stage" note. */
  stages?: string[];
}

const DRAFT_QUADRANTS = new Set(['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with one draft. Errors block freezing; warnings are only shown. */
export function validateDraftTask(draft: MeditateDraftTaskInput, ctx: DraftValidationContext): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const err = (field: string, message: string) => issues.push({ field, severity: 'error', message });
  const warn = (field: string, message: string) => issues.push({ field, severity: 'warning', message });
  const byPhone = new Map(ctx.teamMembers.map((m) => [m.phone, m]));
  const rosterPhones = ctx.teamMembers.map((m) => m.phone);

  if (!draft.title || !draft.title.trim()) err('title', 'Add a title.');

  const R = draft.raci?.R || '';
  if (!R) err('raci.R', 'Choose who is Responsible.');
  else if (!byPhone.has(R)) err('raci.R', 'Responsible is not in the team roster.');
  const A = draft.raci?.A || '';
  if (!A) warn('raci.A', 'No one is Accountable.');
  else if (!byPhone.has(A)) err('raci.A', 'Accountable is not in the team roster.');
  for (const key of ['C', 'I'] as const) {
    const label = key === 'C' ? 'Consulted' : 'Informed';
    if ((draft.raci?.[key] || []).some((p) => !byPhone.has(p))) {
      err(`raci.${key}`, `Someone under ${label} is not in the team roster.`);
    }
  }

  const textFields: Array<[string, string, string | undefined | null]> = [
    ['title', 'title', draft.title],
    ['shortTag', 'short tag', draft.shortTag],
    ['outboundWhatsappPreview', 'message to send', draft.outboundWhatsappPreview],
  ];
  for (const [field, label, value] of textFields) {
    if (containsPhoneNumberInText(value, rosterPhones)) {
      err(field, `Remove the phone number from the ${label}.`);
    }
  }
  if ((draft.microSteps || []).some((s) => containsPhoneNumberInText(s, rosterPhones))) {
    err('microSteps', 'Remove the phone number from the checklist steps.');
  }

  if (!DRAFT_QUADRANTS.has(draft.quadrant)) err('quadrant', 'Choose a valid quadrant.');
  if (ctx.categoryIds && ctx.categoryIds.length > 0 && !ctx.categoryIds.includes(draft.categoryId)) {
    warn('categoryId', 'This category is not in your category list.');
  }
  if (draft.majorOrMinor !== 'MAJOR' && draft.majorOrMinor !== 'MINOR') {
    err('majorOrMinor', 'Choose major or minor.');
  }
  if (draft.taskFrequency === 'RECURRING' && (!draft.recurrenceRule || draft.recurrenceRule === 'NONE')) {
    err('recurrenceRule', 'Choose how often a recurring task repeats.');
  }

  if (!draft.dueDate || !ISO_DATE.test(draft.dueDate)) {
    err('dueDate', 'Set a valid due date.');
  } else if (draft.startDate && ISO_DATE.test(draft.startDate) && draft.startDate > draft.dueDate) {
    err('dueDate', 'The due date is before the start date.');
  }
  if (!(Number(draft.durationDays ?? 1) > 0)) err('durationDays', 'Duration must be more than zero.');
  if (draft.dueDateAssumed && draft.dueDate && ISO_DATE.test(draft.dueDate)) {
    warn('dueDate', `No date was given, so ${draft.dueDate} was assumed. Check it before sending.`);
  }

  const releaseProblem =
    findIncompleteReleaseChoice(draft.release, draft.dependsOnTempIdOrTaskCode ?? null, ctx.timezone) ||
    findPastReleaseTime(draft.release, ctx.timezone, ctx.now);
  if (releaseProblem) err('release', releaseProblem);

  const steps = draft.microSteps || [];
  if (steps.length === 0) warn('microSteps', 'No checklist steps yet.');
  const maxSteps = ctx.maxChecklistStepsPerTask;
  if (typeof maxSteps === 'number' && maxSteps > 0 && steps.length > maxSteps) {
    warn('microSteps', `More than ${maxSteps} checklist steps; consider splitting the task.`);
  }

  const responsible = byPhone.get(R);
  if (
    responsible?.authorityLevel === 'OWNER' &&
    (ctx.ownerProfile?.alwaysDelegatesCategories || []).includes(draft.categoryId)
  ) {
    warn('raci.R', 'You usually delegate this category, but you are Responsible.');
  }
  if (
    draft.messageIsCustom &&
    draft.title?.trim() &&
    !(draft.outboundWhatsappPreview || '').toLowerCase().includes(draft.title.trim().toLowerCase())
  ) {
    warn('outboundWhatsappPreview', 'Your custom message does not mention the current title.');
  }
  return issues;
}

export interface DraftPlanValidation {
  byTempId: Record<string, DraftIssue[]>;
  errorCount: number;
  warningCount: number;
  /** First blocking problem, for the "Not sent" message. */
  firstError: { tempId: string; title: string; issue: DraftIssue } | null;
}

/** Checks every draft plus cross-task dependencies (missing, self, circular). */
export function validateDraftPlan(
  drafts: MeditateDraftTaskInput[],
  ctx: DraftValidationContext
): DraftPlanValidation {
  const byTempId: Record<string, DraftIssue[]> = {};
  const draftIds = new Set(drafts.map((d) => d.tempId));
  const existing = new Set(ctx.existingTaskCodes || []);
  const dependsOf = (d: MeditateDraftTaskInput) =>
    (d.release?.mode === 'AFTER_TASK' ? d.release?.afterTaskCode : null) || d.dependsOnTempIdOrTaskCode || null;

  for (const d of drafts) {
    const issues = validateDraftTask(d, ctx);
    const target = dependsOf(d);
    if (target) {
      if (target === d.tempId) {
        issues.push({ field: 'release', severity: 'error', message: 'A task cannot wait for itself.' });
      } else if (!draftIds.has(target) && !existing.has(target)) {
        issues.push({
          field: 'release',
          severity: 'error',
          message: 'It waits for a task that no longer exists. Choose another task or "Now".',
        });
      }
    }
    byTempId[d.tempId] = issues;
  }

  // A later-stage task that goes out now, while an earlier stage still has tasks: the
  // owner decides (code does not guess what it depends on). Owner-chosen "Now" is quiet.
  const stages = ctx.stages || [];
  if (stages.length > 1) {
    const stageOf = (d: MeditateDraftTaskInput) => Math.max(0, stages.indexOf(d.swimlaneStage || ''));
    const firstStageWithTasks = Math.min(...drafts.map(stageOf));
    for (const d of drafts) {
      const mode = d.release?.mode || 'NOW';
      if (stageOf(d) <= firstStageWithTasks || dependsOf(d) || mode !== 'NOW') continue;
      if ((d.ownerEditedFields || []).includes('release')) continue;
      byTempId[d.tempId].push({
        field: 'release',
        severity: 'warning',
        message: `Goes out now, before "${stages[firstStageWithTasks]}" is done. If it must wait, set "After task".`,
      });
    }
  }

  // Circular waits among drafts (A waits for B, B waits for A ...).
  const next = new Map(drafts.map((d) => [d.tempId, dependsOf(d)]));
  for (const d of drafts) {
    const seen = new Set<string>([d.tempId]);
    let cur = next.get(d.tempId);
    while (cur && draftIds.has(cur)) {
      if (cur === d.tempId) {
        byTempId[d.tempId].push({
          field: 'release',
          severity: 'error',
          message: 'These tasks wait for each other in a circle; one must start first.',
        });
        break;
      }
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = next.get(cur);
    }
  }

  let errorCount = 0;
  let warningCount = 0;
  let firstError: DraftPlanValidation['firstError'] = null;
  for (const d of drafts) {
    for (const issue of byTempId[d.tempId]) {
      if (issue.severity === 'error') {
        errorCount += 1;
        if (!firstError) firstError = { tempId: d.tempId, title: d.title || 'Untitled task', issue };
      } else {
        warningCount += 1;
      }
    }
  }
  return { byTempId, errorCount, warningCount, firstError };
}
