import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOwnerDecisionPrompt,
  handleOwnerWhatsappMessage,
  parseOwnerWhatsappMessage,
  sendOwnerDecisionPrompts,
} from './ownerWhatsapp';
import { BANQUET_DEMO_PHONES, createBanquetDemoSeedState } from './demoBanquet';
import { createDemoStoryState } from './demoStories';
import type { BossReviewItem } from '../types/ops';

const NOW = '2026-11-20T06:30:00.000Z';
const { OWNER, SURESH } = BANQUET_DEMO_PHONES;

const review = (id: string, createdAt: string): BossReviewItem => ({
  reviewId: id,
  taskCode: 'T-1',
  employeePhone: '1',
  reviewType: 'BUDGET_APPROVAL',
  employeeMessageSummary: 's',
  mediaVerificationNote: '',
  aiSuggestedReplies: ['a', 'b', 'c'],
  status: 'OPEN',
  createdAt,
});

test('parseOwnerWhatsappMessage: numbers decide the oldest open decision; REV-id targets one; brief; notes', () => {
  const open = [review('REV-2', '2026-11-20T05:00:00Z'), review('REV-1', '2026-11-20T04:00:00Z')];
  assert.deepEqual(parseOwnerWhatsappMessage('1', open), { kind: 'DECIDE', reviewId: 'REV-1', optionIndex: 0 });
  assert.deepEqual(parseOwnerWhatsappMessage(' 2 ✅', open), { kind: 'DECIDE', reviewId: 'REV-1', optionIndex: 1 });
  assert.deepEqual(parseOwnerWhatsappMessage('rev-2: 3', open), { kind: 'DECIDE', reviewId: 'REV-2', optionIndex: 2 });
  assert.deepEqual(parseOwnerWhatsappMessage('1', []), { kind: 'NO_DECISION_WAITING' });
  assert.deepEqual(parseOwnerWhatsappMessage('REV-9 1', open), { kind: 'NO_DECISION_WAITING' });
  assert.deepEqual(parseOwnerWhatsappMessage('Brief', open), { kind: 'BRIEF' });
  assert.deepEqual(parseOwnerWhatsappMessage('aaj ka update', open), { kind: 'BRIEF' });
  assert.deepEqual(parseOwnerWhatsappMessage('Kal 300 log aa rahe hain', open), { kind: 'PLAN', text: 'Kal 300 log aa rahe hain' });
  assert.deepEqual(parseOwnerWhatsappMessage('   ', open), { kind: 'NONE' });
  assert.equal(parseOwnerWhatsappMessage('12 chairs', open).kind, 'PLAN');
});

test('buildOwnerDecisionPrompt numbers the suggested answers in the owner\'s language', () => {
  const text = buildOwnerDecisionPrompt({
    review: review('REV-1', NOW),
    tag: 'Chairs',
    staffName: 'Suresh Jain',
    owner: { name: 'Owner', preferredLanguage: 'HINGLISH' },
  });
  assert.equal(text, '🟠 Decision chahiye [REV-1] — [Chairs] (Suresh Jain)\ns\nJawab 1: a\nJawab 2: b\nJawab 3: c');
});

test('the demo starts with the open approval waiting in the owner\'s WhatsApp; prompts are sent once', () => {
  const state = createDemoStoryState('banquet', NOW);
  const prompts = state.whatsapp_messages.filter((m) => m.tag === 'OWNER_DECISION_PROMPT');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].employeePhone, OWNER);
  assert.match(prompts[0].text, /^🟠 Decision chahiye \[REV-301\] — \[150 Extra Chairs\] \(Suresh Jain\)\n/);
  assert.match(prompts[0].text, /Jawab 1: Approved — book Shree Tent House/);
  assert.equal(sendOwnerDecisionPrompts(state, NOW).sentReviewIds.length, 0);
});

test('replying "1" on WhatsApp approves REV-301, tells Suresh, and confirms to the owner', () => {
  const state = createDemoStoryState('banquet', NOW);
  const res = handleOwnerWhatsappMessage(state, OWNER, '1', NOW);
  assert.deepEqual(res.action, { kind: 'DECIDE', reviewId: 'REV-301', optionIndex: 0 });
  assert.equal(res.nextState.boss_review_queue.find((r) => r.reviewId === 'REV-301')?.status, 'RESOLVED');
  const toSuresh = res.nextState.whatsapp_messages.filter((m) => m.employeePhone === SURESH && m.timestamp === NOW);
  assert.ok(toSuresh.some((m) => /Shree Tent House/.test(m.text)));
  const ownerChat = res.nextState.whatsapp_messages.filter((m) => m.employeePhone === OWNER && m.timestamp === NOW);
  assert.deepEqual(ownerChat.map((m) => m.direction), ['INBOUND', 'OUTBOUND']);
  assert.match(ownerChat[1].text, /^✅ REV-301 ka faisla: "Approved — book Shree Tent House/);
  // No decision left: another "1" says so instead of guessing.
  const again = handleOwnerWhatsappMessage(res.nextState, OWNER, '1', NOW);
  assert.equal(again.action.kind, 'NO_DECISION_WAITING');
});

test('"brief" sends today\'s summary; any other note goes to Meditate', () => {
  const state = createBanquetDemoSeedState(NOW);
  const brief = handleOwnerWhatsappMessage(state, OWNER, 'brief', NOW);
  const digest = brief.nextState.whatsapp_messages.at(-1)!;
  assert.equal(digest.tag, 'DAILY_DIGEST');
  assert.match(digest.text, /Namaste Harsh ji/);
  assert.match(digest.text, /Sharma Call/);

  const note = handleOwnerWhatsappMessage(state, OWNER, 'Kal Sharma ji ki shaadi hai, Lawn 3, shaam 7 baje', NOW);
  assert.equal(note.action.kind, 'PLAN');
  assert.equal(note.planText, 'Kal Sharma ji ki shaadi hai, Lawn 3, shaam 7 baje');
  assert.match(note.nextState.whatsapp_messages.at(-1)!.text, /Meditate/);
  // Only owners: a staff phone is ignored here.
  assert.equal(handleOwnerWhatsappMessage(state, '000', 'brief', NOW).action.kind, 'NONE');
  assert.equal(handleOwnerWhatsappMessage(state, SURESH, '1', NOW).action.kind, 'NONE');
});
