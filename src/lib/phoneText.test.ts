import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialSeedState } from './seedData';
import {
  buildSlotDirectory,
  deanonymizeMeditateResponse,
  scrubPiiToSlots,
  verifyZeroPiiInPrompt,
} from './promptBuilder';
import {
  MeditateValidationContext,
  OWNER_REPLY_NUMBER_PLACEHOLDER,
  validateIntentStageOutput,
  validateMeditatePlan,
} from './validator';
import { textContainsPhone, normalizeIndianPhone } from './phoneText';

// Seed roster: P3 = Balbir, phone 919876500002 ; P2 = Mohan Ram, phone 919876500001
const state = createInitialSeedState('2026-11-09T10:00:00.000Z');
const roster = Object.values(state.team_members);
const dir = buildSlotDirectory(roster, state.owner_profile);
const BALBIR = roster.find((m) => m.name === 'Balbir')!;
const categoryId = state.category_sops[0].categoryId;

const serverCtx: MeditateValidationContext = {
  roster,
  categoryIds: state.category_sops.map((c) => c.categoryId),
  existingTasks: state.tasks,
  defaultAccountableSlot: dir.defaultAccountableSlot,
  ownerProfile: state.owner_profile,
  maxChecklistStepsPerTask: 5,
  allowResolvedPhonesInRaci: false,
};
const clientCtx: MeditateValidationContext = {
  ...serverCtx,
  defaultAccountableSlot: undefined,
  defaultAccountablePhone: state.owner_profile?.defaultAccountablePhone,
  allowResolvedPhonesInRaci: true,
};

function makeRawPlan(overrides: { chatReplyToBoss?: string; preview?: string; step?: string } = {}) {
  return {
    intentClassification: 'ACTIONABLE_AGENDA',
    chatReplyToBoss: overrides.chatReplyToBoss ?? 'Assigned to {{P3}}.',
    reasoningSummary: 'P3 has capacity.',
    agendaTitle: 'Fix lawn cable',
    agendaQuadrant: 'Q1_DO_FIRST',
    agendaMajorOrMinor: 'MINOR',
    suggestedMemoryRules: [],
    wbsHeads: [],
    draftedTasks: [
      {
        title: 'Fix lawn cable',
        shortTag: 'Cable',
        categoryId,
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MINOR',
        dueDateOffsetDays: 1,
        raci: { R: 'P3', A: 'P2', C: [], I: [] },
        microSteps: [overrides.step ?? 'Check the cable'],
        outboundWhatsappPreview: overrides.preview ?? 'Hi {{P3}}, please fix the lawn cable.',
      },
    ],
  };
}

test('scrubber removes team phones in any formatting before the prompt reaches the AI', () => {
  const formats = ['+91 98765 00002', '98765-00002', '(+91) 98765 00002', '919876500002', '0 98765 00002'];
  for (const f of formats) {
    const out = scrubPiiToSlots(`Ask the electrician on ${f} to fix it`, dir);
    assert.equal(out, 'Ask the electrician on P3 to fix it', `format "${f}"`);
    assert.equal(textContainsPhone(out, roster.map((m) => m.phone)), false);
  }
  // Unknown (non-team) numbers are redacted.
  assert.equal(
    scrubPiiToSlots('Vendor 0 91234 56789 delivers', dir),
    'Vendor [REDACTED_PHONE] delivers'
  );
  // Dates are not mistaken for phone numbers.
  assert.equal(scrubPiiToSlots('Due 2026-11-09 10:30, budget 1,300', dir), 'Due 2026-11-09 10:30, budget 1,300');
  // The PII audit now catches a formatted team phone instead of reporting "clean".
  assert.equal(verifyZeroPiiInPrompt('call +91 98765 00002', dir).clean, false);
});

