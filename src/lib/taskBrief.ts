/**
 * The short WhatsApp brief a person gets for a task: who/what/by when on one line,
 * the steps on one line, and one closing line. No form labels ("Due Date:",
 * "Accountable:"). Language words only; names come from the team profile.
 */
import type { PreferredLanguage, Task, TeamMember } from '../types/ops.ts';
import { staffAddressName } from './staffNames.ts';
import { formatDueShort } from './taskTiming.ts';

export type BriefTask = Pick<Task, 'taskCode' | 'title' | 'dueDate' | 'taskFrequency' | 'recurrenceRule'> & {
  shortTag?: string | null;
  dueTime?: string | null;
  quadrant?: Task['quadrant'];
  microSteps: ReadonlyArray<{ label?: string | null } | string | null | undefined>;
};

/** "1) Load · 2) Deliver · 3) Send photo" (empty when there are no steps). */
export function formatInlineSteps(steps: BriefTask['microSteps'] | null | undefined): string {
  const labels: string[] = [];
  for (const s of steps || []) {
    const label = typeof s === 'string' ? s : s?.label;
    if (typeof label === 'string' && label.trim()) labels.push(label.trim().replace(/[.;]+$/, ''));
  }
  return labels.map((l, i) => `${i + 1}) ${l}`).join(' · ');
}

const REPEAT_WORDS: Record<PreferredLanguage, Record<string, string>> = {
  ENGLISH: { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' },
  HINGLISH: { DAILY: 'roz', WEEKLY: 'har hafte', MONTHLY: 'har mahine' },
  HINDI: { DAILY: 'रोज़', WEEKLY: 'हर हफ़्ते', MONTHLY: 'हर महीने' },
};

/** The task brief in the person's language (2–3 short lines). */
export function buildShortTaskBrief(
  task: BriefTask,
  responsible?: (Pick<TeamMember, 'name' | 'preferredLanguage'> & { addressAs?: string | null }) | null
): string {
  const lang: PreferredLanguage = responsible?.preferredLanguage || 'HINGLISH';
  const tag = (task.shortTag || task.taskCode || '').trim();
  const tagText = tag ? `[${tag}] ` : '';
  const repeat =
    task.taskFrequency === 'RECURRING' && task.recurrenceRule && task.recurrenceRule !== 'NONE'
      ? ` (${REPEAT_WORDS[lang][task.recurrenceRule] || task.recurrenceRule})`
      : '';
  const due = formatDueShort({ dueDate: task.dueDate, dueTime: task.dueTime });
  const steps = formatInlineSteps(task.microSteps);
  const urgent = task.quadrant === 'Q1_DO_FIRST';

  if (lang === 'ENGLISH') {
    const name = staffAddressName(responsible, 'ENGLISH', 'there');
    return [
      `${urgent ? 'URGENT: ' : ''}Hello ${name}, ${tagText}${task.title}${repeat}${due ? ` — due ${due}` : ''}.`,
      steps ? `Steps: ${steps}` : '',
      `Reply here with a photo when it's done.`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (lang === 'HINDI') {
    const name = staffAddressName(responsible, 'HINDI', 'जी');
    return [
      `${urgent ? 'ज़रूरी: ' : ''}नमस्ते ${name}, ${tagText}${task.title}${repeat}${due ? ` — ${due} तक` : ''}।`,
      steps ? `काम: ${steps}` : '',
      `पूरा होने पर यहीं फोटो भेज दें।`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const name = staffAddressName(responsible, 'HINGLISH', 'ji');
  return [
    `${urgent ? 'URGENT: ' : ''}Namaste ${name}, ${tagText}${task.title}${repeat}${due ? ` — ${due} tak` : ''}.`,
    steps ? `Steps: ${steps}` : '',
    `Ho jaye to yahin photo bhej dein.`,
  ]
    .filter(Boolean)
    .join('\n');
}
