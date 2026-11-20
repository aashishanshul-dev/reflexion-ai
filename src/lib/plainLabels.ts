/**
 * Centralised user-facing labels and one-line explainers.
 * Internal code/type names (WBS, RACI, R/A/C/I, slot, head, tenant, quadrant,
 * agenda) stay unchanged in code, types, tests and prompts; only what the user
 * sees is mapped here.
 */
import type {
  AiStageName,
  AiValidationStatus,
  AuthorityLevel,
  BossReviewType,
  Classification,
  PreferredLanguage,
  Quadrant,
  SystemMemoryCategory,
  TaskStatus,
} from '../types/ops.ts';

export const SECTION_EXPLAINERS = {
  meditate:
    "Tell me what's on your mind — by voice or text, in your language. I'll turn it into clear tasks for your team.",
  projects: 'A bigger job, broken into tasks in the right order.',
  raci: 'Does it · Answers for it · Consulted · Kept informed.',
  liveOps: "Every task — who's on it and where it stands.",
  myTasks: 'What you need to do, decide, or follow up on.',
  bossReviews: 'Decisions waiting for you — budgets, sign-offs and anything stuck.',
  team: "Your people, who reports to whom, and who's free.",
  aiBrain: 'Your business, your methods, and how the assistant works.',
} as const;

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  STAGING_DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  LOCKED_BY_DEPENDENCY: 'Waiting on another task',
  PENDING: 'Sent',
  IN_PROGRESS: 'In progress',
  PARTIALLY_DONE: 'Partly done',
  AWAITING_BOSS_DECISION: 'Needs your decision',
  COMPLETED: 'Done',
  EXPIRED_MISSED: 'Missed',
  CANCELLED: 'Cancelled',
};

export function taskStatusLabel(status: TaskStatus | string | undefined | null): string {
  if (!status) return 'Open';
  return (TASK_STATUS_LABELS as Record<string, string>)[status] || 'Open';
}

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  Q1_DO_FIRST: 'Do first',
  Q2_SCHEDULE: 'Schedule',
  Q3_DELEGATE: 'Delegate',
  Q4_LOW: 'Low priority',
};

export const QUADRANT_OPTION_LABELS: Record<Quadrant, string> = {
  Q1_DO_FIRST: 'Do first (Urgent & important)',
  Q2_SCHEDULE: 'Schedule (Important)',
  Q3_DELEGATE: 'Delegate (Urgent)',
  Q4_LOW: 'Low priority (Routine)',
};

export function quadrantLabel(quadrant: Quadrant | string | undefined | null): string {
  if (!quadrant) return 'Schedule';
  return (QUADRANT_LABELS as Record<string, string>)[quadrant] || 'Schedule';
}

export const RACI_ROLE_LABELS = {
  R: 'Does it',
  A: 'Answers for it',
  C: 'Consulted',
  I: 'Kept informed',
} as const;

export const BOSS_REVIEW_TYPE_LABELS: Record<BossReviewType, string> = {
  BUDGET_APPROVAL: 'Budget approval',
  DESIGN_SELECTION: 'Choice needed',
  PARTIAL_HANDOVER_GATE: 'Handover sign-off',
  BLOCKER_ESCALATION: 'Needs your help',
};

export function bossReviewTypeLabel(type: BossReviewType | string | undefined | null): string {
  if (!type) return 'Needs your decision';
  return (BOSS_REVIEW_TYPE_LABELS as Record<string, string>)[type] || 'Needs your decision';
}

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  MAJOR: 'Big task',
  MINOR: 'Quick task',
};

export const LANGUAGE_LABELS: Record<PreferredLanguage, string> = {
  HINGLISH: 'Hinglish',
  HINDI: 'Hindi',
  ENGLISH: 'English',
};

export function languageLabel(lang: PreferredLanguage | string | undefined | null): string {
  if (!lang) return 'Hinglish';
  return (LANGUAGE_LABELS as Record<string, string>)[lang] || 'Hinglish';
}

export const AUTHORITY_LABELS: Record<AuthorityLevel, string> = {
  OWNER: 'Owner',
  BOSS: 'Owner',
  MANAGER: 'Manager',
  SUPERVISOR: 'Supervisor',
  STAFF: 'Staff',
};

export function authorityLabel(level: AuthorityLevel | string | undefined | null): string {
  if (!level) return 'Staff';
  return (AUTHORITY_LABELS as Record<string, string>)[level] || 'Staff';
}

export const MEMORY_CATEGORY_LABELS: Record<SystemMemoryCategory, string> = {
  BUSINESS_RULE: 'Business rule',
  VENDOR_FACT: 'Vendor fact',
  STAFF_TRAIT: 'Staff trait',
  SOP_PREFERENCE: 'Method preference',
};

export function memoryCategoryLabel(
  cat: SystemMemoryCategory | string | undefined | null
): string {
  if (!cat) return 'Business rule';
  return (MEMORY_CATEGORY_LABELS as Record<string, string>)[cat] || 'Business rule';
}

export const AI_STAGE_LABELS: Record<AiStageName, string> = {
  INTENT: 'Understand',
  PLANNER: 'Plan',
  MEDITATE_PLANNING: 'Plan',
  BUFFER_EVALUATION: 'Read reply',
  MESSAGE: 'Write message',
  IMPORT: 'Import team',
  OWNER_EDIT: 'Owner edit',
};

export function aiStageLabel(stage: AiStageName | string | undefined | null): string {
  if (!stage) return 'Assistant';
  return (AI_STAGE_LABELS as Record<string, string>)[stage] || 'Assistant';
}

export const VALIDATION_STATUS_LABELS: Record<AiValidationStatus, string> = {
  VALID: 'Ready',
  SCHEMA_REPAIRED: 'Fixed',
  FALLBACK_USED: 'Backup used',
  ERROR: 'Needs check',
};

export function validationStatusLabel(
  status: AiValidationStatus | string | undefined | null
): string {
  if (!status) return 'Ready';
  return (VALIDATION_STATUS_LABELS as Record<string, string>)[status] || 'Ready';
}

/**
 * Strips raw validator codes, JSON payloads, and technical prefixes from error
 * strings before displaying them to the user.
 */
export function toFriendlyErrorMessage(
  err: unknown,
  fallback: string = 'Something went wrong. Please try again.'
): string {
  const raw =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object' && 'message' in err
        ? String((err as { message?: unknown }).message || '')
        : '';
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('{') || trimmed.includes('"error"') || /at\s+\w+\s*\(/.test(trimmed)) {
    return fallback;
  }
  // Remove leading SCREAMING_SNAKE_CASE codes like "UNKNOWN_RACI_SLOT: "
  const cleaned = trimmed.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, '').trim();
  return cleaned || fallback;
}

const DEFAULT_CATEGORY_LABELS: Record<string, string> = {
  EVENT_SETUP: 'Lawn & event setup',
  VENDOR_PURCHASE: 'Vendor purchases & rentals',
  POWER: 'Power & backup',
  MAINTENANCE: 'Maintenance & repairs',
  SAFETY_SANITATION: 'Safety & sanitation',
  OPS: 'Operations',
};

/**
 * Replaces raw uppercase category ID tokens (e.g. EVENT_SETUP, VENDOR_PURCHASE)
 * in user-facing text with their friendly category names.
 */
export function formatPlainCategoryTokens(
  text: string,
  categoryNames?: Record<string, string>
): string {
  if (!text) return '';
  const merged = { ...DEFAULT_CATEGORY_LABELS, ...(categoryNames || {}) };
  return text.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, (token) => merged[token] || token);
}
