/**
 * Milestone 5A — first-run setup for a new cloud workspace.
 * Builds the initial workspace from the owner's answers (no seed/demo data) and validates
 * each step. Everything business-specific comes from the owner's answers, never from code.
 */
import type {
  AuthorityLevel,
  CategorySop,
  Classification,
  OpsDatabaseState,
  PreferredLanguage,
  TeamMember,
} from '../types/ops.ts';
import { defaultStageConfig, MODEL_DEFAULTS_VERSION } from './modelConfig.ts';
import { normalizeIndianPhone } from './phoneText.ts';

export type SetupStepId = 'BUSINESS' | 'ROLE' | 'PEOPLE' | 'TASK_TYPES';
export const SETUP_STEPS: SetupStepId[] = ['BUSINESS', 'ROLE', 'PEOPLE', 'TASK_TYPES'];

export interface SetupPerson {
  name: string;
  roleTitle: string;
  phone: string;
  preferredLanguage: PreferredLanguage;
  workShiftStart: string;
  workShiftEnd: string;
  maxActiveTasks: number;
  authorityLevel: AuthorityLevel;
  /** "What they handle" (optional). */
  responsibilities?: string;
  /** Strength phrases (optional). */
  strengths?: string[];
  /** Weakness phrases (optional; owner + AI only). */
  weaknesses?: string[];
}

export interface SetupTaskType {
  name: string;
  defaultClassification: Classification;
  defaultSteps: string[];
}

export interface SetupAnswers {
  business: {
    businessName: string;
    businessType: string;
    businessDescription: string;
    workLocations: string;
    defaultStaffLanguage: PreferredLanguage;
    timezone: string;
    workingDays: number[];
    hardRules: string;
  };
  owner: SetupPerson & { howIWork: string };
  people: SetupPerson[];
  taskTypes: SetupTaskType[];
}

export function emptySetupAnswers(timezone: string): SetupAnswers {
  const blankPerson: SetupPerson = {
    name: '',
    roleTitle: '',
    phone: '',
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    maxActiveTasks: 3,
    authorityLevel: 'STAFF',
    responsibilities: '',
    strengths: [],
    weaknesses: [],
  };
  return {
    business: {
      businessName: '',
      businessType: '',
      businessDescription: '',
      workLocations: '',
      defaultStaffLanguage: 'ENGLISH',
      timezone,
      workingDays: [1, 2, 3, 4, 5, 6],
      hardRules: '',
    },
    owner: { ...blankPerson, authorityLevel: 'OWNER', howIWork: '' },
    people: [],
    taskTypes: [],
  };
}

/**
 * Digits only, keeping a leading country code; a bare 10-digit Indian mobile is
 * promoted to 91XXXXXXXXXX. 10–15 digits is a valid WhatsApp number.
 */
