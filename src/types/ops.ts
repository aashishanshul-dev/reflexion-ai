export const DEFAULT_TENANT_ID = 'default';

export type AuthorityLevel = 'OWNER' | 'BOSS' | 'MANAGER' | 'SUPERVISOR' | 'STAFF';

export type PreferredLanguage = 'HINGLISH' | 'HINDI' | 'ENGLISH';

export type EmployeeBufferMode = 'STANDARD_15_MIN' | 'INSTANT_NUDGE_ACTIVE';

export type MeditateEngineMode = 'legacy' | 'v2';

export interface EmployeeStats {
  assigned: number;
  completed: number;
  partial: number;
  overdueCount: number;
  totalWorkHoursReplyMins: number;
  replyCount: number;
}

export interface TeamMember {
  tenantId?: string;
  phone: string;
  slotId?: string; // e.g., "P1", "P2", "P3"
  name: string;
  roleTitle: string;
  authorityLevel: AuthorityLevel;
  skills?: string[]; // e.g., ["Procurement", "Electrical"]
  maxActiveTasks?: number; // default 3
  preferredLanguage: PreferredLanguage;
  workShiftStart: string; // "09:00"
  workShiftEnd: string;   // "19:00"
  dailyOverviewTime: string; // "09:30"
  isOnLeave: boolean;
  lastInboundAt: string; // ISO timestamp
  lastDailyDigestDate?: string | null; // YYYY-MM-DD in business timezone
  bufferMode: EmployeeBufferMode;
  stats: EmployeeStats;
  personaPrompt?: string;
  /** How messages address them, e.g. a first name plus the honorific the team uses. Empty = full name. */
  addressAs?: string;
  /** They prefer voice notes: task messages can be played to them as a voice note. */
  prefersVoiceNotes?: boolean;
  /** "What they handle": a few sentences the planner uses to pick the Responsible person. */
  responsibilities?: string;
  /** Short strength phrases the planner uses to pick the Responsible person. */
  strengths?: string[];
  /** Short weakness phrases — OWNER + AI only; never shown to staff in any message. */
  weaknesses?: string[];
  /** Phone of this person's manager (for the org chart and planner fallback). */
  reportsToPhone?: string | null;
  /** Phone of a partner shown beside this person with a dashed line (e.g. co-founder). */
  partnerOfPhone?: string | null;
  /** Phones of close peers / backups shown with dotted links. */
  worksCloselyWithPhones?: string[];
  /** Saved position on the interactive Team org chart canvas. */
  orgChartPosition?: { x: number; y: number } | null;
}

export interface BusinessProfileConfig {
  businessName: string;
  businessType: string;
  businessDescription: string;
  workLocations: string;
  defaultStaffLanguage: PreferredLanguage;
  hardRules: string;
  timezone?: string; // IANA timezone, e.g. "Asia/Kolkata"
  workingDays?: number[]; // 0 (Sun) .. 6 (Sat)
  batchNonUrgentIntoDigest?: boolean;
  enforceWhatsapp24hWindow?: boolean;
  whatsappTemplateText?: string;
}

export interface OwnerProfileConfig {
  personalOperatingPrompt: string;
  defaultAccountablePhone: string;
  alwaysDelegatesCategories?: string[];
  keepsCategories?: string[];
  /** "My tasks" → Follow up: a delegated task with no update for this many clock hours (default 24). */
  followUpStuckHours?: number;
}

export interface TaskSplittingConfig {
  maxChecklistStepsPerTask: number;
  defaultMaxActiveTasksPerPerson: number;
  taskSplittingRule: string;
}

export interface SampleBrainDumpItem {
  tenantId?: string;
  id: string;
  text: string;
  splitType: 'QUICK_TASK' | 'PROJECT_SWIMLANES';
  aiInstruction?: string;
}

export type Classification = 'MAJOR' | 'MINOR';

