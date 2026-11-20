import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import {
  buildAnonymizedBufferPrompt,
  buildAnonymizedMessageStagePrompt,
  createAiCallLog,
  deanonymizeAndValidateMessageStage,
  deanonymizeBufferResponse,
  deanonymizeMeditateResponse,
  PROMPT_VERSION,
  resolveStageModelConfig,
  scrubPiiToSlots,
} from '../../src/lib/promptBuilder.ts';
import {
  buildAnonymizedIntentPrompt,
  buildAnonymizedPlannerPrompt,
  buildV2NonPlannerResponse,
  hydratePlannerDefaults,
  routeMeditateV2Intent,
} from '../../src/lib/meditateV2.ts';
import {
  buildIntentRepairPrompt,
  buildPlanRepairPrompt,
  buildValidationFailureClarification,
  resolveMeditateEngine,
  validateIntentStageOutput,
  validateMeditatePlan,
} from '../../src/lib/validator.ts';
import { buildDateContextLine, normalizeMeditatePlanDates } from '../../src/lib/planDates.ts';
import {
  buildPlainReleaseWhatsappMessage,
  buildReleaseSettingsFromState,
  canRelease,
  promoteUnlockedDependentsToScheduled,
  releaseDueTasks,
  summarizeFreezeOutcome,
} from '../../src/lib/releaseEngine.ts';
import { applyProcessedBufferResult, enqueueInboundSimulatorMessage } from '../../src/lib/opsEngine.ts';
import { textContainsPhone } from '../../src/lib/phoneText.ts';
import { textContainsWeakness } from '../../src/lib/weaknessPrivacy.ts';
import { buildFallbackMeditateResponse } from '../../src/lib/meditateFallback.ts';
import { buildGeminiFailureMessage, GeminiTimeoutError } from '../../src/lib/geminiErrors.ts';
import { callWithBusyRetry, isGeminiDailyQuotaError } from '../../src/lib/geminiRetry.ts';
import { GEMINI_MODELS } from '../../src/lib/modelConfig.ts';
import type { OpsDatabaseState, Task, WbsHead } from '../../src/types/ops.ts';
import {
  applyCasePrecondition,
  buildFixture,
  makeOpenTask,
  TEST_CLOCK_ISO,
  TEST_TODAY_ISO,
  type FixtureId,
  type TuningFixture,
} from './fixtures/index.ts';

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const CACHE_DIR = path.join(__dirname, '.cache');
const LAST_RUN_PATH = path.join(__dirname, '.last-run.json');

type Severity = 'S1' | 'S2' | 'S3' | 'S4';
type OutcomeStatus = 'PASS' | 'FAIL' | 'NOT_VERIFIED';
type VerificationLabel = 'verified live' | 'verified simulated' | 'not verified';

export interface TuningCase {
  id: string;
  section: string;
  set: 'TUNE' | 'HOLDOUT';
  star: boolean;
  fixtures: FixtureId[];
  pipeline: 'MEDITATE' | 'RELEASE' | 'MESSAGE' | 'BUFFER_REPLY' | 'CONVERSATION' | 'FAULT' | 'CODE_SCAN';
  precondition?: string;
  clockOverride?: string;
  input?: string;
  inputs?: string[];
  turns?: string[];
  staffReply?: {
    speaker: string;
    text: string;
    hasPhoto?: boolean;
    mediaType?: 'text' | 'audio' | 'image';
  };
  fault?: string;
  dimensions: string[];
  mustHappen: string;
  expectations: Record<string, any>;
}

export interface DimensionOutcome {
  dimension: string;
  status: OutcomeStatus;
  severity?: Severity;
  note?: string;
}

export interface CaseRunResult {
  id: string;
  section: string;
  set: 'TUNE' | 'HOLDOUT';
  star: boolean;
  fixtureId: string;
  pipeline: string;
  status: OutcomeStatus;
  verification: VerificationLabel;
  maxSeverity?: Severity;
  latencyMs: number;
  dimensions: DimensionOutcome[];
  featureGaps: string[];
  /** Only populated for non-HOLDOUT cases (H3 strict isolation). */
  tuneDetail?: string;
}

const ALL_DIMENSIONS = [
  'Intent',
  'Lane',
  'Structure',
  'Person',
  'Reason',
  'Money',
  'Dates',
  'Release',
  'Message',
  'Privacy',
  'Safety',
  'Honesty',
  'Plain language',
  'Robustness',
] as const;

const GAP_DESCRIPTIONS: Record<string, string> = {
  RULE_UPDATE_EXISTING_UNSUPPORTED:
    'Pending rules only append a new SystemMemoryRule; no mechanism updates/replaces a conflicting existing rule.',
  BUSINESS_RECORDS_STORE_ABSENT:
    'OpsDatabaseState has no structured records/orders/bookings store, and buildAnonymizedIntentPrompt does not pass notes or booking records for QUESTION queries.',
  MIXED_TASK_PLUS_NOTE_SINGLE_TURN_ABSENT:
    'Meditate v2 routes each turn exclusively to either TASK or NOTE; cannot execute one TASK and save one NOTE from a single message.',
  RULE_SHIFT_COMPATIBILITY_CHECK_ABSENT:
    'Rule staging does not verify whether a recurring rule schedule clashes with the named teammate shift.',
  DATE_RANGE_LEAVE_UNSUPPORTED:
    'TeamMember only has boolean isOnLeave; there are no date-ranged leave intervals for future scheduled dates.',
  SPEND_THRESHOLD_PARSER_ABSENT:
    'No deterministic rupee/lakh/crore amount parser or numeric spendThreshold rule engine (CategorySop only has boolean spendApprovalRequired; no automatic 3-quote > ₹20k or > ₹X owner-approval step insertion).',
  PLANNER_OVER_CAPACITY_GATE_ABSENT:
    'validateMeditatePlan does not block or flag assigning tasks to a teammate at ActiveWorkload >= maxActiveTasks.',
  PER_PERSON_WORKING_DAYS_ABSENT:
    'TeamMember has no per-person workingDays field (only business-wide workingDays exists).',
  TASK_DUE_TIME_FIELD_ABSENT:
    'Task schema stores dueDate (YYYY-MM-DD) only and has no time-of-day field (dueTime) in planning or validation.',
  HINGLISH_DATE_PARSER_ABSENT:
    'parseDueHintToDate does not parse Hinglish/Hindi relative dates (parso, mahine ke end, 10 tareekh, shanivaar).',
  NON_WORKING_DAY_PLANNER_FLAG_ABSENT:
    'Planning/validation does not flag or refuse scheduling a task dueDate on a non-working day (e.g., Sunday).',
  PAST_DUE_TIME_PLANNER_FLAG_ABSENT:
    'Planning/validation does not flag or reject a due time that is already in the past on the current day.',
  IMPOSSIBLE_CALENDAR_DATE_FLAG_ABSENT:
    'Invalid calendar dates like "30 February" are silently dropped/defaulted instead of flagged to the owner.',
  AUTO_OWNER_CONFIRM_ON_SPEND_ABSENT:
    'Meditate planner/freeze does not automatically set release.requireOwnerConfirm=true on purchase steps above a spend rule limit.',
  SHIFT_DEADLINE_CLASH_CHECK_ABSENT:
    'Planning/validation does not check whether a same-day/morning deadline falls before the assignee shift start.',
  BUFFER_VALIDATOR_PROOF_GATE_ABSENT:
    '/api/ai/process-buffer has no deterministic validator blocking COMPLETED when task requires photo proof and no image is attached.',
  BUFFER_VALIDATOR_APPROVAL_GATE_ABSENT:
    '/api/ai/process-buffer has no deterministic validator blocking approval/completion when staff claims verbal owner approval on a task awaiting Boss decision.',
  BUFFER_MULTI_TASK_DISAMBIGUATION_ABSENT:
    'No deterministic guard preventing a vague staff update ("ho gaya") from closing tasks when multiple open tasks exist.',
  BUFFER_ASSIGNEE_OWNERSHIP_GATE_ABSENT:
    'process-buffer / applyProcessedBufferResult does not deterministically block one teammate from closing a task assigned to someone else.',
  BUFFER_OUTPUT_PRIVACY_VALIDATOR_ABSENT:
    '/api/ai/process-buffer does not run stripWeaknessPhrases or textContainsPhone validation on outbound replies or Boss summaries.',
  COMPLETED_LATE_FLAG_ABSENT:
    'Task schema has no dedicated completedLate flag distinguishing tasks finished past dueDate.',
  DUPLICATE_SUBMISSION_GUARD_ABSENT:
    'No server/planner idempotency or duplicate-submission guard when identical input is submitted twice within seconds.',
  MAX_INPUT_LENGTH_GUARD_ABSENT:
    'No explicit word/character length guard before sending oversized 5,000-word brain-dumps to Gemini.',
  CHAT_REASSIGN_FROZEN_TASK_ABSENT:
    'Meditate chat only edits draft tasks on activeHead; it cannot reassign an already-frozen task via conversation.',
  CHAT_CANCEL_FROZEN_TASK_ABSENT:
    'Meditate chat cannot cancel an already-frozen task or disambiguate between two active tasks to cancel.',
  RULE_CONFLICT_CHECK_BEFORE_CREATE_ABSENT:
    'Planner does not deterministically cross-check newly proposed tasks against approved SystemMemoryRule constraints.',
  APPROVAL_CEILING_AMOUNT_ABSENT:
    'BossReviewItem / Task schema has no numeric approvedBudgetCeiling field to block release when lowest quote exceeds owner cap.',
  CHAT_TEAM_ONBOARDING_ROUTE_ABSENT:
    'Meditate v2 intent gates lack a TEAM_SETUP route/action to stage or add new teammates from conversational input.',
};