export function normalizeSetupPhone(raw: string): string {
  return normalizeIndianPhone(raw);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validatePerson(p: SetupPerson, label: string): string[] {
  const errors: string[] = [];
  if (!p.name.trim()) errors.push(`${label}: add a name.`);
  if (!p.roleTitle.trim()) errors.push(`${label}: add a role.`);
  const digits = normalizeSetupPhone(p.phone);
  if (digits.length < 10 || digits.length > 15) {
    errors.push(`${label}: add a WhatsApp number with country code (10–15 digits).`);
  }
  if (!HHMM.test(p.workShiftStart) || !HHMM.test(p.workShiftEnd)) {
    errors.push(`${label}: shift times must look like 09:00.`);
  }
  if (!(p.maxActiveTasks >= 1)) errors.push(`${label}: task limit must be at least 1.`);
  return errors;
}

/** Problems that stop the owner moving past a step (empty array = OK). */
export function validateSetupStep(step: SetupStepId, answers: SetupAnswers): string[] {
  const errors: string[] = [];
  if (step === 'BUSINESS') {
    const b = answers.business;
    if (!b.businessName.trim()) errors.push('Add your business name.');
    if (!b.businessType.trim()) errors.push('Say what kind of business it is.');
    if (!b.timezone.trim()) errors.push('Choose a timezone.');
    if (!b.workingDays.length) errors.push('Choose at least one working day.');
  }
  if (step === 'ROLE') {
    errors.push(...validatePerson(answers.owner, 'You'));
  }
  if (step === 'PEOPLE') {
    if (answers.people.length === 0) errors.push('Add at least one person who will receive tasks.');
    answers.people.forEach((p, i) => errors.push(...validatePerson(p, p.name.trim() || `Person ${i + 1}`)));
    const all = [answers.owner, ...answers.people].map((p) => normalizeSetupPhone(p.phone)).filter(Boolean);
    const dupes = all.filter((ph, i) => all.indexOf(ph) !== i);
    if (dupes.length > 0) errors.push('Each person needs a different WhatsApp number.');
  }
  if (step === 'TASK_TYPES') {
    answers.taskTypes.forEach((t, i) => {
      if (!t.name.trim()) errors.push(`Task type ${i + 1}: add a name.`);
    });
    const names = answers.taskTypes.map((t) => t.name.trim().toLowerCase()).filter(Boolean);
    if (names.some((n, i) => names.indexOf(n) !== i)) errors.push('Each task type needs a different name.');
  }
  return errors;
}

/** Stable category id from a name ("Site visits" -> "SITE_VISITS"). */
export function categoryIdFromName(name: string, taken: Set<string>): string {
  const base =
    name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'TYPE';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

function toMember(p: SetupPerson, idx: number, tenantId: string, nowIso: string): TeamMember {
  return {
    tenantId,
    phone: normalizeSetupPhone(p.phone),
    slotId: `P${idx + 1}`,
    name: p.name.trim(),
    roleTitle: p.roleTitle.trim(),
    authorityLevel: p.authorityLevel,
    skills: [],
    maxActiveTasks: Math.max(1, Math.round(p.maxActiveTasks || 3)),
    preferredLanguage: p.preferredLanguage,
    workShiftStart: p.workShiftStart,
    workShiftEnd: p.workShiftEnd,
    dailyOverviewTime: p.workShiftStart,
    isOnLeave: false,
    lastInboundAt: nowIso,
    lastDailyDigestDate: null,
    bufferMode: 'STANDARD_15_MIN',
    stats: { assigned: 0, completed: 0, partial: 0, overdueCount: 0, totalWorkHoursReplyMins: 0, replyCount: 0 },
    personaPrompt: '',
    responsibilities: (p.responsibilities || '').trim(),
    strengths: Array.isArray(p.strengths) ? p.strengths.map((x) => x.trim()).filter(Boolean) : [],
    weaknesses: Array.isArray(p.weaknesses) ? p.weaknesses.map((x) => x.trim()).filter(Boolean) : [],
  };
}

/**
 * The first workspace for a new tenant, built only from the owner's answers.
 * No tasks, plans, messages or demo data. The owner is the OWNER team member and the
 * default Accountable person. If no task type is given, one generic "General" type is added.
 */
export function buildWorkspaceFromSetup(answers: SetupAnswers, tenantId: string, nowIso: string): OpsDatabaseState {
  const owner = toMember({ ...answers.owner, authorityLevel: 'OWNER' }, 0, tenantId, nowIso);
  const people = answers.people.map((p, i) =>
    toMember({ ...p, authorityLevel: p.authorityLevel === 'OWNER' ? 'MANAGER' : p.authorityLevel }, i + 1, tenantId, nowIso)
  );
  const taken = new Set<string>();
  const types = answers.taskTypes.filter((t) => t.name.trim());
  const categories: CategorySop[] = (types.length > 0 ? types : [{ name: 'General', defaultClassification: 'MINOR' as const, defaultSteps: [] }]).map(
    (t) => ({
      tenantId,
      categoryId: categoryIdFromName(t.name, taken),
      categoryName: t.name.trim(),
      defaultClassification: t.defaultClassification,
      sopSystemPrompt: '',
      defaultMicroSteps: t.defaultSteps.map((s) => s.trim()).filter(Boolean),
    })
  );
  const b = answers.business;
  return {
    tenantId,
    principal_prompts: { planningPrompt: '', evaluationPrompt: '' },
    business_profile: {
      businessName: b.businessName.trim(),
      businessType: b.businessType.trim(),
      businessDescription: b.businessDescription.trim(),
      workLocations: b.workLocations.trim(),
      defaultStaffLanguage: b.defaultStaffLanguage,
      hardRules: b.hardRules.trim(),
      timezone: b.timezone.trim(),
      workingDays: [...b.workingDays].sort((x, y) => x - y),
      batchNonUrgentIntoDigest: false,
      enforceWhatsapp24hWindow: true,
    },
    owner_profile: {
      personalOperatingPrompt: answers.owner.howIWork.trim(),
      defaultAccountablePhone: owner.phone,
      followUpStuckHours: 24,
    },
    task_splitting_rules: {
      maxChecklistStepsPerTask: 5,
      defaultMaxActiveTasksPerPerson: 3,
      taskSplittingRule:
        'Keep work that one person can finish without waiting on anyone as one task. Split only when the work changes hands between people or waits on an approval.',
    },
    sample_brain_dumps: [],
    team_members: Object.fromEntries([owner, ...people].map((m) => [m.phone, m])),
    category_sops: categories,
    umbrella_agendas: [],
    wbs_heads: [],
    tasks: [],
    boss_review_queue: [],
    inbound_message_buffer: {},
    system_memory: [],
    notes: [],
    whatsapp_messages: [],
    model_tuning: {
      modelDefaultsVersion: MODEL_DEFAULTS_VERSION,
      meditateEngine: 'v2', // server MEDITATE_ENGINE env var controls the active engine (defaults to v2)
      meditateEngineUserSet: false,
      intentConfidenceThreshold: 0.75,
      maxRecentConversationTurns: 8,
      meditate: defaultStageConfig('meditate'),
      intent: defaultStageConfig('intent'),
      planner: defaultStageConfig('planner'),
      bufferEvaluation: defaultStageConfig('bufferEvaluation'),
      message: defaultStageConfig('message'),
    },
    ai_logs: [],
  };
}
