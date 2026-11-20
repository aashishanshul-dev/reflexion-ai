/**
 * Shared helpers for MediaRecorder-based voice input (WhatsApp Simulator + Meditate)
 * and server-side Gemini audio transcription.
 */
import type { InboundMessageBuffer } from '../types/ops.ts';

export const MIC_BLOCKED_MESSAGE =
  'Microphone blocked — allow it in your browser, or type instead';

export const MIC_UNSUPPORTED_MESSAGE =
  'Voice recording is not available in this browser — type your message instead.';

export const TRANSCRIBE_AUDIO_PROMPT =
  'Listen to this voice note and transcribe accurately what the speaker said, word for word, in the language they spoke (Hindi, Hinglish in Roman script, or English). Return ONLY the spoken transcript text with no quotes, labels, or extra commentary. If the audio is silent or unintelligible, return an empty string.';

/**
 * Chooses the best MediaRecorder audio MIME type for the current browser:
 * prefers audio/mp4 on Safari and audio/webm elsewhere.
 */
export function pickSupportedAudioMimeType(
  isTypeSupported?: (mime: string) => boolean,
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''
): string {
  const isSafari =
    /Safari/i.test(userAgent) && !/Chrome|Chromium|CriOS|Android|Edg/i.test(userAgent);
  const candidates = isSafari
    ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

  if (!isTypeSupported) {
    return isSafari ? 'audio/mp4' : 'audio/webm';
  }
  for (const mime of candidates) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // Ignore probe error and check next candidate
    }
  }
  return '';
}

export function normalizeAudioMimeType(mimeType?: string): string {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (base.startsWith('audio/')) return base;
  return 'audio/webm';
}

export function audioFileExtensionForMime(mimeType?: string): string {
  const base = normalizeAudioMimeType(mimeType);
  if (base === 'audio/mp4' || base === 'audio/aac' || base === 'audio/m4a') return 'm4a';
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/wav') return 'wav';
  return 'webm';
}

export function stripDataUrlPrefix(base64OrDataUrl: string): string {
  const raw = String(base64OrDataUrl || '').trim();
  const commaIdx = raw.indexOf(',');
  return commaIdx >= 0 && raw.slice(0, commaIdx).includes('base64')
    ? raw.slice(commaIdx + 1)
    : raw;
}

export function buildRecordedAudioBufferItem(params: {
  base64Data: string;
  mimeType?: string;
  durationSec?: number;
  caption?: string;
}): Omit<InboundMessageBuffer['messages'][number], 'id' | 'timestamp'> {
  const cleanBase64 = stripDataUrlPrefix(params.base64Data);
  const cleanMime = normalizeAudioMimeType(params.mimeType);
  const ext = audioFileExtensionForMime(cleanMime);
  const dur = Math.max(1, Math.round(params.durationSec || 1));
  const approxBytes = Math.floor((cleanBase64.length * 3) / 4);
  const fileSizeMB = Math.max(0.01, Number((approxBytes / (1024 * 1024)).toFixed(3)));
  const caption = String(params.caption || '').trim();

  return {
    type: 'audio',
    fileName: `voice_note_${dur}s.${ext}`,
    mimeType: cleanMime,
    fileSizeMB,
    base64Data: cleanBase64,
    ...(caption ? { textContent: `Voice Note: "${caption}"` } : {}),
  };
}

export function appendTranscribedText(existing: string, spoken: string): string {
  const prev = String(existing || '').trim();
  const next = String(spoken || '').trim();
  if (!next) return prev;
  if (!prev) return next;
  if (prev.toLowerCase().endsWith(next.toLowerCase())) return prev;
  return `${prev} ${next}`;
}

export function isMicPermissionError(err: unknown): boolean {
  const name =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name?: unknown }).name || '')
      : '';
  const msg =
    err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message || '')
      : '';
  return (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    /permission|not allowed|denied/i.test(msg)
  );
}

export async function transcribeAudioClip(params: {
  audioBase64: string;
  mimeType?: string;
  generate: (
    parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }>
  ) => Promise<{ text: string; modelUsed: string }>;
}): Promise<{ text: string; modelUsed: string }> {
  const cleanBase64 = stripDataUrlPrefix(params.audioBase64);
  if (!cleanBase64) {
    throw new Error('No audio recorded.');
  }
  const cleanMime = normalizeAudioMimeType(params.mimeType);
  const result = await params.generate([
    { inlineData: { mimeType: cleanMime, data: cleanBase64 } },
    { text: TRANSCRIBE_AUDIO_PROMPT },
  ]);
  const cleanedText = String(result.text || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  return {
    text: cleanedText,
    modelUsed: result.modelUsed,
  };
}
