/**
 * Milestone 3.6 — editing Meditate drafts before freezing.
 *
 * Pure helpers: apply an owner edit to a draft, add/delete/reorder, rename/delete heads,
 * record the owner's corrections (without names or phones), and merge an AI refinement
 * so the owner's edits are kept unless the owner explicitly asked to change them.
 */
import {
  type AiCallLogEntry,
  DEFAULT_TENANT_ID,
  type OpsDatabaseState,
  type DraftEditableField,
  type ManualDraftEdit,
  type MeditateDraftTaskInput,
  type OwnerEditOverride,
  type OwnerProfileConfig,
  type TeamMember,
  type WbsHead,
} from '../types/ops.ts';
import { computeStartDateFromDeadline, generateOutboundWhatsappMessage } from './opsEngine.ts';
import { buildSlotDirectory, scrubPiiToSlots, type SlotDirectory } from './promptBuilder.ts';
import { normalizeDueTime } from './taskTiming.ts';

export const DRAFT_EDITABLE_FIELDS: DraftEditableField[] = [
  'title',
  'shortTag',
  'outboundWhatsappPreview',
  'microSteps',
  'raci.R',
  'raci.A',
  'raci.C',
  'raci.I',
  'categoryId',
  'quadrant',
  'majorOrMinor',
  'dueDate',
  'dueTime',
  'durationDays',
  'release',
  'taskFrequency',
  'recurrenceRule',
];

export const DRAFT_FIELD_LABELS: Record<DraftEditableField, string> = {
  title: 'title',
  shortTag: 'short tag',
  outboundWhatsappPreview: 'message to send',
  microSteps: 'checklist steps',
  'raci.R': 'Responsible',
  'raci.A': 'Accountable',
  'raci.C': 'Consulted',
  'raci.I': 'Informed',
  categoryId: 'category',
  quadrant: 'quadrant',
  majorOrMinor: 'major/minor',
  dueDate: 'due date',
  dueTime: 'due time',
  durationDays: 'duration',
  release: 'release choice',
  taskFrequency: 'one-time / recurring',
  recurrenceRule: 'repeat rule',
};

export type DraftEditPatch = Partial<Record<DraftEditableField, unknown>>;

export function getDraftFieldValue(draft: MeditateDraftTaskInput, field: DraftEditableField): unknown {
  switch (field) {
    case 'raci.R':
      return draft.raci?.R ?? '';
    case 'raci.A':
      return draft.raci?.A ?? '';
    case 'raci.C':
      return [...(draft.raci?.C || [])];
    case 'raci.I':
      return [...(draft.raci?.I || [])];
    case 'microSteps':
      return [...(draft.microSteps || [])];
    case 'release':
      return draft.release ? { ...draft.release } : null;
    default:
      return (draft as unknown as Record<string, unknown>)[field] ?? null;
  }
}

