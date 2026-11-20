import {
  BufferProcessAiResponse,
  CategorySop,
  DEFAULT_TENANT_ID,
  InboundMessageBuffer,
  MeditateAiResponse,
  MeditateEngineMode,
  MeditateV2IntentKind,
  OpsDatabaseState,
  SystemMemoryRule,
  Task,
  TeamMember,
  WbsHead,
} from '../types/ops';
import { stripEphemeralMediaFromState } from '../lib/opsEngine';
import { migrateTaskReleaseConfig, runScheduledJobsTick } from '../lib/releaseEngine';
import { createInitialSeedState } from '../lib/seedData';
import { type DemoLead } from '../lib/demoData';
import {
  createDemoStoryState,
  DEFAULT_DEMO_STORY,
  isDemoStoryId,
  type DemoStoryId,
} from '../lib/demoStories';
import type { DemoVisitorRecord } from '../lib/demoLeadsAnalytics';
import { sanitizeModelTuning } from '../lib/modelConfig';
import { getIdTokenOrNull } from './firebaseClient';
import { AccessDecision, interpretAccessCheck } from '../lib/accessCheck';

let demoApiModeEnabled = false;

export function setDemoApiMode(enabled: boolean): void {
  demoApiModeEnabled = enabled;
}

export function isDemoApiMode(): boolean {
  return demoApiModeEnabled;
}

