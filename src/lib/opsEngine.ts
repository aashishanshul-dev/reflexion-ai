import {
  type AiCallLogEntry,
  type BossReviewItem,
  type BufferProcessAiResponse,
  DEFAULT_TENANT_ID,
  type InboundMessageBuffer,
  type MeditateDraftTaskInput,
  type NoteItem,
  type OpsDatabaseState,
  type PausedInterval,
  type PreferredLanguage,
  type SimulatedWhatsappMessage,
  type SystemMemoryCategory,
  type SystemMemoryRule,
  type Task,
  type TaskStatus,
  type TeamMember,
  type UmbrellaAgenda,
  type WbsHead,
} from '../types/ops.ts';
import { buildMyTasks, buildOwnerDigestText, getOwnerPhones } from './myTasks.ts';
import {
  applyWhatsapp24hWindowPolicy,
  buildTaskCancelledMessage,
  getZonedDateParts,
  formatNumberedStepsBlock,
  isTaskClosed,
  isTaskReleasedStatus,
  PARENT_CANCELLED_HOLD_REASON,
  migrateTaskReleaseConfig,
  promoteUnlockedDependentsToScheduled,
  releaseDueTasks,
} from './releaseEngine.ts';
import { stripWeaknessPhrases } from './weaknessPrivacy.ts';
import { assessReplyScheduleRisk, formatDueShort, normalizeDueTime } from './taskTiming.ts';
import { staffAddressName } from './staffNames.ts';
import { buildShortTaskBrief } from './taskBrief.ts';
import { sendBehindAlerts } from './behindAlerts.ts';
import { sendOwnerDecisionPrompts } from './ownerWhatsapp.ts';
import { applyStepUpdate, completionFromSteps, enrichStep } from './stepChecks.ts';

export const MAX_SYSTEM_MEMORY_RULES = 30;
export const MAX_VIDEO_SIZE_MB = 15;
export const MAX_AI_LOGS = 200;

export function appendAiLogToState(
  state: OpsDatabaseState,
  logEntry?: AiCallLogEntry | null
): OpsDatabaseState {
  if (!logEntry) return state;
  const tenantId = state.tenantId || DEFAULT_TENANT_ID;
  const stamped: AiCallLogEntry = {
    ...logEntry,
    tenantId: logEntry.tenantId || tenantId,
  };
  const existing = Array.isArray(state.ai_logs) ? state.ai_logs : [];
  return {
    ...state,
    ai_logs: [stamped, ...existing].slice(0, MAX_AI_LOGS),
  };
}

/**
 * Pure helper adding a captured note to state.notes with tenantId stamped.
 */
export function addNoteToState(
  state: OpsDatabaseState,
  text: string,
  nowIso: string = new Date().toISOString()
): OpsDatabaseState {
  const cleanText = String(text || '').trim();
  if (!cleanText) return state;
  const tenantId = state.tenantId || DEFAULT_TENANT_ID;
  const existingNotes = Array.isArray(state.notes) ? state.notes : [];
  const note: NoteItem = {
    tenantId,
    noteId: `NOTE-${existingNotes.length + 1}-${Date.now().toString(36)}`,
    text: cleanText,
    createdAt: nowIso,
  };
  return {
    ...state,
    notes: [note, ...existingNotes],
  };
}

/**
 * Pure helper removing a note by noteId from state.notes.
 */
export function deleteNoteFromState(
  state: OpsDatabaseState,
  noteId: string
): OpsDatabaseState {
  const existingNotes = Array.isArray(state.notes) ? state.notes : [];
  return {
    ...state,
    notes: existingNotes.filter((n) => n.noteId !== noteId),
  };
}

/**
 * Pure helper adding a memory rule. Pending AI rules carry approved=false and active=false
 * until the owner approves them in System Memory.
 */
export function addMemoryRuleToState(
  state: OpsDatabaseState,
  params: {
    category: SystemMemoryCategory;
    fact: string;
    approved?: boolean;
  }
): OpsDatabaseState {
  const cleanFact = String(params.fact || '').trim();
  if (!cleanFact) return state;
  const existing = Array.isArray(state.system_memory) ? state.system_memory : [];
  if (existing.length >= MAX_SYSTEM_MEMORY_RULES) return state;

  // Avoid inserting duplicate identical rule facts
  const isDuplicate = existing.some(
    (r) => r.fact.trim().toLowerCase() === cleanFact.toLowerCase()
  );
  if (isDuplicate) return state;

  const tenantId = state.tenantId || DEFAULT_TENANT_ID;
  const isApproved = params.approved !== false;
  const nextId = `MEM-${String(existing.length + 1).padStart(2, '0')}-${Date.now()
    .toString()
    .slice(-3)}`;

  const rule: SystemMemoryRule = {
    tenantId,
    memoryId: nextId,
    category: params.category || 'BUSINESS_RULE',
    fact: cleanFact,
    approved: isApproved,
    active: isApproved,
  };

  return {
    ...state,
    system_memory: [rule, ...existing],
  };
}

/**
 * Pure helper approving a pending memory rule (sets approved=true and active=true).
 */
export function approveMemoryRuleInState(
  state: OpsDatabaseState,
  memoryId: string
): OpsDatabaseState {
  const existing = Array.isArray(state.system_memory) ? state.system_memory : [];
  return {
    ...state,
    system_memory: existing.map((m) =>
      m.memoryId === memoryId ? { ...m, approved: true, active: true } : m
    ),
  };
}

/**
 * Computes end/due date from startDate (YYYY-MM-DD) + durationDays (e.g. 0.5, 1, 2).
 * e.g., start 2026-11-04 + 1 day = 2026-11-04 (or 2026-11-05 if multi-day).
 * Rule: 0.5 or 1 day task finishing on the same day ends on startDate.
 * 2 days ends on startDate + 1 day. 3 days ends on startDate + 2 days.
 */
export function computeDueDate(startDate: string, durationDays: number): string {
  if (!startDate) return new Date().toISOString().slice(0, 10);
  const dur = Math.max(0.5, durationDays || 1);
  const parts = startDate.split('-').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return startDate;
  }
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const offsetDays = Math.max(0, Math.ceil(dur) - 1);
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Computes startDate from a target dueDate (YYYY-MM-DD) and durationDays.
 */
export function computeStartDateFromDeadline(dueDate: string, durationDays: number): string {
  if (!dueDate) return new Date().toISOString().slice(0, 10);
  const dur = Math.max(0.5, durationDays || 1);
  const parts = dueDate.split('-').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return dueDate;
  }
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const offsetDays = Math.max(0, Math.ceil(dur) - 1);
  d.setDate(d.getDate() - offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Recalculates WBS Head tentative dates and backwards-calculates subtask dates if isForcedDeadline is true.
 */
export function recalculateWbsHeadDates(head: WbsHead): WbsHead {
  const updated = structuredClone(head);
  if (!updated.subTasks || updated.subTasks.length === 0) {
    return updated;
  }

  const totalDuration = updated.subTasks.reduce((acc, t) => acc + (t.durationDays || 1), 0);
  updated.tentativeDurationDays = Math.max(0.5, totalDuration);

  if (updated.isForcedDeadline && updated.tentativeDeadline) {
    // Back-calculate from tentativeDeadline backwards across stages
    let cursorEnd = updated.tentativeDeadline;
    for (let i = updated.subTasks.length - 1; i >= 0; i--) {
      const task = updated.subTasks[i];
      const dur = task.durationDays || 1;
      // A due date the owner set by hand is kept; the chain continues from it.
      task.dueDate = task.ownerEditedFields?.includes('dueDate') && task.dueDate ? task.dueDate : cursorEnd;
      task.startDate = computeStartDateFromDeadline(task.dueDate, dur);
      task.isForcedDeadline = true;
      task.forcedDeadlineDate = updated.tentativeDeadline;

      // Cursor for the previous task becomes the day before current task's start date
      const parts = task.startDate.split('-').map((p) => Number.parseInt(p, 10));
      const prevD = new Date(parts[0], parts[1] - 1, parts[2]);
      prevD.setDate(prevD.getDate() - 1);
      const y = prevD.getFullYear();
      const m = String(prevD.getMonth() + 1).padStart(2, '0');
      const day = String(prevD.getDate()).padStart(2, '0');
      cursorEnd = `${y}-${m}-${day}`;
    }
    updated.tentativeStartDate = updated.subTasks[0].startDate || updated.tentativeStartDate;
  } else {
    // Forward-calculate from tentativeStartDate
    let cursorStart = updated.tentativeStartDate || new Date().toISOString().slice(0, 10);
    for (let i = 0; i < updated.subTasks.length; i++) {
      const task = updated.subTasks[i];
      const dur = task.durationDays || 1;
      if (task.ownerEditedFields?.includes('dueDate') && task.dueDate) {
        // A due date the owner set by hand is kept; the chain continues after it.
        task.startDate = computeStartDateFromDeadline(task.dueDate, dur);
      } else {
        task.startDate = cursorStart;
        task.dueDate = computeDueDate(cursorStart, dur);
      }

      // Next task starts day after dueDate
      const parts = task.dueDate.split('-').map((p) => Number.parseInt(p, 10));
      const nextD = new Date(parts[0], parts[1] - 1, parts[2]);
      nextD.setDate(nextD.getDate() + 1);
      const y = nextD.getFullYear();
      const m = String(nextD.getMonth() + 1).padStart(2, '0');
      const day = String(nextD.getDate()).padStart(2, '0');
      cursorStart = `${y}-${m}-${day}`;
    }
    const lastSubTask = updated.subTasks[updated.subTasks.length - 1];
    updated.tentativeDeadline = lastSubTask ? lastSubTask.dueDate : updated.tentativeStartDate;
  }

  return updated;
}

/**
 * Cascades schedule changes forward along dependency chains.
 * If moving a task forward would breach its or a downstream task's forced deadline,
 * a conflict is flagged.
 */
export function cascadeTaskSchedule(
  tasks: Task[],
  updatedTaskCode: string,
  newStartDate: string,
  newDurationDays: number
): {
  updatedTasks: Task[];
  cascadedCount: number;
  conflict: boolean;
  conflictMessage?: string;
} {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) {
    taskMap.set(t.taskCode, { ...t });
  }

  const target = taskMap.get(updatedTaskCode);
  if (!target) {
    return { updatedTasks: tasks, cascadedCount: 0, conflict: false };
  }

  target.startDate = newStartDate;
  target.durationDays = newDurationDays;
  target.dueDate = computeDueDate(newStartDate, newDurationDays);

  let conflict = false;
  let conflictMessage: string | undefined;

  if (target.isForcedDeadline && target.forcedDeadlineDate && target.dueDate > target.forcedDeadlineDate) {
    conflict = true;
    conflictMessage = `Task [${target.shortTag || target.taskCode}] due date (${target.dueDate}) exceeds its hard forced deadline (${target.forcedDeadlineDate})!`;
  }

  let cascadedCount = 0;
  // Queue downstream tasks whose dependencies changed
  const queue: string[] = [updatedTaskCode];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const parentCode = queue.shift()!;
    if (visited.has(parentCode)) continue;
    visited.add(parentCode);

    const parent = taskMap.get(parentCode)!;
    // Find all tasks that depend on parentCode
    for (const [code, child] of taskMap.entries()) {
      if (child.dependency?.dependsOnTaskCode === parentCode) {
        // Child cannot start before parent finishes (parent.dueDate)
        const parts = parent.dueDate.split('-').map((p) => Number.parseInt(p, 10));
        const minChildStartD = new Date(parts[0], parts[1] - 1, parts[2]);
        minChildStartD.setDate(minChildStartD.getDate() + 1);
        const y = minChildStartD.getFullYear();
        const m = String(minChildStartD.getMonth() + 1).padStart(2, '0');
        const day = String(minChildStartD.getDate()).padStart(2, '0');
        const minChildStart = `${y}-${m}-${day}`;

        if (!child.startDate || child.startDate < minChildStart) {
          child.startDate = minChildStart;
          child.dueDate = computeDueDate(minChildStart, child.durationDays || 1);
          cascadedCount++;

          if (child.isForcedDeadline && child.forcedDeadlineDate && child.dueDate > child.forcedDeadlineDate) {
            conflict = true;
            conflictMessage = `Dependent task [${child.shortTag || child.taskCode}] pushed to ${child.dueDate}, breaching forced deadline (${child.forcedDeadlineDate})!`;
          }

          queue.push(code);
        }
      }
    }
  }

  return {
    updatedTasks: Array.from(taskMap.values()),
    cascadedCount,
    conflict,
    conflictMessage,
  };
}

