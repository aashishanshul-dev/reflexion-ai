import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudioApi } from '../services/dataService.ts';
import {
  appendTranscribedText,
  isMicPermissionError,
  MIC_BLOCKED_MESSAGE,
  MIC_UNSUPPORTED_MESSAGE,
  pickSupportedAudioMimeType,
  stripDataUrlPrefix,
} from './voiceInput.ts';

export const UNSUPPORTED_VOICE_MESSAGE = "Voice input isn't supported in this browser";

// SpeechRecognition type declarations for browsers that support it
interface SpeechRecognitionResultItem {
  transcript: string;
  confidence?: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionResultItem;
}

interface SpeechRecognitionEventLike {
  resultIndex?: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

export interface SpeechRecognitionResultEntry {
  isFinal: boolean;
  transcript: string;
}

export interface SpeechRecognitionEventSlice {
  resultIndex?: number;
  results: SpeechRecognitionResultEntry[];
}

export interface VoiceSessionAccumulator {
  baseText: string;
  /** Finalized segments keyed by recognition result index. */
  finalSegments: string[];
  /** Current unfinished (interim) speech preview, never committed into base/final text. */
  interimText: string;
}

export interface UseVoiceRecorderOptions {
  lang?: string;
  onNotify?: (message: string) => void;
}

export interface UseVoiceRecorderReturn {
  isRecording: boolean;
  isTranscribing: boolean;
  recordingSeconds: number;
  isSupported: boolean;
  interimTranscript: string;
  errorMessage: string | null;
  startRecording: (
    currentText: string,
    onUpdate: (fullText: string) => void
  ) => Promise<boolean>;
  stopRecording: () => void;
  toggleRecording: (
    currentText: string,
    onUpdate: (fullText: string) => void
  ) => Promise<void>;
}

function normalizeSpokenChunk(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Rebuilds clean finalized spoken text from indexed final segments while guarding
 * against Chrome/Android continuous-mode duplicate or cumulative final emissions.
 */
export function collectUniqueFinalSpokenText(finalSegments: string[]): string {
  let assembled = '';
  let lastAcceptedLower = '';

  for (let i = 0; i < finalSegments.length; i++) {
    const chunk = normalizeSpokenChunk(finalSegments[i] || '');
    if (!chunk) continue;

    const lower = chunk.toLowerCase();

    // Guard 1: adjacent duplicate emission (e.g. ["yesterday", "yesterday"])
    if (lower === lastAcceptedLower) {
      continue;
    }

    // Guard 2: cumulative prefix re-emission (e.g. ["deliver", "deliver 40 jars"])
    if (assembled && lower.startsWith(`${assembled.toLowerCase()} `)) {
      assembled = chunk;
      lastAcceptedLower = lower;
      continue;
    }

    // Guard 3: shorter trailing duplicate of what just ended the assembled string
    if (
      assembled &&
      (assembled.toLowerCase() === lower || assembled.toLowerCase().endsWith(` ${lower}`))
    ) {
      lastAcceptedLower = lower;
      continue;
    }

    assembled = assembled ? `${assembled} ${chunk}` : chunk;
    lastAcceptedLower = lower;
  }

  return assembled;
}

export function createVoiceSessionAccumulator(baseText: string): VoiceSessionAccumulator {
  return {
    baseText: baseText ?? '',
    finalSegments: [],
    interimText: '',
  };
}

/**
 * Formats ONLY finalized speech appended cleanly onto the pre-recording baseText.
 * Interim text is deliberately excluded so unfinished guesses never pollute the input.
 */
export function formatVoiceFinalText(acc: VoiceSessionAccumulator): string {
  const spokenFinal = collectUniqueFinalSpokenText(acc.finalSegments);
  if (!spokenFinal) return acc.baseText;

  const base = acc.baseText.trim();
  return base ? `${base} ${spokenFinal}` : spokenFinal;
}

/**
 * Applies a SpeechRecognition `onresult` event starting from `event.resultIndex`.
 * - Final segments are stored at their index without re-appending earlier indices.
 * - Interim segments replace `interimText` only and are kept strictly separate.
 */
export function applyRecognitionEvent(
  prev: VoiceSessionAccumulator,
  event: SpeechRecognitionEventSlice
): VoiceSessionAccumulator {
  const nextFinals = [...prev.finalSegments];
  const results = event.results || [];
  const startIdx = Math.max(0, typeof event.resultIndex === 'number' ? event.resultIndex : 0);

  const interimParts: string[] = [];

  for (let i = startIdx; i < results.length; i++) {
    const item = results[i];
    if (!item) continue;
    const chunk = normalizeSpokenChunk(item.transcript);
    if (!chunk) continue;

    if (item.isFinal) {
      nextFinals[i] = chunk;
    } else {
      interimParts.push(chunk);
    }
  }

  // Deduplicate adjacent interim pieces if a mobile engine emits overlapping hypotheses
  const uniqueInterim: string[] = [];
  for (const part of interimParts) {
    const prevPart = uniqueInterim[uniqueInterim.length - 1];
    if (!prevPart || prevPart.toLowerCase() !== part.toLowerCase()) {
      uniqueInterim.push(part);
    }
  }

  return {
    baseText: prev.baseText,
    finalSegments: nextFinals,
    interimText: uniqueInterim.join(' '),
  };
}

/**
 * Pure helper kept for direct final+interim previews in tests/utilities without repetition.
 */
export function buildAccumulatedTranscript(
  baseText: string,
  results: Array<{ isFinal: boolean; transcript: string }>
): string {
  const acc = applyRecognitionEvent(createVoiceSessionAccumulator(baseText), {
    resultIndex: 0,
    results,
  });
  const combinedSpoken = [collectUniqueFinalSpokenText(acc.finalSegments), acc.interimText]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!combinedSpoken) return baseText;
  const base = baseText.trim();
  return base ? `${base} ${combinedSpoken}` : combinedSpoken;
}

function getSpeechRecognitionConstructor(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

function detachAndStopRecognition(rec: any, abort: boolean): void {
  if (!rec) return;
  try {
    rec.onstart = null;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
  } catch {
    // ignore listener cleanup errors
  }
  try {
    if (abort && typeof rec.abort === 'function') {
      rec.abort();
    } else if (typeof rec.stop === 'function') {
      rec.stop();
    }
  } catch {
    // ignore already stopped / invalid state
  }
}

/**
 * useVoiceRecorder - MediaRecorder + Gemini transcription hook.
 * Works across Chrome, Safari, Firefox, and embedded webviews without vendor SpeechRecognition.
 * Never inserts fake/placeholder text on failure.
 */
export function useVoiceRecorder(
  options: UseVoiceRecorderOptions = {}
): UseVoiceRecorderReturn {
  const { onNotify } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>('audio/webm');
  const isStartingRef = useRef<boolean>(false);
  const cancelledRef = useRef<boolean>(false);
  const baseTextRef = useRef<string>('');
  const onUpdateRef = useRef<((text: string) => void) | null>(null);
  const onNotifyRef = useRef<((message: string) => void) | undefined>(onNotify);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  onNotifyRef.current = onNotify;

  const isSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    isStartingRef.current = false;
    clearTimer();
    setIsRecording(false);
    setRecordingSeconds(0);

    const rec = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        releaseStream();
      }
    } else {
      releaseStream();
    }
  }, [clearTimer, releaseStream]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      isStartingRef.current = false;
      clearTimer();
      const rec = mediaRecorderRef.current;
      mediaRecorderRef.current = null;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {}
      }
      releaseStream();
    };
  }, [clearTimer, releaseStream]);

  const startRecording = useCallback(
    async (
      currentText: string,
      onUpdate: (fullText: string) => void
    ): Promise<boolean> => {
      setErrorMessage(null);

      if (mediaRecorderRef.current || isStartingRef.current || isTranscribing) {
        return false;
      }

      if (!isSupported) {
        setErrorMessage(MIC_UNSUPPORTED_MESSAGE);
        onNotifyRef.current?.(MIC_UNSUPPORTED_MESSAGE);
        return false;
      }

      isStartingRef.current = true;
      cancelledRef.current = false;
      baseTextRef.current = currentText ?? '';
      onUpdateRef.current = onUpdate;
      chunksRef.current = [];

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelledRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          isStartingRef.current = false;
          return false;
        }
        streamRef.current = stream;

        const chosenMime = pickSupportedAudioMimeType((m) => MediaRecorder.isTypeSupported(m));
        const recorder = chosenMime
          ? new MediaRecorder(stream, { mimeType: chosenMime })
          : new MediaRecorder(stream);
        mimeTypeRef.current = recorder.mimeType || chosenMime || 'audio/webm';

        recorder.ondataavailable = (evt: BlobEvent) => {
          if (evt.data && evt.data.size > 0) {
            chunksRef.current.push(evt.data);
          }
        };

        recorder.onerror = () => {
          isStartingRef.current = false;
          clearTimer();
          setIsRecording(false);
          setRecordingSeconds(0);
          releaseStream();
          const msg = 'Could not record audio — please type instead.';
          setErrorMessage(msg);
          onNotifyRef.current?.(msg);
        };

        recorder.onstop = () => {
          releaseStream();
          if (cancelledRef.current) return;

          const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
          chunksRef.current = [];
          if (blob.size === 0) {
            const msg = 'No audio recorded — try again or type instead.';
            setErrorMessage(msg);
            onNotifyRef.current?.(msg);
            return;
          }

          setIsTranscribing(true);
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const resultStr = typeof reader.result === 'string' ? reader.result : '';
              const base64 = stripDataUrlPrefix(resultStr);
              if (!base64) {
                throw new Error('Empty audio recording.');
              }
              const { text } = await transcribeAudioApi({
                audioBase64: base64,
                mimeType: mimeTypeRef.current,
              });
              if (cancelledRef.current) return;
              if (!text.trim()) {
                const msg = 'No speech detected — try again or type instead.';
                setErrorMessage(msg);
                onNotifyRef.current?.(msg);
                return;
              }
              onUpdateRef.current?.(appendTranscribedText(baseTextRef.current, text));
            } catch (err: any) {
              if (cancelledRef.current) return;
              const msg =
                err?.message && !/fetch|network/i.test(String(err.message))
                  ? String(err.message)
                  : 'Could not transcribe voice note — please type instead.';
              setErrorMessage(msg);
              onNotifyRef.current?.(msg);
            } finally {
              setIsTranscribing(false);
            }
          };
          reader.onerror = () => {
            setIsTranscribing(false);
            const msg = 'Could not read recorded audio — please type instead.';
            setErrorMessage(msg);
            onNotifyRef.current?.(msg);
          };
          reader.readAsDataURL(blob);
        };

        mediaRecorderRef.current = recorder;
        recorder.start(250);
        isStartingRef.current = false;
        setIsRecording(true);
        setRecordingSeconds(0);
        clearTimer();
        timerRef.current = setInterval(() => {
          setRecordingSeconds((s) => s + 1);
        }, 1000);
        onNotifyRef.current?.('Microphone active. Speak naturally.');
        return true;
      } catch (err: any) {
        isStartingRef.current = false;
        releaseStream();
        const msg = isMicPermissionError(err)
          ? MIC_BLOCKED_MESSAGE
          : 'Could not start microphone — please type instead.';
        setErrorMessage(msg);
        onNotifyRef.current?.(msg);
        setIsRecording(false);
        return false;
      }
    },
    [clearTimer, isSupported, isTranscribing, releaseStream]
  );

  const toggleRecording = useCallback(
    async (
      currentText: string,
      onUpdate: (fullText: string) => void
    ): Promise<void> => {
      if (isRecording || mediaRecorderRef.current || isStartingRef.current) {
        stopRecording();
      } else {
        await startRecording(currentText, onUpdate);
      }
    },
    [isRecording, startRecording, stopRecording]
  );

  return {
    isRecording,
    isTranscribing,
    recordingSeconds,
    isSupported,
    interimTranscript: '',
    errorMessage,
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
