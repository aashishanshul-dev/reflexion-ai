import type { TeamMember } from '../types/ops.ts';

/**
 * Weaknesses are for the owner and the AI only. They must never appear in any text
 * a staff member sees (WhatsApp messages, checklist steps sent out, staff digests).
 * These helpers detect and strip weakness phrases from staff-facing text as a backstop,
 * independent of the validator.
 */

/** Short, meaningful weakness phrases across the whole roster (deduped, trimmed). */
export function collectWeaknessPhrases(members: Iterable<TeamMember>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    for (const raw of m.weaknesses || []) {
      const phrase = String(raw || '').trim();
      // Ignore 1–2 char fragments: too short to match safely without false positives.
      if (phrase.length < 3) continue;
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(phrase);
    }
  }
  // Longest first, so stripping removes the fullest phrase before any sub-phrase.
  return out.sort((a, b) => b.length - a.length);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when any roster weakness phrase appears in the text (case-insensitive). */
export function textContainsWeakness(text: unknown, members: Iterable<TeamMember>): boolean {
  if (typeof text !== 'string' || !text) return false;
  const lower = text.toLowerCase();
  return collectWeaknessPhrases(members).some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Removes every roster weakness phrase from the text and tidies the leftover spacing
 * and punctuation, so a leaked weakness can never reach a staff member verbatim.
 */
export function stripWeaknessPhrases(text: string, members: Iterable<TeamMember>): string {
  if (!text) return text;
  let out = text;
  for (const phrase of collectWeaknessPhrases(members)) {
    out = out.replace(new RegExp(escapeRegExp(phrase), 'gi'), '');
  }
  // Collapse spaces left behind and clean up stray punctuation/leading-trailing gaps.
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