export interface CategorySop {
  tenantId?: string;
  categoryId: string;
  categoryName: string;
  defaultClassification: Classification;
  sopSystemPrompt: string;
  defaultMicroSteps: string[];
  /** Phone of the person who is Responsible for this task type by default. */
  defaultResponsiblePhone?: string | null;
  /** Phone of the backup, used when the default is on leave or at their task limit. */
  backupResponsiblePhone?: string | null;
  /** When true, spending on this task type needs the Accountable person's approval first. */
  spendApprovalRequired?: boolean;
  /**
   * Facts the owner must give before this kind of work is planned (e.g. a quantity,
   * an address, a date). When one is missing, Meditate asks one short question instead
   * of guessing.
   */
  requiredFacts?: string[];
}

export type Quadrant = 'Q1_DO_FIRST' | 'Q2_SCHEDULE' | 'Q3_DELEGATE' | 'Q4_LOW';

export interface UmbrellaAgenda {
  tenantId?: string;
  agendaId: string;
  title: string;
  rawBrainDump: string;
  quadrant: Quadrant;
  majorOrMinor: Classification;
  status: 'ACTIVE' | 'COMPLETED';
  createdAt: string;
}

export type TaskFrequency = 'ONE_TIME' | 'RECURRING';
export type RecurrenceRule = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

export type TaskStatus =
  | 'STAGING_DRAFT'
  | 'SCHEDULED'
  | 'LOCKED_BY_DEPENDENCY'
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'PARTIALLY_DONE'
  | 'AWAITING_BOSS_DECISION'
  | 'COMPLETED'
  | 'EXPIRED_MISSED'
  | 'CANCELLED';

export type TaskReleaseMode = 'NOW' | 'AT_TIME' | 'AFTER_TASK' | 'WHEN_FREE';

export interface TaskReleaseConfig {
  mode: TaskReleaseMode;
  releaseAt: string | null;
  afterTaskCode: string | null;
  afterTrigger: DependencyTrigger;
  delayMinutes: number;
  requireOwnerConfirm: boolean;
  ownerConfirmed?: boolean;
  releasedAt: string | null;
  holdReason: string | null;
  /** Earliest time the engine expects it can send a held task (e.g. next shift start). */
  nextEligibleAt?: string | null;
  batchedForDigest?: boolean;
  unlockNoticeText?: string | null;
}

export type MicroStepStatus = 'PENDING' | 'DONE' | 'MISSED';

export interface MicroStep {
  id: string;
  label: string;
  status: MicroStepStatus;
  evidenceNote?: string;
  /** How many things the step is about (read by code from the label, e.g. 250 chairs). */
  targetCount?: number | null;
  /** How many are done so far (from replies; code clamps to 0..targetCount). */
  doneCount?: number | null;
  /** What a photo must show before this step can be DONE (read by code from the label). */
  photoMustShow?: string | null;
  /** True once an attached photo was checked and showed it. */
  photoVerified?: boolean;
}

export interface RaciMatrix {
  R: string;
  A: string;
  C: string[];
  I: string[];
}

export type DependencyTrigger = 'FULL_COMPLETION' | 'PARTIAL_OR_BOSS_APPROVAL';

export interface TaskDependency {
  dependsOnTaskCode: string | null;
  triggerCondition: DependencyTrigger;
}

export interface ReminderConfig {
  includeInDailyOverview: boolean;
  customIntervalHours: number | null;
  lastNudgedAt: string | null;
  nudgeCount: number;
  /** Business-timezone date (YYYY-MM-DD) that `autoNudgesOnDate` counts for. */
  autoNudgeDate?: string | null;
  /** Automatic reminders sent on `autoNudgeDate` (daily cap; manual nudges not counted). */
  autoNudgesOnDate?: number;
}

export interface TaskAuditLog {
  timestamp: string;
  sender: string;
  rawInputSummary: string;
  mediaInspected?: string;
  aiDecision: string;
}

export interface PausedInterval {
  pausedAt: string;
  resumedAt?: string;
}

