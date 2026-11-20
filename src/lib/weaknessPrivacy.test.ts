import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectWeaknessPhrases,
  stripWeaknessPhrases,
  textContainsWeakness,
} from './weaknessPrivacy';
import { generateOutboundWhatsappMessage } from './opsEngine';
import { TeamMember, Task } from '../types/ops';

function member(phone: string, name: string, extra: Partial<TeamMember> = {}): TeamMember {
  return {
    phone,
    slotId: 'P1',
    name,
    roleTitle: 'Technician',
    authorityLevel: 'STAFF',
    skills: [],
    maxActiveTasks: 3,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '18:00',
    dailyOverviewTime: '09:00',
    isOnLeave: false,
    lastInboundAt: '2026-11-15T00:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: { assigned: 0, completed: 0, partial: 0, overdueCount: 0, totalWorkHoursReplyMins: 0, replyCount: 0 },
    ...extra,
  };
}

const ROSTER = [
  member('911', 'Mohan Ram', { strengths: ['backend infrastructure'], weaknesses: ['slow at paperwork', 'shy on calls'] }),
  member('922', 'Priya Das', { weaknesses: ['x'] }), // 1-char: ignored as too short
];

test('collectWeaknessPhrases: dedupes, drops <3-char fragments, longest first', () => {
  const phrases = collectWeaknessPhrases([
    ...ROSTER,
    member('933', 'Dup', { weaknesses: ['Slow at paperwork'] }),
  ]);
  assert.deepEqual(phrases, ['slow at paperwork', 'shy on calls']);
});

test('textContainsWeakness: case-insensitive, false when none present', () => {
  assert.equal(textContainsWeakness('He is SLOW at paperwork today', ROSTER), true);
  assert.equal(textContainsWeakness('Great work on the backend infrastructure', ROSTER), false);
  assert.equal(textContainsWeakness('', ROSTER), false);
});

test('stripWeaknessPhrases: removes weakness text and tidies spacing/punctuation', () => {
  const out = stripWeaknessPhrases('Please note: slow at paperwork, so send a photo.', ROSTER);
  assert.equal(textContainsWeakness(out, ROSTER), false);
  assert.ok(!/slow at paperwork/i.test(out));
  assert.ok(out.includes('send a photo'));
});

test('stripWeaknessPhrases: leaves strengths and unrelated text untouched', () => {
  const out = stripWeaknessPhrases('Strength: backend infrastructure. Due today.', ROSTER);
  assert.equal(out, 'Strength: backend infrastructure. Due today.');
});

test('generateOutboundWhatsappMessage: weakness never reaches the staff message (backstop)', () => {
  const responsible = member('911', 'Mohan Ram', { weaknesses: ['slow at paperwork'], preferredLanguage: 'ENGLISH' });
  const task = {
    taskCode: 'T-1',
    title: 'Collect vendor quotes',
    dueDate: '2026-11-20',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    shortTag: 'Quotes',
    // A leaked weakness smuggled into a step: it must be stripped from the final message.
    microSteps: ['Call three vendors', 'Note that Mohan is slow at paperwork'],
  } as unknown as Task & { microSteps: string[] };
  const msg = generateOutboundWhatsappMessage(task as any, responsible);
  assert.ok(!/slow at paperwork/i.test(msg), `weakness leaked: ${msg}`);
  assert.ok(msg.includes('Call three vendors'));
});