function setDraftFieldValue(
  draft: MeditateDraftTaskInput,
  field: DraftEditableField,
  value: unknown
): MeditateDraftTaskInput {
  const raci = { ...draft.raci, C: [...(draft.raci?.C || [])], I: [...(draft.raci?.I || [])] };
  switch (field) {
    case 'raci.R':
      return { ...draft, raci: { ...raci, R: String(value ?? '') } };
    case 'raci.A':
      return { ...draft, raci: { ...raci, A: String(value ?? '') } };
    case 'raci.C':
      return { ...draft, raci: { ...raci, C: Array.isArray(value) ? value.map(String) : [] } };
    case 'raci.I':
      return { ...draft, raci: { ...raci, I: Array.isArray(value) ? value.map(String) : [] } };
    case 'microSteps':
      return {
        ...draft,
        microSteps: Array.isArray(value) ? value.map((s) => String(s).trim()).filter(Boolean) : [],
      };
    case 'durationDays': {
      const n = Number(value);
      return { ...draft, durationDays: Number.isFinite(n) && n > 0 ? n : 1 };
    }
    case 'release':
      return { ...draft, release: value ? { ...(value as object) } : undefined };
    case 'dueTime':
      return { ...draft, dueTime: normalizeDueTime(value) };
    case 'dueDate':
      // The owner chose the date: it is no longer an assumption.
      return { ...draft, dueDate: String(value ?? ''), dueDateAssumed: false };
    case 'title':
    case 'shortTag':
      return { ...draft, [field]: String(value ?? '').trim() };
    default:
      return { ...draft, [field]: value } as MeditateDraftTaskInput;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** A missing release means "Now"; compare release choices by their meaning, not their shape. */
function normalizeReleaseForCompare(value: unknown) {
  const r = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    mode: r.mode || 'NOW',
    releaseAt: r.releaseAt || null,
    afterTaskCode: r.afterTaskCode || null,
    afterTrigger: r.afterTrigger || 'FULL_COMPLETION',
    delayMinutes: Number(r.delayMinutes) || 0,
    requireOwnerConfirm: Boolean(r.requireOwnerConfirm),
  };
}

function sameFieldValue(field: DraftEditableField, a: unknown, b: unknown): boolean {
  if (field === 'release') {
    return sameValue(normalizeReleaseForCompare(a), normalizeReleaseForCompare(b));
  }
  return sameValue(a, b);
}

/** The WhatsApp brief generated from the draft's own fields. */
export function generateDraftMessage(draft: MeditateDraftTaskInput, teamMembers: Record<string, TeamMember>): string {
  return generateOutboundWhatsappMessage(
    {
      taskCode: 'DRAFT',
      shortTag: draft.shortTag,
      title: draft.title,
      microSteps: draft.microSteps || [],
      dueDate: draft.dueDate,
      dueTime: draft.dueTime ?? null,
      quadrant: draft.quadrant,
      taskFrequency: draft.taskFrequency,
      recurrenceRule: draft.recurrenceRule,
    },
    teamMembers[draft.raci?.R],
    teamMembers[draft.raci?.A]
  );
}

/**
 * Drafts from the planner start with the generated short brief (addressed to the
 * Responsible person, with steps and due time) instead of the AI's free text, which
 * was sometimes written to the client or to nobody. An owner-written message is kept.
 */
export function withGeneratedDraftMessages<T extends MeditateDraftTaskInput>(
  drafts: T[],
  teamMembers: Record<string, TeamMember>
): T[] {
  return drafts.map((d) =>
    d.messageIsCustom ? d : { ...d, outboundWhatsappPreview: generateDraftMessage(d, teamMembers) }
  );
}

function snapshotEditableFields(draft: MeditateDraftTaskInput): Partial<Record<DraftEditableField, unknown>> {
  const snap: Partial<Record<DraftEditableField, unknown>> = {};
  for (const f of DRAFT_EDITABLE_FIELDS) snap[f] = getDraftFieldValue(draft, f);
  return snap;
}

export interface DraftEditResult {
  draft: MeditateDraftTaskInput;
  changedFields: DraftEditableField[];
}

/**
 * Applies the owner's edit to a draft. Marks changed fields as owner-edited, keeps the AI's
 * original values (first edit only), keeps dates consistent and refreshes the generated
 * message unless the owner wrote a custom one. Pass `outboundWhatsappPreview: null` to go
 * back to the generated message.
 */
export function applyDraftEdit(
  draft: MeditateDraftTaskInput,
  patch: DraftEditPatch,
  teamMembers: Record<string, TeamMember>
): DraftEditResult {
  let next: MeditateDraftTaskInput = { ...draft };
  const changed: DraftEditableField[] = [];
  let messageIsCustom = Boolean(draft.messageIsCustom);

  for (const field of DRAFT_EDITABLE_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (field === 'outboundWhatsappPreview') {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) {
        if (messageIsCustom) {
          messageIsCustom = false;
          changed.push(field);
        }
        continue;
      }
      if (text === (draft.outboundWhatsappPreview || '').trim()) continue;
      messageIsCustom = true;
      next = { ...next, outboundWhatsappPreview: text };
      changed.push(field);
      continue;
    }
    if (sameFieldValue(field, getDraftFieldValue(next, field), value)) continue;
    next = setDraftFieldValue(next, field, value);
    changed.push(field);
  }

  if (changed.length === 0) return { draft, changedFields: [] };

  if (next.taskFrequency === 'ONE_TIME' && next.recurrenceRule !== 'NONE') {
    next = { ...next, recurrenceRule: 'NONE' };
  } else if (next.taskFrequency === 'RECURRING' && next.recurrenceRule === 'NONE') {
    next = { ...next, recurrenceRule: 'DAILY' };
    if (!changed.includes('recurrenceRule')) changed.push('recurrenceRule');
  }
  if (changed.includes('dueDate') || changed.includes('durationDays')) {
    next = { ...next, startDate: computeStartDateFromDeadline(next.dueDate, next.durationDays || 1) };
  }
  // A blank short tag gets the same one freezing would make, so the draft shows what is sent.
  if (!next.shortTag?.trim() && next.title?.trim()) {
    next = { ...next, shortTag: deriveShortTag(next.title) };
  }

  const edited = new Set([...(draft.ownerEditedFields || []), ...changed]);
  if (!messageIsCustom) edited.delete('outboundWhatsappPreview');

  next = {
    ...next,
    messageIsCustom,
    ownerEditedFields: DRAFT_EDITABLE_FIELDS.filter((f) => edited.has(f)),
    aiSnapshot: draft.ownerAdded ? undefined : draft.aiSnapshot || snapshotEditableFields(draft),
  };
  if (!messageIsCustom) {
    next = { ...next, outboundWhatsappPreview: generateDraftMessage(next, teamMembers) };
  }
  return { draft: next, changedFields: changed };
}