export interface Task {
  tenantId?: string;
  taskCode: string;
  shortTag: string;
  agendaId: string | null;
  wbsHeadId?: string | null;
  swimlaneStage?: string;
  title: string;
  categoryId: string;
  quadrant: Quadrant;
  majorOrMinor: Classification;
  taskFrequency: TaskFrequency;
  recurrenceRule: RecurrenceRule;
  isFrozen: boolean;
  raci: RaciMatrix;
  status: TaskStatus;
  completionPercent: number;
  microSteps: MicroStep[];
  missingStepsAlert: string;
  dependency: TaskDependency;
  release?: TaskReleaseConfig;
  reminderConfig: ReminderConfig;
  startDate: string; // YYYY-MM-DD tentative start date
  durationDays: number; // 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 7 - default 1
  dueDate: string; // YYYY-MM-DD tentative closing date
  /** Time of day it is due (HH:mm, business timezone). Absent/null = end of the due date. */
  dueTime?: string | null;
  isForcedDeadline: boolean; // if true, anchored by forcedDeadlineDate
  forcedDeadlineDate: string | null; // YYYY-MM-DD
  outboundWhatsappPreview: string;
  latestAiSummary: string;
  auditLogs: TaskAuditLog[];
  lastOutboundAt?: string;
  pausedIntervals?: PausedInterval[];
  /** Set when the owner cancels the task (status becomes CANCELLED). */
  cancelledAt?: string | null;
  /** The owner wrote this task's WhatsApp message; it is sent exactly as written. */
  messageIsCustom?: boolean;
  /** Set when the task leaves the active board (archived or cancelled). */
  archivedAt?: string | null;
  /** Set by code when a staff reply shows the work is late or will finish after the deadline. */
  scheduleRisk?: TaskScheduleRisk | null;
}

/** Why a task is behind schedule (owner-facing, written by code). */
export interface TaskScheduleRisk {
  reason: string;
  flaggedAt: string;
  /** The finish time the person gave, in their words (e.g. "4 baje"), if any. */
  reportedEta?: string | null;
  /** One practical recovery step suggested by the AI for the supervisor (owner-facing). */
  suggestedFix?: string | null;
  /** When the Accountable person was told on WhatsApp (sent once). */
  alertedAt?: string | null;
}

export type EscalationSignal =
  | 'NONE'
  | 'REFUSAL'
  | 'ON_LEAVE'
  | 'TIMELINE_SLIP'
  | 'REASSIGNMENT'
  | 'BLOCKER'
  | 'CAPACITY'
  | 'CONFUSION'
  | 'NO_RESPONSE';

export type BossReviewType =
  | 'BUDGET_APPROVAL'
  | 'DESIGN_SELECTION'
  | 'PARTIAL_HANDOVER_GATE'
  | 'BLOCKER_ESCALATION';

export interface BossReviewItem {
  tenantId?: string;
  reviewId: string;
  taskCode: string;
  employeePhone: string;
  /** Resolved Accountable person phone (manager first, then owner) for routing. */
  routedToPhone?: string;
  /** Escalation trigger that created or updated this review, if any. */
  trigger?: EscalationSignal;
  isUrgent?: boolean;
  reviewType: BossReviewType;
  employeeMessageSummary: string;
  mediaVerificationNote: string;
  aiSuggestedReplies: string[];
  status: 'OPEN' | 'RESOLVED';
  createdAt: string;
  resolvedAt?: string;
  resolutionReply?: string;
}

export type BufferedMediaType = 'text' | 'audio' | 'image' | 'video';

export interface BufferedMessage {
  id: string;
  timestamp: string;
  type: BufferedMediaType;
  textContent?: string;
  fileName?: string;
  mimeType?: string;
  base64Data?: string;
  fileSizeMB?: number;
}

export interface InboundMessageBuffer {
  tenantId?: string;
  employeePhone: string;
  bufferMode: 'STANDARD_15_MIN' | 'INSTANT_NUDGE';
  firstMessageAt: string;
  processAt: string;
  messages: BufferedMessage[];
}

export type SystemMemoryCategory =
  | 'BUSINESS_RULE'
  | 'VENDOR_FACT'
  | 'STAFF_TRAIT'
  | 'SOP_PREFERENCE';

export interface SystemMemoryRule {
  tenantId?: string;
  memoryId: string;
  category: SystemMemoryCategory;
  fact: string;
  active: boolean;
  approved?: boolean;
}