/** JSON headers plus the signed-in user's token in cloud mode (or X-Demo-Mode in demo sandbox). */
async function jsonHeadersWithAuth(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (demoApiModeEnabled) {
    headers['X-Demo-Mode'] = 'true';
    const currentLead = loadDemoLead();
    if (currentLead?.leadId) {
      headers['X-Demo-Lead-Id'] = currentLead.leadId;
    }
    return headers;
  }
  const token = await getIdTokenOrNull().catch(() => null);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Asks the server whether the signed-in Google account is in ALLOWED_EMAILS (fails closed). */
export async function checkCloudAccessApi(): Promise<AccessDecision> {
  let response: Response;
  try {
    response = await fetch('/api/auth/check', { headers: await jsonHeadersWithAuth() });
  } catch {
    return interpretAccessCheck(null);
  }
  const body = await response.json().catch(() => ({}));
  return interpretAccessCheck({ status: response.status, body });
}

const LOCAL_STATE_KEY = 'opscommand_ai_state_v3';
const DEMO_STATE_KEY = 'opscommand_ai_demo_state_v1';
const DEMO_LEAD_KEY = 'opscommand_ai_demo_lead_v1';
const DEMO_STORY_KEY = 'opscommand_ai_demo_story_v1';

export type PersistenceMode = 'LOCAL_STORAGE' | 'CLOUD' | 'DEMO';


export function normalizeOpsDatabaseState(
  raw: any,
  fallbackSeed: OpsDatabaseState = createInitialSeedState()
): OpsDatabaseState {
  const seeded = fallbackSeed;
  if (!raw || typeof raw !== 'object') {
    return seeded;
  }
  const defaultMaxCap =
    raw.task_splitting_rules?.defaultMaxActiveTasksPerPerson ??
    seeded.task_splitting_rules.defaultMaxActiveTasksPerPerson;

  const normalizedMembers: Record<string, TeamMember> =
    raw.team_members && typeof raw.team_members === 'object' && !Array.isArray(raw.team_members)
      ? Object.fromEntries(
          Object.entries(raw.team_members).map(([phone, m]: [string, any], idx) => [
            phone,
            {
              ...m,
              slotId: m?.slotId || `P${idx + 1}`,
              authorityLevel: m?.authorityLevel === 'BOSS' ? 'OWNER' : m?.authorityLevel || 'STAFF',
              skills: Array.isArray(m?.skills) ? m.skills : [],
              maxActiveTasks: typeof m?.maxActiveTasks === 'number' ? m.maxActiveTasks : defaultMaxCap,
              stats: {
                assigned: 0,
                completed: 0,
                partial: 0,
                overdueCount: 0,
                totalWorkHoursReplyMins: 0,
                replyCount: 0,
                ...(m?.stats || {}),
              },
            },
          ])
        )
      : seeded.team_members;

  const tenantId =
    typeof raw.tenantId === 'string' && raw.tenantId.trim()
      ? raw.tenantId.trim()
      : DEFAULT_TENANT_ID;

  return {
    ...seeded,
    ...raw,
    tenantId,
    team_members: normalizedMembers,
    category_sops: Array.isArray(raw.category_sops) ? raw.category_sops : seeded.category_sops,
    umbrella_agendas: Array.isArray(raw.umbrella_agendas) ? raw.umbrella_agendas : seeded.umbrella_agendas,
    wbs_heads: Array.isArray(raw.wbs_heads)
      ? raw.wbs_heads.map((h: any) => ({
          ...h,
          dynamicStages: Array.isArray(h?.dynamicStages) ? h.dynamicStages : ['Execution'],
          involvedPhones: Array.isArray(h?.involvedPhones) ? h.involvedPhones : [],
          subTasks: Array.isArray(h?.subTasks) ? h.subTasks : [],
        }))
      : seeded.wbs_heads || [],
    tasks: Array.isArray(raw.tasks)
      ? raw.tasks.map((t: any) => ({
          ...t,
          raci: { R: '', A: 'Boss', C: [], I: [], ...(t?.raci || {}) },
          dependsOnTaskCodes: Array.isArray(t?.dependsOnTaskCodes) ? t.dependsOnTaskCodes : [],
          microSteps: Array.isArray(t?.microSteps) ? t.microSteps : [],
          release: migrateTaskReleaseConfig(t),
          auditLogs: Array.isArray(t?.auditLogs)
            ? t.auditLogs
            : Array.isArray(t?.auditLog)
              ? t.auditLog
              : [],
        }))
      : seeded.tasks,
    boss_review_queue: Array.isArray(raw.boss_review_queue) ? raw.boss_review_queue : seeded.boss_review_queue,
    inbound_message_buffer:
      raw.inbound_message_buffer &&
      typeof raw.inbound_message_buffer === 'object' &&
      !Array.isArray(raw.inbound_message_buffer)
        ? raw.inbound_message_buffer
        : seeded.inbound_message_buffer,
    system_memory: Array.isArray(raw.system_memory)
      ? raw.system_memory.map((m: any) => {
          const isApproved = m?.approved === false ? false : true;
          return {
            ...m,
            tenantId: m?.tenantId || tenantId,
            approved: isApproved,
            active: isApproved ? Boolean(m?.active) : false,
          };
        })
      : seeded.system_memory,
    notes: Array.isArray(raw.notes)
      ? raw.notes.map((n: any, idx: number) => ({
          tenantId: n?.tenantId || tenantId,
          noteId: n?.noteId || `NOTE-${idx + 1}`,
          text: String(n?.text || ''),
          createdAt: n?.createdAt || new Date().toISOString(),
        }))
      : seeded.notes,
    whatsapp_messages: Array.isArray(raw.whatsapp_messages) ? raw.whatsapp_messages : seeded.whatsapp_messages,
    principal_prompts:
      raw.principal_prompts && typeof raw.principal_prompts === 'object'
        ? { ...seeded.principal_prompts, ...raw.principal_prompts }
        : seeded.principal_prompts,
    business_profile:
      raw.business_profile && typeof raw.business_profile === 'object'
        ? { ...seeded.business_profile, ...raw.business_profile }
        : seeded.business_profile,
    owner_profile:
      raw.owner_profile && typeof raw.owner_profile === 'object'
        ? { ...seeded.owner_profile, ...raw.owner_profile }
        : seeded.owner_profile,
    task_splitting_rules:
      raw.task_splitting_rules && typeof raw.task_splitting_rules === 'object'
        ? { ...seeded.task_splitting_rules, ...raw.task_splitting_rules }
        : seeded.task_splitting_rules,
    sample_brain_dumps: Array.isArray(raw.sample_brain_dumps)
      ? raw.sample_brain_dumps
      : seeded.sample_brain_dumps,
    // sanitizeModelTuning swaps any saved model name that's no longer offered
    // (e.g. gemini-2.5-pro) for the current default from src/lib/modelConfig.ts.
    model_tuning:
      raw.model_tuning && typeof raw.model_tuning === 'object'
        ? sanitizeModelTuning({
            modelDefaultsVersion:
              typeof raw.model_tuning.modelDefaultsVersion === 'number'
                ? raw.model_tuning.modelDefaultsVersion
                : undefined,
            meditateEngine: 'v2',
            meditateEngineUserSet: false,
            intentConfidenceThreshold:
              typeof raw.model_tuning.intentConfidenceThreshold === 'number' &&
              Number.isFinite(raw.model_tuning.intentConfidenceThreshold)
                ? Math.max(0, Math.min(1, Number(raw.model_tuning.intentConfidenceThreshold.toFixed(2))))
                : 0.75,
            maxRecentConversationTurns: Math.max(
              1,
              Math.min(8, Number(raw.model_tuning.maxRecentConversationTurns) || 8)
            ),
            meditate: {
              ...seeded.model_tuning.meditate,
              ...(raw.model_tuning.meditate || {}),
            },
            intent: {
              ...seeded.model_tuning.intent!,
              ...(raw.model_tuning.intent || {}),
            },
            planner: {
              ...seeded.model_tuning.planner!,
              ...(raw.model_tuning.planner || {}),
            },
            bufferEvaluation: {
              ...seeded.model_tuning.bufferEvaluation,
              ...(raw.model_tuning.bufferEvaluation || {}),
            },
            message: {
              ...seeded.model_tuning.message!,
              ...(raw.model_tuning.message || {}),
            },
          } as OpsDatabaseState['model_tuning']).tuning
        : seeded.model_tuning,
    ai_logs: Array.isArray(raw.ai_logs) ? raw.ai_logs : seeded.ai_logs,
  };
}

export function loadLocalState(): OpsDatabaseState {
  try {
    const raw = localStorage.getItem(LOCAL_STATE_KEY);
    if (!raw) {
      const seeded = createInitialSeedState();
      localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(seeded));
      return seeded;
    }
    const parsed = normalizeOpsDatabaseState(JSON.parse(raw));
    return parsed;
  } catch {
    const seeded = createInitialSeedState();
    return seeded;
  }
}