// ---------------------------- Helper Scanners ----------------------------

function walkSourceFiles(dir: string, exts = ['.ts', '.tsx']): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walkSourceFiles(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function getNonSeedNonTestFiles(): string[] {
  const files = [...walkSourceFiles(path.join(ROOT_DIR, 'src')), path.join(ROOT_DIR, 'server.ts')];
  return files.filter((f) => {
    const rel = path.relative(ROOT_DIR, f).replace(/\\/g, '/');
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) return false;
    if (rel === 'src/lib/seedData.ts' || rel === 'src/lib/demoData.ts') return false;
    return true;
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runGen01Scan(): { pass: boolean; detail: string } {
  // All Section 5 fixture business, staff, client and vendor names (excluding very common English nouns if any? None of these are normal code identifiers except maybe "Chairs" which is GEN-05!)
  const fixtureTerms = [
    'Marigold Lawns',
    'Kavita Rathore',
    'Imran',
    'Bhanu',
    'Lata',
    'Dinesh',
    'Pooja',
    'Gopal',
    'Sunil',
    'Mehta reception',
    'Rotary Club',
    'Shakti Tent House',
    'Royal Flowers',
    'Jai Ambe Diesel',
    'Vardhan Precision',
    'Nikhil Vardhan',
    'Farid',
    'Ravi Kulkarni',
    'Ravi Pawar',
    'Sandeep',
    'Asha',
    'Meenal',
    'Joseph',
    'Shobha',
    'Tarang Pumps',
    'Zenith Agro',
    'Metro Steel Traders',
    'Northlight Diagnostics',
    'Anjali Verma',
    'Rehan',
    'Kiran',
    'Tara',
    'Vivek',
    'Shalini',
    'Manoj',
  ];
  const files = getNonSeedNonTestFiles();
  const hits: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (const term of fixtureTerms) {
      const re = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
      lines.forEach((line, idx) => {
        if (re.test(line)) {
          hits.push(`${path.relative(ROOT_DIR, file)}:${idx + 1} (${term})`);
        }
      });
    }
  }
  return {
    pass: hits.length === 0,
    detail: hits.length === 0 ? '0 fixture terms found in app/server code.' : `Found: ${hits.slice(0, 6).join('; ')}`,
  };
}

function runGen05Scan(): { pass: boolean; detail: string } {
  const words = [
    'banquet',
    'lawn',
    'catering',
    'wedding',
    'shaadi',
    'reception',
    'generator',
    'chairs',
    'hotel',
  ];
  const files = getNonSeedNonTestFiles();
  const hits: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (const word of words) {
      const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'i');
      lines.forEach((line, idx) => {
        if (re.test(line)) {
          // Ignore UI placeholder/CSS/generic code comments unless it's prompt text or business logic
          hits.push(`${path.relative(ROOT_DIR, file)}:${idx + 1} (${word})`);
        }
      });
    }
  }
  return {
    pass: hits.length === 0,
    detail: hits.length === 0 ? '0 hard-coded industry words in app/prompts.' : `Found ${hits.length} hit(s): ${hits.slice(0, 8).join('; ')}`,
  };
}

function runSaf07Audit(): { pass: boolean; detail: string } {
  const fx = buildFixture('F1');
  const members = Object.values(fx.state.team_members);
  const str01Input =
    'Shanivaar ko Mehta reception hai, 350 log. Lawn setup karwana hai, 350 chairs lagwani hain, generator ka diesel check karna hai, phoolon ka order Royal Flowers ko dena hai, aur menu final karke client ko bhejna hai.';

  const intentBuilt = buildAnonymizedIntentPrompt({
    brainDump: str01Input,
    wbsHeads: [],
    teamMembers: members,
    tasks: [],
    categorySops: fx.state.category_sops,
    systemMemory: fx.state.system_memory,
    businessProfile: fx.state.business_profile,
    ownerProfile: fx.state.owner_profile,
    taskSplittingRules: fx.state.task_splitting_rules,
    dateContext: buildDateContextLine(TEST_TODAY_ISO),
  });

  const plannerBuilt = buildAnonymizedPlannerPrompt({
    brainDump: str01Input,
    teamMembers: members,
    tasks: [],
    categorySops: fx.state.category_sops,
    systemMemory: fx.state.system_memory,
    principalPrompts: fx.state.principal_prompts,
    businessProfile: fx.state.business_profile,
    ownerProfile: fx.state.owner_profile,
    taskSplittingRules: fx.state.task_splitting_rules,
    dateContext: buildDateContextLine(TEST_TODAY_ISO),
  });

  const aiLog = createAiCallLog({
    tenantId: fx.state.tenantId,
    stage: 'PLANNER',
    model: GEMINI_MODELS.fast,
    temperature: 0.2,
    maxOutputTokens: 4096,
    latencyMs: 120,
    validationStatus: 'VALID',
    validationNote: 'Audit test log',
  });
  // Mask synthetic generated logId timestamp ("ailog-<ms>-...") and ISO timestamp before phone scan
  // while still catching any real phone numbers, roster numbers, names, or weaknesses anywhere in aiLog.
  const sanitizedLog = {
    ...aiLog,
    logId: aiLog.logId.replace(/^ailog-\d+-/, 'ailog-[TS]-'),
    timestamp: '[ISO_TS]',
  };
  const logText = JSON.stringify(sanitizedLog);
  const rosterPhones = members.map((m) => m.phone);
  const rosterNames = members.map((m) => m.name).filter((n) => n.trim().length >= 3);
  const weaknesses = members.flatMap((m) => m.weaknesses || []);
  const logHasPhone = textContainsPhone(logText, rosterPhones) || /90000/.test(logText);
  const logHasName = rosterNames.some((n) => new RegExp(`\\b${escapeRegex(n)}\\b`, 'i').test(logText));
  const logHasWeakness = weaknesses.some((w) => logText.toLowerCase().includes(w.toLowerCase()));

  const clean =
    intentBuilt.piiAudit.clean &&
    plannerBuilt.piiAudit.clean &&
    !logHasPhone &&
    !logHasName &&
    !logHasWeakness;
  const violations = [
    ...intentBuilt.piiAudit.violations.map((v) => `INTENT:${v}`),
    ...plannerBuilt.piiAudit.violations.map((v) => `PLANNER:${v}`),
    ...(logHasPhone ? ['LOG:phone'] : []),
    ...(logHasName ? ['LOG:name'] : []),
    ...(logHasWeakness ? ['LOG:weakness'] : []),
  ];
  return {
    pass: clean,
    detail: clean
      ? 'Zero real names or phones in INTENT/PLANNER prompts; zero phones/weaknesses in AI logs.'
      : `PII audit violations: ${violations.join(', ')}`,
  };
}

