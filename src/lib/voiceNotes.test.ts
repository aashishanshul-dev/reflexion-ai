import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVoiceNotePrompt, buildVoiceNoteSpeechText, ensureWavAudio, isVoiceNoteTextClean } from './voiceNotes';
import { buildSlotDirectory, deanonymizeBufferResponse } from './promptBuilder';
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

test('buildVoiceNotePrompt returns only the clean message text with no instruction preamble', () => {
  for (const lang of ['HINDI', 'HINGLISH', 'ENGLISH'] as const) {
    const out = buildVoiceNotePrompt('जी हां, शाम 6 बजे तक सफाई पूरी कर लें।', lang);
    assert.equal(out, 'जी हां, शाम 6 बजे तक सफाई पूरी कर लें।');
    assert.doesNotMatch(out, /read this|aloud|whatsapp|supervisor|concise|natural hindi|indian english/i);
  }
});

test('banquet story: Ramesh, Gopal and Mahesh prefer voice notes (slide 12: Voice · Hindi)', () => {
  const voice = Object.values(state.team_members).filter((m) => m.prefersVoiceNotes).map((m) => m.phone).sort();
  const { RAMESH, GOPAL, MAHESH } = BANQUET_DEMO_PHONES;
  assert.deepEqual(voice, [RAMESH, GOPAL, MAHESH].sort());
});

test('ensureWavAudio wraps raw PCM with a 44-byte WAV header and passes RIFF WAV through', () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const wrapped = ensureWavAudio(pcm, 'audio/L16;rate=24000');
  assert.equal(wrapped.mimeType, 'audio/wav');
  assert.equal(wrapped.bytes.length, 48);
  assert.equal(String.fromCharCode(...wrapped.bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wrapped.bytes.slice(8, 12)), 'WAVE');

  const riff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]);
  const pass = ensureWavAudio(riff, 'audio/wav');
  assert.equal(pass.bytes, riff);
  assert.equal(pass.mimeType, 'audio/wav');
});

test('deanonymizeBufferResponse and buildVoiceNoteSpeechText never leak Roman or Devanagari slot tokens (P3, पी3, पी३)', () => {
  const gopal = state.team_members[BANQUET_DEMO_PHONES.GOPAL];
  assert.ok(gopal);
  const slot = dir.phoneToEntry.get(gopal.phone)!.slotId; // e.g. P3 or P4

  const devanagariReply = `नमस्ते ${slot.replace(/^P/i, 'पी')}, बहुत बढ़िया। पी99`;
  const suresh = state.team_members[BANQUET_DEMO_PHONES.SURESH];
  assert.ok(suresh);
  const sureshSlot = dir.phoneToEntry.get(suresh.phone)!.slotId;
  const romanReply = `Namaste [${sureshSlot}] ji, kaam ho gaya. P99`;

  const resDevanagari = deanonymizeBufferResponse(
    { whatsappReplyInPreferredLanguage: devanagariReply },
    dir,
    gopal.phone
  );
  assert.doesNotMatch(resDevanagari.whatsappReplyInPreferredLanguage, /P\d+|पी\s*[0-9०-९]+/);
  assert.match(resDevanagari.whatsappReplyInPreferredLanguage, new RegExp(gopal.addressAs || gopal.name));

  const resRoman = deanonymizeBufferResponse(
    { whatsappReplyInPreferredLanguage: romanReply },
    dir,
    suresh.phone
  );
  assert.doesNotMatch(resRoman.whatsappReplyInPreferredLanguage, /P\d+|पी\s*[0-9०-९]+/);
  assert.match(resRoman.whatsappReplyInPreferredLanguage, new RegExp(suresh.addressAs || suresh.name));

  const speech = buildVoiceNoteSpeechText('नमस्ते पी3, बहुत बढ़िया। [P3] पी३', dir);
  assert.doesNotMatch(speech, /P\d+|पी\s*[0-9०-९]+/);
  assert.equal(speech, 'नमस्ते, बहुत बढ़िया।');
});
