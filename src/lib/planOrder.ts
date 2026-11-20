/**
 * Plan order and plan labels.
 *
 * - The planner is asked which task waits for which (PLAN_ORDER_RULES); code stores
 *   those links as "After task" so the card and the release engine agree.
 * - Plans get short labels (HEAD-1, HEAD-2 ...) instead of raw AI-made IDs.
 */
import type { MeditateDraftTaskInput } from '../types/ops.ts';

/** Prompt rule asking the planner to set the order of tasks in a project. */
export const PLAN_ORDER_RULES = `TASK ORDER (PROJECT lane):
- Set dependsOnSubtaskIndex on every task that cannot start until an earlier task is finished (it needs that task's result, an approval or a confirmation first). Use the 0-based index of that earlier task in draftedTasks.
- Leave dependsOnSubtaskIndex null only for tasks that can start right away, in parallel with the others.
- Put a waiting task in a later swimlaneStage than the task it waits for.`;

type OrderDraft = Pick<
  MeditateDraftTaskInput,
  'tempId' | 'dependsOnTempIdOrTaskCode' | 'release' | 'ownerEditedFields'
>;

/**
 * Stores the AI's own "this waits for that" links as an "After task" release, so the
 * draft card shows "After task" instead of "Now" and freezing agrees with it. Code
 * never invents a link: a stage says where a task sits, not what it needs. A later-stage
 * task left on "Now" gets a note from the validator instead (`validateDraftPlan` with
 * `stages`). Owner choices are kept. Returns new objects; the input is not changed.
 */
export function applyAiTaskOrder<T extends OrderDraft>(subTasks: T[]): T[] {
  return subTasks.map((t) => {
    const parent = t.dependsOnTempIdOrTaskCode;
    if (!parent || t.release?.mode || (t.ownerEditedFields || []).includes('release')) return t;
    return {
      ...t,
      release: {
        ...(t.release || {}),
        mode: 'AFTER_TASK',
        afterTaskCode: parent,
        afterTrigger: t.release?.afterTrigger || 'FULL_COMPLETION',
      },
    };
  });
}

const SHORT_HEAD_ID = /^HEAD-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/**
 * A short, readable plan label. Keeps IDs already like "HEAD-D1"; replaces raw
 * AI-made IDs ("wbs_metro_onboarding") with the next free "HEAD-<n>".
 */
export function toShortHeadId(rawId: string, takenIds: Set<string>): string {
  const id = (rawId || '').trim();
  if (SHORT_HEAD_ID.test(id) && !takenIds.has(id)) return id;
  let n = 1;
  while (takenIds.has(`HEAD-${n}`)) n++;
  return `HEAD-${n}`;
}