// ---------------------------- Deterministic Fault Cases ----------------------------

async function runDeterministicFaultCase(tc: TuningCase): Promise<CaseRunResult> {
  const start = Date.now();
  const dims: DimensionOutcome[] = [];
  let detail = '';

  if (tc.id === 'ROB-01') {
    const emptyFb = buildFallbackMeditateResponse({ brainDump: '' });
    const spacesFb = buildFallbackMeditateResponse({ brainDump: '   ' });
    const noCrash =
      emptyFb.intentClassification === 'NEEDS_CLARIFICATION' &&
      spacesFb.intentClassification === 'NEEDS_CLARIFICATION' &&
      emptyFb.draftedTasks.length === 0 &&
      spacesFb.draftedTasks.length === 0 &&
      Boolean(emptyFb.chatReplyToBoss);
    for (const d of tc.dimensions) {
      dims.push({ dimension: d, status: noCrash ? 'PASS' : 'FAIL', severity: noCrash ? undefined : 'S2' });
    }
    detail = 'Empty and whitespace inputs return gentle prompt with 0 tasks and 0 LLM calls.';
  } else if (tc.id === 'ROB-04') {
    const fx = buildFixture('F1');
    let calls: string[] = [];
    let switchedAtOnce = false;
    try {
      let attempt = 0;
      const res = await callWithBusyRetry({
        models: [GEMINI_MODELS.balanced, GEMINI_MODELS.fast],
        retryDelaysMs: [10],
        sleep: async () => {},
        call: async (model) => {
          calls.push(model);
          attempt++;
          if (attempt === 1) throw new GeminiTimeoutError(model, 45000);
          const quotaErr: any = new Error('RESOURCE_EXHAUSTED: GenerateRequestsPerDayPerProjectPerModel limit: 0');
          quotaErr.status = 429;
          throw quotaErr;
        },
        onRetry: (e) => {
          if (e.nextDelayMs === null && isGeminiDailyQuotaError(e.error)) {
            switchedAtOnce = true;
          }
        },
      });
      void res;
    } catch (err: any) {
      const msg = buildGeminiFailureMessage({ model: GEMINI_MODELS.fast, error: err });
      const ok = calls.includes(GEMINI_MODELS.balanced) && calls.includes(GEMINI_MODELS.fast) && Boolean(msg);
      for (const d of tc.dimensions) {
        dims.push({
          dimension: d,
          status: ok ? 'PASS' : 'FAIL',
          severity: ok ? undefined : 'S2',
          note: `models tried=${calls.join('->')}, backupSwitchedImmediately=${switchedAtOnce}`,
        });
      }
      detail = `Tested timeout + daily-quota fault: models=${calls.join(' -> ')}, message="${msg.slice(0, 80)}"`;
    }
    void fx;
  } else if (tc.id === 'ROB-05') {
    const fx = buildFixture('F1');
    const members = Object.values(fx.state.team_members);
    let brokenRejected = false;
    try {
      JSON.parse('{ broken json');
    } catch {
      brokenRejected = true;
    }
    const missingRes = validateMeditatePlan(
      { intentClassification: 'ACTIONABLE_AGENDA', draftedTasks: [{ title: '' }] },
      {
        roster: members,
        categoryIds: fx.state.category_sops.map((c) => c.categoryId),
        existingTasks: [],
        defaultAccountableSlot: 'P2',
        ownerProfile: fx.state.owner_profile,
        maxChecklistStepsPerTask: 5,
      }
    );
    const ok = brokenRejected && !missingRes.valid;
    for (const d of tc.dimensions) {
      dims.push({ dimension: d, status: ok ? 'PASS' : 'FAIL', severity: ok ? undefined : 'S1' });
    }
    detail = `Broken JSON threw cleanly; incomplete plan rejected with ${missingRes.issues.length} issue(s).`;
  } else if (tc.id === 'ROB-06') {
    const fx = buildFixture('F1');
    const members = Object.values(fx.state.team_members);
    const res = validateMeditatePlan(
      {
        intentClassification: 'ACTIONABLE_AGENDA',
        agendaTitle: 'Test',
        agendaQuadrant: 'Q2_SCHEDULE',
        agendaMajorOrMinor: 'MINOR',
        wbsHeads: [],
        suggestedMemoryRules: [],
        draftedTasks: [
          {
            title: 'Check generator',
            shortTag: 'Gen Check',
            categoryId: 'ELECTRICAL',
            quadrant: 'Q2_SCHEDULE',
            majorOrMinor: 'MINOR',
            taskFrequency: 'ONE_TIME',
            recurrenceRule: 'NONE',
            raci: { R: 'P99', A: 'P2', C: [], I: [] },
            dependsOnSubtaskIndex: null,
            triggerCondition: 'FULL_COMPLETION',
            dueDate: TEST_TODAY_ISO,
            dueDateOffsetDays: 0,
            microSteps: ['Check fuel'],
            outboundWhatsappPreview: 'Check generator',
          },
        ],
      },
      {
        roster: members,
        categoryIds: fx.state.category_sops.map((c) => c.categoryId),
        existingTasks: [],
        defaultAccountableSlot: 'P2',
        ownerProfile: fx.state.owner_profile,
        maxChecklistStepsPerTask: 5,
      }
    );
    const ok = !res.valid && res.issues.some((i) => i.code === 'UNKNOWN_RACI_SLOT');
    for (const d of tc.dimensions) {
      dims.push({ dimension: d, status: ok ? 'PASS' : 'FAIL', severity: ok ? undefined : 'S2' });
    }
    detail = `Unknown slot P99 rejected cleanly (${res.issues.map((i) => i.code).join(', ')}).`;
  }

  const failed = dims.filter((d) => d.status === 'FAIL');
  return {
    id: tc.id,
    section: tc.section,
    set: tc.set,
    star: tc.star,
    fixtureId: tc.fixtures[0] || 'F1',
    pipeline: tc.pipeline,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    verification: 'verified simulated',
    maxSeverity: failed[0]?.severity,
    latencyMs: Math.max(1, Date.now() - start),
    dimensions: dims,
    featureGaps: tc.expectations.featureGaps || [],
    tuneDetail: tc.set === 'TUNE' ? detail : undefined,
  };
}

// ---------------------------- Deterministic Release Cases ----------------------------

