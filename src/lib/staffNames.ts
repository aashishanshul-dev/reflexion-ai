/**
 * How to address a person in a message. A person's "Address as" text (e.g. a first
 * name plus the honorific the team uses) wins; otherwise the full name, plus "ji"/"जी"
 * in Hinglish/Hindi. Language words only; no names live in code.
 */
import type { PreferredLanguage, TeamMember } from '../types/ops.ts';

type Named = Pick<TeamMember, 'name'> & { addressAs?: string | null };

export function staffAddressName(
  member: Named | null | undefined,
  lang: PreferredLanguage = 'HINGLISH',
  fallback: string = ''
): string {
  const custom = typeof member?.addressAs === 'string' ? member.addressAs.trim() : '';
  if (custom) return custom;
  const name = typeof member?.name === 'string' ? member.name.trim() : '';
  if (!name) return fallback;
  if (lang === 'ENGLISH') return name;
  if (lang === 'HINDI') return `${name} जी`;
  return `${name} ji`;
}
