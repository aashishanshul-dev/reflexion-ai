import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnonymizedIntentPrompt,
  buildAnonymizedPlannerPrompt,
  buildMeditateWelcomeMessage,
  normalizeOwnerMeditateReply,
  resolveOwnerPreferredLanguage,
  routeMeditateV2Intent,
} from './meditateV2';
import { buildSlotDirectory, deanonymizeMeditateResponse } from './promptBuilder';
import { hasDevanagariScript } from './staffEscalation';
import { BANQUET_DEMO_PHONES, createBanquetDemoSeedState } from './demoBanquet';
import type { PreferredLanguage } from '../types/ops';

const NOW = '2026-11-20T06:30:00.000Z';
const { OWNER } = BANQUET_DEMO_PHONES;

function stateWithOwnerLang(lang: PreferredLanguage) {
  const base = createBanquetDemoSeedState(NOW);
  return {
    ...base,
    team_members: {
      ...base.team_members,
      [OWNER]: { ...base.team_members[OWNER], preferredLanguage: lang },
    },
  };
}

test('welcome message matches owner preferred language with no jargon', () => {
  const en = buildMeditateWelcomeMessage('ENGLISH', 'Sunehri Bagh');
  assert.match(en, /^Hi — tell me what needs doing/);
  assert.equal(hasDevanagariScript(en), false);
  assert.doesNotMatch(en, /\b(WBS|RACI|slot|head|tenant|quadrant)\b/i);

  const hi = buildMeditateWelcomeMessage('HINDI', 'Sunehri Bagh');
  assert.equal(hasDevanagariScript(hi), true);
  assert.doesNotMatch(hi, /\b(WBS|RACI|slot|head|tenant|quadrant)\b/i);

  const hg = buildMeditateWelcomeMessage('HINGLISH', 'Sunehri Bagh');
  assert.match(hg, /^Namaste — bataiye/);
  assert.equal(hasDevanagariScript(hg), false);
  assert.doesNotMatch(hg, /\b(WBS|RACI|slot|head|tenant|quadrant)\b/i);
});

test('owner=ENGLISH stays English across multi-turn (confirm chip, clarifying question, planner reply)', () => {
  const state = stateWithOwnerLang('ENGLISH');
  const members = Object.values(state.team_members);
  const ownerLang = resolveOwnerPreferredLanguage(members, state.owner_profile, state.business_profile);
  assert.equal(ownerLang, 'ENGLISH');

  // Turn 1: low-confidence confirm chip (even if model drifted into Devanagari)
  const confirmTurn = routeMeditateV2Intent(
    {
      kind: 'NOTE',
      confidence: 0.4,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: 'क्या इसे टास्क बनाना है?',
    },
    { ownerLanguage: ownerLang }
  );
  assert.equal(confirmTurn.route, 'AWAIT_OWNER_CONFIRMATION');
  assert.equal(hasDevanagariScript(confirmTurn.replyToOwner), false);
  assert.match(confirmTurn.replyToOwner, /How would you like me to handle this\?/);

  // Turn 2: clarifying question
  const clarifyTurn = routeMeditateV2Intent(
    {
      kind: 'TASK',
      confidence: 0.9,
      missingCritical: ['which lawn'],
      followUpForHeadId: null,
      replyToOwner: 'कौन से लॉन में काम करना है?',
    },
    { ownerLanguage: ownerLang }
  );
  assert.equal(clarifyTurn.route, 'ASK_CLARIFYING_QUESTION');
  assert.equal(hasDevanagariScript(clarifyTurn.replyToOwner), false);

  // Turn 3: planner reply normalized at deanonymizeMeditateResponse
  const dir = buildSlotDirectory(members, state.owner_profile);
  const deanon = deanonymizeMeditateResponse(
    { chatReplyToBoss: 'कार्य ड्राफ्ट तैयार है।' },
    dir
  );
  assert.equal(hasDevanagariScript(deanon.chatReplyToBoss), false);
  assert.match(deanon.chatReplyToBoss, /Draft tasks are ready/);
});

test('owner=HINGLISH stays Roman Hinglish across multi-turn even if model drifts to Devanagari', () => {
  const state = stateWithOwnerLang('HINGLISH');
  const members = Object.values(state.team_members);
  const ownerLang = resolveOwnerPreferredLanguage(members, state.owner_profile, state.business_profile);
  assert.equal(ownerLang, 'HINGLISH');

  const intentBuilt = buildAnonymizedIntentPrompt({
    brainDump: 'Kal shaadi hai',
    teamMembers: members,
    tasks: state.tasks,
    categorySops: state.category_sops,
    systemMemory: [],
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
  });
  assert.match(intentBuilt.systemInstruction, /HINGLISH in Roman script ONLY/);

  const confirmTurn = routeMeditateV2Intent(
    {
      kind: 'NOTE',
      confidence: 0.5,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: 'क्या इसे नोट के रूप में सहेजना है?',
    },
    { ownerLanguage: ownerLang }
  );
  assert.equal(hasDevanagariScript(confirmTurn.replyToOwner), false);

  const clarifyTurn = routeMeditateV2Intent(
    {
      kind: 'TASK',
      confidence: 0.95,
      missingCritical: ['kaun sa lawn'],
      followUpForHeadId: null,
      replyToOwner: 'कौन सा लॉन?',
    },
    { ownerLanguage: ownerLang }
  );
  assert.equal(hasDevanagariScript(clarifyTurn.replyToOwner), false);

  const planReply = normalizeOwnerMeditateReply('ड्राफ्ट तैयार है।', ownerLang, 'PLAN');
  assert.equal(hasDevanagariScript(planReply), false);
});

test('owner=HINDI stays Devanagari across multi-turn even if model drifts to Roman', () => {
  const state = stateWithOwnerLang('HINDI');
  const members = Object.values(state.team_members);
  const ownerLang = resolveOwnerPreferredLanguage(members, state.owner_profile, state.business_profile);
  assert.equal(ownerLang, 'HINDI');

  const plannerBuilt = buildAnonymizedPlannerPrompt({
    brainDump: 'Lawn 2 saaf karvao',
    teamMembers: members,
    tasks: state.tasks,
    categorySops: state.category_sops,
    systemMemory: [],
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
  });
  assert.match(plannerBuilt.systemInstruction, /HINDI in Devanagari script ONLY/);

  const confirmTurn = routeMeditateV2Intent(
    {
      kind: 'NOTE',
      confidence: 0.5,
      missingCritical: [],
      followUpForHeadId: null,
      replyToOwner: 'Should I save this as a note?',
    },
    { ownerLanguage: ownerLang }
  );
  assert.equal(hasDevanagariScript(confirmTurn.replyToOwner), true);

  const clarifyTurn = routeMeditateV2Intent(
    {
      kind: 'TASK',
      confidence: 0.95,
      missingCritical: ['which lawn'],
      followUpForHeadId: null,
      replyToOwner: 'Which lawn is this for?',
    },
    { ownerLanguage: ownerLang }
  );
  assert.equal(hasDevanagariScript(clarifyTurn.replyToOwner), true);

  const dir = buildSlotDirectory(members, state.owner_profile);
  const deanon = deanonymizeMeditateResponse(
    { chatReplyToBoss: 'Draft tasks are ready for review.' },
    dir
  );
  assert.equal(hasDevanagariScript(deanon.chatReplyToBoss), true);
});
