/**
 * Time limits and plain-language error messages for Gemini calls.
 */

/** Longest a single Gemini call may take before we give up on it. */
export const GEMINI_CALL_TIMEOUT_MS = 45_000;

export class GeminiTimeoutError extends Error {
  readonly model: string;
  readonly timeoutMs: number;
  constructor(model: string, timeoutMs: number) {
    super(`Gemini model ${model} did not reply within ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = 'GeminiTimeoutError';
    this.model = model;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when both the primary and the fallback model failed. `message` is a
 * short, plain-language explanation that is safe to show to the owner.
 */
export class GeminiCallFailedError extends Error {
  readonly userMessage: string;
  readonly causes: unknown[];
  constructor(userMessage: string, causes: unknown[] = []) {
    super(userMessage);
    this.name = 'GeminiCallFailedError';
    this.userMessage = userMessage;
    this.causes = causes;
  }
}

/**
 * Runs `call(signal)` but rejects with GeminiTimeoutError after `timeoutMs`,
 * aborting the underlying request so it doesn't keep running in the background.
 */
export async function withGeminiTimeout<T>(
  model: string,
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = GEMINI_CALL_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GeminiTimeoutError(model, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One short sentence describing why a Gemini call failed, in simple words. */
export function describeGeminiError(err: unknown, model: string): string {
  if (err instanceof GeminiTimeoutError) {
    return `${model} did not reply within ${Math.round(err.timeoutMs / 1000)} seconds (Google's servers may be busy)`;
  }
  const raw = String((err as any)?.message ?? (err as any)?.status ?? err ?? '');
  const name = String((err as any)?.name ?? '');
  if (name === 'AbortError' || name === 'TimeoutError' || /aborted|timed? ?out/i.test(raw)) {
    return `${model} did not reply in time (Google's servers may be busy)`;
  }
  const status = Number((err as any)?.status) || Number(raw.match(/\b(4\d\d|5\d\d)\b/)?.[1]) || 0;
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(raw)) {
    return `${model} is over your Gemini usage limit`;
  }
  if (status === 404 || /not found|no longer available/i.test(raw)) {
    return `${model} is not available to your API key`;
  }
  if (status === 401 || status === 403 || /API key/i.test(raw)) {
    return `Google rejected the GEMINI_API_KEY for ${model}`;
  }
  if (status === 503 || /overloaded|high demand|UNAVAILABLE/i.test(raw)) {
    return `${model} is overloaded right now`;
  }
  if (/fetch failed|ENOTFOUND|ECONNRESET|network/i.test(raw)) {
    return `could not connect to Google's Gemini servers`;
  }
  return `${model} returned an error`;
}

/** Message shown to the owner when both models failed. */
export function buildGeminiFailureMessage(
  primary: { model: string; error: unknown },
  fallback?: { model: string; error: unknown }
): string {
  const parts = [describeGeminiError(primary.error, primary.model)];
  if (fallback && fallback.model !== primary.model) {
    parts.push(`the backup model ${describeGeminiError(fallback.error, fallback.model)}`);
  }
  return `Sorry, the AI couldn't finish this request right now: ${parts.join(', and ')}. Nothing was changed — please try again in a moment.`;
}

/**
 * True when a model's text is a complete JSON value. A reply cut off by the output
 * limit (thinking models spend part of it before answering) is not, and should go
 * to the backup model instead of failing the request.
 */
export function isCompleteJsonText(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  try {
    JSON.parse(text.trim());
    return true;
  } catch {
    return false;
  }
}