test('regression: a phone the AI echoes into chatReplyToBoss is shown as the name, not blocked', () => {
  const raw = makeRawPlan({ chatReplyToBoss: 'I have asked Balbir (+91 98765 00002) and 0 91234 56789 to start.' });

  // Server-side check on the anonymized AI output.
  const serverCheck = validateMeditatePlan(raw, serverCtx);
  assert.equal(serverCheck.valid, true, JSON.stringify(serverCheck.issues));
  assert.ok(!serverCheck.issues.some((i) => i.path === 'chatReplyToBoss'));

  // Server restores names/phones, then the browser re-validates.
  const deanonymized = deanonymizeMeditateResponse(serverCheck.normalizedPlan, dir, 5);
  const clientCheck = validateMeditatePlan(deanonymized, clientCtx);
  assert.equal(clientCheck.valid, true, JSON.stringify(clientCheck.issues));

  const reply: string = clientCheck.normalizedPlan.chatReplyToBoss;
  assert.equal(reply, `I have asked Balbir (Balbir) and ${OWNER_REPLY_NUMBER_PLACEHOLDER} to start.`);
  assert.equal(textContainsPhone(reply, roster.map((m) => m.phone)), false);

  // Phones are still used where messages are actually sent.
  assert.equal(clientCheck.normalizedPlan.draftedTasks[0].raci.R, BALBIR.phone);
});

test('regression: a normal slot-based reply turns into names and passes both checks', () => {
  const serverCheck = validateMeditatePlan(makeRawPlan(), serverCtx);
  assert.equal(serverCheck.valid, true, JSON.stringify(serverCheck.issues));
  const deanonymized = deanonymizeMeditateResponse(serverCheck.normalizedPlan, dir, 5);
  const clientCheck = validateMeditatePlan(deanonymized, clientCtx);
  assert.equal(clientCheck.valid, true, JSON.stringify(clientCheck.issues));
  assert.equal(clientCheck.normalizedPlan.chatReplyToBoss, 'Assigned to Balbir.');
});

test('messages that go to staff still block any phone number', () => {
  const preview = validateMeditatePlan(makeRawPlan({ preview: 'Call +91 98765 00001 when done.' }), serverCtx);
  assert.equal(preview.valid, false);
  assert.ok(
    preview.issues.some(
      (i) => i.code === 'PHONE_NUMBER_IN_TEXT' && i.path === 'draftedTasks[0].outboundWhatsappPreview'
    )
  );

  const step = validateMeditatePlan(makeRawPlan({ step: 'Ring vendor on 0 91234 56789' }), serverCtx);
  assert.equal(step.valid, false);
  assert.ok(step.issues.some((i) => i.path === 'draftedTasks[0].microSteps[0]'));
});

test('Meditate v2 intent reply to the owner swaps phones for names', () => {
  const res = validateIntentStageOutput(
    {
      kind: 'TASK',
      confidence: 0.9,
      missingCritical: ['Which zone should 98765 00002 inspect?'],
      followUpForHeadId: null,
      replyToOwner: 'Should +91 98765 00002 handle this?',
    },
    { roster }
  );
  assert.equal(res.valid, true, JSON.stringify(res.issues));
  assert.equal(res.normalizedIntent?.replyToOwner, 'Should Balbir handle this?');
  assert.deepEqual(res.normalizedIntent?.missingCritical, ['Which zone should Balbir inspect?']);
});

test('normalizeIndianPhone: 10-digit mobile gets 91; already-prefixed and formatted inputs unchanged', () => {
  // Bare 10-digit Indian mobile -> 91XXXXXXXXXX (the A1 fix).
  assert.equal(normalizeIndianPhone('9928943179'), '919928943179');
  assert.equal(normalizeIndianPhone('98765 00002'), '919876500002');
  // Already prefixed (any formatting) is kept as 91XXXXXXXXXX.
  assert.equal(normalizeIndianPhone('919928943179'), '919928943179');
  assert.equal(normalizeIndianPhone('+91 99289 43179'), '919928943179');
  assert.equal(normalizeIndianPhone('(+91) 98765-00002'), '919876500002');
  // Foreign numbers that already carry their own country code are left intact.
  assert.equal(normalizeIndianPhone('12025550123'), '12025550123');
  // Empty / junk -> digits only.
  assert.equal(normalizeIndianPhone(''), '');
  assert.equal(normalizeIndianPhone('abc'), '');
});
