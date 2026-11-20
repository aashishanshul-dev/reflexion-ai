/**
 * Batch 4 — ready-made routines: run a task type's own checklist (opening checks,
 * event setup, monthly billing ...) for its default person without a new brain dump.
 * Who gets it follows the task type's default/backup rules (leave and limits checked).
 */
import type { CategorySop, MeditateDraftTaskInput, OpsDatabaseState } from '../types/ops.ts';
import { getZonedDateParts, resolveSafeTimezone } from './releaseEngine.ts';
import {
  buildSlotDirectory,
  countOpenTasksByPhone,
  resolveTaskTypeOwner,
  suggestAccountablePhone,
} from './promptBuilder.ts';

export function buildRoutineDraft(
  sop: CategorySop,
  state: Pick<OpsDatabaseState, 'team_members' | 'tasks' | 'owner_profile' | 'business_profile'>,
  options: { daily: boolean; nowMs: number }
): MeditateDraftTaskInput | null {
  const dir = buildSlotDirectory(Object.values(state.team_members || {}), state.owner_profile);
  const choice = resolveTaskTypeOwner(sop, dir, countOpenTasksByPhone(state.tasks || []));
  const R = choice.slotId ? dir.slotToEntry.get(choice.slotId)?.phone : undefined;
  if (!R) return null; // nobody free for this task type: the owner picks in Meditate
  const today = getZonedDateParts(options.nowMs, resolveSafeTimezone(state.business_profile?.timezone)).dateStr;
  return {
    tempId: `routine-${sop.categoryId}-${options.nowMs}`,
    title: `${sop.categoryName}${options.daily ? ' (daily)' : ''}`,
    shortTag: sop.categoryName.slice(0, 24),
    categoryId: sop.categoryId,
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: sop.defaultClassification,
    taskFrequency: options.daily ? 'RECURRING' : 'ONE_TIME',
    recurrenceRule: options.daily ? 'DAILY' : 'NONE',
    raci: { R, A: suggestAccountablePhone(R, dir) || R, C: [], I: [] },
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION',
    startDate: today,
    durationDays: 1,
    dueDate: today,
    dueTime: null,
    microSteps: [...(sop.defaultMicroSteps || [])],
    release: { mode: 'NOW' },
  };
}
