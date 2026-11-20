/**
 * Batch 3 — task briefs as voice notes (Gemini text-to-speech) for people who prefer
 * them. Privacy: names and phone numbers are swapped for slot IDs and then dropped
 * before the text goes to Gemini, so the model never sees a team member's identity.
 */
import type { PreferredLanguage } from '../types/ops.ts';
import { scrubPiiToSlots, verifyZeroPiiInPrompt, type SlotDirectory } from './promptBuilder.ts';

/** Prepares a WhatsApp brief for speaking: no names, phones, brackets, emojis or bullet dots. */
export function buildVoiceNoteSpeechText(text: string, dir: SlotDirectory): string {
  const anon = scrubPiiToSlots(String(text || ''), dir);
  return anon
    .replace(/\{\{\s*P\d+\s*\}\}|\[\s*P\d+\s*\]|\bP\d+\b/g, '') // slot placeholders: dropped
    .replace(/\[REDACTED_PHONE\]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '') // emojis and symbols
    .replace(/[[\]]/g, '')
    .replace(/\s*·\s*/g, ', ')
    .replace(/\s+([,.।!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s,]+/gm, '')
    .trim();
}

const LANGUAGE_HINT: Record<PreferredLanguage, string> = {
  HINDI: 'in natural Hindi (English words can stay as they are)',
  HINGLISH: 'in natural Hinglish, the way people speak at work in India',
  ENGLISH: 'in clear Indian English',
};

/** The instruction sent to the text-to-speech model. */
export function buildVoiceNotePrompt(speechText: string, language: PreferredLanguage = 'HINDI'): string {
  return `Read this WhatsApp task message aloud ${LANGUAGE_HINT[language] || LANGUAGE_HINT.HINDI}, warm and clear, like a supervisor's voice note. Read numbers and times naturally.\n\n${speechText}`;
}

/** True when the speech text is safe to send (no team names or phone numbers left). */
export function isVoiceNoteTextClean(speechText: string, dir: SlotDirectory): boolean {
  return verifyZeroPiiInPrompt(speechText, dir).clean && !/\d{10,}/.test(speechText.replace(/\s/g, ''));
}