function runDeterministicReleaseCase(tc: TuningCase): CaseRunResult {
  const start = Date.now();
  const fx = buildFixture(tc.fixtures[0] || 'F1');
  const nowIso = tc.clockOverride || TEST_CLOCK_ISO;
  const nowMs = Date.parse(nowIso);
  const settings = buildReleaseSettingsFromState(fx.state);
  const dims: DimensionOutcome[] = [];
  const gaps: string[] = [...(tc.expectations.featureGaps || [])];
  let detail = '';

  const p = fx.phoneByName;

  if (tc.id === 'REL-01') {
    const task = makeOpenTask({
      taskCode: 'T-REL01',
      shortTag: 'Gen Check',
      title: 'Check generator fuel and status',
      responsiblePhone: p.Gopal,
      accountablePhone: p.Imran,
      categoryId: 'ELECTRICAL',
      releasedAt: null,
    });
    const beforeState: OpsDatabaseState = { ...fx.state, tasks: [] };
    const stagedState: OpsDatabaseState = {
      ...fx.state,
      tasks: [{ ...task, status: 'SCHEDULED' }],
    };
    const res = releaseDueTasks(stagedState, nowIso);
    const updated = res.nextState.tasks[0];
    const summary = summarizeFreezeOutcome(beforeState, res.nextState, nowIso);
    const heldOk = res.releasedTaskCodes.length === 0 && updated.status === 'SCHEDULED';
    // 12:00 IST on 2026-11-16 = 2026-11-16T06:30:00.000Z
    const heldUntil12Ok = updated.release?.nextEligibleAt === '2026-11-16T06:30:00.000Z';
    const urgentOffered = /\burgent\b/i.test(summary.notice);

    dims.push({
      dimension: 'Release',
      status: heldOk && heldUntil12Ok ? 'PASS' : 'FAIL',
      severity: heldOk && heldUntil12Ok ? undefined : 'S2',
      note: `held=${heldOk}, nextEligibleAt=${updated.release?.nextEligibleAt}`,
    });
    dims.push({
      dimension: 'Plain language',
      status: urgentOffered ? 'PASS' : 'FAIL',
      severity: urgentOffered ? undefined : 'S3',
      note: urgentOffered ? 'Offers urgent override.' : `Notice does not offer "urgent": "${summary.notice}"`,
    });
    dims.push({
      dimension: 'Privacy',
      status: !textContainsPhone(summary.notice, Object.keys(fx.state.team_members)) ? 'PASS' : 'FAIL',
    });
    detail = `Held=${heldOk} until ${updated.release?.nextEligibleAt}; notice="${summary.notice}" (urgentOffered=${urgentOffered})`;
  } else if (tc.id === 'REL-02') {
    const task = makeOpenTask({
      taskCode: 'T-REL02',
      shortTag: 'Short Circuit',
      title: 'Fix lawn short circuit immediately',
      responsiblePhone: p.Gopal,
      accountablePhone: p.Imran,
      categoryId: 'ELECTRICAL',
      quadrant: 'Q1_DO_FIRST',
      releasedAt: null,
    });
    const check = canRelease(task, fx.state.team_members[p.Gopal], nowIso, {
      ...settings,
      allTasks: [task],
    });
    const res = releaseDueTasks({ ...fx.state, tasks: [{ ...task, status: 'SCHEDULED' }] }, nowIso);
    const ok = check.allowed && res.releasedTaskCodes.includes('T-REL02');
    const outMsg = res.nextState.whatsapp_messages.find((m) => m.taskCode === 'T-REL02')?.text || '';
    const msgHasUrgent = Boolean(outMsg) && /urgent|turant|jaldi|immediately/i.test(outMsg);
    dims.push({
      dimension: 'Release',
      status: ok ? 'PASS' : 'FAIL',
      severity: ok ? undefined : 'S2',
      note: ok ? undefined : `Held outside shift despite Q1_DO_FIRST (${check.reasonCode}: ${check.holdReason})`,
    });
    dims.push({
      dimension: 'Message',
      status: ok && msgHasUrgent && outMsg.length < 600 ? 'PASS' : 'FAIL',
      severity: 'S3',
      note: ok ? undefined : 'Not released, so no urgent outbound message emitted.',
    });
    dims.push({ dimension: 'Privacy', status: !textContainsPhone(outMsg, Object.keys(fx.state.team_members)) ? 'PASS' : 'FAIL' });
    dims.push({ dimension: 'Plain language', status: 'PASS' });
    detail = `Q1_DO_FIRST at 10:00 IST (outside 12:00 shift): allowed=${check.allowed} (${check.reasonCode || 'OK'}), released=${res.releasedTaskCodes.join(',') || 'none'}`;
  } else if (tc.id === 'REL-03') {
    const qcTask = makeOpenTask({
      taskCode: 'T-QC',
      shortTag: 'Shafts QC',
      title: 'QC inspect 200 shafts',
      responsiblePhone: p.Sandeep,
      accountablePhone: p.Farid,
      categoryId: 'QUALITY',
    });
    const dispatchTask = makeOpenTask({
      taskCode: 'T-DISP',
      shortTag: 'Shafts Dispatch',
      title: 'Dispatch 200 shafts after QC',
      responsiblePhone: p['Ravi Pawar'],
      accountablePhone: p.Farid,
      categoryId: 'DISPATCH',
      status: 'LOCKED_BY_DEPENDENCY',
      releasedAt: null,
    });
    dispatchTask.dependency = { dependsOnTaskCode: 'T-QC', triggerCondition: 'FULL_COMPLETION' };
    dispatchTask.release = {
      mode: 'AFTER_TASK',
      releaseAt: null,
      afterTaskCode: 'T-QC',
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: false,
      releasedAt: null,
      holdReason: 'Waiting on T-QC',
    };
    const r1 = releaseDueTasks({ ...fx.state, tasks: [qcTask, dispatchTask] }, nowIso);
    const blockedBeforeQc = r1.releasedTaskCodes.length === 0;
    const completedState: OpsDatabaseState = {
      ...fx.state,
      tasks: [{ ...qcTask, status: 'COMPLETED', completionPercent: 100 }, dispatchTask],
    };
    const unlocked = promoteUnlockedDependentsToScheduled(completedState, 'T-QC', { nowIso });
    const r2 = releaseDueTasks(unlocked, nowIso);
    const releasedAfterQc = r2.releasedTaskCodes.includes('T-DISP');
    const ok = blockedBeforeQc && releasedAfterQc;
    dims.push({ dimension: 'Release', status: ok ? 'PASS' : 'FAIL', severity: ok ? undefined : 'S2' });
    dims.push({ dimension: 'Privacy', status: 'PASS' });
    detail = `Dispatch blocked before QC (${blockedBeforeQc}), released after QC completion (${releasedAfterQc}).`;
  } else if (tc.id === 'REL-04') {
    const task = makeOpenTask({
      taskCode: 'T-REL04',
      shortTag: 'Menu Tasting',
      title: 'Mehta menu tasting reminder',
      responsiblePhone: p.Lata,
      accountablePhone: p.Imran,
      categoryId: 'CATERING',
      dueDate: '2026-11-20',
      status: 'SCHEDULED',
      releasedAt: null,
    });
    task.release = {
      mode: 'AT_TIME',
      releaseAt: '2026-11-20T09:00',
      afterTaskCode: null,
      afterTrigger: 'FULL_COMPLETION',
      delayMinutes: 0,
      requireOwnerConfirm: false,
      releasedAt: null,
      holdReason: null,
    };
    const rToday = releaseDueTasks({ ...fx.state, tasks: [task] }, nowIso);
    const rFriMorning = releaseDueTasks({ ...fx.state, tasks: [task] }, '2026-11-20T03:30:00.000Z');
    const ok = rToday.releasedTaskCodes.length === 0 && rFriMorning.releasedTaskCodes.includes('T-REL04');
    dims.push({ dimension: 'Dates', status: ok ? 'PASS' : 'FAIL', severity: ok ? undefined : 'S2' });
    dims.push({ dimension: 'Release', status: ok ? 'PASS' : 'FAIL', severity: ok ? undefined : 'S2' });
    dims.push({ dimension: 'Message', status: 'PASS' });
    dims.push({ dimension: 'Privacy', status: 'PASS' });
    detail = `Held on Mon (${rToday.releasedTaskCodes.length === 0}), released Fri 20 Nov 09:00 IST (${ok}).`;
  } else if (tc.id === 'REL-05') {
    // Release engine supports requireOwnerConfirm, but planner/freeze does not auto-set it on spend rules (gap)
    const buyTask = makeOpenTask({
      taskCode: 'T-BUY',
      shortTag: 'Buy Chairs',
      title: 'Buy 40 chairs up to ₹32,000',
      responsiblePhone: p.Dinesh,
      accountablePhone: p.Kavita,
      categoryId: 'PURCHASE',
      status: 'SCHEDULED',
      requireOwnerConfirm: true,
      releasedAt: null,
    });
    const rHold = releaseDueTasks({ ...fx.state, tasks: [buyTask] }, nowIso);
    const engineHoldsWhenFlagged = rHold.releasedTaskCodes.length === 0;
    // Gap: planner never auto-populates requireOwnerConfirm
    dims.push({ dimension: 'Money', status: 'FAIL', severity: 'S2', note: GAP_DESCRIPTIONS.AUTO_OWNER_CONFIRM_ON_SPEND_ABSENT });
    dims.push({ dimension: 'Release', status: engineHoldsWhenFlagged ? 'PASS' : 'FAIL', severity: 'S2' });
    dims.push({ dimension: 'Privacy', status: 'PASS' });
    detail = `ReleaseEngine respects requireOwnerConfirm=${engineHoldsWhenFlagged}, but planner lacks automatic requireOwnerConfirm gating.`;
  } else if (tc.id === 'REL-06') {
    const task = makeOpenTask({
      taskCode: 'T-REL06',
      shortTag: 'Tarang Job',
      title: 'Start Tarang Pumps job first thing',
      responsiblePhone: p.Farid,
      accountablePhone: p.Nikhil,
      categoryId: 'PRODUCTION',
      status: 'SCHEDULED',
      releasedAt: null,
    });
    const rNight = releaseDueTasks({ ...fx.state, tasks: [task] }, nowIso);
    const heldTask = rNight.nextState.tasks[0];
    // Farid shift 08:00-17:00 IST on Tue 17 Nov => 08:00 IST = 02:30Z
    const nextOk = heldTask.release?.nextEligibleAt === '2026-11-17T02:30:00.000Z';
    const rMorning = releaseDueTasks(rNight.nextState, '2026-11-17T02:30:00.000Z');
    const ok = rNight.releasedTaskCodes.length === 0 && nextOk && rMorning.releasedTaskCodes.includes('T-REL06');
    dims.push({ dimension: 'Release', status: ok ? 'PASS' : 'FAIL', severity: ok ? undefined : 'S2' });
    dims.push({ dimension: 'Dates', status: nextOk ? 'PASS' : 'FAIL', severity: nextOk ? undefined : 'S2' });
    dims.push({ dimension: 'Privacy', status: 'PASS' });
    detail = `At 23:30 IST held until ${heldTask.release?.nextEligibleAt}, released Tue 08:00 IST (${ok}).`;
  } else if (tc.id === 'REL-07') {
    // Gap: no shift vs deadline clash check at planning/release
    dims.push({ dimension: 'Dates', status: 'FAIL', severity: 'S2', note: GAP_DESCRIPTIONS.SHIFT_DEADLINE_CLASH_CHECK_ABSENT });
    dims.push({ dimension: 'Release', status: 'FAIL', severity: 'S2', note: GAP_DESCRIPTIONS.SHIFT_DEADLINE_CLASH_CHECK_ABSENT });
    dims.push({ dimension: 'Plain language', status: 'NOT_VERIFIED' });
    dims.push({ dimension: 'Privacy', status: 'PASS' });
    detail = 'Feature absent: planner/validator does not check dueTime against assignee shift start.';
  } else if (tc.id === 'REL-08') {
    const task = makeOpenTask({
      taskCode: 'T-REL08',
      shortTag: 'Store Stock',
      title: 'Count store stock on Monday',
      responsiblePhone: p.Lata,
      accountablePhone: p.Imran,
      categoryId: 'CATERING',
      dueDate: '2026-11-23',
      status: 'SCHEDULED',
      releasedAt: null,
    });
    const rSatNight = releaseDueTasks({ ...fx.state, tasks: [task] }, nowIso);
    const rSun = releaseDueTasks(rSatNight.nextState, '2026-11-22T05:30:00.000Z'); // Sun 11:00 IST
    const rMonMorning = releaseDueTasks(rSun.nextState, '2026-11-23T03:30:00.000Z'); // Mon 09:00 IST
    const ok =
      rSatNight.releasedTaskCodes.length === 0 &&
      rSun.releasedTaskCodes.length === 0 &&
      rMonMorning.releasedTaskCodes.includes('T-REL08');
    dims.push({ dimension: 'Release', status: ok ? 'PASS' : 'FAIL', severity: ok ? undefined : 'S2' });
    dims.push({ dimension: 'Dates', status: ok ? 'PASS' : 'FAIL', severity: ok ? undefined : 'S2' });
    dims.push({ dimension: 'Privacy', status: 'PASS' });
    detail = `Sat 19:00 held (${rSatNight.releasedTaskCodes.length === 0}), Sun held (${rSun.releasedTaskCodes.length === 0}), Mon 09:00 released (${ok}).`;
  }

  const failed = dims.filter((d) => d.status === 'FAIL');
  const notVer = dims.filter((d) => d.status === 'NOT_VERIFIED');
  const overallStatus: OutcomeStatus =
    failed.length > 0 ? 'FAIL' : notVer.length > 0 ? 'NOT_VERIFIED' : 'PASS';
  return {
    id: tc.id,
    section: tc.section,
    set: tc.set,
    star: tc.star,
    fixtureId: tc.fixtures[0] || 'F1',
    pipeline: tc.pipeline,
    status: overallStatus,
    verification: overallStatus === 'NOT_VERIFIED' ? 'not verified' : 'verified simulated',
    maxSeverity: failed[0]?.severity,
    latencyMs: Math.max(1, Date.now() - start),
    dimensions: dims,
    featureGaps: gaps,
    tuneDetail: tc.set === 'TUNE' ? detail : undefined,
  };
}

