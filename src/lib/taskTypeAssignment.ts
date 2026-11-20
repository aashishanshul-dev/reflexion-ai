import type { CategorySop } from '../types/ops.ts';

export type TaskTypeAssignmentFields = Pick<
  CategorySop,
  'defaultResponsiblePhone' | 'backupResponsiblePhone' | 'spendApprovalRequired'
>;

/**
 * Cleans the owner's task-type assignment choices before saving:
 * empty or unknown people become null, and a backup equal to the default is dropped.
 */
export function normalizeTaskTypeAssignment(
  input: { defaultPhone?: string | null; backupPhone?: string | null; spendApprovalRequired?: boolean },
  rosterPhones: Iterable<string>
): TaskTypeAssignmentFields {
  const known = new Set(rosterPhones);
  const clean = (p?: string | null) => {
    const v = String(p || '').trim();
    return v && known.has(v) ? v : null;
  };
  const def = clean(input.defaultPhone);
  let backup = clean(input.backupPhone);
  if (backup && backup === def) backup = null;
  return {
    defaultResponsiblePhone: def,
    backupResponsiblePhone: backup,
    spendApprovalRequired: Boolean(input.spendApprovalRequired),
  };
}