export function saveLocalState(state: OpsDatabaseState): void {
  try {
    // Always strip heavy ephemeral Base64 media before writing to persistent storage
    const clean = stripEphemeralMediaFromState(state);
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(clean));
  } catch (err) {
    console.error('Failed to persist state to localStorage:', err);
  }
}

export function resetToDemoSeedState(): OpsDatabaseState {
  const fresh = createInitialSeedState();
  saveLocalState(fresh);
  return fresh;
}

/** Which sample business the demo shows. A demo saved before stories existed is the water story. */
export function loadDemoStory(): DemoStoryId {
  try {
    const raw = localStorage.getItem(DEMO_STORY_KEY);
    if (isDemoStoryId(raw)) return raw;
    return localStorage.getItem(DEMO_STATE_KEY) ? 'water' : DEFAULT_DEMO_STORY;
  } catch {
    return DEFAULT_DEMO_STORY;
  }
}

export function saveDemoStory(story: DemoStoryId): void {
  try {
    localStorage.setItem(DEMO_STORY_KEY, story);
  } catch (err) {
    console.error('Failed to save the demo story choice:', err);
  }
}

export function loadDemoState(story: DemoStoryId = loadDemoStory()): OpsDatabaseState {
  try {
    const raw = localStorage.getItem(DEMO_STATE_KEY);
    if (!raw) {
      const seeded = createDemoStoryState(story);
      saveDemoStory(story);
      saveDemoState(seeded);
      return seeded;
    }
    return normalizeOpsDatabaseState(JSON.parse(raw), createDemoStoryState(story));
  } catch {
    return createDemoStoryState(story);
  }
}

export function saveDemoState(state: OpsDatabaseState): void {
  try {
    const clean = stripEphemeralMediaFromState(state);
    localStorage.setItem(DEMO_STATE_KEY, JSON.stringify(clean));
  } catch (err) {
    console.error('Failed to persist demo state to localStorage:', err);
  }
}

export function resetToDemoSandboxState(story: DemoStoryId = loadDemoStory()): OpsDatabaseState {
  const fresh = createDemoStoryState(story);
  saveDemoStory(story);
  saveDemoState(fresh);
  return fresh;
}