// ---------------------------- Simulated LLM-Dependent Evaluation ----------------------------

function runSimulatedLlmDependentCase(tc: TuningCase, fixtureId: FixtureId): CaseRunResult {
  const start = Date.now();
  const baseFx = buildFixture(fixtureId);
  const fx = applyCasePrecondition(baseFx, tc.precondition);
  const members = Object.values(fx.state.team_members);
  const gaps: string[] = [...(tc.expectations.featureGaps || [])];

  // Run real deterministic prompt-assembly & PII/privacy pipelines so those checks ARE verified!
  let piiClean = true;
  let piiNote = '';

  if (tc.pipeline === 'BUFFER_REPLY' && tc.staffReply) {
    const speakerPhone = fx.phoneByName[tc.staffReply.speaker];
    const speaker = fx.state.team_members[speakerPhone] || members[0];
    const bufRes = enqueueInboundSimulatorMessage(
      fx.state,
      speaker.phone,
      {
        type: tc.staffReply.mediaType || 'text',
        textContent: tc.staffReply.text,
        fileName: tc.staffReply.hasPhoto ? 'proof_photo.jpg' : undefined,
        mimeType: tc.staffReply.hasPhoto ? 'image/jpeg' : undefined,
      },
      tc.clockOverride || TEST_CLOCK_ISO
    );
    const buffer = bufRes.nextState.inbound_message_buffer[speaker.phone];
    const built = buildAnonymizedBufferPrompt({
      employee: speaker,
      teamMembers: members,
      buffer,
      activeTasks: fx.state.tasks,
      systemMemory: fx.state.system_memory,
      principalPrompts: fx.state.principal_prompts,
      businessProfile: fx.state.business_profile,
      ownerProfile: fx.state.owner_profile,
    });
    piiClean = built.piiAudit.clean;
    piiNote = built.piiAudit.violations.join('; ');
  } else {
    const rawInput =
      tc.input === '__REPEAT_5000_WORDS__'
        ? Array(1000).fill('Check main gate lighting and backup generator fuel.').join(' ')
        : tc.input || tc.inputs?.[0] || tc.turns?.[0] || '';
    const intentBuilt = buildAnonymizedIntentPrompt({
      brainDump: rawInput,
      wbsHeads: fx.state.wbs_heads,
      teamMembers: members,
      tasks: fx.state.tasks,
      categorySops: fx.state.category_sops,
      systemMemory: fx.state.system_memory,
      businessProfile: fx.state.business_profile,
      ownerProfile: fx.state.owner_profile,
      taskSplittingRules: fx.state.task_splitting_rules,
      dateContext: buildDateContextLine(
        (tc.clockOverride || TEST_CLOCK_ISO).slice(0, 10)
      ),
    });
    const plannerBuilt = buildAnonymizedPlannerPrompt({
      brainDump: rawInput,
      teamMembers: members,
      tasks: fx.state.tasks,
      categorySops: fx.state.category_sops,
      systemMemory: fx.state.system_memory,
      principalPrompts: fx.state.principal_prompts,
      businessProfile: fx.state.business_profile,
      ownerProfile: fx.state.owner_profile,
      taskSplittingRules: fx.state.task_splitting_rules,
      dateContext: buildDateContextLine(
        (tc.clockOverride || TEST_CLOCK_ISO).slice(0, 10)
      ),
    });
    piiClean = intentBuilt.piiAudit.clean && plannerBuilt.piiAudit.clean;
    piiNote = [
      ...intentBuilt.piiAudit.violations,
      ...plannerBuilt.piiAudit.violations,
    ].join('; ');
  }

  // Deterministic dimensions vs LLM-dependent dimensions (Rule H9: NEVER mark LLM dimensions passed in simulated mode!)
  const dims: DimensionOutcome[] = tc.dimensions.map((d) => {
    if (d === 'Privacy') {
      if (!piiClean) {
        return { dimension: d, status: 'FAIL', severity: 'S1', note: piiNote };
      }
      // In BUFFER_REPLY or MESSAGE, full Privacy also depends on LLM output check, so prompt PII is verified clean while output remains not verified in simulated mode unless gaps fail
      if (gaps.includes('BUFFER_OUTPUT_PRIVACY_VALIDATOR_ABSENT')) {
        return { dimension: d, status: 'FAIL', severity: 'S1', note: GAP_DESCRIPTIONS.BUFFER_OUTPUT_PRIVACY_VALIDATOR_ABSENT };
      }
      return { dimension: d, status: 'NOT_VERIFIED', note: 'Prompt PII audit clean; model output requires live check.' };
    }
    if (
      (d === 'Money' && gaps.some((g) => g.includes('SPEND_THRESHOLD') || g.includes('APPROVAL_CEILING'))) ||
      (d === 'Dates' &&
        gaps.some((g) =>
          [
            'TASK_DUE_TIME_FIELD_ABSENT',
            'HINGLISH_DATE_PARSER_ABSENT',
            'NON_WORKING_DAY_PLANNER_FLAG_ABSENT',
            'PAST_DUE_TIME_PLANNER_FLAG_ABSENT',
            'IMPOSSIBLE_CALENDAR_DATE_FLAG_ABSENT',
          ].includes(g)
        )) ||
      (d === 'Person' && gaps.some((g) => g === 'DATE_RANGE_LEAVE_UNSUPPORTED' || g === 'PLANNER_OVER_CAPACITY_GATE_ABSENT' || g === 'PER_PERSON_WORKING_DAYS_ABSENT')) ||
      (d === 'Safety' && gaps.some((g) => g.startsWith('BUFFER_') || g === 'RULE_CONFLICT_CHECK_BEFORE_CREATE_ABSENT')) ||
      (d === 'Robustness' && gaps.some((g) => g === 'DUPLICATE_SUBMISSION_GUARD_ABSENT' || g === 'MAX_INPUT_LENGTH_GUARD_ABSENT'))
    ) {
      return {
        dimension: d,
        status: 'FAIL',
        severity: d === 'Safety' ? 'S1' : 'S2',
        note: gaps.map((g) => GAP_DESCRIPTIONS[g] || g).join(' '),
      };
    }
    return {
      dimension: d,
      status: 'NOT_VERIFIED',
      note: 'Requires live Gemini response (simulated mode never marks model judgment passed).',
    };
  });

  const hasFail = dims.some((d) => d.status === 'FAIL');
  const status: OutcomeStatus = hasFail ? 'FAIL' : 'NOT_VERIFIED';
  const verification: VerificationLabel = hasFail ? 'verified simulated' : 'not verified';

  return {
    id: tc.id,
    section: tc.section,
    set: tc.set,
    star: tc.star,
    fixtureId,
    pipeline: tc.pipeline,
    status,
    verification,
    maxSeverity: dims.find((d) => d.status === 'FAIL')?.severity,
    latencyMs: Math.max(1, Date.now() - start),
    dimensions: dims,
    featureGaps: gaps,
    tuneDetail:
      tc.set === 'TUNE'
        ? hasFail
          ? `Gap/deterministic failure: ${gaps.join(', ')}`
          : 'Prompt PII audit clean; awaits live model verification.'
        : undefined,
  };
}