/** The short tag freezing makes from a title when none is given. */
export function deriveShortTag(title: string): string {
  return title.trim().split(/[:\-–]/)[0].trim().slice(0, 24) || 'Task';
}

/** Moves a checklist step from one position to another. */
export function moveStep(steps: string[], from: number, to: number): string[] {
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length || from === to) {
    return [...steps];
  }
  const next = [...steps];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** A blank, hand-added task for a head. Responsible is left empty for the owner to choose. */
export function newBlankDraft(params: {
  head?: Pick<WbsHead, 'headId' | 'domainCategory' | 'quadrant' | 'majorOrMinor' | 'tentativeDeadline' | 'dynamicStages'> | null;
  defaultAccountablePhone?: string;
  todayDate: string;
  idSuffix: string;
}): MeditateDraftTaskInput {
  const head = params.head || null;
  // Never default to a date that has already passed.
  const headDue = head?.tentativeDeadline || '';
  const dueDate = headDue && headDue > params.todayDate ? headDue : params.todayDate;
  return {
    tempId: `owner-${head?.headId || 'quick'}-${params.idSuffix}`,
    title: '',
    shortTag: '',
    categoryId: head?.domainCategory || 'AD_HOC',
    quadrant: head?.quadrant || 'Q2_SCHEDULE',
    majorOrMinor: head?.majorOrMinor || 'MINOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    raci: { R: '', A: params.defaultAccountablePhone || '', C: [], I: [] },
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION',
    release: { mode: 'NOW' },
    startDate: computeStartDateFromDeadline(dueDate, 1),
    durationDays: 1,
    dueDate,
    wbsHeadId: head?.headId || null,
    swimlaneStage: head?.dynamicStages?.[0] || 'Execution',
    microSteps: [],
    ownerAdded: true,
    ownerEditedFields: [],
  };
}

export function addDraftToHead(head: WbsHead, draft: MeditateDraftTaskInput): WbsHead {
  return { ...head, subTasks: [...(head.subTasks || []), { ...draft, wbsHeadId: head.headId }] };
}

/** Removes a draft; AI-made drafts are remembered so a refinement cannot bring them back. */
export function removeDraftFromHead(head: WbsHead, tempId: string): WbsHead {
  const target = (head.subTasks || []).find((t) => t.tempId === tempId);
  if (!target) return head;
  const deleted = new Set(head.ownerDeletedTempIds || []);
  if (!target.ownerAdded) deleted.add(tempId);
  return {
    ...head,
    subTasks: head.subTasks.filter((t) => t.tempId !== tempId),
    ownerDeletedTempIds: Array.from(deleted),
  };
}