export interface NoteItem {
  tenantId: string;
  noteId: string;
  text: string;
  createdAt: string;
}

export interface SimulatedWhatsappMessage {
  tenantId?: string;
  id: string;
  employeePhone: string;
  direction: 'OUTBOUND' | 'INBOUND' | 'SYSTEM_NOTICE';
  timestamp: string;
  text: string;
  tag?: string;
  taskCode?: string;
  mediaLabel?: string;
  isTemplateMessage?: boolean;
}

export interface PrincipalPrompts {
  planningPrompt: string;
  evaluationPrompt: string;
}

export interface WbsHead {
  tenantId?: string;
  headId: string; // e.g., "HEAD-1", "HEAD-2"
  title: string;
  domainCategory: string; // Links to category_sops.categoryId
  contextSummary: string; // Contextual requirement & nuances
  quadrant: Quadrant;
  majorOrMinor: Classification;
  tentativeDurationDays: number;
  tentativeStartDate: string; // YYYY-MM-DD
  tentativeDeadline: string; // YYYY-MM-DD
  isForcedDeadline: boolean;
  dynamicStages: string[]; // Task-dependent process columns (X-axis)
  involvedPhones: string[]; // Task-dependent teammate rows (Y-axis)
  status: 'DRAFT_HEAD' | 'SWIMLANE_READY' | 'FROZEN_DISPATCHED';
  subTasks: MeditateDraftTaskInput[];
  /** Draft tasks the owner deleted (the AI must not bring them back unless explicitly asked). */
  ownerDeletedTempIds?: string[];
  /** The owner renamed this head. */
  titleEditedByOwner?: boolean;
}

export type AiStageName =
  | 'MEDITATE_PLANNING'
  | 'INTENT'
  | 'PLANNER'
  | 'BUFFER_EVALUATION'
  | 'MESSAGE'
  | 'OWNER_EDIT'
  | 'IMPORT';

export type AiValidationStatus = 'VALID' | 'FALLBACK_USED' | 'SCHEMA_REPAIRED' | 'ERROR';

export interface AiCallLogEntry {
  tenantId?: string;
  logId: string;
  timestamp: string;
  stage: AiStageName;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  promptVersion: string;
  latencyMs: number;
  validationStatus: AiValidationStatus;
  validationNote?: string;
  turnsSent?: number;
  olderTurnsSummarized?: number;
  /** OWNER_EDIT entries: the owner's corrections to AI drafts (future golden cases). */
  manualEdits?: ManualDraftEdit[];
}

export interface StageModelConfig {
  model: string;
  fallbackModel: string;
  temperature: number;
  maxOutputTokens: number;
  /** Cap on the primary model's thinking tokens (thinking models only); unset = model default. */
  thinkingBudget?: number;
}

export interface AiModelTuningConfig {
  /** Which version of the model defaults these settings were last migrated to. */
  modelDefaultsVersion?: number;
  meditateEngine?: MeditateEngineMode;
  meditateEngineUserSet?: boolean;
  intentConfidenceThreshold?: number;
  maxRecentConversationTurns: number;
  meditate: StageModelConfig;
  intent?: StageModelConfig;
  planner?: StageModelConfig;
  bufferEvaluation: StageModelConfig;
  message?: StageModelConfig;
}

export interface OpsDatabaseState {
  tenantId: string;
  team_members: Record<string, TeamMember>;
  category_sops: CategorySop[];
  umbrella_agendas: UmbrellaAgenda[];
  wbs_heads: WbsHead[];
  tasks: Task[];
  boss_review_queue: BossReviewItem[];
  inbound_message_buffer: Record<string, InboundMessageBuffer>;
  system_memory: SystemMemoryRule[];
  notes: NoteItem[];
  whatsapp_messages: SimulatedWhatsappMessage[];
  principal_prompts: PrincipalPrompts;
  business_profile: BusinessProfileConfig;
  owner_profile: OwnerProfileConfig;
  task_splitting_rules: TaskSplittingConfig;
  sample_brain_dumps: SampleBrainDumpItem[];
  model_tuning: AiModelTuningConfig;
  ai_logs: AiCallLogEntry[];
  /** Snapshot saved just before the last team-setup import, for "Undo last import". */
  last_import_backup?: ImportBackup | null;
}

