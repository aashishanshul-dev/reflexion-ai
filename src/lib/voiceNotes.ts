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
    .replace(/\{\{\s*(?:P\d+|पी[\s-]?[0-9०-९]+|प[\s-]?[0-9०-९]+)\s*\}\}|\[\s*(?:P\d+|पी[\s-]?[0-9०-९]+|प[\s-]?[0-9०-९]+)\s*\]|(?<![\p{L}\p{N}_])(?:P\d+|पी[\s-]?[0-9०-९]+)(?![\p{L}\p{N}_])/gu, '') // slot placeholders: dropped
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

/**
 * Text sent to Gemini TTS to be spoken aloud.
 * Must contain ONLY the clean message text — never any instruction preamble,
 * because Gemini TTS reads its entire input text aloud.
 */
export function buildVoiceNotePrompt(speechText: string, _language: PreferredLanguage = 'HINDI'): string {
  return String(speechText || '').trim();
}

/** True when the speech text is safe to send (no team names or phone numbers left). */
export function isVoiceNoteTextClean(speechText: string, dir: SlotDirectory): boolean {
  return verifyZeroPiiInPrompt(speechText, dir).clean && !/\d{10,}/.test(speechText.replace(/\s/g, ''));
}

/**
 * Ensures audio bytes from Gemini TTS are wrapped in a browser-playable WAV
 * container if raw PCM (`audio/L16` / `audio/pcm`) is returned.
 */
export function ensureWavAudio(
  bytes: Uint8Array,
  mimeType: string = 'audio/wav'
): { bytes: Uint8Array; mimeType: string } {
  const hasRiff =
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46;
  const lower = String(mimeType || '').toLowerCase();
  const isRawPcm = lower.includes('audio/l16') || lower.includes('audio/pcm');
  if (hasRiff || !isRawPcm) {
    return { bytes, mimeType: mimeType || 'audio/wav' };
  }

  const rateMatch = lower.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? Number(rateMatch[1]) || 24000 : 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = bytes.length;

  const wav = new Uint8Array(44 + dataSize);
  const view = new DataView(wav.buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) wav[offset + i] = str.charCodeAt(i);
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  wav.set(bytes, 44);
  return { bytes: wav, mimeType: 'audio/wav' };
}