export function renameHead(head: WbsHead, title: string): WbsHead {
  const clean = title.trim();
  if (!clean || clean === head.title) return head;
  return { ...head, title: clean, titleEditedByOwner: true };
}

/** Deletes a draft (not yet frozen) head together with its tasks. Frozen heads are kept. */
export function deleteDraftHead(heads: WbsHead[], headId: string): WbsHead[] {
  return heads.filter((h) => h.headId !== headId || h.status === 'FROZEN_DISPATCHED');
}

// ---------------------------------------------------------------------------
// Edit log (future golden cases): people as slot IDs, text scrubbed of names/phones.
// ---------------------------------------------------------------------------

function sanitizeEditValue(field: DraftEditableField, value: unknown, dir: SlotDirectory): unknown {
  const slotOf = (phone: unknown) => {
    const p = String(phone ?? '');
    if (!p) return null;
    return dir.phoneToEntry.get(p)?.slotId || '[UNKNOWN_PERSON]';
  };
  if (value === undefined || value === null) return null;
  if (field === 'raci.R' || field === 'raci.A') return slotOf(value);
  if (field === 'raci.C' || field === 'raci.I') {
    return Array.isArray(value) ? value.map(slotOf).filter(Boolean) : [];
  }
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? scrubPiiToSlots(v, dir) : v));
  if (typeof value === 'string') return scrubPiiToSlots(value, dir);
  if (field === 'release' && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    return {
      mode: r.mode ?? 'NOW',
      releaseAt: r.releaseAt ?? null,
      afterTaskCode: r.afterTaskCode ?? null,
      delayMinutes: r.delayMinutes ?? 0,
      requireOwnerConfirm: Boolean(r.requireOwnerConfirm),
    };
  }
  return value;
}

/** One OWNER_EDIT log entry for a Save (null when nothing changed). */
export function buildManualEditLog(params: {
  after: MeditateDraftTaskInput;
  changedFields: DraftEditableField[];
  teamMembers: TeamMember[];
  ownerProfile?: OwnerProfileConfig;
  tenantId?: string;
  nowIso: string;
}): AiCallLogEntry | null {
  if (params.changedFields.length === 0) return null;
  const dir = buildSlotDirectory(params.teamMembers, params.ownerProfile);
  const edits: ManualDraftEdit[] = params.changedFields.map((field) => ({
    draftRef: params.after.tempId,
    field,
    aiValue: params.after.ownerAdded
      ? null
      : sanitizeEditValue(field, params.after.aiSnapshot?.[field], dir),
    ownerValue: sanitizeEditValue(field, getDraftFieldValue(params.after, field), dir),
  }));
  return {
    tenantId: params.tenantId || DEFAULT_TENANT_ID,
    logId: `owner-edit-${params.after.tempId}-${Date.parse(params.nowIso) || Date.now()}`,
    timestamp: params.nowIso,
    stage: 'OWNER_EDIT',
    model: 'owner-manual-edit',
    temperature: 0,
    maxOutputTokens: 0,
    promptVersion: 'manual',
    latencyMs: 0,
    validationStatus: 'VALID',
    validationNote: `${params.after.ownerAdded ? 'Owner-added task' : 'Owner edited AI draft'}: ${params.changedFields
      .map((f) => DRAFT_FIELD_LABELS[f])
      .join(', ')}`,
    manualEdits: edits,
  };
}

// ---------------------------------------------------------------------------
// Keeping owner edits through AI refinement.
// ---------------------------------------------------------------------------

export type { OwnerEditOverride };

function findOverride(overrides: OwnerEditOverride[], tempId: string, field: OwnerEditOverride['field']) {
  return overrides.find((o) => o.tempId === tempId && o.field === field);
}

