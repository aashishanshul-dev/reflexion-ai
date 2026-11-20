import { useCallback, useEffect, useRef, useState } from 'react';

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
 * useVoiceRecorder - Single-instance Web Speech dictation hook.
 * - Commits ONLY final segments to the target input (rebuilt cleanly from baseText snapshot).
 * - Exposes live interim speech separately via `interimTranscript` (never appended to input).
 * - Detaches all listeners and stops cleanly on stop/unmount; never fakes dictation if unsupported.
 */
export function useVoiceRecorder(
  options: UseVoiceRecorderOptions = {}
): UseVoiceRecorderReturn {
  const { lang = 'en-IN', onNotify } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const isStartingRef = useRef<boolean>(false);
  const sessionIdRef = useRef<number>(0);
  const accRef = useRef<VoiceSessionAccumulator>(createVoiceSessionAccumulator(''));
  const lastCommittedTextRef = useRef<string>('');
  const onUpdateRef = useRef<((text: string) => void) | null>(null);
  const onNotifyRef = useRef<((message: string) => void) | undefined>(onNotify);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  onNotifyRef.current = onNotify;

  const isSupported = Boolean(getSpeechRecognitionConstructor());

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    sessionIdRef.current += 1;
    isStartingRef.current = false;
    clearTimer();

    if (recognitionRef.current) {
      const active = recognitionRef.current;
      recognitionRef.current = null;
      detachAndStopRecognition(active, false);
    }

    setIsRecording(false);
    setRecordingSeconds(0);
    setInterimTranscript('');
  }, [clearTimer]);

  // Cleanup active session & listeners on unmount (including React StrictMode remounts)
  useEffect(() => {
    return () => {
      sessionIdRef.current += 1;
      isStartingRef.current = false;
      clearTimer();
      if (recognitionRef.current) {
        const active = recognitionRef.current;
        recognitionRef.current = null;
        detachAndStopRecognition(active, true);
      }
    };
  }, [clearTimer]);

  const startRecording = useCallback(
    async (
      currentText: string,
      onUpdate: (fullText: string) => void
    ): Promise<boolean> => {
      setErrorMessage(null);

      // Guard against duplicate/overlapping start calls
      if (recognitionRef.current || isStartingRef.current) {
        return false;
      }

      const SpeechRecognitionConstructor = getSpeechRecognitionConstructor();
      if (!SpeechRecognitionConstructor) {
        setErrorMessage(UNSUPPORTED_VOICE_MESSAGE);
        onNotifyRef.current?.(UNSUPPORTED_VOICE_MESSAGE);
        return false;
      }

      const sessionId = ++sessionIdRef.current;
      isStartingRef.current = true;
      accRef.current = createVoiceSessionAccumulator(currentText ?? '');
      lastCommittedTextRef.current = currentText ?? '';
      onUpdateRef.current = onUpdate;
      setInterimTranscript('');

      try {
        const rec = new SpeechRecognitionConstructor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.lang = lang;

        rec.onstart = () => {
          if (sessionIdRef.current !== sessionId) return;
          isStartingRef.current = false;
          setIsRecording(true);
          setRecordingSeconds(0);
          clearTimer();
          timerRef.current = setInterval(() => {
            setRecordingSeconds((s) => s + 1);
          }, 1000);
          onNotifyRef.current?.('Microphone active. Speak naturally.');
        };

        rec.onresult = (event: SpeechRecognitionEventLike) => {
          if (sessionIdRef.current !== sessionId) return;
          const resultsArray: SpeechRecognitionResultEntry[] = [];
          const rawResults = event?.results;
          const len = rawResults?.length ?? 0;
          for (let i = 0; i < len; i++) {
            const entry = rawResults[i];
            resultsArray.push({
              isFinal: Boolean(entry?.isFinal),
              transcript: entry?.[0]?.transcript || '',
            });
          }

          const nextAcc = applyRecognitionEvent(accRef.current, {
            resultIndex: event?.resultIndex,
            results: resultsArray,
          });
          accRef.current = nextAcc;
          setInterimTranscript(nextAcc.interimText);

          const nextFinalText = formatVoiceFinalText(nextAcc);
          if (nextFinalText !== lastCommittedTextRef.current) {
            lastCommittedTextRef.current = nextFinalText;
            onUpdateRef.current?.(nextFinalText);
          }
        };

        rec.onerror = (event: any) => {
          if (sessionIdRef.current !== sessionId) return;
          const errCode = event?.error || 'unknown';
          if (errCode === 'not-allowed' || errCode === 'service-not-allowed') {
            const msg = 'Microphone permission blocked. Please allow mic access in your browser.';
            setErrorMessage(msg);
            onNotifyRef.current?.(msg);
          } else if (errCode === 'audio-capture') {
            const msg = 'No microphone detected. Check your audio input device.';
            setErrorMessage(msg);
            onNotifyRef.current?.(msg);
          } else if (errCode !== 'no-speech' && errCode !== 'aborted') {
            setErrorMessage(`Voice recognition error: ${errCode}`);
          }
          stopRecording();
        };

        rec.onend = () => {
          if (sessionIdRef.current !== sessionId) return;
          isStartingRef.current = false;
          if (recognitionRef.current === rec) {
            recognitionRef.current = null;
          }
          clearTimer();
          setIsRecording(false);
          setRecordingSeconds(0);
          setInterimTranscript('');
        };

        recognitionRef.current = rec;
        rec.start();
        return true;
      } catch (err: any) {
        isStartingRef.current = false;
        if (recognitionRef.current) {
          detachAndStopRecognition(recognitionRef.current, true);
          recognitionRef.current = null;
        }
        const msg = err?.message
          ? `Could not start voice input: ${err.message}`
          : UNSUPPORTED_VOICE_MESSAGE;
        setErrorMessage(msg);
        onNotifyRef.current?.(msg);
        setIsRecording(false);
        return false;
      }
    },
    [clearTimer, lang, stopRecording]
  );

  const toggleRecording = useCallback(
    async (
      currentText: string,
      onUpdate: (fullText: string) => void
    ): Promise<void> => {
      if (isRecording || recognitionRef.current || isStartingRef.current) {
        stopRecording();
      } else {
        await startRecording(currentText, onUpdate);
      }
    },
    [isRecording, startRecording, stopRecording]
  );

  return {
    isRecording,
    recordingSeconds,
    isSupported,
    interimTranscript,
    errorMessage,
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