/** A restore point captured before a team-setup import is applied. */
export interface ImportBackup {
  savedAt: string;
  summary: string;
  team_members: Record<string, TeamMember>;
  category_sops: CategorySop[];
  tasks: Task[];
}

export interface MeditateDraftTaskInput {
  tempId: string;
  title: string;
  shortTag?: string;
  categoryId: string;
  quadrant: Quadrant;
  majorOrMinor: Classification;
  taskFrequency: TaskFrequency;
  recurrenceRule: RecurrenceRule;
  raci: RaciMatrix;
  dependsOnTempIdOrTaskCode: string | null;
  triggerCondition: DependencyTrigger;
  release?: Partial<TaskReleaseConfig>;
  startDate?: string;
  durationDays?: number;
  dueDate: string;
  /** Time of day it is due (HH:mm, business timezone); null = end of the due date. */
  dueTime?: string | null;
  /** True when no date was given and code filled one in (shown as a note to check). */
  dueDateAssumed?: boolean;
  dueHint?: string | null;
  isForcedDeadline?: boolean;
  forcedDeadlineDate?: string | null;
  wbsHeadId?: string | null;
  swimlaneStage?: string;
  microSteps: string[];
  outboundWhatsappPreview?: string;
  /** One-line owner-facing reason for the assignee (strengths/handles ok; never a weakness). */
  assignmentReason?: string;
  /** Fields the owner changed by hand (kept through AI refinements unless explicitly overridden). */
  ownerEditedFields?: DraftEditableField[];
  /** The AI's original values, captured on the first manual edit (for the edit log). */
  aiSnapshot?: Partial<Record<DraftEditableField, unknown>>;
  /** Task added by hand by the owner (not by the AI). */
  ownerAdded?: boolean;
  /** The owner wrote the WhatsApp message; it is sent exactly as written. */
  messageIsCustom?: boolean;
  /** Notes about owner edits the AI changed because the owner explicitly asked. */
  aiOverrideNotes?: string[];
}

/** Draft fields the owner can edit before freezing. */
export type DraftEditableField =
  | 'title'
  | 'shortTag'
  | 'outboundWhatsappPreview'
  | 'microSteps'
  | 'raci.R'
  | 'raci.A'
  | 'raci.C'
  | 'raci.I'
  | 'categoryId'
  | 'quadrant'
  | 'majorOrMinor'
  | 'dueDate'
  | 'dueTime'
  | 'durationDays'
  | 'release'
  | 'taskFrequency'
  | 'recurrenceRule';

/** An owner edit the AI changed because the owner's new message explicitly asked. */
export interface OwnerEditOverride {
  /** Draft tempId, or the head ID for 'headTitle'. */
  tempId: string;
  field: DraftEditableField | 'headTitle' | 'removeTask' | 'restoreTask';
  quote?: string;
}

/** One owner correction to an AI draft (people as slot IDs; no names or phones). */
export interface ManualDraftEdit {
  draftRef: string;
  field: DraftEditableField;
  aiValue: unknown;
  ownerValue: unknown;
}

export type MeditateIntentClassification =
  | 'CASUAL_OR_TEST'
  | 'NEEDS_CLARIFICATION'
  | 'ACTIONABLE_AGENDA';

export type MeditateV2IntentKind = 'TASK' | 'NOTE' | 'RULE' | 'QUESTION' | 'CASUAL';

export type MeditateV2Lane = 'QUICK' | 'PROJECT';

export type MeditateV2RouteOutcome =
  | 'AWAIT_OWNER_CONFIRMATION'
  | 'ASK_CLARIFYING_QUESTION'
  | 'RUN_PLANNER'
  | 'SAVE_NOTE'
  | 'STAGE_PENDING_RULE'
  | 'ANSWER_QUESTION'
  | 'CASUAL_REPLY';

export interface MeditateConfirmChip {
  label: 'Make it a task' | 'Save as note' | 'Add as rule' | 'Just chatting';
  kind: 'TASK' | 'NOTE' | 'RULE' | 'CASUAL';
}

