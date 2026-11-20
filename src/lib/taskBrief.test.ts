import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShortTaskBrief, formatInlineSteps } from './taskBrief';
import { generateOutboundWhatsappMessage } from './opsEngine';
import { buildPlainReleaseWhatsappMessage } from './releaseEngine';
import { createDemoSeedState } from './demoData';

const task = {
  taskCode: 'T-1',
  shortTag: 'Sunrise 40 Jars',
  title: 'Deliver 40 jars to Sunrise IT Park',
  dueDate: '2026-11-19',
  dueTime: '11:00',
  taskFrequency: 'ONE_TIME' as const,
  recurrenceRule: 'NONE' as const,
  quadrant: 'Q1_DO_FIRST' as const,
  microSteps: ['Load 40 jars.', { label: 'Deliver to reception' }, '  ', { label: 'Send photo' }],
};

test('formatInlineSteps numbers steps on one line and skips blanks', () => {
  assert.equal(formatInlineSteps(task.microSteps), '1) Load 40 jars · 2) Deliver to reception · 3) Send photo');
  assert.equal(formatInlineSteps([]), '');
  assert.equal(formatInlineSteps(undefined), '');
});

test('short brief: 3 lines, "Address as", due time in words, no form labels (Hinglish)', () => {
  const msg = buildShortTaskBrief(task, { name: 'Nitin Sharma', preferredLanguage: 'HINGLISH', addressAs: 'Nitin bhai' });
  assert.equal(
    msg,
    'URGENT: Namaste Nitin bhai, [Sunrise 40 Jars] Deliver 40 jars to Sunrise IT Park — 19 Nov, 11:00 tak.\n' +
      'Steps: 1) Load 40 jars · 2) Deliver to reception · 3) Send photo\n' +
      'Ho jaye to yahin photo bhej dein.'
  );
  assert.doesNotMatch(msg, /Due Date|Checklist|Accountable|Supervisor/);
});

test('short brief in English and Hindi; recurring tasks say how often; no steps line when empty', () => {
  const en = buildShortTaskBrief(
    { ...task, quadrant: 'Q2_SCHEDULE', taskFrequency: 'RECURRING', recurrenceRule: 'DAILY', microSteps: [] },
    { name: 'Kavita Joshi', preferredLanguage: 'ENGLISH' }
  );
  assert.equal(
    en,
    "Hello Kavita Joshi, [Sunrise 40 Jars] Deliver 40 jars to Sunrise IT Park (daily) — due 19 Nov, 11:00.\nReply here with a photo when it's done."
  );
  const hi = buildShortTaskBrief({ ...task, dueTime: null }, { name: 'Ramesh', preferredLanguage: 'HINDI' });
  assert.match(hi, /^ज़रूरी: नमस्ते Ramesh जी, \[Sunrise 40 Jars\] .* — 19 Nov तक।\nकाम: 1\) /);
});

test('draft preview and release message both use the short brief', () => {
  const state = createDemoSeedState('2026-11-19T04:00:00.000Z');
  const nitin = state.team_members['919820100006'];
  const rohan = state.team_members['919820100003'];
  const preview = generateOutboundWhatsappMessage(task, nitin, rohan);
  assert.match(preview, /^URGENT: Namaste Nitin bhai, \[Sunrise 40 Jars\]/);
  assert.doesNotMatch(preview, /Rohan|Supervisor|Due:/);
  const t201 = state.tasks.find((t) => t.taskCode === 'T-201')!;
  const release = buildPlainReleaseWhatsappMessage(t201, nitin, rohan, 'Pichla step ho gaya.');
  assert.match(release, /^Pichla step ho gaya\.\n\nURGENT: Namaste Nitin bhai, /);
  assert.match(release, /, 11:00 tak\./);
});