function overrideNote(label: string, quote?: string): string {
  return `Changed ${label} because you asked${quote ? `: "${quote}"` : ''}.`;
}

/**
 * Merges the AI's refined drafts with the owner's edited ones. Owner-edited fields are put
 * back unless the AI listed them as explicitly requested; owner-deleted tasks stay deleted
 * and owner-added/edited tasks stay, unless explicitly requested.
 */
export function mergeRefinedDrafts(params: {
  previous: MeditateDraftTaskInput[];
  refined: MeditateDraftTaskInput[];
  overrides?: OwnerEditOverride[];
  ownerDeletedTempIds?: string[];
  teamMembers: Record<string, TeamMember>;
}): MeditateDraftTaskInput[] {
  const overrides = params.overrides || [];
  const deleted = new Set(params.ownerDeletedTempIds || []);
  const prevById = new Map(params.previous.map((d) => [d.tempId, d]));
  const out: MeditateDraftTaskInput[] = [];
  const seen = new Set<string>();

  // If the AI did not echo a task's tempId, match it to an unmatched previous draft
  // with the same title (case-insensitive), so the owner's edits still apply.
  const norm = (t: string) => (t || '').trim().toLowerCase();
  const echoed = new Set(params.refined.map((d) => d.tempId).filter((id) => prevById.has(id)));
  const refined = params.refined.map((d) => {
    if (prevById.has(d.tempId) || deleted.has(d.tempId)) return d;
    const twin = params.previous.find(
      (p) => !echoed.has(p.tempId) && norm(p.title) && norm(p.title) === norm(d.title)
    );
    if (!twin) return d;
    echoed.add(twin.tempId);
    return { ...d, tempId: twin.tempId };
  });

  for (const aiDraft of refined) {
    if (deleted.has(aiDraft.tempId) && !findOverride(overrides, aiDraft.tempId, 'restoreTask')) continue;
    seen.add(aiDraft.tempId);
    const prev = prevById.get(aiDraft.tempId);
    if (!prev || !(prev.ownerEditedFields?.length || prev.ownerAdded)) {
      out.push(aiDraft);
      continue;
    }
    let merged: MeditateDraftTaskInput = {
      ...aiDraft,
      aiSnapshot: prev.aiSnapshot,
      ownerAdded: prev.ownerAdded,
      messageIsCustom: prev.messageIsCustom,
    };
    const stillEdited: DraftEditableField[] = [];
    const notes: string[] = [...(prev.aiOverrideNotes || [])];
    for (const field of prev.ownerEditedFields || []) {
      const ov = findOverride(overrides, aiDraft.tempId, field);
      if (ov) {
        notes.push(overrideNote(DRAFT_FIELD_LABELS[field], ov.quote));
        if (field === 'outboundWhatsappPreview') merged = { ...merged, messageIsCustom: false };
        continue;
      }
      merged = setDraftFieldValue(merged, field, getDraftFieldValue(prev, field));
      stillEdited.push(field);
    }
    merged = {
      ...merged,
      ownerEditedFields: stillEdited,
      aiOverrideNotes: notes.length > 0 ? notes : undefined,
    };
    if (stillEdited.includes('dueDate') || stillEdited.includes('durationDays')) {
      merged = { ...merged, startDate: prev.startDate };
    }
    if (!merged.messageIsCustom) {
      merged = { ...merged, outboundWhatsappPreview: generateDraftMessage(merged, params.teamMembers) };
    }
    out.push(merged);
  }

  // Owner-added or owner-edited tasks the AI dropped stay, unless removal was explicitly asked.
  for (const prev of params.previous) {
    if (seen.has(prev.tempId)) continue;
    const ownerTouched = prev.ownerAdded || (prev.ownerEditedFields?.length || 0) > 0;
    if (!ownerTouched) continue;
    if (findOverride(overrides, prev.tempId, 'removeTask')) continue;
    out.push(prev);
  }
  return out;
}