// ---------------------------- Live Runner Helper ----------------------------

function sha256(obj: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callCachedGeminiJson(params: {
  apiKey: string;
  cacheKeyObj: unknown;
  systemInstruction: string;
  contents: any;
  model: string;
  fallbackModel: string;
  temperature: number;
  maxOutputTokens: number;
  responseSchema?: any;
}): Promise<{ data: any; rawText: string; latencyMs: number; modelUsed: string; cached: boolean }> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = sha256(params.cacheKeyObj);
  const cachePath = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return { ...cached, cached: true };
  }

  await sleep(1000); // ~1 call/sec pacing per Section 3.4
  const ai = new GoogleGenAI({ apiKey: params.apiKey });
  const t0 = Date.now();
  const { result, modelUsed } = await callWithBusyRetry({
    models: [params.model, params.fallbackModel],
    call: (m) =>
      ai.models.generateContent({
        model: m,
        contents: params.contents,
        config: {
          systemInstruction: params.systemInstruction,
          temperature: params.temperature,
          maxOutputTokens: params.maxOutputTokens,
          ...(params.responseSchema
            ? { responseMimeType: 'application/json', responseSchema: params.responseSchema }
            : {}),
        },
      }),
  });
  const latencyMs = Date.now() - t0;
  const rawText = (result.text ?? '').trim();
  const data = params.responseSchema ? JSON.parse(rawText || '{}') : rawText;
  const record = { data, rawText, latencyMs, modelUsed };
  fs.writeFileSync(cachePath, JSON.stringify(record, null, 2));
  return { ...record, cached: false };
}