/**
 * Checks whether Meta's 24-hour free-form customer service window is open.
 */
export function isWithin24HrWindow(lastInboundIso: string, nowIso: string = new Date().toISOString()): boolean {
  if (!lastInboundIso) return false;
  const lastMs = new Date(lastInboundIso).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (Number.isNaN(lastMs) || Number.isNaN(nowMs)) return false;
  const diffHours = (nowMs - lastMs) / (1000 * 60 * 60);
  return diffHours >= 0 && diffHours < 24;
}

function parseShiftMinutes(hhmm: string): number {
  const [hStr, mStr] = (hhmm || '09:00').split(':');
  const h = Number.parseInt(hStr || '9', 10);
  const m = Number.parseInt(mStr || '0', 10);
  return (Number.isNaN(h) ? 9 : h) * 60 + (Number.isNaN(m) ? 0 : m);
}

/**
 * Calculates elapsed response minutes strictly inside the employee's daily work shift
 * (`workShiftStart` to `workShiftEnd`), excluding overnight off-hours and any intervals
 * where the task was paused in `AWAITING_BOSS_DECISION`.
 */
export function calculateWorkHoursMinutes(
  startIso: string,
  endIso: string,
  workShiftStart: string,
  workShiftEnd: string,
  pausedIntervals: PausedInterval[] = []
): number {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return 0;
  }

  const shiftStartMin = parseShiftMinutes(workShiftStart);
  const shiftEndMin = parseShiftMinutes(workShiftEnd);
  if (shiftEndMin <= shiftStartMin) {
    return 0;
  }

  const normalizedPauses = pausedIntervals
    .map((p) => ({
      s: new Date(p.pausedAt).getTime(),
      e: p.resumedAt ? new Date(p.resumedAt).getTime() : endMs,
    }))
    .filter((p) => !Number.isNaN(p.s) && !Number.isNaN(p.e) && p.e > p.s);

  let countedMinutes = 0;
  const cursor = new Date(startMs);
  cursor.setUTCSeconds(0, 0);

  // Iterate day by day in UTC/local consistent calendar slices relative to start Date
  const dayCursor = new Date(startMs);
  dayCursor.setHours(0, 0, 0, 0);

  while (dayCursor.getTime() <= endMs) {
    const dayBaseMs = dayCursor.getTime();
    const windowStartMs = Math.max(startMs, dayBaseMs + shiftStartMin * 60_000);
    const windowEndMs = Math.min(endMs, dayBaseMs + shiftEndMin * 60_000);

    if (windowEndMs > windowStartMs) {
      // Subtract any overlapping paused intervals from [windowStartMs, windowEndMs]
      let segments: Array<[number, number]> = [[windowStartMs, windowEndMs]];
      for (const pause of normalizedPauses) {
        const nextSegments: Array<[number, number]> = [];
        for (const [segS, segE] of segments) {
          if (pause.e <= segS || pause.s >= segE) {
            nextSegments.push([segS, segE]);
          } else {
            if (pause.s > segS) nextSegments.push([segS, pause.s]);
            if (pause.e < segE) nextSegments.push([pause.e, segE]);
          }
        }
        segments = nextSegments;
      }

      for (const [segS, segE] of segments) {
        countedMinutes += (segE - segS) / 60_000;
      }
    }

    dayCursor.setDate(dayCursor.getDate() + 1);
  }

  return Math.max(1, Math.round(countedMinutes));
}

export function getActiveTaskWorkload(tasks: Task[], phone: string): number {
  return tasks.filter(
    (t) => t.raci.R === phone && t.isFrozen && isTaskReleasedStatus(t.status)
  ).length;
}

/**
 * Generates localized outbound WhatsApp instructions in the Responsible employee's preferred language.
 */
export function generateOutboundWhatsappMessage(
  task: Pick<Task, 'taskCode' | 'title' | 'dueDate' | 'taskFrequency' | 'recurrenceRule'> & {
    dueTime?: string | null;
    shortTag?: string;
    quadrant?: Task['quadrant'];
    /** Step objects or plain step labels (drafts use plain strings). */
    microSteps: ReadonlyArray<{ label?: string | null } | string>;
  },
  responsible: TeamMember | undefined,
  accountable?: TeamMember
): string {
  // Short brief: who/what/by when, steps on one line, one closing line (no form labels).
  const message = buildShortTaskBrief(task, responsible);

  // Privacy backstop: a weakness phrase must never reach staff, even if the validator missed it.
  const involved = [responsible, accountable].filter(Boolean) as TeamMember[];
  return stripWeaknessPhrases(message, involved);
}

export function formatLocalizedNotification(
  kind:
    | 'INSTANT_NUDGE'
    | 'BOSS_DECISION'
    | 'REASSIGN_HANDOVER'
    | 'REASSIGN_REMOVED'
    | 'DEPENDENCY_UNLOCKED',
  member: TeamMember | undefined,
  taskCodeOrTag: string,
  title: string,
  extraNote?: string
): string {
  const lang = member?.preferredLanguage || 'HINGLISH';
  const name = staffAddressName(member, 'ENGLISH', 'Team');
  const hiName = staffAddressName(member, lang, 'ji');

  if (kind === 'INSTANT_NUDGE') {
    if (lang === 'ENGLISH') {
      return `⚡ Urgent Nudge ${name} — Please share an immediate status update on [${taskCodeOrTag}] (${title}). Priority fast-track processing is active.`;
    }
    return `⚡ Urgent Nudge ${hiName} — Kripya [${taskCodeOrTag}] (${title}) ka turant update aur photo abhi bhejein. Boss live wait kar rahe hain.`;
  }

  if (kind === 'BOSS_DECISION') {
    if (lang === 'ENGLISH') {
      return `✅ Boss Decision on [${taskCodeOrTag}]: "${extraNote}" — Task timer resumed; please proceed accordingly.`;
    }
    return `✅ Boss Decision on [${taskCodeOrTag}]: "${extraNote}" — Kripya iske hisaab se aage ka kaam pura karein.`;
  }

  if (kind === 'REASSIGN_HANDOVER') {
    if (lang === 'ENGLISH') {
      return `🔄 Task Handover [${taskCodeOrTag}]: Hello ${name}, you are now assigned as Responsible (R) for "${title}". ${extraNote || ''}`.trim();
    }
    return `🔄 Task Handover [${taskCodeOrTag}]: Namaste ${hiName}, "${title}" ab aapko assign kiya gaya hai. ${extraNote || ''}`.trim();
  }

  if (kind === 'REASSIGN_REMOVED') {
    if (lang === 'ENGLISH') {
      return `↪️ Task Moved [${taskCodeOrTag}]: Hello ${name}, "${title}" is no longer assigned to you. ${extraNote || ''} No further action needed from you on this task.`.replace(/\s+No further/, ' No further').trim();
    }
    return `↪️ Task Moved [${taskCodeOrTag}]: Namaste ${hiName}, "${title}" ab aapke paas nahi hai. ${extraNote || ''} Is task par aapko aage kuch karne ki zaroorat nahi hai.`.replace(/\s+Is task/, ' Is task').trim();
  }

  // DEPENDENCY_UNLOCKED
  if (lang === 'ENGLISH') {
    return `🔓 Prerequisite Cleared [${taskCodeOrTag}]: Hello ${name}, upstream handover is complete. You may now begin "${title}".`;
  }
  return `🔓 Task Unlocked [${taskCodeOrTag}]: Namaste ${hiName}, pichla step clear ho gaya hai. Ab aap "${title}" shuru kar sakte hain!`;
}

