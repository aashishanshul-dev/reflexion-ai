import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVoiceNotePrompt, buildVoiceNoteSpeechText, isVoiceNoteTextClean } from './voiceNotes';
import { buildSlotDirectory } from './promptBuilder';
import { BANQUET_DEMO_PHONES, createBanquetDemoSeedState } from './demoBanquet';

const state = createBanquetDemoSeedState('2026-11-20T04:30:00.000Z');
const dir = buildSlotDirectory(Object.values(state.team_members), state.owner_profile);

test('buildVoiceNoteSpeechText drops names, phones, brackets, emojis and bullet dots', () => {
  const t301 = state.tasks.find((t) => t.taskCode === 'T-301')!;
  const speech = buildVoiceNoteSpeechText(t301.outboundWhatsappPreview, dir);
  assert.doesNotMatch(speech, /Ramesh|Choudhary|\[|\]|·/);
  assert.match(speech, /^ज़रूरी: नमस्ते bhai, Lawn 2 Setup Set up Lawn 2 for the Mehta reception/);
  assert.match(speech, /1\) Clean the lawn and walkways, 2\)/);
  const withPhone = buildVoiceNoteSpeechText(`⚠️ Call Suresh Jain on ${BANQUET_DEMO_PHONES.SURESH} today 🙏`, dir);
  assert.equal(withPhone, 'Call on today');
  assert.equal(isVoiceNoteTextClean(speech, dir), true);
  assert.equal(isVoiceNoteTextClean('Ramesh Choudhary', dir), false);
});

test('buildVoiceNotePrompt asks for a warm voice note in the person\'s language', () => {
  assert.match(buildVoiceNotePrompt('Hello', 'HINDI'), /^Read this WhatsApp task message aloud in natural Hindi/);
  assert.match(buildVoiceNotePrompt('Hello', 'HINGLISH'), /natural Hinglish/);
  assert.match(buildVoiceNotePrompt('Hello', 'ENGLISH'), /clear Indian English[\s\S]*\n\nHello$/);
});

test('banquet story: Ramesh, Gopal and Mahesh prefer voice notes (slide 12: Voice · Hindi)', () => {
  const voice = Object.values(state.team_members).filter((m) => m.prefersVoiceNotes).map((m) => m.phone).sort();
  const { RAMESH, GOPAL, MAHESH } = BANQUET_DEMO_PHONES;
  assert.deepEqual(voice, [RAMESH, GOPAL, MAHESH].sort());
});