/** Applies `mergeRefinedDrafts` to a head and keeps an owner-renamed title. */
export function mergeRefinedHead(params: {
  previous: WbsHead;
  refined: WbsHead;
  overrides?: OwnerEditOverride[];
  teamMembers: Record<string, TeamMember>;
}): WbsHead {
  const overrides = params.overrides || [];
  const deleted = params.previous.ownerDeletedTempIds || [];
  const subTasks = mergeRefinedDrafts({
    previous: params.previous.subTasks || [],
    refined: params.refined.subTasks || [],
    overrides,
    ownerDeletedTempIds: deleted,
    teamMembers: params.teamMembers,
  }).map((d) => ({ ...d, wbsHeadId: params.refined.headId }));
  const titleOverride = findOverride(overrides, params.previous.headId, 'headTitle');
  const keepTitle = params.previous.titleEditedByOwner && !titleOverride;
  return {
    ...params.refined,
    title: keepTitle ? params.previous.title : params.refined.title,
    titleEditedByOwner: keepTitle ? true : undefined,
    ownerDeletedTempIds: deleted.length > 0 ? deleted : undefined,
    subTasks,
  };
}

/** Normalises the AI's `overriddenOwnerEdits` list (drops anything malformed). */
export function normalizeOwnerEditOverrides(raw: unknown): OwnerEditOverride[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<string>([...DRAFT_EDITABLE_FIELDS, 'headTitle', 'removeTask', 'restoreTask']);
  const out: OwnerEditOverride[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const tempId = typeof r.tempId === 'string' ? r.tempId.trim() : '';
    const field = typeof r.field === 'string' ? r.field.trim() : '';
    if (!tempId || !allowed.has(field)) continue;
    out.push({
      tempId,
      field: field as OwnerEditOverride['field'],
      quote: typeof r.quote === 'string' ? r.quote.trim().slice(0, 200) : undefined,
    });
  }
  return out;
}

/** Validator context for drafts, built from the workspace state. */
export function buildDraftValidationContext(
  state: Pick<OpsDatabaseState, 'team_members' | 'category_sops' | 'owner_profile' | 'task_splitting_rules' | 'business_profile' | 'tasks'>,
  now?: Date | string
) {
  return {
    teamMembers: Object.values(state.team_members || {}),
    categoryIds: (state.category_sops || []).map((c) => c.categoryId),
    ownerProfile: state.owner_profile,
    maxChecklistStepsPerTask: state.task_splitting_rules?.maxChecklistStepsPerTask,
    timezone: state.business_profile?.timezone,
    now,
    existingTaskCodes: (state.tasks || []).map((t) => t.taskCode),
  };
}

// ---------------------------------------------------------------------------
// Quick (single-task) drafts: refined the same way as plans.
// ---------------------------------------------------------------------------

export const QUICK_DRAFT_HEAD_PREFIX = 'QUICK-';

export function isQuickDraftHeadId(headId: string | null | undefined): boolean {
  return Boolean(headId && headId.startsWith(QUICK_DRAFT_HEAD_PREFIX));
}

/**
 * Wraps a quick draft as a one-task plan so the AI can refine it (echoing its tempId and
 * any explicit overrides) and `mergeRefinedHead` can keep the owner's edits. Never stored.
 */
export function quickDraftAsHead(draft: MeditateDraftTaskInput): WbsHead {
  const headId = `${QUICK_DRAFT_HEAD_PREFIX}${draft.tempId}`;
  return {
    headId,
    title: draft.title,
    domainCategory: draft.categoryId,
    contextSummary: 'Single quick task the owner may be refining.',
    quadrant: draft.quadrant,
    majorOrMinor: draft.majorOrMinor,
    tentativeDurationDays: draft.durationDays || 1,
    tentativeStartDate: draft.startDate || draft.dueDate,
    tentativeDeadline: draft.dueDate,
    isForcedDeadline: false,
    dynamicStages: [draft.swimlaneStage || 'Execution'],
    involvedPhones: draft.raci?.R ? [draft.raci.R] : [],
    status: 'SWIMLANE_READY',
    subTasks: [{ ...draft, wbsHeadId: headId }],
  };
}

