/**
 * Shared phone-number detection for free text.
 *
 * The prompt scrubber (promptBuilder) and the plan validator (validator) both use
 * these helpers, so any number the validator would reject is also scrubbed before
 * it reaches the AI — in any formatting ("+91 98765 00002", "98765-00002", ...).
 */

/** Separators people put between phone digits. */
const SEP = '[\\s().-]*';

/** Phone-like spans: 10–15 digits, optionally with +/00 prefix and separators. */
const GENERIC_PHONE_RE = /(?:\+|00)?\(?\d[\d\s().-]{8,18}\d\)?/g;

/** ISO dates/timestamps are masked first so "2026-11-09 10" is never read as a phone. */
const ISO_DATE_RE =
  /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

function digitsOf(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Canonical WhatsApp number format for an Indian business.
 * A bare 10-digit Indian mobile becomes "91" + digits; an already-prefixed
 * 12-digit "91…" number is kept; anything else is returned digits-only (so a
 * foreign number with its own country code is left intact). Shared by the setup
 * wizard, the roster editor, the Team panel and the team-setup import so every
 * save path stores the same 91XXXXXXXXXX form.
 */
export function normalizeIndianPhone(raw: string): string {
  const digits = digitsOf(raw);
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits;
}

/**
 * Regex matching one roster phone in any common formatting: the full number
 * (with or without "+") or its last 10 digits (with or without a leading 0).
 * Returns null for values too short to be a phone.
 */
export function rosterPhoneRegex(phone: string, flags = 'g'): RegExp | null {
  const digits = digitsOf(phone);
  if (digits.length < 7) return null;
  const spaced = (v: string) => v.split('').join(SEP);
  const alternatives = [`\\+?${spaced(digits)}`];
  if (digits.length > 10) {
    const countryCode = digits.slice(0, -10);
    const national = digits.slice(-10);
    // "(+91) 98765 00002" — the bracketed country code is matched as a unit, so
    // prose brackets like "Balbir (+91 98765 00002)" keep their own "(".
    alternatives.unshift(`\\(\\+?${spaced(countryCode)}\\)${SEP}${spaced(national)}`);
    alternatives.push(`(?:0${SEP})?${spaced(national)}`);
  }
  return new RegExp(`(?<!\\d)(?:${alternatives.join('|')})(?!\\d)`, flags);
}

/** Start/end offsets of generic phone-like spans (ISO dates ignored). */
function findGenericPhoneSpans(text: string): Array<[number, number]> {
  const masked = text.replace(ISO_DATE_RE, (m) => '#'.repeat(m.length));
  const spans: Array<[number, number]> = [];
  for (const match of masked.matchAll(GENERIC_PHONE_RE)) {
    const digitCount = digitsOf(match[0]).length;
    if (digitCount >= 10 && digitCount <= 15) {
      spans.push([match.index!, match.index! + match[0].length]);
    }
  }
  return spans;
}

/** True if text contains a roster phone (any formatting) or any phone-like number. */
export function textContainsPhone(text: unknown, rosterPhones: string[] = []): boolean {
  if (!text || typeof text !== 'string') return false;
  for (const phone of rosterPhones) {
    if (rosterPhoneRegex(phone, '')?.test(text)) return true;
  }
  return findGenericPhoneSpans(text).length > 0;
}

/**
 * Replaces roster phones with a per-person replacement, then any remaining
 * phone-like numbers with `otherReplacement`.
 */
export function replacePhonesInText(
  text: string,
  roster: Array<{ phone: string; replacement: string }>,
  otherReplacement: string
): string {
  if (!text) return text;
  let out = text;
  // Longest numbers first so a short number never eats part of a longer one.
  const sorted = [...roster].sort((a, b) => digitsOf(b.phone).length - digitsOf(a.phone).length);
  for (const { phone, replacement } of sorted) {
    const re = rosterPhoneRegex(phone);
    if (re) out = out.replace(re, () => replacement);
  }
  const spans = findGenericPhoneSpans(out);
  for (let i = spans.length - 1; i >= 0; i--) {
    const [start, end] = spans[i];
    out = out.slice(0, start) + otherReplacement + out.slice(end);
  }
  return out;
}
