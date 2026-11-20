/**
 * Batch 4 — "Save as rule?": when the owner corrects a draft, offer to keep the
 * correction as a rule so the AI does it that way next time. Code writes the rule
 * text from the edit (who it went to, a step the owner added); the owner decides.
 */
import type {
  CategorySop,
  DraftEditableField,
  MeditateDraftTaskInput,
  SystemMemoryCategory,
  TeamMember,
} from '../types/ops.ts';

export interface RuleSuggestion {
  category: SystemMemoryCategory;
  fact: string;
}

export function suggestRuleFromOwnerEdit(params: {
  draft: Pick<MeditateDraftTaskInput, 'categoryId' | 'raci' | 'microSteps' | 'aiSnapshot'>;
  changedFields: DraftEditableField[];
  teamMembers: Record<string, TeamMember>;
  categories: CategorySop[];
}): RuleSuggestion | null {
  const { draft, changedFields, teamMembers } = params;
  const ai = draft.aiSnapshot || {};
  const typeName =
    params.categories.find((c) => c.categoryId === draft.categoryId)?.categoryName || draft.categoryId || 'this kind of';

  if (changedFields.includes('raci.R')) {
    const before = teamMembers[String(ai['raci.R'] || '')]?.name;
    const after = teamMembers[draft.raci?.R]?.name;
    if (after && before && after !== before) {
      return {
        category: 'SOP_PREFERENCE',
        fact: `For ${typeName} work, give it to ${after} instead of ${before}.`,
      };
    }
  }

  if (changedFields.includes('microSteps')) {
    const aiSteps = new Set((Array.isArray(ai.microSteps) ? (ai.microSteps as string[]) : []).map((s) => s.trim().toLowerCase()));
    const added = (draft.microSteps || []).map((s) => s.trim()).filter((s) => s && !aiSteps.has(s.toLowerCase()));
    if (added.length > 0) {
      return {
        category: 'SOP_PREFERENCE',
        fact: `For ${typeName} work, always include the step: "${added[0]}".`,
      };
    }
  }
  return null;
}