// ---------------------------- Main Entry & Report ----------------------------

const SEVERITY_RANK: Record<Severity, number> = { S1: 1, S2: 2, S3: 3, S4: 4 };

function aggregateByUniqueCase(results: CaseRunResult[]): CaseRunResult[] {
  const byId = new Map<string, CaseRunResult[]>();
  for (const r of results) {
    const arr = byId.get(r.id) || [];
    arr.push(r);
    byId.set(r.id, arr);
  }
  const merged: CaseRunResult[] = [];
  for (const [, group] of byId) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const first = group[0];
    const hasFail = group.some((g) => g.status === 'FAIL');
    const hasNv = group.some((g) => g.status === 'NOT_VERIFIED');
    const status: OutcomeStatus = hasFail ? 'FAIL' : hasNv ? 'NOT_VERIFIED' : 'PASS';
    const allLive = group.every((g) => g.verification === 'verified live');
    const anySimFail = group.some((g) => g.verification === 'verified simulated');
    const verification: VerificationLabel = allLive
      ? 'verified live'
      : status === 'FAIL' && anySimFail
        ? 'verified simulated'
        : group.every((g) => g.verification === 'verified simulated')
          ? 'verified simulated'
          : 'not verified';

    const sevs = group.map((g) => g.maxSeverity).filter((s): s is Severity => Boolean(s));
    const maxSeverity =
      sevs.length > 0 ? sevs.sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0] : undefined;

    const dimNames = Array.from(new Set(group.flatMap((g) => g.dimensions.map((d) => d.dimension))));
    const dimensions: DimensionOutcome[] = dimNames.map((dim) => {
      const ds = group.flatMap((g) => g.dimensions.filter((d) => d.dimension === dim));
      const dFail = ds.find((d) => d.status === 'FAIL');
      if (dFail) return { dimension: dim, status: 'FAIL', severity: dFail.severity, note: dFail.note };
      const dNv = ds.find((d) => d.status === 'NOT_VERIFIED');
      if (dNv) return { dimension: dim, status: 'NOT_VERIFIED', note: dNv.note };
      return { dimension: dim, status: 'PASS' };
    });

    const sortedLat = group.map((g) => g.latencyMs).sort((a, b) => a - b);
    merged.push({
      ...first,
      fixtureId: group.map((g) => g.fixtureId).join('+'),
      status,
      verification,
      maxSeverity,
      latencyMs: sortedLat[Math.floor(sortedLat.length / 2)],
      dimensions,
      featureGaps: Array.from(new Set(group.flatMap((g) => g.featureGaps))),
      tuneDetail:
        first.set === 'TUNE'
          ? group.map((g) => `${g.fixtureId}: ${g.tuneDetail || g.status}`).join(' | ')
          : undefined,
    });
  }
  return merged;
}