export interface MeditateIntentStageOutput {
  kind: MeditateV2IntentKind;
  confidence: number;
  missingCritical: string[];
  followUpForHeadId: string | null;
  replyToOwner: string;
  ruleCategory?: SystemMemoryCategory | null;
}

export interface MeditateAiResponse {
  intentClassification?: MeditateIntentClassification;
  lane?: MeditateV2Lane;
  v2Intent?: MeditateIntentStageOutput;
  v2Route?: MeditateV2RouteOutcome;
  confirmChips?: MeditateConfirmChip[];
  noteToSave?: {
    text: string;
  };
  pendingRuleToSave?: {
    category: SystemMemoryCategory;
    fact: string;
    approved: false;
  };
  chatReplyToBoss?: string;
  reasoningSummary: string;
  agendaTitle: string;
  agendaQuadrant: Quadrant;
  agendaMajorOrMinor: Classification;
  wbsHeads?: WbsHead[];
  suggestedMemoryRules: Array<{
    category: SystemMemoryCategory;
    fact: string;
  }>;
  /** Owner edits the AI changed because the owner's new message explicitly asked. */
  overriddenOwnerEdits?: OwnerEditOverride[];
  draftedTasks: Array<{
    /** Existing draft's tempId when refining a plan (null/absent for a new task). */
    tempId?: string | null;
    title: string;
    shortTag?: string;
    categoryId: string;
    quadrant: Quadrant;
    majorOrMinor: Classification;
    taskFrequency: TaskFrequency;
    recurrenceRule: RecurrenceRule;
    raci: RaciMatrix;
    dependsOnSubtaskIndex: number | null;
    triggerCondition: DependencyTrigger;
    startDate?: string;
    durationDays?: number;
    dueDate?: string;
    /** HH:mm; filled by code from dueHint or the title when a time of day is written. */
    dueTime?: string | null;
    /** Set by code when no date was given (only a day offset or nothing). */
    dueDateAssumed?: boolean;
    dueHint?: string | null;
    dueDateOffsetDays: number;
    isForcedDeadline?: boolean;
    forcedDeadlineDate?: string | null;
    wbsHeadId?: string | null;
    swimlaneStage?: string;
    microSteps: string[];
    outboundWhatsappPreview: string;
    assignmentReason?: string;
  }>;
  modelUsed?: string;
  meditateEngineUsed?: MeditateEngineMode;
  aiLog?: AiCallLogEntry;
  aiLogs?: AiCallLogEntry[];
}

export interface BufferProcessAiResponse {
  matchedTaskCode: string | null;
  englishBossSummary: string;
  mediaVerificationNote: string;
  updatedMicroSteps: Array<{
    id: string;
    status: MicroStepStatus;
    evidenceNote?: string;
    /** For counted steps: how many are done so far, from the messages. */
    doneCount?: number | null;
    /** For photo steps: an attached image clearly shows what the step requires. */
    photoShows?: boolean | null;
  }>;
  completionPercent: number;
  missingStepsAlert: string;
  whatsappReplyInPreferredLanguage: string;
  escalateToBossReview: boolean;
  /** Structured escalation signal detected by the reader; code enforces the escalation decision. */
  escalationSignal?: EscalationSignal;
  /** Short quote of the staff member's relevant words, if any. */
  staffQuote?: string | null;
  reviewType?: BossReviewType;
  aiSuggestedReplies?: string[];
  /** The person said some of the work will finish later than planned. */
  delayReported?: boolean;
  /** The finish time they gave for the remaining work, in their words; null if none. */
  reportedEta?: string | null;
  /** When behind: one practical recovery step for the supervisor; null otherwise. */
  suggestedFix?: string | null;
  isNeutralFallback?: boolean;
  modelUsed?: string;
  aiLog?: AiCallLogEntry;
}

/** Result of freezing drafts: blocked with a message, or what happened to each task. */
export type FreezeDispatchResult =
  | { ok: true; notice: string; sentCount: number; scheduledCount: number; waitingCount: number }
  | { ok: false; error: string };