export function loadDemoLead(): DemoLead | null {
  try {
    const raw = localStorage.getItem(DEMO_LEAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.name === 'string' && typeof parsed.email === 'string' && typeof parsed.phone === 'string') {
      return parsed as DemoLead;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveDemoLead(lead: DemoLead): void {
  try {
    localStorage.setItem(DEMO_LEAD_KEY, JSON.stringify(lead));
  } catch (err) {
    console.error('Failed to persist demo lead to localStorage:', err);
  }
}

export function clearDemoSession(): void {
  try {
    localStorage.removeItem(DEMO_LEAD_KEY);
  } catch {
    // ignore storage errors
  }
}

export async function registerDemoLeadApi(input: {
  name: string;
  email: string;
  phone: string;
}): Promise<DemoLead> {
  const response = await fetch('/api/demo/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.lead) {
    throw new Error(body?.error || 'Could not register demo access.');
  }
  const registered: DemoLead = {
    ...(body.lead as DemoLead),
    ...(typeof body.leadId === 'string' && body.leadId ? { leadId: body.leadId } : {}),
  };
  saveDemoLead(registered);
  return registered;
}

/** Owner-only: fetches registered demo guests via the Firebase Admin route (ALLOWED_EMAILS only). */
export async function fetchDemoVisitorsApi(): Promise<DemoVisitorRecord[]> {
  if (demoApiModeEnabled) {
    throw new Error('Demo sessions cannot view visitor records.');
  }
  const token = await getIdTokenOrNull().catch(() => null);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch('/api/demo/leads', { headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || `Could not load demo visitors (${response.status}).`);
  }
  return Array.isArray(body?.visitors) ? (body.visitors as DemoVisitorRecord[]) : [];
}

/** Owner-only: removes a demo visitor entry by ID via the Firebase Admin route (ALLOWED_EMAILS only). */
export async function deleteDemoVisitorApi(leadId: string): Promise<void> {
  if (demoApiModeEnabled) {
    throw new Error('Demo sessions cannot modify visitor records.');
  }
  const token = await getIdTokenOrNull().catch(() => null);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`/api/demo/leads/${encodeURIComponent(leadId)}`, {
    method: 'DELETE',
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || `Could not delete visitor entry (${response.status}).`);
  }
}

export async function fetchServerHealth(): Promise<{
  status: string;
  meditateEngine?: MeditateEngineMode;
} | null> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Browser-side upper bound for one Meditate request (several 45s Gemini calls). */
const MEDITATE_REQUEST_TIMEOUT_MS = 3 * 60_000;

/**
 * Calls the server-side Gemini Meditate Agent (/api/ai/meditate)
 */
export async function runMeditateAgentApi(params: {
  tenantId?: string;
  brainDump: string;
  teamMembers: TeamMember[];
  tasks: Task[];
  categorySops: CategorySop[];
  systemMemory: SystemMemoryRule[];
  principalPrompts?: OpsDatabaseState['principal_prompts'];
  businessProfile?: OpsDatabaseState['business_profile'];
  ownerProfile?: OpsDatabaseState['owner_profile'];
  taskSplittingRules?: OpsDatabaseState['task_splitting_rules'];
  sampleBrainDumps?: OpsDatabaseState['sample_brain_dumps'];
  modelTuning?: OpsDatabaseState['model_tuning'];
  conversationHistory?: Array<{ role: 'user' | 'assistant'; text: string }>;
  activeHead?: any;
  wbsHeads?: WbsHead[];
  confirmedIntentKind?: MeditateV2IntentKind;
  priorMissingCritical?: string[];
  priorFollowUpForHeadId?: string | null;
}): Promise<MeditateAiResponse> {
  // Safety net: the server caps each Gemini call at 45s, but a request can make a few
  // calls (fallback model, one repair). Never leave the spinner running past this.
  let response: Response;
  try {
    response = await fetch('/api/ai/meditate', {
      method: 'POST',
      headers: await jsonHeadersWithAuth(),
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(MEDITATE_REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(
        `The AI took longer than ${Math.round(MEDITATE_REQUEST_TIMEOUT_MS / 60_000)} minutes, so I stopped waiting. Nothing was changed. Please try again in a minute.`
      );
    }
    throw new Error('Could not reach the OpsCommand server. Is it still running?');
  }

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Meditate Agent request failed (${response.status})`);
  }

  return (await response.json()) as MeditateAiResponse;
}

/**
 * Calls server-side Gemini 2.5 Flash-Lite Multimodal Batch Processor (/api/ai/process-buffer)
 */
export async function runBufferBatchProcessorApi(params: {
  tenantId?: string;
  employee: TeamMember;
  teamMembers?: TeamMember[];
  buffer: InboundMessageBuffer;
  activeTasks: Task[];
  systemMemory: SystemMemoryRule[];
  principalPrompts?: OpsDatabaseState['principal_prompts'];
  businessProfile?: OpsDatabaseState['business_profile'];
  ownerProfile?: OpsDatabaseState['owner_profile'];
  modelTuning?: OpsDatabaseState['model_tuning'];
}): Promise<BufferProcessAiResponse> {
  const response = await fetch('/api/ai/process-buffer', {
    method: 'POST',
    headers: await jsonHeadersWithAuth(),
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Buffer Processor request failed (${response.status})`);
  }

  return (await response.json()) as BufferProcessAiResponse;
}

/**
 * Calls server-side MESSAGE stage writer (/api/ai/release-messages) for newly released tasks.
 */
export async function draftReleaseMessagesApi(params: {
  state: OpsDatabaseState;
  taskCodes: string[];
}): Promise<{
  messagesByTaskCode: Record<string, string>;
  aiLogs: OpsDatabaseState['ai_logs'];
}> {
  if (!params.taskCodes || params.taskCodes.length === 0) {
    return { messagesByTaskCode: {}, aiLogs: [] };
  }
  const response = await fetch('/api/ai/release-messages', {
    method: 'POST',
    headers: await jsonHeadersWithAuth(),
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Release message writer failed (${response.status})`);
  }

  return await response.json();
}

/**
 * Calls POST /api/jobs/tick on the backend (with local release engine fallback if offline).
 */
export async function runJobsTickApi(
  state: OpsDatabaseState,
  nowIso?: string
): Promise<{
  state: OpsDatabaseState;
  releasedTaskCodes: string[];
  digestsSent: number;
  expiredCount: number;
  remindersSent: number;
  behindAlertsSent?: number;
  tickTimestamp: string;
  /** 'cloud' when the server ran the tick on the stored workspace and saved it itself. */
  storage?: 'cloud' | 'request';
}> {
  let response: Response | null = null;
  try {
    response = await fetch('/api/jobs/tick', {
      method: 'POST',
      headers: await jsonHeadersWithAuth(),
      body: JSON.stringify({ state, nowIso }),
    });
  } catch {
    response = null; // server unreachable: fall back to the local tick below
  }
  if (response?.ok) {
    const body = await response.json();
    return {
      ...body,
      remindersSent: Number(body?.remindersSent) || 0,
      behindAlertsSent: Number(body?.behindAlertsSent) || 0,
    };
  }
  // Signed out, not allowed, a conflict, or any server error in cloud mode: tell the owner,
  // never run a silent local tick (it would not reflect the stored workspace).
  const signedIn = demoApiModeEnabled
    ? false
    : Boolean(await getIdTokenOrNull().catch(() => null));
  if (response && ([401, 403, 409].includes(response.status) || signedIn)) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error || 'The scheduler tick was refused.');
  }

  const localRes = runScheduledJobsTick(state, nowIso);
  return {
    state: localRes.nextState,
    releasedTaskCodes: localRes.releasedTaskCodes,
    digestsSent: localRes.digestsSent,
    expiredCount: localRes.expiredCount,
    remindersSent: localRes.remindersSent,
    behindAlertsSent: localRes.behindAlertsSent || 0,
    tickTimestamp: localRes.tickTimestamp,
  };
}

/** Batch 3: a task message as a voice note (Gemini text-to-speech on the server). */
export async function fetchVoiceNoteApi(params: {
  text: string;
  language?: string;
  teamMembers: TeamMember[];
  ownerProfile?: OpsDatabaseState['owner_profile'];
}): Promise<{ audioBase64: string; mimeType: string }> {
  const response = await fetch('/api/ai/voice-note', {
    method: 'POST',
    headers: await jsonHeadersWithAuth(),
    body: JSON.stringify(params),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.audioBase64) {
    throw new Error(body?.error || `Voice note failed (${response.status})`);
  }
  return { audioBase64: body.audioBase64, mimeType: body.mimeType || 'audio/wav' };
}
