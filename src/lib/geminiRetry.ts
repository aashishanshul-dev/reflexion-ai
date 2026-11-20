/**
 * Wait-and-retry for Gemini calls that fail only because Google is busy
 * (503 "high demand", 429 rate limit, 5xx, or our own timeout). Tries the
 * primary model a few times with growing waits, then the backup model.
 * A daily-quota 429 (RESOURCE_EXHAUSTED with a "PerDay" quota) won't clear by
 * waiting, so it moves to the backup model at once: no retries, no wait.
 * Any other error (bad key, model not found, bad request) is thrown at once.
 */
import { GeminiTimeoutError } from './geminiErrors.ts';

/** Waits between attempts on the same model: 3 retries after the first try. */
export const DEFAULT_BUSY_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];

/** Shorter backoff (~1s, 2s, 4s) for live interactive requests under the 45s timeout. */
export const INTERACTIVE_BUSY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/** True when the error means "Google is busy right now, try again later". */
export function isGeminiBusyError(err: unknown): boolean {
  if (err instanceof GeminiTimeoutError) return true;
  const name = String((err as any)?.name ?? '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const raw = String((err as any)?.message ?? err ?? '');
  const status = Number((err as any)?.status) || Number(raw.match(/"code"\s*:\s*(\d{3})/)?.[1]) || 0;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return /high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|ECONNRESET|fetch failed/i.test(raw);
}

/**
 * True when the error is any 429 / quota / rate-limit error (RESOURCE_EXHAUSTED).
 * Switching to the backup model immediately avoids wasting interactive latency on
 * a model whose quota is currently exhausted.
 */
export function isGeminiQuotaError(err: unknown): boolean {
  const raw = String((err as any)?.message ?? err ?? '');
  const status = Number((err as any)?.status) || Number(raw.match(/"code"\s*:\s*(\d{3})/)?.[1]) || 0;
  return status === 429 || /RESOURCE_EXHAUSTED/i.test(raw);
}

/**
 * True when the error is a 429 for a per-day quota (e.g. quotaId
 * "GenerateRequestsPerDayPerProjectPerModel"). Retrying the same model today
 * is pointless, so callers should switch to the backup model immediately.
 */
export function isGeminiDailyQuotaError(err: unknown): boolean {
  return isGeminiQuotaError(err) && /PerDay/i.test(String((err as any)?.message ?? err ?? ''));
}

export interface BusyRetryEvent {
  model: string;
  attempt: number;
  error: unknown;
  /** Wait before the next try on this model, or null when moving to the next model. */
  nextDelayMs: number | null;
}

export interface BusyRetryResult<T> {
  result: T;
  modelUsed: string;
  /** Total calls made, including the successful one. */
  attempts: number;
  usedBackupModel: boolean;
}

export async function callWithBusyRetry<T>(opts: {
  models: Array<string | undefined>;
  call: (model: string) => Promise<T>;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (event: BusyRetryEvent) => void;
  /** Return false to move straight to the backup model instead of retrying the same model. */
  shouldRetrySameModel?: (err: unknown) => boolean;
  /** When primary and backup are distinct and both stay busy (non-quota, non-timeout), pause briefly and try primary once more. */
  finalPrimaryRetryDelayMs?: number;
  /** Optional overall time budget (ms) across all attempts and sleeps (e.g. 45_000). */
  totalTimeoutMs?: number;
  now?: () => number;
}): Promise<BusyRetryResult<T>> {
  const models = [...new Set(opts.models.map((m) => m?.trim()).filter((m): m is string => !!m))];
  if (models.length === 0) throw new Error('callWithBusyRetry needs at least one model');
  const delays = opts.retryDelaysMs ?? DEFAULT_BUSY_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadlineMs =
    typeof opts.totalTimeoutMs === 'number' && opts.totalTimeoutMs > 0
      ? now() + opts.totalTimeoutMs
      : null;
  const remainingMs = () => (deadlineMs === null ? Infinity : deadlineMs - now());
  const canRetrySameModel =
    opts.shouldRetrySameModel ?? ((err: unknown) => !(err instanceof GeminiTimeoutError) && !isGeminiQuotaError(err));

  let attempts = 0;
  let lastError: unknown;
  let primaryError: unknown;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    for (let i = 0; i <= delays.length; i++) {
      if (attempts > 0 && remainingMs() <= 0) {
        throw lastError ?? new GeminiTimeoutError(model, opts.totalTimeoutMs ?? 45_000);
      }
      attempts++;
      try {
        const result = await opts.call(model);
        return { result, modelUsed: model, attempts, usedBackupModel: m > 0 };
      } catch (err) {
        if (!isGeminiBusyError(err)) throw err;
        lastError = err;
        if (m === 0 && primaryError === undefined) primaryError = err;
        const retrySame = canRetrySameModel(err);
        const plannedDelay = retrySame && i < delays.length ? delays[i] : null;
        const nextDelayMs =
          plannedDelay !== null && remainingMs() > plannedDelay ? plannedDelay : null;
        opts.onRetry?.({ model, attempt: i + 1, error: err, nextDelayMs });
        if (nextDelayMs === null) break;
        await sleep(nextDelayMs);
      }
    }
  }

  if (
    opts.finalPrimaryRetryDelayMs &&
    opts.finalPrimaryRetryDelayMs > 0 &&
    models.length > 1 &&
    canRetrySameModel(primaryError ?? lastError) &&
    remainingMs() > opts.finalPrimaryRetryDelayMs
  ) {
    const primary = models[0];
    await sleep(opts.finalPrimaryRetryDelayMs);
    if (remainingMs() > 0) {
      attempts++;
      try {
        const result = await opts.call(primary);
        return { result, modelUsed: primary, attempts, usedBackupModel: false };
      } catch (err) {
        if (!isGeminiBusyError(err)) throw err;
        lastError = err;
      }
    }
  }

  throw lastError;
}
