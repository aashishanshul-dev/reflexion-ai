/**
 * Batch 2 — step checks. Code reads a step's target count ("Lay out 250 items") and
 * photo requirement ("Send a photo of the fuel gauge") from its words, and gates
 * the AI's step updates: a photo step is only DONE when an image was actually sent
 * and the AI says it shows what is required (rule 2: AI judges the picture, code
 * checks the facts and does the arithmetic).
 */
import type { MicroStep } from '../types/ops.ts';

const NOT_A_COUNT_AFTER =
  /^\s*(?:l\b|ltr|litre|liter|kg|g\b|m\b|mtr|km|min|mins|minute|minutes|hr|hrs|hour|hours|h\b|am\b|pm\b|a\.m|p\.m|%|baje|बजे|days?|din|[:.]\d|x\b|\/)/i;

/** The number of things a step is about ("250 items" → 250), or null. Times, amounts and units are skipped. */
export function parseStepTarget(label: unknown): number | null {
  if (typeof label !== 'string') return null;
  const re = /(^|[^\d₹.,:/-])(\d{1,5})(?![\d,.])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(label))) {
    const before = label.slice(0, m.index + m[1].length);
    if (/(₹|rs\.?|inr)\s*$/i.test(before)) continue;
    const after = label.slice(m.index + m[0].length);
    if (NOT_A_COUNT_AFTER.test(after)) continue;
    const n = Number(m[2]);
    if (n >= 2) return n;
  }
  return null;
}

/** What a step's photo must show ("Send a photo of the fuel gauge" → "fuel gauge"), or null. */
export function parseStepPhotoRequirement(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const tidy = (s: string) =>
    s
      .replace(/\s+(on|via|in)\s+whatsapp\b.*$/i, '')
      .replace(/\s+(after|before|when|once)\b.*$/i, '')
      .replace(/^(the|a|an|clear|clean|quick|one)\s+/i, '')
      .replace(/^(the|a|an|clear|clean|quick)\s+/i, '')
      .replace(/[.;,!]+$/, '')
      .trim();
  const ofMatch = label.match(/\b(?:photo|picture|pic|image)s?\s+(?:of|showing)\s+(.+)/i);
  if (ofMatch && tidy(ofMatch[1])) return tidy(ofMatch[1]);
  const beforeMatch = label.match(/\b([a-z][a-z\s-]{1,40}?)\s+(?:photo|picture|pic)s?\b/i);
  // "message and photo", "a photo": a photo is asked for but nothing specific is named.
  if (beforeMatch && /(?:^|\s)(and|or|with|a|an|the|clear|one)$/i.test(beforeMatch[1].trim())) return GENERIC_PHOTO;
  if (beforeMatch) {
    const words = tidy(beforeMatch[1].replace(/^(send|upload|share|take|click|send the|upload the)\s+/i, ''));
    const cleaned = tidy(words.replace(/^(send|upload|share|take|click)\s+/i, ''));
    if (cleaned && !/^(a|the|clear|one)$/i.test(cleaned)) return cleaned;
  }
  const hindi = label.match(/(.{2,40}?)\s*(?:की|का|के)\s*(?:फोटो|फ़ोटो)/);
  if (hindi) return hindi[1].trim();
  if (/\b(?:photo|picture|pic)s?\b|फोटो|फ़ोटो/i.test(label)) return GENERIC_PHOTO;
  return null;
}

/** Used when a step asks for a photo without naming what it must show. */
export const GENERIC_PHOTO = 'the work done';

/** Adds the code-read target and photo requirement to a step (keeps values already set). */
export function enrichStep(step: MicroStep): MicroStep {
  const targetCount = step.targetCount ?? parseStepTarget(step.label);
  const photoMustShow = step.photoMustShow ?? parseStepPhotoRequirement(step.label);
  return {
    ...step,
    ...(targetCount ? { targetCount, doneCount: step.doneCount ?? 0 } : {}),
    ...(photoMustShow ? { photoMustShow } : {}),
  };
}

export interface StepUpdate {
  status: MicroStep['status'];
  evidenceNote?: string;
  doneCount?: number | null;
  photoShows?: boolean | null;
}

/**
 * Applies the AI's update to one step with code's checks:
 * - counts are clamped to 0..target; reaching the target marks the step DONE;
 * - a photo step stays PENDING (with a note) unless an image was sent and the AI
 *   says it shows what is required.
 * Returns the new step and whether a DONE was held back by the photo check.
 */
export function applyStepUpdate(
  step: MicroStep,
  update: StepUpdate,
  hasImage: boolean
): { step: MicroStep; heldBack: boolean } {
  let status = update.status;
  let evidenceNote = update.evidenceNote || step.evidenceNote;
  let doneCount = step.doneCount;

  if (step.targetCount) {
    const reported = Number(update.doneCount);
    if (Number.isFinite(reported) && reported >= 0) {
      doneCount = Math.min(step.targetCount, Math.max(step.doneCount ?? 0, Math.round(reported)));
    }
    if ((doneCount ?? 0) >= step.targetCount) status = status === 'MISSED' ? status : 'DONE';
    else if (status === 'DONE' && update.doneCount !== undefined && update.doneCount !== null) status = 'PENDING';
  }

  let heldBack = false;
  if (step.photoMustShow && status === 'DONE' && step.status !== 'DONE') {
    if (!hasImage) {
      status = 'PENDING';
      heldBack = true;
      evidenceNote = `Waiting for a photo showing ${step.photoMustShow}.`;
    } else if (update.photoShows !== true) {
      status = 'PENDING';
      heldBack = true;
      evidenceNote = `The photo does not clearly show ${step.photoMustShow}. Please send another.`;
    } else {
      evidenceNote = update.evidenceNote || `Photo shows ${step.photoMustShow}.`;
    }
  }

  return {
    step: {
      ...step,
      status,
      ...(evidenceNote ? { evidenceNote } : {}),
      ...(step.targetCount ? { doneCount: doneCount ?? 0 } : {}),
      ...(step.photoMustShow ? { photoVerified: status === 'DONE' } : {}),
    },
    heldBack,
  };
}

/** How far along one step is, 0..1 (counts give partial credit). */
export function stepProgress(step: MicroStep): number {
  if (step.status === 'DONE') return 1;
  if (step.targetCount && step.doneCount) return Math.min(1, step.doneCount / step.targetCount);
  return 0;
}

/** Task completion from its steps, 0..100. */
export function completionFromSteps(steps: MicroStep[]): number {
  if (!steps || steps.length === 0) return 0;
  return Math.round((steps.reduce((sum, s) => sum + stepProgress(s), 0) / steps.length) * 100);
}

/** "100/250" for a counted step, "" otherwise. */
export function formatStepCount(step: Pick<MicroStep, 'targetCount' | 'doneCount'>): string {
  return step.targetCount ? `${step.doneCount ?? 0}/${step.targetCount}` : '';
}

/** Sample data: read counts and photo needs for every step; seed steps already DONE count as checked. */
export function enrichSeedTaskSteps<T extends { microSteps: MicroStep[] }>(tasks: T[]): T[] {
  return tasks.map((t) => ({
    ...t,
    microSteps: (t.microSteps || []).map((raw) => {
      const step = enrichStep(raw);
      return step.photoMustShow && step.status === 'DONE' ? { ...step, photoVerified: true } : step;
    }),
  }));
}