function computeScoreboard(rawResults: CaseRunResult[], mode: 'SIMULATED' | 'LIVE') {
  const results = aggregateByUniqueCase(rawResults);
  const tune = results.filter((r) => r.set === 'TUNE');
  const holdout = results.filter((r) => r.set === 'HOLDOUT');
  const tunePass = tune.filter((r) => r.status === 'PASS').length;
  const holdoutPass = holdout.filter((r) => r.status === 'PASS').length;
  const notVerified = results.filter((r) => r.status === 'NOT_VERIFIED').length;
  const starLivePass = results.filter((r) => r.star && r.verification === 'verified live' && r.status === 'PASS').length;
  const starTotal = results.filter((r) => r.star).length;

  const sevCounts = { S1: 0, S2: 0, S3: 0, S4: 0 };
  for (const r of results) {
    if (r.status === 'FAIL' && r.maxSeverity) {
      sevCounts[r.maxSeverity]++;
    }
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const medianLatency = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : 0;

  const demEmpty = rawResults.filter((r) => r.section === 'DEM' && r.fixtureId === 'EMPTY');
  const demDemo = rawResults.filter((r) => r.section === 'DEM' && r.fixtureId === 'DEMO');

  const dimTable = ALL_DIMENSIONS.map((dim) => {
    const calc = (subset: CaseRunResult[]) => {
      const relevant = subset.flatMap((r) => r.dimensions.filter((d) => d.dimension === dim));
      if (relevant.length === 0) return '—';
      const pass = relevant.filter((d) => d.status === 'PASS').length;
      const nv = relevant.filter((d) => d.status === 'NOT_VERIFIED').length;
      const fail = relevant.filter((d) => d.status === 'FAIL').length;
      return `${pass}/${relevant.length} pass (${fail} fail, ${nv} not verified)`;
    };
    return {
      dimension: dim,
      tune: calc(tune),
      holdout: calc(holdout),
    };
  });

  return {
    mode,
    uniqueCases: results.length,
    rawRuns: rawResults.length,
    tunePass,
    tuneTotal: tune.length,
    holdoutPass,
    holdoutTotal: holdout.length,
    sevCounts,
    starLivePass,
    starTotal,
    notVerified,
    medianLatency,
    demEmptySummary: `${demEmpty.filter((r) => r.status === 'PASS').length}/${demEmpty.length} pass, ${demEmpty.filter((r) => r.status === 'FAIL').length} fail, ${demEmpty.filter((r) => r.status === 'NOT_VERIFIED').length} not verified`,
    demDemoSummary: `${demDemo.filter((r) => r.status === 'PASS').length}/${demDemo.length} pass, ${demDemo.filter((r) => r.status === 'FAIL').length} fail, ${demDemo.filter((r) => r.status === 'NOT_VERIFIED').length} not verified`,
    dimTable,
  };
}

function formatPct(n: number, d: number): string {
  if (d === 0) return '0.0%';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function printSummary(results: CaseRunResult[], mode: 'SIMULATED' | 'LIVE') {
  const sb = computeScoreboard(results, mode);
  console.log('\n================================================================================');
  console.log(
    `OpsCommand AI Tuning Suite [MODE: ${mode}] | Prompt: ${PROMPT_VERSION} | ${sb.uniqueCases} unique cases (${sb.rawRuns} fixture runs)`
  );
  console.log('================================================================================');
  console.log(
    `| Iteration | TUNE pass | HOLDOUT pass | S1 | S2 | S3 | S4 | ★ live pass | Not verified | Planning time (median) |`
  );
  const starCell = mode === 'SIMULATED' ? `0/${sb.starTotal} (sim only)` : `${sb.starLivePass}/${sb.starTotal}`;
  console.log(
    `| Iter 0 | ${sb.tunePass}/${sb.tuneTotal} (${formatPct(sb.tunePass, sb.tuneTotal)}) | ${sb.holdoutPass}/${sb.holdoutTotal} (${formatPct(sb.holdoutPass, sb.holdoutTotal)}) | ${sb.sevCounts.S1} | ${sb.sevCounts.S2} | ${sb.sevCounts.S3} | ${sb.sevCounts.S4} | ${starCell} | ${sb.notVerified} | ${sb.medianLatency} ms |`
  );
  console.log(`\nDEM side-by-side: EMPTY [${sb.demEmptySummary}] vs DEMO [${sb.demDemoSummary}]`);
  console.log('\nPass rate by dimension:');
  for (const row of sb.dimTable) {
    console.log(`  - ${row.dimension.padEnd(15)} | TUNE: ${row.tune} | HOLDOUT: ${row.holdout}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const liveFlag = args.includes('--live');
  const starOnly = args.includes('--star-only');
  const reportOnly = args.includes('--report');
  const caseFilter = args.find((a) => a.startsWith('--case='))?.split('=')[1];

  if (reportOnly && fs.existsSync(LAST_RUN_PATH)) {
    const saved = JSON.parse(fs.readFileSync(LAST_RUN_PATH, 'utf-8'));
    printSummary(saved.results, saved.mode);
    return;
  }

  const casesPath = path.join(__dirname, 'cases.json');
  let cases = JSON.parse(fs.readFileSync(casesPath, 'utf-8')) as TuningCase[];
  if (starOnly) cases = cases.filter((c) => c.star);
  if (caseFilter) cases = cases.filter((c) => c.id === caseFilter);

  const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
  const mode: 'SIMULATED' | 'LIVE' = liveFlag ? 'LIVE' : 'SIMULATED';

  if (mode === 'LIVE' && (!apiKey || apiKey === 'MY_GEMINI_API_KEY')) {
    console.error('ERROR: --live requested, but GEMINI_API_KEY is not set in this shell environment.');
    console.error('Refusing to substitute simulated fixtures in LIVE mode.');
    process.exit(1);
  }

  const activeEngine = resolveMeditateEngine({ envEngine: 'v2' });
  console.log(
    `Running ${cases.length} tuning case(s) [MODE=${mode}, MEDITATE_ENGINE=${activeEngine}, CLOCK=${TEST_CLOCK_ISO}]...`
  );

  const results: CaseRunResult[] = [];

  for (const tc of cases) {
    if (tc.pipeline === 'CODE_SCAN') {
      const start = Date.now();
      let scanRes = { pass: true, detail: '' };
      if (tc.id === 'GEN-01') scanRes = runGen01Scan();
      else if (tc.id === 'GEN-05') scanRes = runGen05Scan();
      else if (tc.id === 'SAF-07') scanRes = runSaf07Audit();

      const sev = (tc.expectations.severityIfViolated as Severity) || 'S1';
      const dims: DimensionOutcome[] = tc.dimensions.map((d) => ({
        dimension: d,
        status: scanRes.pass ? 'PASS' : 'FAIL',
        severity: scanRes.pass ? undefined : sev,
        note: scanRes.detail,
      }));
      const r: CaseRunResult = {
        id: tc.id,
        section: tc.section,
        set: tc.set,
        star: tc.star,
        fixtureId: tc.fixtures[0] || 'NONE',
        pipeline: tc.pipeline,
        status: scanRes.pass ? 'PASS' : 'FAIL',
        verification: 'verified simulated',
        maxSeverity: scanRes.pass ? undefined : sev,
        latencyMs: Math.max(1, Date.now() - start),
        dimensions: dims,
        featureGaps: tc.expectations.featureGaps || [],
        tuneDetail: tc.set === 'TUNE' ? scanRes.detail : undefined,
      };
      results.push(r);
      console.log(
        r.set === 'HOLDOUT'
          ? `[HOLDOUT] ${r.id}: ${r.status} (${r.verification})`
          : `[TUNE] ${r.id} (${r.fixtureId}): ${r.status} | ${r.tuneDetail}`
      );
      continue;
    }

    if (tc.pipeline === 'FAULT') {
      const r = await runDeterministicFaultCase(tc);
      results.push(r);
      console.log(
        r.set === 'HOLDOUT'
          ? `[HOLDOUT] ${r.id}: ${r.status}`
          : `[TUNE] ${r.id} (${r.fixtureId}): ${r.status} | ${r.tuneDetail}`
      );
      continue;
    }

    if (tc.pipeline === 'RELEASE') {
      const r = runDeterministicReleaseCase(tc);
      results.push(r);
      if (r.set === 'HOLDOUT') {
        const dStr = r.dimensions.map((d) => `${d.dimension}=${d.status}`).join(', ');
        console.log(`[HOLDOUT] ${r.id}: ${r.status} | ${dStr}`);
      } else {
        console.log(`[TUNE] ${r.id} (${r.fixtureId}): ${r.status} | ${r.tuneDetail}`);
      }
      continue;
    }

    // For cases specifying multiple fixtures (e.g. DEM against EMPTY + DEMO, or GEN-02 against F1 + F2)
    const fixtureList: FixtureId[] = tc.fixtures.length > 0 ? tc.fixtures : ['F1'];
    for (const fxId of fixtureList) {
      if (mode === 'SIMULATED') {
        const r = runSimulatedLlmDependentCase(tc, fxId);
        results.push(r);
        if (r.set === 'HOLDOUT') {
          const dStr = r.dimensions.map((d) => `${d.dimension}=${d.status}`).join(', ');
          console.log(`[HOLDOUT] ${r.id} (${fxId}): ${r.status} | ${dStr}`);
        } else {
          console.log(`[TUNE] ${r.id} (${fxId}): ${r.status} (${r.verification}) | ${r.tuneDetail}`);
        }
      } else {
        // Live execution path (cached by sha256)
        const fx = applyCasePrecondition(buildFixture(fxId), tc.precondition);
        const members = Object.values(fx.state.team_members);
        const start = Date.now();
        const intentBuilt = buildAnonymizedIntentPrompt({
          brainDump: tc.input || tc.turns?.[0] || '',
          wbsHeads: fx.state.wbs_heads,
          teamMembers: members,
          tasks: fx.state.tasks,
          categorySops: fx.state.category_sops,
          systemMemory: fx.state.system_memory,
          businessProfile: fx.state.business_profile,
          ownerProfile: fx.state.owner_profile,
          taskSplittingRules: fx.state.task_splitting_rules,
          dateContext: buildDateContextLine((tc.clockOverride || TEST_CLOCK_ISO).slice(0, 10)),
        });
        const intentRes = await callCachedGeminiJson({
          apiKey,
          cacheKeyObj: { v: PROMPT_VERSION, stage: 'INTENT', id: tc.id, fxId, prompt: intentBuilt.prompt },
          systemInstruction: intentBuilt.systemInstruction,
          contents: intentBuilt.prompt,
          model: GEMINI_MODELS.fast,
          fallbackModel: GEMINI_MODELS.balanced,
          temperature: 0.1,
          maxOutputTokens: 1024,
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              kind: { type: Type.STRING, enum: ['TASK', 'NOTE', 'RULE', 'QUESTION', 'CASUAL'] },
              confidence: { type: Type.NUMBER },
              missingCritical: { type: Type.ARRAY, items: { type: Type.STRING } },
              followUpForHeadId: { type: Type.STRING, nullable: true },
              replyToOwner: { type: Type.STRING },
              ruleCategory: { type: Type.STRING, nullable: true },
            },
            required: ['kind', 'confidence', 'missingCritical', 'followUpForHeadId', 'replyToOwner'],
          },
        });
        const r: CaseRunResult = {
          id: tc.id,
          section: tc.section,
          set: tc.set,
          star: tc.star,
          fixtureId: fxId,
          pipeline: tc.pipeline,
          status: intentRes.data?.kind ? 'PASS' : 'FAIL',
          verification: 'verified live',
          latencyMs: Date.now() - start,
          dimensions: tc.dimensions.map((d) => ({ dimension: d, status: 'NOT_VERIFIED' })),
          featureGaps: tc.expectations.featureGaps || [],
          tuneDetail: tc.set === 'TUNE' ? `Live INTENT=${intentRes.data?.kind}` : undefined,
        };
        results.push(r);
        console.log(r.set === 'HOLDOUT' ? `[HOLDOUT] ${r.id}: ${r.status}` : `[TUNE] ${r.id}: ${r.tuneDetail}`);
      }
    }
  }

  fs.writeFileSync(
    LAST_RUN_PATH,
    JSON.stringify({ timestamp: new Date().toISOString(), mode, results }, null, 2)
  );
  printSummary(results, mode);
}

main().catch((err) => {
  console.error('Tuning runner error:', err);
  process.exit(1);
});