export function getNextTaskCode(existingTasks: Task[]): string {
  let maxNum = 100;
  for (const t of existingTasks) {
    const match = t.taskCode.match(/^T-(\d+)$/);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return `T-${maxNum + 1}`;
}

export function getNextAgendaId(agendas: UmbrellaAgenda[]): string {
  let maxNum = 0;
  for (const a of agendas) {
    const match = a.agendaId.match(/^AG-(\d+)$/);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return `AG-${String(maxNum + 1).padStart(2, '0')}`;
}

/**
 * Freezes staged rubric drafts and dispatches unlocked tasks to WhatsApp while placing
 * dependent tasks in LOCKED_BY_DEPENDENCY.
 */
export function freezeAndDispatchStagingTasks(
  state: OpsDatabaseState,
  drafts: MeditateDraftTaskInput[],
  agendaInput?: Omit<UmbrellaAgenda, 'agendaId' | 'createdAt' | 'status'>,
  nowIso: string = new Date().toISOString()
): OpsDatabaseState {
  if (drafts.length === 0) return state;

  const tenantId = state.tenantId || DEFAULT_TENANT_ID;
  const nextAgendas = [...state.umbrella_agendas];
  let createdAgendaId: string | null = null;
  if (agendaInput && agendaInput.title.trim()) {
    createdAgendaId = getNextAgendaId(nextAgendas);
    nextAgendas.unshift({
      tenantId,
      agendaId: createdAgendaId,
      title: agendaInput.title.trim(),
      rawBrainDump: agendaInput.rawBrainDump,
      quadrant: agendaInput.quadrant,
      majorOrMinor: agendaInput.majorOrMinor,
      status: 'ACTIVE',
      createdAt: nowIso,
    });
  }

  const nextTasks = [...state.tasks];
  const nextMembers: Record<string, TeamMember> = structuredClone(state.team_members);

  // First map tempIds to real T-XXX codes
  const tempToRealCode = new Map<string, string>();
  let runningTasksForCode = [...nextTasks];
  for (const d of drafts) {
    const code = getNextTaskCode(runningTasksForCode);
    tempToRealCode.set(d.tempId, code);
    runningTasksForCode.push({ taskCode: code } as Task);
  }

  for (const d of drafts) {
    const taskCode = tempToRealCode.get(d.tempId)!;
    const resolvedAfterCode = d.release?.afterTaskCode
      ? tempToRealCode.get(d.release.afterTaskCode) || d.release.afterTaskCode
      : d.dependsOnTempIdOrTaskCode
        ? tempToRealCode.get(d.dependsOnTempIdOrTaskCode) || d.dependsOnTempIdOrTaskCode
        : null;
    const resolvedTrigger = d.release?.afterTrigger || d.triggerCondition || 'FULL_COMPLETION';

    // Check if dependency is already satisfied
    let isLocked = false;
    if (resolvedAfterCode) {
      const upstream = nextTasks.find((t) => t.taskCode === resolvedAfterCode);
      if (!upstream) {
        isLocked = true;
      } else if (resolvedTrigger === 'FULL_COMPLETION') {
        isLocked = upstream.status !== 'COMPLETED';
      } else {
        isLocked = upstream.status !== 'COMPLETED' && upstream.status !== 'PARTIALLY_DONE';
      }
    }

    const microSteps = (d.microSteps.length > 0 ? d.microSteps : ['Execute task and confirm on WhatsApp']).map(
      // Code reads each step's count ("250 items") and photo requirement ("photo of the finished work").
      (label, i) =>
        enrichStep({
          id: `ms-${taskCode.toLowerCase()}-${i + 1}`,
          label,
          status: 'PENDING' as const,
        })
    );

    const rMember = nextMembers[d.raci.R];
    const aMember = nextMembers[d.raci.A];
    const preview =
      d.outboundWhatsappPreview && d.outboundWhatsappPreview.trim()
        ? d.outboundWhatsappPreview.trim()
        : generateOutboundWhatsappMessage(
            {
              taskCode,
              shortTag: d.shortTag,
              title: d.title,
              microSteps,
              dueDate: d.dueDate,
              dueTime: d.dueTime ?? null,
              taskFrequency: d.taskFrequency,
              recurrenceRule: d.recurrenceRule,
            },
            rMember,
            aMember
          );

    const releaseMode = d.release?.mode || (resolvedAfterCode ? 'AFTER_TASK' : 'NOW');
    const status: TaskStatus = isLocked ? 'LOCKED_BY_DEPENDENCY' : 'SCHEDULED';
    const releaseConfig = migrateTaskReleaseConfig(
      {
        status,
        dependency: {
          dependsOnTaskCode: resolvedAfterCode,
          triggerCondition: resolvedTrigger,
        },
        release: {
          mode: releaseMode,
          releaseAt: d.release?.releaseAt ?? null,
          afterTaskCode: resolvedAfterCode,
          afterTrigger: resolvedTrigger,
          delayMinutes: d.release?.delayMinutes ?? 0,
          requireOwnerConfirm: Boolean(d.release?.requireOwnerConfirm),
          ownerConfirmed: false,
          releasedAt: null,
          holdReason: isLocked
            ? `Waiting on prerequisite ${resolvedAfterCode} (${resolvedTrigger})`
            : null,
          batchedForDigest: false,
        },
      },
      nowIso
    );

    const newTask: Task = {
      tenantId,
      taskCode,
      shortTag:
        d.shortTag && d.shortTag.trim()
          ? d.shortTag.trim()
          : d.title.trim().split(/[:\-–]/)[0].trim().slice(0, 24) || 'Task',
      agendaId: createdAgendaId,
      title: d.title.trim(),
      categoryId: d.categoryId,
      quadrant: d.quadrant,
      majorOrMinor: d.majorOrMinor,
      taskFrequency: d.taskFrequency,
      recurrenceRule: d.taskFrequency === 'RECURRING' ? d.recurrenceRule : 'NONE',
      isFrozen: true,
      raci: {
        R: d.raci.R,
        A: d.raci.A,
        C: [...d.raci.C],
        I: [...d.raci.I],
      },
      status,
      completionPercent: 0,
      microSteps,
      missingStepsAlert: '',
      dependency: {
        dependsOnTaskCode: resolvedAfterCode,
        triggerCondition: resolvedTrigger,
      },
      release: releaseConfig,
      reminderConfig: {
        includeInDailyOverview: true,
        customIntervalHours: d.quadrant === 'Q1_DO_FIRST' ? 2 : 4,
        lastNudgedAt: null,
        nudgeCount: 0,
      },
      startDate: d.startDate || nowIso.slice(0, 10),
      durationDays: d.durationDays || 1,
      dueDate: d.dueDate || computeDueDate(d.startDate || nowIso.slice(0, 10), d.durationDays || 1),
      dueTime: normalizeDueTime(d.dueTime),
      isForcedDeadline: !!d.isForcedDeadline,
      forcedDeadlineDate: d.forcedDeadlineDate || null,
      wbsHeadId: d.wbsHeadId || null,
      swimlaneStage: d.swimlaneStage || '',
      outboundWhatsappPreview: preview,
      messageIsCustom: Boolean(d.messageIsCustom && d.outboundWhatsappPreview?.trim()),
      latestAiSummary: isLocked
        ? `Frozen & waiting on prerequisite ${resolvedAfterCode} (${resolvedTrigger}).`
        : `Scheduled (${releaseMode}) for release evaluation.`,
      auditLogs: [
        {
          timestamp: nowIso,
          sender: isLocked ? 'SYSTEM_DEPENDENCY_GATE' : 'SYSTEM_SCHEDULER',
          rawInputSummary: isLocked
            ? `Rubric frozen; queued behind ${resolvedAfterCode}.`
            : `Rubric frozen and queued as SCHEDULED (${releaseMode}).`,
          aiDecision: `Status -> ${status}`,
        },
      ],
    };

    nextTasks.unshift(newTask);
  }

  const workingState: OpsDatabaseState = {
    ...state,
    team_members: nextMembers,
    umbrella_agendas: nextAgendas,
    tasks: nextTasks,
  };

  return releaseDueTasks(workingState, nowIso).nextState;
}

/**
 * Sends an Instant Nudge to R, increments nudgeCount, and switches the employee's bufferMode
 * to INSTANT_NUDGE_ACTIVE so their next WhatsApp reply bypasses the 15-minute wait.
 */
export function sendInstantNudge(
  state: OpsDatabaseState,
  taskCode: string,
  nowIso: string = new Date().toISOString()
): OpsDatabaseState {
  const target = state.tasks.find((t) => t.taskCode === taskCode);
  if (!target || target.status === 'AWAITING_BOSS_DECISION') return state;

  const rPhone = target.raci.R;
  const nextMembers = structuredClone(state.team_members);
  const member = nextMembers[rPhone];
  if (member) {
    member.bufferMode = 'INSTANT_NUDGE_ACTIVE';
  }

  // If employee already has an active buffer, accelerate its countdown immediately
  const nextBuffers = structuredClone(state.inbound_message_buffer);
  if (nextBuffers[rPhone]) {
    nextBuffers[rPhone].bufferMode = 'INSTANT_NUDGE';
    nextBuffers[rPhone].processAt = new Date(new Date(nowIso).getTime() + 15 * 1000).toISOString();
  }

  const nudgeMsg = formatLocalizedNotification(
    'INSTANT_NUDGE',
    member,
    target.shortTag || target.taskCode,
    target.title
  );
  const formattedNudge = applyWhatsapp24hWindowPolicy({
    rawText: nudgeMsg,
    person: member,
    shortTag: target.shortTag || target.taskCode,
    title: target.title,
    dueDate: target.dueDate,
    businessProfile: state.business_profile,
    nowIso,
  });

  const nextTasks = state.tasks.map((t) => {
    if (t.taskCode !== taskCode) return t;
    return {
      ...t,
      lastOutboundAt: nowIso,
      reminderConfig: {
        ...t.reminderConfig,
        lastNudgedAt: nowIso,
        nudgeCount: t.reminderConfig.nudgeCount + 1,
      },
      auditLogs: [
        ...t.auditLogs,
        {
          timestamp: nowIso,
          sender: 'BOSS_INSTANT_NUDGE',
          rawInputSummary: `Instant WhatsApp nudge sent to ${member?.name || rPhone}. Buffer switched to INSTANT_NUDGE_ACTIVE.`,
          aiDecision: `Nudge #${t.reminderConfig.nudgeCount + 1} dispatched; 15-min buffer bypassed for next reply.`,
        },
      ],
    };
  });

  return {
    ...state,
    team_members: nextMembers,
    tasks: nextTasks,
    inbound_message_buffer: nextBuffers,
    whatsapp_messages: [
      ...state.whatsapp_messages,
      {
        tenantId: state.tenantId || DEFAULT_TENANT_ID,
        id: `wa-nudge-${Date.now()}`,
        employeePhone: rPhone,
        direction: 'OUTBOUND',
        timestamp: nowIso,
        tag: 'INSTANT_NUDGE',
        taskCode,
        text: formattedNudge.text,
        isTemplateMessage: formattedNudge.isTemplateMessage,
      },
    ],
  };
}

/** Clears a hold reason / next-eligible time computed for the previous Responsible person. */
function clearPersonHold(release: Task['release']): Task['release'] {
  if (!release) return release;
  return { ...release, holdReason: null, nextEligibleAt: null, batchedForDigest: false };
}

/**
 * True when the task's WhatsApp brief has actually gone out to its Responsible person.
 * Scheduled, waiting and draft tasks have not been sent yet.
 */
export function hasTaskBeenSent(
  task: Pick<Task, 'isFrozen' | 'status' | 'release'> | undefined | null
): boolean {
  if (!task) return false;
  if (
    task.status === 'SCHEDULED' ||
    task.status === 'LOCKED_BY_DEPENDENCY' ||
    task.status === 'STAGING_DRAFT'
  ) {
    return false;
  }
  return (
    Boolean(task.isFrozen) &&
    (isTaskReleasedStatus(task.status) || Boolean(task.release?.releasedAt))
  );
}

function buildReassignRemovedMessage(params: {
  state: OpsDatabaseState;
  task: Task;
  oldPhone: string;
  oldMember: TeamMember | undefined;
  newMember: TeamMember | undefined;
  newPhone: string;
  nowIso: string;
  idSuffix: string;
}): SimulatedWhatsappMessage {
  const { state, task, oldPhone, oldMember, newMember, newPhone, nowIso } = params;
  const removedText = formatLocalizedNotification(
    'REASSIGN_REMOVED',
    oldMember,
    task.shortTag || task.taskCode,
    task.title,
    `Now with: ${newMember?.name || newPhone}.`
  );
  const formatted = applyWhatsapp24hWindowPolicy({
    rawText: removedText,
    person: oldMember,
    shortTag: task.shortTag || task.taskCode,
    title: task.title,
    dueDate: task.dueDate,
    businessProfile: state.business_profile,
    nowIso,
  });
  return {
    tenantId: state.tenantId || DEFAULT_TENANT_ID,
    id: `wa-reassign-removed-${task.taskCode}-${params.idSuffix}`,
    employeePhone: oldPhone,
    direction: 'OUTBOUND',
    timestamp: nowIso,
    tag: 'HANDOVER_DISPATCH',
    taskCode: task.taskCode,
    text: formatted.text,
    isTemplateMessage: formatted.isTemplateMessage,
  };
}

/**
 * Reassigns Responsible (R) owner on a task.
 * - Already sent: the new person gets a handover brief and the previous person is told
 *   the task has moved.
 * - Not sent yet (scheduled / waiting): no WhatsApp messages; the new person gets the
 *   brief when the release engine sends the task.
 */
export function reassignTaskResponsible(
  state: OpsDatabaseState,
  taskCode: string,
  newRPhone: string,
  nowIso: string = new Date().toISOString()
): OpsDatabaseState {
  const target = state.tasks.find((t) => t.taskCode === taskCode);
  if (!target || target.raci.R === newRPhone) return state;

  const nextMembers = structuredClone(state.team_members);
  const newMember = nextMembers[newRPhone];
  const oldPhone = target.raci.R;
  const oldMember = nextMembers[oldPhone];
  const accMember = nextMembers[target.raci.A];
  const alreadySent = hasTaskBeenSent(target);
  const nowMs = Date.parse(nowIso) || Date.now();

  const updatedPreview = generateOutboundWhatsappMessage(target, newMember, accMember);

  if (alreadySent && newMember) {
    newMember.stats.assigned += 1;
  }

  const nextTasks = state.tasks.map((t) => {
    if (t.taskCode !== taskCode) return t;
    return {
      ...t,
      raci: {
        ...t.raci,
        R: newRPhone,
      },
      // Not sent yet: drop the previous person's hold so it is re-checked for the new person.
      release: alreadySent ? t.release : clearPersonHold(t.release),
      outboundWhatsappPreview: updatedPreview,
      lastOutboundAt: alreadySent ? nowIso : t.lastOutboundAt,
      auditLogs: [
        ...t.auditLogs,
        {
          timestamp: nowIso,
          sender: 'BOSS_REASSIGN',
          rawInputSummary: `Reassigned R from ${oldMember?.name || t.raci.R} to ${newMember?.name || newRPhone}.`,
          aiDecision: alreadySent
            ? 'Sent WhatsApp handover to the new Responsible owner and told the previous owner.'
            : 'Not sent yet: no WhatsApp messages; the new owner gets the brief on release.',
        },
      ],
    };
  });

  if (!alreadySent) {
    // Re-check release for the new person (their shift, limit, leave). If it can go now,
    // the release engine sends the normal first brief; otherwise it stays held for them.
    return releaseDueTasks(
      {
        ...state,
        team_members: nextMembers,
        tasks: nextTasks,
      },
      nowIso
    ).nextState;
  }

  const handoverText = formatLocalizedNotification(
    'REASSIGN_HANDOVER',
    newMember,
    target.shortTag || target.taskCode,
    target.title,
    `Previous owner: ${oldMember?.name || oldPhone}.`
  );

  const formattedHandover = applyWhatsapp24hWindowPolicy({
    rawText: `${handoverText}\n\n${updatedPreview}`,
    person: newMember,
    shortTag: target.shortTag || target.taskCode,
    title: target.title,
    dueDate: target.dueDate,
    businessProfile: state.business_profile,
    nowIso,
  });

  return {
    ...state,
    team_members: nextMembers,
    tasks: nextTasks,
    whatsapp_messages: [
      ...state.whatsapp_messages,
      {
        tenantId: state.tenantId || DEFAULT_TENANT_ID,
        id: `wa-reassign-${taskCode}-${nowMs}`,
        employeePhone: newRPhone,
        direction: 'OUTBOUND',
        timestamp: nowIso,
        tag: 'HANDOVER_DISPATCH',
        taskCode,
        text: formattedHandover.text,
        isTemplateMessage: formattedHandover.isTemplateMessage,
      },
      buildReassignRemovedMessage({
        state,
        task: target,
        oldPhone,
        oldMember,
        newMember,
        newPhone: newRPhone,
        nowIso,
        idSuffix: String(nowMs),
      }),
    ],
  };
}

export interface CancelTaskResult {
  nextState: OpsDatabaseState;
  /** The Responsible person was sent a "you can stop" message (only if the task had been sent). */
  personNotified: boolean;
  /** Held tasks released because the cancellation freed a slot. */
  releasedTaskCodes: string[];
  /** Tasks left waiting because their prerequisite was cancelled. */
  waitingTaskCodes: string[];
}

/**
 * Cancels a task: status CANCELLED, leaves the active board, tells the Responsible person
 * to stop (only if it had been sent), closes its open owner reviews, keeps dependents held
 * ("Waiting: parent task cancelled"), and re-runs the release engine so a freed slot is used.
 */
export function cancelTask(
  state: OpsDatabaseState,
  taskCode: string,
  nowIso: string = new Date().toISOString()
): CancelTaskResult {
  const target = state.tasks.find((t) => t.taskCode === taskCode);
  if (!target || target.status === 'CANCELLED' || target.status === 'STAGING_DRAFT') {
    return { nextState: state, personNotified: false, releasedTaskCodes: [], waitingTaskCodes: [] };
  }

  const tenantId = state.tenantId || DEFAULT_TENANT_ID;
  const person = state.team_members[target.raci.R];
  const wasSent = hasTaskBeenSent(target) && !isTaskClosed(target.status);
  const nowMs = Date.parse(nowIso) || Date.now();
  const waitingTaskCodes: string[] = [];

  const nextTasks = state.tasks.map((t) => {
    if (t.taskCode === taskCode) {
      return {
        ...t,
        status: 'CANCELLED' as const,
        cancelledAt: nowIso,
        archivedAt: t.archivedAt || nowIso,
        latestAiSummary: 'Cancelled by the owner.',
        release: t.release ? { ...t.release, holdReason: null, nextEligibleAt: null } : t.release,
        auditLogs: [
          ...t.auditLogs,
          {
            timestamp: nowIso,
            sender: 'OWNER_CANCEL',
            rawInputSummary: `Task cancelled (was ${t.status}).`,
            aiDecision: wasSent
              ? `Status -> CANCELLED; told ${person?.name || t.raci.R} to stop.`
              : 'Status -> CANCELLED; not sent yet, so no WhatsApp message.',
          },
        ],
      };
    }
    const waitsOnTarget =
      !isTaskClosed(t.status) &&
      (t.status === 'LOCKED_BY_DEPENDENCY' || t.status === 'SCHEDULED') &&
      (t.release?.afterTaskCode === taskCode || t.dependency?.dependsOnTaskCode === taskCode);
    if (!waitsOnTarget) return t;
    waitingTaskCodes.push(t.taskCode);
    return {
      ...t,
      release: t.release
        ? { ...t.release, holdReason: PARENT_CANCELLED_HOLD_REASON, nextEligibleAt: null }
        : t.release,
      latestAiSummary: PARENT_CANCELLED_HOLD_REASON,
      auditLogs: [
        ...t.auditLogs,
        {
          timestamp: nowIso,
          sender: 'OWNER_CANCEL',
          rawInputSummary: `Prerequisite ${taskCode} was cancelled.`,
          aiDecision: 'Still held until the owner reassigns, releases or cancels it.',
        },
      ],
    };
  });

  const nextReviews = state.boss_review_queue.map((r) =>
    r.taskCode === taskCode && r.status === 'OPEN'
      ? { ...r, status: 'RESOLVED' as const, resolvedAt: nowIso, resolutionReply: 'Task cancelled by the owner.' }
      : r
  );

  const nextWhatsapp = [...state.whatsapp_messages];
  if (wasSent) {
    const formatted = applyWhatsapp24hWindowPolicy({
      rawText: buildTaskCancelledMessage(target, person),
      person,
      shortTag: target.shortTag || target.taskCode,
      title: target.title,
      dueDate: target.dueDate,
      businessProfile: state.business_profile,
      nowIso,
    });
    nextWhatsapp.push({
      tenantId,
      id: `wa-cancel-${taskCode}-${nowMs}`,
      employeePhone: target.raci.R,
      direction: 'OUTBOUND',
      timestamp: nowIso,
      tag: 'TASK_CANCELLED',
      taskCode,
      text: formatted.text,
      isTemplateMessage: formatted.isTemplateMessage,
    });
  }

  const released = releaseDueTasks(
    {
      ...state,
      tasks: nextTasks,
      boss_review_queue: nextReviews,
      whatsapp_messages: nextWhatsapp,
    },
    nowIso
  );

  return {
    nextState: released.nextState,
    personNotified: wasSent,
    releasedTaskCodes: released.releasedTaskCodes,
    waitingTaskCodes,
  };
}

/**
 * Archives a task (removes it from the active board; viewable under "Archived").
 * A live (unfinished) task is cancelled first, exactly like `cancelTask`.
 */
export function archiveTask(
  state: OpsDatabaseState,
  taskCode: string,
  nowIso: string = new Date().toISOString()
): CancelTaskResult {
  const target = state.tasks.find((t) => t.taskCode === taskCode);
  if (!target || target.archivedAt || target.status === 'STAGING_DRAFT') {
    return { nextState: state, personNotified: false, releasedTaskCodes: [], waitingTaskCodes: [] };
  }
  if (!isTaskClosed(target.status)) {
    return cancelTask(state, taskCode, nowIso);
  }
  return {
    nextState: {
      ...state,
      tasks: state.tasks.map((t) =>
        t.taskCode !== taskCode
          ? t
          : {
              ...t,
              archivedAt: nowIso,
              auditLogs: [
                ...t.auditLogs,
                {
                  timestamp: nowIso,
                  sender: 'OWNER_ARCHIVE',
                  rawInputSummary: `Archived (status ${t.status}).`,
                  aiDecision: 'Moved to Archived; no message sent.',
                },
              ],
            }
      ),
    },
    personNotified: false,
    releasedTaskCodes: [],
    waitingTaskCodes: [],
  };
}

/**
 * Manually or automatically unlocks a task waiting on a dependency or schedule hold
 * and routes it through `releaseDueTasks`.
 */
export function forceUnlockTask(
  state: OpsDatabaseState,
  taskCode: string,
  nowIso: string = new Date().toISOString(),
  reasonLabel: string = 'Boss Force Unlock / Partial Handover'
): OpsDatabaseState {
  // Preserve compatibility with callers passing (reasonLabel, nowIso)
  let resolvedNowIso = nowIso;
  let resolvedReason = reasonLabel;
  if (Number.isNaN(Date.parse(nowIso)) && !Number.isNaN(Date.parse(reasonLabel))) {
    resolvedNowIso = reasonLabel;
    resolvedReason = nowIso;
  }

  const target = state.tasks.find((t) => t.taskCode === taskCode);
  if (!target || (target.status !== 'LOCKED_BY_DEPENDENCY' && target.status !== 'SCHEDULED')) {
    return state;
  }

  const rMember = state.team_members[target.raci.R];
  const unlockNotice =
    target.status === 'LOCKED_BY_DEPENDENCY'
      ? formatLocalizedNotification(
          'DEPENDENCY_UNLOCKED',
          rMember,
          target.shortTag || target.taskCode,
          target.title
        )
      : target.release?.unlockNoticeText || null;

  const nextTasks = state.tasks.map((t) => {
    if (t.taskCode !== taskCode) return t;
    const rel = migrateTaskReleaseConfig(t, resolvedNowIso);
    return {
      ...t,
      status: 'SCHEDULED' as const,
      release: {
        ...rel,
        mode: 'NOW' as const,
        releaseAt: null,
        ownerConfirmed: true,
        batchedForDigest: false,
        holdReason: null,
        unlockNoticeText: unlockNotice,
      },
      auditLogs: [
        ...t.auditLogs,
        {
          timestamp: resolvedNowIso,
          sender: 'DEPENDENCY_UNLOCK',
          rawInputSummary: resolvedReason,
          aiDecision: 'Promoted to SCHEDULED (NOW) -> releaseDueTasks evaluation.',
        },
      ],
    };
  });

  return releaseDueTasks(
    {
      ...state,
      tasks: nextTasks,
    },
    resolvedNowIso
  ).nextState;
}

/**
 * Simulates the shift-start Daily Overview Digest Cron:
 * 1. Auto-expires uncompleted yesterday instances of RECURRING tasks as EXPIRED_MISSED
 *    (strictly skipping tasks in AWAITING_BOSS_DECISION).
 * 2. Sends each active staff member a consolidated WhatsApp list of their open tasks
 *    (skipping tasks in AWAITING_BOSS_DECISION and LOCKED_BY_DEPENDENCY).
 */
export function triggerDailyOverviewCron(
  state: OpsDatabaseState,
  nowIso: string = new Date().toISOString()
): {
  nextState: OpsDatabaseState;
  digestsSent: number;
  expiredCount: number;
  /** Names of the people who got a digest, in send order. */
  recipientNames: string[];
} {
  // "Today" in the business timezone (not UTC), so early-morning runs in India use the right day.
  const todayStr = getZonedDateParts(Date.parse(nowIso), state.business_profile?.timezone).dateStr;
  const nextMembers = structuredClone(state.team_members);
  const recipientNames: string[] = [];
  let expiredCount = 0;
  const expiredRecurringTasks: Task[] = [];

  const updatedExistingTasks = state.tasks.map((t) => {
    if (
      t.taskFrequency === 'RECURRING' &&
      t.dueDate < todayStr &&
      !isTaskClosed(t.status) &&
      !t.archivedAt &&
      t.status !== 'AWAITING_BOSS_DECISION' &&
      t.status !== 'STAGING_DRAFT'
    ) {
      expiredCount += 1;
      const owner = nextMembers[t.raci.R];
      if (owner) {
        owner.stats.overdueCount += 1;
      }
      expiredRecurringTasks.push(t);
      return {
        ...t,
        status: 'EXPIRED_MISSED' as const,
        latestAiSummary: `Auto-expired by Daily Shift Cron (uncompleted recurring instance from ${t.dueDate}).`,
        auditLogs: [
          ...t.auditLogs,
          {
            timestamp: nowIso,
            sender: 'DAILY_SHIFT_CRON',
            rawInputSummary: `Uncompleted recurring task past due date (${t.dueDate}).`,
            aiDecision: 'Status -> EXPIRED_MISSED',
          },
        ],
      };
    }
    return t;
  });

  const nextTasks = [...updatedExistingTasks];

  // Auto-spawn fresh clone instance for today for each expired recurring task
  for (const exp of expiredRecurringTasks) {
    const alreadyExists = nextTasks.some(
      (t) =>
        t.title === exp.title &&
        t.raci.R === exp.raci.R &&
        t.dueDate === todayStr &&
        t.status !== 'EXPIRED_MISSED'
    );
    if (!alreadyExists) {
      const spawnedCode = getNextTaskCode(nextTasks);
      const responsible = nextMembers[exp.raci.R];
      const accountable = nextMembers[exp.raci.A];
      const freshMicroSteps = exp.microSteps.map((s, idx) => ({
        id: `ms-${spawnedCode.toLowerCase().replace(/[^a-z0-9]/g, '')}-${idx + 1}`,
        label: s.label,
        status: 'PENDING' as const,
        evidenceNote: undefined,
        verifiedAt: undefined,
      }));

      const spawnedTask: Task = {
        ...exp,
        taskCode: spawnedCode,
        shortTag: exp.shortTag || 'Daily Check',
        dueDate: todayStr,
        status: 'PENDING',
        completionPercent: 0,
        microSteps: freshMicroSteps,
        reminderConfig: {
          ...exp.reminderConfig,
          lastNudgedAt: null,
          nudgeCount: 0,
          includeInDailyOverview: true,
        },
        isFrozen: true,
        lastOutboundAt: nowIso,
        // A fresh cycle sent now: record its own send time (not the expired copy's).
        release: {
          ...migrateTaskReleaseConfig(exp, nowIso),
          mode: 'NOW',
          releaseAt: null,
          releasedAt: nowIso,
          holdReason: null,
          nextEligibleAt: null,
        },
        latestAiSummary: `Auto-spawned recurring instance for ${todayStr}.`,
        auditLogs: [
          {
            timestamp: nowIso,
            sender: 'DAILY_SHIFT_CRON',
            rawInputSummary: `Auto-spawned fresh recurring cycle for ${todayStr} from ${exp.taskCode}.`,
            aiDecision: `Created ${spawnedCode} with status PENDING.`,
          },
        ],
        outboundWhatsappPreview: '',
      };
      spawnedTask.outboundWhatsappPreview = generateOutboundWhatsappMessage(
        spawnedTask,
        responsible,
        accountable
      );

      if (responsible) {
        responsible.stats.assigned += 1;
      }
      nextTasks.push(spawnedTask);
    }
  }

  const nextWhatsapp = [...state.whatsapp_messages];
  let digestsSent = 0;
  const ownerPhones = new Set(getOwnerPhones(nextMembers));
  const businessToday = todayStr;

  for (const member of Object.values(nextMembers)) {
    if (member.isOnLeave) continue;

    // The owner gets "My tasks" (own tasks, decisions waiting, follow-ups) instead of a staff list.
    if (ownerPhones.has(member.phone)) {
      const summary = buildMyTasks(
        { ...state, team_members: nextMembers, tasks: nextTasks, whatsapp_messages: nextWhatsapp },
        { nowIso, todayStr: businessToday, timezone: state.business_profile?.timezone }
      );
      const ownerText = buildOwnerDigestText(summary, member, nextMembers);
      if (!ownerText) continue;
      nextWhatsapp.push({
        tenantId: state.tenantId || DEFAULT_TENANT_ID,
        id: `wa-digest-${member.phone}-${Date.now()}`,
        employeePhone: member.phone,
        direction: 'OUTBOUND',
        timestamp: nowIso,
        tag: 'DAILY_DIGEST',
        text: ownerText,
      });
      digestsSent += 1;
      recipientNames.push(member.name);
      continue;
    }

    const openTasks = nextTasks.filter(
      (t) =>
        t.raci.R === member.phone &&
        t.isFrozen &&
        t.reminderConfig.includeInDailyOverview &&
        (t.status === 'PENDING' || t.status === 'IN_PROGRESS' || t.status === 'PARTIALLY_DONE')
    );

    if (openTasks.length === 0) continue;

    const bulletLines = openTasks
      .map((t) => `• [${t.shortTag || t.taskCode}] ${t.title} (${t.completionPercent}% | ${formatDueShort(t)})`)
      .join('\n');

    let digestText = '';
    if (member.preferredLanguage === 'ENGLISH') {
      digestText = `☀️ Daily Shift Digest for ${member.name} (${member.workShiftStart}–${member.workShiftEnd}):\n${bulletLines}\nNote: Any items awaiting Boss Review remain paused.`;
    } else {
      digestText = `☀️ Good Morning ${staffAddressName(member, member.preferredLanguage)}, Aaj ke active tasks (${member.workShiftStart}–${member.workShiftEnd}):\n${bulletLines}\nKripya kaam shuru karke updates WhatsApp par bhejein.`;
    }

    nextWhatsapp.push({
      id: `wa-digest-${member.phone}-${Date.now()}`,
      employeePhone: member.phone,
      direction: 'OUTBOUND',
      timestamp: nowIso,
      tag: 'DAILY_DIGEST',
      text: digestText,
    });
    digestsSent += 1;
    recipientNames.push(member.name);
  }

  return {
    nextState: {
      ...state,
      team_members: nextMembers,
      tasks: nextTasks,
      whatsapp_messages: nextWhatsapp,
    },
    digestsSent,
    expiredCount,
    recipientNames,
  };
}

/**
 * Resolves an item in boss_review_queue, resumes the task (or marks complete / unlocks downstream tasks),
 * and dispatches the Boss's localized instruction to the employee on WhatsApp.
 */
export function resolveBossReviewItem(
  state: OpsDatabaseState,
  reviewId: string,
  resolutionReply: string,
  approveHandoverUnlock: boolean = true,
  nowIso: string = new Date().toISOString()
): OpsDatabaseState {
  const review = state.boss_review_queue.find((r) => r.reviewId === reviewId);
  if (!review || review.status === 'RESOLVED') return state;

  const nextQueue: BossReviewItem[] = state.boss_review_queue.map((r) =>
    r.reviewId === reviewId
      ? {
          ...r,
          status: 'RESOLVED',
          resolvedAt: nowIso,
          resolutionReply,
        }
      : r
  );

  const stillHasOpenReview = nextQueue.some(
    (r) => r.taskCode === review.taskCode && r.status === 'OPEN'
  );

  const member = state.team_members[review.employeePhone];
  const nextMembers = structuredClone(state.team_members);

  let taskBecameCompletedOrHandedOver = false;

  const nextTasks = state.tasks.map((t) => {
    if (t.taskCode !== review.taskCode) return t;

    const allStepsDone = t.microSteps.every((s) => s.status === 'DONE');
    let nextStatus = t.status;
    if (!stillHasOpenReview) {
      if (allStepsDone && t.completionPercent >= 100) {
        nextStatus = 'COMPLETED';
        taskBecameCompletedOrHandedOver = true;
        if (nextMembers[t.raci.R]) {
          nextMembers[t.raci.R].stats.completed += 1;
        }
      } else if (review.reviewType === 'PARTIAL_HANDOVER_GATE' && approveHandoverUnlock) {
        nextStatus = t.completionPercent > 0 ? 'PARTIALLY_DONE' : 'IN_PROGRESS';
        taskBecameCompletedOrHandedOver = true;
        if (nextMembers[t.raci.R]) {
          nextMembers[t.raci.R].stats.partial += 1;
        }
      } else {
        nextStatus = 'IN_PROGRESS';
      }
    }

    const updatedPauses = (t.pausedIntervals || []).map((p, idx, arr) =>
      idx === arr.length - 1 && !p.resumedAt ? { ...p, resumedAt: nowIso } : p
    );

    return {
      ...t,
      status: nextStatus,
      lastOutboundAt: nowIso,
      pausedIntervals: updatedPauses,
      latestAiSummary: `Boss resolved ${review.reviewType}: "${resolutionReply}"`,
      auditLogs: [
        ...t.auditLogs,
        {
          timestamp: nowIso,
          sender: 'BOSS_REVIEW_RESOLUTION',
          rawInputSummary: `Decision: "${resolutionReply}"`,
          aiDecision: `Review ${review.reviewId} RESOLVED -> Task status ${nextStatus}.`,
        },
      ],
    };
  });

  const parentTask = state.tasks.find((t) => t.taskCode === review.taskCode);
  const taskDisplayName = parentTask?.shortTag || review.taskCode;

  const bossWaMsg = formatLocalizedNotification(
    'BOSS_DECISION',
    member,
    taskDisplayName,
    parentTask?.title || '',
    resolutionReply
  );
  const formattedBossMsg = applyWhatsapp24hWindowPolicy({
    rawText: bossWaMsg,
    person: member,
    shortTag: taskDisplayName,
    title: parentTask?.title || taskDisplayName,
    dueDate: parentTask?.dueDate || '',
    businessProfile: state.business_profile,
    nowIso,
  });

  let workingState: OpsDatabaseState = {
    ...state,
    team_members: nextMembers,
    tasks: nextTasks,
    boss_review_queue: nextQueue,
    whatsapp_messages: [
      ...state.whatsapp_messages,
      {
        tenantId: state.tenantId || DEFAULT_TENANT_ID,
        id: `wa-boss-res-${Date.now()}`,
        employeePhone: review.employeePhone,
        direction: 'OUTBOUND',
        timestamp: nowIso,
        tag: 'BOSS_DECISION',
        taskCode: review.taskCode,
        text: formattedBossMsg.text,
        isTemplateMessage: formattedBossMsg.isTemplateMessage,
      },
    ],
  };

  // Auto-unlock downstream tasks & evaluate any scheduled/WHEN_FREE releases via releaseDueTasks
  if (
    approveHandoverUnlock &&
    (taskBecameCompletedOrHandedOver || review.reviewType === 'PARTIAL_HANDOVER_GATE')
  ) {
    workingState = promoteUnlockedDependentsToScheduled(workingState, review.taskCode, {
      nowIso,
      reasonLabel: `Auto-unlocked after Boss Review approval on ${review.taskCode}`,
      allowPartialHandover: review.reviewType === 'PARTIAL_HANDOVER_GATE',
    });
  }

  return releaseDueTasks(workingState, nowIso).nextState;
}

/**
 * Enforces the 15 MB Video Guard so heavy site videos never clog RAM or database storage.
 */
export function validateMediaAttachment(
  fileSizeMB: number,
  mimeType: string
): { allowedInRam: boolean; guardMessage?: string } {
  const isVideo = mimeType.toLowerCase().startsWith('video/');
  if (isVideo && fileSizeMB > MAX_VIDEO_SIZE_MB) {
    return {
      allowedInRam: false,
      guardMessage: 'Video > 15MB: Skipped RAM inspection — flagged for direct WhatsApp viewing',
    };
  }
  return { allowedInRam: true };
}

/**
 * Routes an oversized (>15MB) video directly to Boss Review without loading Base64 into state.
 */
export function handleOversizedVideoEscalation(
  state: OpsDatabaseState,
  employeePhone: string,
  fileName: string,
  fileSizeMB: number,
  nowIso: string = new Date().toISOString()
): OpsDatabaseState {
  const member = state.team_members[employeePhone];
  if (!member) return state;

  const activeTask =
    state.tasks.find(
      (t) =>
        t.raci.R === employeePhone &&
        (t.status === 'IN_PROGRESS' || t.status === 'PENDING' || t.status === 'PARTIALLY_DONE')
    ) || state.tasks.find((t) => t.raci.R === employeePhone);

  const guardNote = `Video > 15MB (${fileName}, ${fileSizeMB.toFixed(1)} MB): Skipped RAM inspection — flagged for direct WhatsApp viewing`;

  if (!activeTask) {
    return {
      ...state,
      whatsapp_messages: [
        ...state.whatsapp_messages,
        {
          id: `wa-vidguard-${Date.now()}`,
          employeePhone,
          direction: 'SYSTEM_NOTICE',
          timestamp: nowIso,
          tag: '15MB_VIDEO_GUARD',
          text: guardNote,
        },
      ],
    };
  }

  const reviewId = `REV-${Date.now().toString().slice(-4)}`;
  const accountableMember = state.team_members[activeTask.raci.A];
  const supervisorLabel = accountableMember
    ? `${accountableMember.roleTitle} (${accountableMember.slotId || accountableMember.name})`
    : 'the assigned supervisor';
  const newReview: BossReviewItem = {
    reviewId,
    taskCode: activeTask.taskCode,
    employeePhone,
    reviewType: 'DESIGN_SELECTION',
    employeeMessageSummary: `${member.name} sent a ${fileSizeMB.toFixed(1)} MB video (${fileName}) for [${activeTask.taskCode}].`,
    mediaVerificationNote: 'Video > 15MB: Skipped RAM inspection — flagged for direct WhatsApp viewing',
    aiSuggestedReplies: [
      'Checked video directly on WhatsApp — looks good, mark step complete.',
      'Please send 2 clear still photos of the close-up work instead of a large video.',
      `Hold execution until ${supervisorLabel} inspects on site.`,
    ],
    status: 'OPEN',
    createdAt: nowIso,
  };

  const nextTasks = state.tasks.map((t) => {
    if (t.taskCode !== activeTask.taskCode) return t;
    return {
      ...t,
      status: 'AWAITING_BOSS_DECISION' as const,
      latestAiSummary: guardNote,
      pausedIntervals: [...(t.pausedIntervals || []), { pausedAt: nowIso }],
      auditLogs: [
        ...t.auditLogs,
        {
          timestamp: nowIso,
          sender: `${member.name} (${employeePhone})`,
          rawInputSummary: `Sent oversized video ${fileName} (${fileSizeMB.toFixed(1)} MB).`,
          mediaInspected: 'Video > 15MB: Skipped RAM inspection — flagged for direct WhatsApp viewing',
          aiDecision: `Routed to Boss Review Queue (${reviewId}). Status -> AWAITING_BOSS_DECISION.`,
        },
      ],
    };
  });

  const nextMembers = structuredClone(state.team_members);
  nextMembers[employeePhone].lastInboundAt = nowIso;

  return {
    ...state,
    team_members: nextMembers,
    tasks: nextTasks,
    boss_review_queue: [newReview, ...state.boss_review_queue],
    whatsapp_messages: [
      ...state.whatsapp_messages,
      {
        id: `wa-in-vid-${Date.now()}`,
        employeePhone,
        direction: 'INBOUND',
        timestamp: nowIso,
        taskCode: activeTask.taskCode,
        mediaLabel: `${fileName} (${fileSizeMB.toFixed(1)} MB)`,
        text: '[Video Attachment > 15 MB]',
      },
      {
        id: `wa-sys-vid-${Date.now() + 1}`,
        employeePhone,
        direction: 'SYSTEM_NOTICE',
        timestamp: nowIso,
        tag: '15MB_VIDEO_GUARD',
        taskCode: activeTask.taskCode,
        text: 'Video > 15MB: Skipped RAM inspection — flagged for direct WhatsApp viewing & routed to Boss Review Queue.',
      },
    ],
  };
}

/**
 * Appends a message to the employee's 15-minute (or Instant Nudge 2-minute) aggregator buffer.
 * Also handles the Unknown Sender Guard if phone is not in team_members.
 */
export function enqueueInboundSimulatorMessage(
  state: OpsDatabaseState,
  employeePhone: string,
  msg: Omit<InboundMessageBuffer['messages'][number], 'id' | 'timestamp'>,
  nowIso: string = new Date().toISOString()
): { nextState: OpsDatabaseState; unknownSenderBlocked: boolean } {
  const member = state.team_members[employeePhone];
  if (!member) {
    return {
      unknownSenderBlocked: true,
      nextState: {
        ...state,
        whatsapp_messages: [
          ...state.whatsapp_messages,
          {
            id: `wa-unk-in-${Date.now()}`,
            employeePhone,
            direction: 'INBOUND',
            timestamp: nowIso,
            text: msg.textContent || `[Attachment: ${msg.fileName || msg.type}]`,
          },
          {
            id: `wa-unk-guard-${Date.now() + 1}`,
            employeePhone,
            direction: 'SYSTEM_NOTICE',
            timestamp: nowIso,
            tag: 'UNKNOWN_SENDER_GUARD',
            text: `Blocked unregistered number (${employeePhone}): Ignored before LLM buffer & zero tokens consumed.`,
          },
        ],
      },
    };
  }

  const nextMembers = structuredClone(state.team_members);
  nextMembers[employeePhone].lastInboundAt = nowIso;

  const isInstant = member.bufferMode === 'INSTANT_NUDGE_ACTIVE';
  const waitMs = isInstant ? 2 * 60 * 1000 : 15 * 60 * 1000;

  const nextBuffers = structuredClone(state.inbound_message_buffer);
  const existing = nextBuffers[employeePhone];

  const createdMsg = {
    ...msg,
    id: `buf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: nowIso,
  };

  if (existing) {
    existing.messages.push(createdMsg);
    if (isInstant && existing.bufferMode !== 'INSTANT_NUDGE') {
      existing.bufferMode = 'INSTANT_NUDGE';
      existing.processAt = new Date(new Date(nowIso).getTime() + waitMs).toISOString();
    }
  } else {
    nextBuffers[employeePhone] = {
      tenantId: state.tenantId || DEFAULT_TENANT_ID,
      employeePhone,
      bufferMode: isInstant ? 'INSTANT_NUDGE' : 'STANDARD_15_MIN',
      firstMessageAt: nowIso,
      processAt: new Date(new Date(nowIso).getTime() + waitMs).toISOString(),
      messages: [createdMsg],
    };
  }

  return {
    unknownSenderBlocked: false,
    nextState: {
      ...state,
      team_members: nextMembers,
      inbound_message_buffer: nextBuffers,
    },
  };
}

/**
 * Strips any residual base64Data across buffers if persisting to storage.
 */
export function stripEphemeralMediaFromState(state: OpsDatabaseState): OpsDatabaseState {
  const cleanedBuffers: Record<string, InboundMessageBuffer> = {};
  for (const [phone, buf] of Object.entries(state.inbound_message_buffer)) {
    cleanedBuffers[phone] = {
      ...buf,
      messages: buf.messages.map(({ base64Data: _discarded, ...rest }) => rest),
    };
  }
  return {
    ...state,
    inbound_message_buffer: cleanedBuffers,
  };
}

/**
 * Applies the Gemini 2.5 Flash-Lite multimodal batch inspection output to tasks,
 * team stats, Boss Review Queue, dependency unlocks, and clears ephemeral media from RAM.
 */
export function applyProcessedBufferResult(
  state: OpsDatabaseState,
  employeePhone: string,
  aiResult: BufferProcessAiResponse,
  nowIso: string = new Date().toISOString()
): OpsDatabaseState {
  const buffer = state.inbound_message_buffer[employeePhone];
  const member = state.team_members[employeePhone];
  if (!member || !buffer) return state;

  const nextMembers = structuredClone(state.team_members);
  const targetMember = nextMembers[employeePhone];
  targetMember.lastInboundAt = nowIso;
  targetMember.bufferMode = 'STANDARD_15_MIN';

  const tenantId = state.tenantId || DEFAULT_TENANT_ID;
  // Commit buffered messages to visible WhatsApp history WITHOUT base64Data
  const committedMessages = buffer.messages.map((m, idx) => ({
    tenantId,
    id: `wa-commit-${Date.now()}-${idx}`,
    employeePhone,
    direction: 'INBOUND' as const,
    timestamp: m.timestamp,
    taskCode: aiResult.matchedTaskCode || undefined,
    mediaLabel: m.fileName ? `${m.type.toUpperCase()}: ${m.fileName}` : undefined,
    text: m.textContent || `[Sent ${m.type}]`,
  }));

  // Remove processed buffer completely (ephemeral media cleanup!)
  const nextBuffers = { ...state.inbound_message_buffer };
  delete nextBuffers[employeePhone];

  const matchedTask = aiResult.matchedTaskCode
    ? state.tasks.find((t) => t.taskCode === aiResult.matchedTaskCode)
    : state.tasks.find(
        (t) =>
          t.raci.R === employeePhone &&
          (t.status === 'IN_PROGRESS' || t.status === 'PENDING' || t.status === 'PARTIALLY_DONE')
      );

  // A reply about a cancelled or archived task is kept as data only: no status change (rules 5 & 6).
  if (matchedTask && (matchedTask.status === 'CANCELLED' || matchedTask.archivedAt)) {
    const nextTasksClosed = state.tasks.map((t) =>
      t.taskCode !== matchedTask.taskCode
        ? t
        : {
            ...t,
            auditLogs: [
              ...t.auditLogs,
              {
                timestamp: nowIso,
                sender: `${member.name} (${employeePhone})`,
                rawInputSummary: 'WhatsApp update received after the task was closed.',
                aiDecision: 'Logged only; task is cancelled/archived, status unchanged.',
              },
            ],
          }
    );
    return stripEphemeralMediaFromState(
      appendAiLogToState(
        {
          ...state,
          team_members: nextMembers,
          tasks: nextTasksClosed,
          inbound_message_buffer: nextBuffers,
          whatsapp_messages: [...state.whatsapp_messages, ...committedMessages],
        },
        aiResult.aiLog
      )
    );
  }

  if (!matchedTask) {
    return appendAiLogToState(
      {
        ...state,
        team_members: nextMembers,
        inbound_message_buffer: nextBuffers,
        whatsapp_messages: [
          ...state.whatsapp_messages,
          ...committedMessages,
          {
            tenantId,
            id: `wa-ai-reply-${Date.now()}`,
            employeePhone,
            direction: 'OUTBOUND',
            timestamp: nowIso,
            tag: 'AI_BATCH_REPLY',
            text: aiResult.whatsappReplyInPreferredLanguage,
          },
        ],
      },
      aiResult.aiLog
    );
  }

  // Neutral fallback path: log batch, mark "Update received — needs review", send neutral ack, change zero task/step statuses
  if (aiResult.isNeutralFallback) {
    const rawBatchSummary = buffer.messages
      .map((m) => (m.fileName ? `[${m.type}: ${m.fileName}] ${m.textContent || ''}` : m.textContent || ''))
      .join(' | ');

    const neutralReviewMarker = 'Update received — needs review';
    const nextTasksNeutral = state.tasks.map((t) => {
      if (t.taskCode !== matchedTask.taskCode) return t;
      return {
        ...t,
        latestAiSummary: neutralReviewMarker,
        missingStepsAlert: neutralReviewMarker,
        auditLogs: [
          ...t.auditLogs,
          {
            timestamp: nowIso,
            sender: `${member.name} (${employeePhone})`,
            rawInputSummary: rawBatchSummary || 'Buffered WhatsApp batch logged.',
            mediaInspected: aiResult.mediaVerificationNote || undefined,
            aiDecision: `${neutralReviewMarker} (neutral fallback; task and step statuses unchanged).`,
          },
        ],
      };
    });

    return stripEphemeralMediaFromState(
      appendAiLogToState(
        {
          ...state,
          team_members: nextMembers,
          tasks: nextTasksNeutral,
          inbound_message_buffer: nextBuffers,
          whatsapp_messages: [
            ...state.whatsapp_messages,
            ...committedMessages,
            {
              tenantId,
              id: `wa-ai-reply-${Date.now()}`,
              employeePhone,
              direction: 'OUTBOUND',
              timestamp: nowIso,
              tag: 'NEUTRAL_FALLBACK_ACK',
              taskCode: matchedTask.taskCode,
              text: aiResult.whatsappReplyInPreferredLanguage,
            },
          ],
        },
        aiResult.aiLog
      )
    );
  }

  // Compute work-hours-adjusted response time if task had a prior outbound timestamp
  if (matchedTask.lastOutboundAt) {
    const replyMins = calculateWorkHoursMinutes(
      matchedTask.lastOutboundAt,
      nowIso,
      targetMember.workShiftStart,
      targetMember.workShiftEnd,
      matchedTask.pausedIntervals || []
    );
    targetMember.stats.totalWorkHoursReplyMins += replyMins;
    targetMember.stats.replyCount += 1;
  }

  // Merge micro-step updates with code's checks: counts are clamped, and a photo step is
  // only DONE when an image was really sent and the AI says it shows what is required.
  const hasImage = buffer.messages.some((m) => (m.type === 'image' || m.type === 'video') && Boolean(m.base64Data || m.fileName));
  const stepUpdates = new Map(aiResult.updatedMicroSteps.map((u) => [u.id, u]));
  let photoHeldBack = false;
  const mergedSteps = matchedTask.microSteps.map((raw) => {
    const s = enrichStep(raw);
    const upd = stepUpdates.get(s.id);
    if (!upd) return s;
    const res = applyStepUpdate(s, upd, hasImage);
    if (res.heldBack) photoHeldBack = true;
    return res.step;
  });
  const countsInPlay = mergedSteps.some((s) => s.targetCount);

  // Check if downstream tasks depend on this task with PARTIAL_OR_BOSS_APPROVAL
  const hasDownstreamHandoverGate = state.tasks.some(
    (t) =>
      t.status === 'LOCKED_BY_DEPENDENCY' &&
      t.dependency.dependsOnTaskCode === matchedTask.taskCode &&
      t.dependency.triggerCondition === 'PARTIAL_OR_BOSS_APPROVAL'
  );

  // Code does the arithmetic when steps carry counts or a photo check held a step back.
  const clampedPercent =
    countsInPlay || photoHeldBack
      ? completionFromSteps(mergedSteps)
      : Math.max(0, Math.min(100, Math.round(aiResult.completionPercent)));
  const allDone = mergedSteps.every((s) => s.status === 'DONE') && clampedPercent >= 100 && !aiResult.missingStepsAlert;

  // Escalate to Boss Review if AI flagged it OR if partial handover gate needs Boss sign-off while steps are still missing
  const shouldEscalate =
    aiResult.escalateToBossReview ||
    (hasDownstreamHandoverGate && clampedPercent >= 60 && !allDone);

  const nextQueue = [...state.boss_review_queue];
  let createdReviewId: string | null = null;

  if (shouldEscalate) {
    createdReviewId = `REV-${Date.now().toString().slice(-4)}`;
    const rType =
      aiResult.reviewType ||
      (hasDownstreamHandoverGate ? 'PARTIAL_HANDOVER_GATE' : 'BLOCKER_ESCALATION');
    nextQueue.unshift({
      reviewId: createdReviewId,
      taskCode: matchedTask.taskCode,
      employeePhone,
      reviewType: rType,
      employeeMessageSummary: aiResult.englishBossSummary,
      mediaVerificationNote:
        aiResult.mediaVerificationNote || 'Text batch analyzed chronologically (no media attached).',
      aiSuggestedReplies:
        aiResult.aiSuggestedReplies && aiResult.aiSuggestedReplies.length > 0
          ? aiResult.aiSuggestedReplies
          : [
              `Approve handover on [${matchedTask.shortTag || matchedTask.taskCode}] and unlock next dependent task; submit pending receipt by evening.`,
              `Hold handover until the required receipt or proof photo is uploaded on WhatsApp.`,
              `Approved — proceed as proposed and confirm final step.`,
            ],
      status: 'OPEN',
      createdAt: nowIso,
    });
  }

  let nextStatus = matchedTask.status;
  if (shouldEscalate) {
    nextStatus = 'AWAITING_BOSS_DECISION';
  } else if (allDone) {
    nextStatus = 'COMPLETED';
    targetMember.stats.completed += 1;
  } else if (clampedPercent >= 50) {
    nextStatus = 'PARTIALLY_DONE';
  } else {
    nextStatus = 'IN_PROGRESS';
  }

  const rawBatchSummary = buffer.messages
    .map((m) => (m.fileName ? `[${m.type}: ${m.fileName}] ${m.textContent || ''}` : m.textContent || ''))
    .join(' | ');

  // Code decides "behind" from the clock; the AI only reports a delay and any finish time given.
  const parsedNowMs = Date.parse(nowIso);
  const assessedRisk = assessReplyScheduleRisk({
    task: matchedTask,
    allDone: nextStatus === 'COMPLETED',
    delayReported: Boolean(aiResult.delayReported),
    reportedEta: aiResult.reportedEta ?? matchedTask.scheduleRisk?.reportedEta ?? null,
    suggestedFix: aiResult.suggestedFix ?? matchedTask.scheduleRisk?.suggestedFix ?? null,
    nowMs: Number.isNaN(parsedNowMs) ? Date.now() : parsedNowMs,
    timezone: state.business_profile?.timezone,
  });
  // The Accountable person is told once per behind spell, not on every reply.
  const scheduleRisk =
    assessedRisk && matchedTask.scheduleRisk?.alertedAt
      ? { ...assessedRisk, alertedAt: matchedTask.scheduleRisk.alertedAt }
      : assessedRisk;
  const riskNote = scheduleRisk ? ` Behind: ${scheduleRisk.reason}` : '';

  const nextTasks = state.tasks.map((t) => {
    if (t.taskCode !== matchedTask.taskCode) return t;
    return {
      ...t,
      status: nextStatus,
      completionPercent: allDone ? 100 : clampedPercent,
      microSteps: mergedSteps,
      missingStepsAlert: aiResult.missingStepsAlert || '',
      latestAiSummary: aiResult.englishBossSummary,
      scheduleRisk,
      pausedIntervals: shouldEscalate
        ? [...(t.pausedIntervals || []), { pausedAt: nowIso }]
        : t.pausedIntervals,
      auditLogs: [
        ...t.auditLogs,
        {
          timestamp: nowIso,
          sender: `${member.name} (${employeePhone})`,
          rawInputSummary: rawBatchSummary || 'Buffered WhatsApp batch processed.',
          mediaInspected: aiResult.mediaVerificationNote || undefined,
          aiDecision: (shouldEscalate
            ? `Escalated to Boss Review (${createdReviewId}). Status -> AWAITING_BOSS_DECISION (${clampedPercent}%).`
            : `Updated to ${nextStatus} (${allDone ? 100 : clampedPercent}%). ${aiResult.missingStepsAlert ? `Alert: ${aiResult.missingStepsAlert}` : ''}`.trim()) + riskNote,
        },
      ],
    };
  });

  let workingState: OpsDatabaseState = {
    ...state,
    team_members: nextMembers,
    tasks: nextTasks,
    boss_review_queue: nextQueue,
    inbound_message_buffer: nextBuffers,
    whatsapp_messages: [
      ...state.whatsapp_messages,
      ...committedMessages,
      {
        id: `wa-ai-reply-${Date.now()}`,
        employeePhone,
        direction: 'OUTBOUND',
        timestamp: nowIso,
        tag: shouldEscalate ? 'BOSS_ESCALATION_HOLD' : 'AI_CONFIRMATION',
        taskCode: matchedTask.taskCode,
        text: aiResult.whatsappReplyInPreferredLanguage,
      },
    ],
  };

  // A new decision for the owner: send it to their WhatsApp with numbered answers.
  if (createdReviewId) {
    workingState = sendOwnerDecisionPrompts(workingState, nowIso).nextState;
  }

  // Behind now: tell the Accountable person once (with the AI's suggested fix and linked approvals).
  if (scheduleRisk && !scheduleRisk.alertedAt) {
    workingState = sendBehindAlerts(workingState, nowIso, { onlyTaskCodes: [matchedTask.taskCode] }).nextState;
  }

  // If task cleanly reached 100% COMPLETED without needing Boss escalation, promote dependents & run releaseDueTasks
  if (nextStatus === 'COMPLETED') {
    workingState = promoteUnlockedDependentsToScheduled(workingState, matchedTask.taskCode, {
      nowIso,
      reasonLabel: `Auto-unlocked upon 100% completion of ${matchedTask.taskCode}`,
    });
    workingState = releaseDueTasks(workingState, nowIso).nextState;
  }

  return stripEphemeralMediaFromState(appendAiLogToState(workingState, aiResult.aiLog));
}

/**
 * Toggles a micro-step manually, updates completionPercent/status, and routes any
 * newly-unlocked dependents or WHEN_FREE tasks through `releaseDueTasks`.
 */
export function toggleTaskMicroStepManual(
  state: OpsDatabaseState,
  taskCode: string,
  stepId: string,
  nowIso: string = new Date().toISOString()
): OpsDatabaseState {
  const nextMembers = structuredClone(state.team_members);
  let newlyCompleted = false;
  let ownerPhone = '';
  let targetShortTag = taskCode;

  const nextTasks = state.tasks.map((t) => {
    if (t.taskCode !== taskCode) return t;
    targetShortTag = t.shortTag || t.taskCode;
    const updatedSteps = t.microSteps.map((s) => {
      if (s.id !== stepId) return s;
      return {
        ...s,
        status: s.status === 'DONE' ? ('PENDING' as const) : ('DONE' as const),
      };
    });
    const doneCount = updatedSteps.filter((s) => s.status === 'DONE').length;
    const pct = Math.round((doneCount / Math.max(1, updatedSteps.length)) * 100);
    const isAllDone = doneCount === updatedSteps.length;
    const wasCompleted = t.status === 'COMPLETED';

    let nextStatus: TaskStatus = t.status;
    if (
      t.status !== 'AWAITING_BOSS_DECISION' &&
      t.status !== 'LOCKED_BY_DEPENDENCY' &&
      t.status !== 'SCHEDULED'
    ) {
      if (isAllDone) {
        nextStatus = 'COMPLETED';
        if (!wasCompleted) {
          newlyCompleted = true;
          ownerPhone = t.raci.R;
        }
      } else if (pct > 0) {
        nextStatus = 'IN_PROGRESS';
      } else {
        nextStatus = 'PENDING';
      }
    }

    return {
      ...t,
      microSteps: updatedSteps,
      completionPercent: pct,
      status: nextStatus,
    };
  });

  if (newlyCompleted && nextMembers[ownerPhone]) {
    nextMembers[ownerPhone].stats.completed += 1;
  }

  let workingState: OpsDatabaseState = {
    ...state,
    team_members: nextMembers,
    tasks: nextTasks,
  };

  if (newlyCompleted) {
    workingState = promoteUnlockedDependentsToScheduled(workingState, taskCode, {
      nowIso,
      reasonLabel: `Prerequisite [${targetShortTag}] Completed`,
    });
    workingState = releaseDueTasks(workingState, nowIso).nextState;
  }

  return workingState;
}

/**
 * Updates an existing task's fields.
 * - Already sent: any edit to title, steps, deadline or responsible person re-notifies the
 *   Responsible person (and tells the previous person on a reassignment); the edit is logged.
 * - Not sent yet (scheduled / waiting): no "Task Update" message is sent, even if requested;
 *   the person gets the up-to-date brief when the task is released.
 * - Marking the task COMPLETED unlocks its dependent tasks straight away.
 */
export function updateTaskAndNotify(
  state: OpsDatabaseState,
  updatedTask: Task,
  sendWhatsappNotification: boolean = true,
  nowIso: string = new Date().toISOString()
): { nextState: OpsDatabaseState; notificationSent: boolean } {
  const existing = state.tasks.find((t) => t.taskCode === updatedTask.taskCode);
  const nextMembers = structuredClone(state.team_members);
  const rMember = nextMembers[updatedTask.raci.R];
  const wasSent = hasTaskBeenSent(existing);

  const editedFields: string[] = [];
  let responsibleChanged = false;
  if (existing) {
    if (existing.title !== updatedTask.title) editedFields.push('title');
    if (
      existing.microSteps.length !== updatedTask.microSteps.length ||
      existing.microSteps.some(
        (s, i) =>
          s.label !== updatedTask.microSteps[i]?.label ||
          s.status !== updatedTask.microSteps[i]?.status
      )
    ) {
      editedFields.push('steps');
    }
    if (
      existing.dueDate !== updatedTask.dueDate ||
      existing.forcedDeadlineDate !== updatedTask.forcedDeadlineDate
    ) {
      editedFields.push('deadline');
    }
    if (existing.raci.R !== updatedTask.raci.R) {
      editedFields.push('responsible');
      responsibleChanged = true;
      if (rMember && wasSent) {
        rMember.stats.assigned += 1;
      }
    }
  }

  const shouldNotify = wasSent && (sendWhatsappNotification || editedFields.length > 0);
  const nowMs = Date.parse(nowIso) || Date.now();

  const displayTag = updatedTask.shortTag || updatedTask.taskCode;
  const stepsBlock = formatNumberedStepsBlock(updatedTask.microSteps, 'Steps', {
    withStatus: true,
  });
  const rawNotifyText =
    rMember?.preferredLanguage === 'ENGLISH'
      ? `🔄 Task Update [${displayTag}]: "${updatedTask.title}" has been updated.\n${stepsBlock}Due: ${updatedTask.dueDate}\nPlease follow this updated checklist.`
      : `🔄 Task Update [${displayTag}]: "${updatedTask.title}" update ho gaya hai.\n${stepsBlock}Due: ${updatedTask.dueDate}\nKripya updated checklist ke hisaab se kaam karein.`;

  const formattedNotify = applyWhatsapp24hWindowPolicy({
    rawText: rawNotifyText,
    person: rMember,
    shortTag: displayTag,
    title: updatedTask.title,
    dueDate: updatedTask.dueDate,
    businessProfile: state.business_profile,
    nowIso,
  });

  const editedSummary =
    editedFields.length > 0 ? `Edited: ${editedFields.join(', ')}` : 'Updated task details & checklist';
  const notSentNote =
    !wasSent && (sendWhatsappNotification || editedFields.length > 0)
      ? ' (not sent yet, so no WhatsApp update)'
      : '';
  const previousOwnerTold = shouldNotify && responsibleChanged && Boolean(existing);

  const nextTasks = state.tasks.map((t) =>
    t.taskCode === updatedTask.taskCode
      ? {
          ...updatedTask,
          lastOutboundAt: shouldNotify ? nowIso : updatedTask.lastOutboundAt,
          auditLogs: [
            ...updatedTask.auditLogs,
            {
              timestamp: nowIso,
              sender: 'TASK_EDITOR',
              rawInputSummary: `${editedSummary}${shouldNotify ? ' (WhatsApp re-notification sent)' : notSentNote}.`,
              aiDecision: shouldNotify
                ? `Re-notified ${rMember?.name || updatedTask.raci.R} on WhatsApp${
                    previousOwnerTold ? ' and told the previous owner' : ''
                  }.`
                : 'Saved local task changes.',
            },
          ],
        }
      : t
  );

  const nextWhatsapp = [...state.whatsapp_messages];
  if (shouldNotify) {
    nextWhatsapp.push({
      tenantId: state.tenantId || DEFAULT_TENANT_ID,
      id: `wa-update-${updatedTask.taskCode}-${nowMs}`,
      employeePhone: updatedTask.raci.R,
      direction: 'OUTBOUND',
      timestamp: nowIso,
      tag: 'TASK_UPDATE',
      taskCode: updatedTask.taskCode,
      text: formattedNotify.text,
      isTemplateMessage: formattedNotify.isTemplateMessage,
    });
  }
  if (previousOwnerTold && existing) {
    nextWhatsapp.push(
      buildReassignRemovedMessage({
        state,
        task: existing,
        oldPhone: existing.raci.R,
        oldMember: nextMembers[existing.raci.R],
        newMember: rMember,
        newPhone: updatedTask.raci.R,
        nowIso,
        idSuffix: String(nowMs),
      })
    );
  }

  let nextState: OpsDatabaseState = {
    ...state,
    team_members: nextMembers,
    tasks: nextTasks,
    whatsapp_messages: nextWhatsapp,
  };

  // Not sent yet and given to someone else: re-check release for the new person.
  if (!wasSent && responsibleChanged && existing && updatedTask.status === 'SCHEDULED') {
    nextState = {
      ...nextState,
      tasks: nextState.tasks.map((t) =>
        t.taskCode === updatedTask.taskCode ? { ...t, release: clearPersonHold(t.release) } : t
      ),
    };
    nextState = releaseDueTasks(nextState, nowIso).nextState;
  }

  // Completing a task in the edit form unlocks its dependents straight away.
  const newlyCompleted =
    Boolean(existing) && existing!.status !== 'COMPLETED' && updatedTask.status === 'COMPLETED';
  if (newlyCompleted) {
    nextState = promoteUnlockedDependentsToScheduled(nextState, updatedTask.taskCode, {
      nowIso,
      reasonLabel: `Prerequisite ${updatedTask.taskCode} marked completed in the task editor.`,
    });
    nextState = releaseDueTasks(nextState, nowIso).nextState;
  }

  return {
    nextState,
    notificationSent: shouldNotify,
  };
}