/**
 * Merges the AI's refined quick task with the owner's edited one, exactly like plans.
 * Returns null when the AI's task is not the same task (different tempId and title),
 * so an unrelated new quick task never inherits old edits.
 */
export function mergeRefinedQuickDraft(params: {
  previous: MeditateDraftTaskInput;
  refined: MeditateDraftTaskInput;
  overrides?: OwnerEditOverride[];
  teamMembers: Record<string, TeamMember>;
}): MeditateDraftTaskInput | null {
  const norm = (t: string) => (t || '').trim().toLowerCase();
  const sameTask =
    params.refined.tempId === params.previous.tempId ||
    (norm(params.previous.title) !== '' && norm(params.previous.title) === norm(params.refined.title));
  if (!sameTask) return null;
  const prevHead = quickDraftAsHead(params.previous);
  const refinedHead: WbsHead = {
    ...prevHead,
    subTasks: [{ ...params.refined, tempId: params.previous.tempId, wbsHeadId: prevHead.headId }],
  };
  const merged = mergeRefinedHead({
    previous: prevHead,
    refined: refinedHead,
    overrides: (params.overrides || []).filter((o) => o.field !== 'headTitle' && o.field !== 'removeTask'),
    teamMembers: params.teamMembers,
  });
  const draft = merged.subTasks.find((t) => t.tempId === params.previous.tempId) || merged.subTasks[0];
  return draft ? { ...draft, wbsHeadId: null } : null;
}

/** Reopens a FROZEN_DISPATCHED head back to SWIMLANE_READY for safe editing without re-sending. */
export function reopenHeadForEditing(head: WbsHead): WbsHead {
  if (head.status !== 'FROZEN_DISPATCHED') return head;
  return {
    ...head,
    status: 'SWIMLANE_READY',
  };
}

/**
 * Extracts a single draft task from a multi-task WbsHead into its own new
 * SWIMLANE_READY WbsHead so mistakenly merged tasks can be separated cleanly.
 */
export function splitTaskIntoNewHead(
  heads: WbsHead[],
  sourceHeadId: string,
  tempId: string,
  nowTs: number = Date.now()
): { heads: WbsHead[]; newHeadId: string | null } {
  const source = heads.find((h) => h.headId === sourceHeadId);
  const task = source?.subTasks?.find((t) => t.tempId === tempId);
  if (!source || !task || (source.subTasks?.length || 0) <= 1) {
    return { heads, newHeadId: null };
  }

  const taken = new Set(heads.map((h) => h.headId));
  let n = heads.length + 1;
  let newHeadId = `HEAD-${n}`;
  while (taken.has(newHeadId)) {
    n += 1;
    newHeadId = `HEAD-${n}-${nowTs.toString(36).slice(-3).toUpperCase()}`;
  }

  const remaining = source.subTasks.filter((t) => t.tempId !== tempId);
  const updatedSource: WbsHead = {
    ...source,
    subTasks: remaining,
    involvedPhones: Array.from(new Set(remaining.map((t) => t.raci?.R).filter(Boolean))),
  };

  const splitHead: WbsHead = {
    headId: newHeadId,
    title: task.title || task.shortTag || 'New Plan',
    domainCategory: task.categoryId || source.domainCategory,
    quadrant: task.quadrant || source.quadrant,
    majorOrMinor: task.majorOrMinor || source.majorOrMinor,
    contextSummary: task.title || source.contextSummary,
    tentativeDurationDays: task.durationDays || 1,
    tentativeStartDate: task.startDate || task.dueDate,
    tentativeDeadline: task.dueDate,
    isForcedDeadline: false,
    dynamicStages: [task.swimlaneStage || 'Execution'],
    involvedPhones: task.raci?.R ? [task.raci.R] : [],
    status: 'SWIMLANE_READY',
    subTasks: [
      {
        ...task,
        wbsHeadId: newHeadId,
        dependsOnTempIdOrTaskCode: null,
      },
    ],
  };

  return {
    heads: [...heads.map((h) => (h.headId === sourceHeadId ? updatedSource : h)), splitHead],
    newHeadId,
  };
}
