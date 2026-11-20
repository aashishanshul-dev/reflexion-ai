import test from 'node:test';
import assert from 'node:assert/strict';
import { staffAddressName } from './staffNames';
import {
  buildOwnerReaderLine,
  buildRosterLine,
  buildSlotDirectory,
  deanonymizeAndValidateMessageStage,
  deanonymizeBufferResponse,
  deanonymizeMeditateResponse,
  RESPONSIBLE_SELECTION_RULES,
  restoreNamesForRecipient,
  stripNonOwnerSalutation,
  suggestAccountablePhone,
} from './promptBuilder';
import { buildAnonymizedIntentPrompt, buildAnonymizedPlannerPrompt } from './meditateV2';
import { buildAutoReminderMessage, buildTaskCancelledMessage } from './releaseEngine';
import { formatLocalizedNotification } from './opsEngine';
import { createDemoSeedState } from './demoData';

const state = createDemoSeedState('2026-11-19T04:00:00.000Z');
const members = Object.values(state.team_members);
const dir = buildSlotDirectory(members, state.owner_profile);
const ARVIND = '919820100001'; // owner
const PRIYA = '919820100002'; // co-founder, partner of the owner, no manager
const ROHAN = '919820100003'; // operations head, reports to the owner
const NITIN = '919820100006'; // reports to Rohan; addressed as "Nitin bhai"
const KAVITA = '919820100007'; // reports to Priya
const slot = (phone: string) => dir.phoneToEntry.get(phone)!.slotId;

test('staffAddressName: "Address as" wins; else full name with ji / जी / plain English', () => {
  assert.equal(staffAddressName({ name: 'Nitin Sharma', addressAs: 'Nitin bhai' }, 'HINGLISH'), 'Nitin bhai');
  assert.equal(staffAddressName({ name: 'Nitin Sharma', addressAs: 'Nitin bhai' }, 'ENGLISH'), 'Nitin bhai');
  assert.equal(staffAddressName({ name: 'Kavita Joshi' }, 'ENGLISH'), 'Kavita Joshi');
  assert.equal(staffAddressName({ name: 'Kavita Joshi' }, 'HINGLISH'), 'Kavita Joshi ji');
  assert.equal(staffAddressName({ name: 'Kavita Joshi', addressAs: '  ' }, 'HINDI'), 'Kavita Joshi जी');
  assert.equal(staffAddressName(undefined, 'HINGLISH', 'ji'), 'ji');
});

test('suggestAccountablePhone follows the org chart: manager, then partner; owner answers for own tasks', () => {
  assert.equal(suggestAccountablePhone(NITIN, dir), ROHAN);
  assert.equal(suggestAccountablePhone(ROHAN, dir), ARVIND);
  assert.equal(suggestAccountablePhone(PRIYA, dir), ARVIND); // partner, not the default (Rohan)
  assert.equal(suggestAccountablePhone(KAVITA, dir), PRIYA);
  assert.equal(suggestAccountablePhone(ARVIND, dir), ARVIND);
  assert.equal(suggestAccountablePhone('000', dir), state.owner_profile.defaultAccountablePhone);
});

test('roster line shows AccountableDefault; planner prompt uses it instead of one global default', () => {
  const line = buildRosterLine(dir.phoneToEntry.get(PRIYA)!, 0, dir);
  assert.match(line, new RegExp(`AccountableDefault: ${slot(ARVIND)}\\b`));
  const built = buildAnonymizedPlannerPrompt({
    brainDump: 'Send a rate card to a new client',
    teamMembers: members,
    tasks: [],
    categorySops: state.category_sops,
    systemMemory: [],
    businessProfile: state.business_profile,
    ownerProfile: state.owner_profile,
  });
  assert.match(built.systemInstruction, /AccountableDefault/);
  assert.doesNotMatch(built.systemInstruction, /Default Accountable \(A\) Slot ID/);
  assert.equal(built.piiAudit.clean, true);
});

test('deanonymize: blank A or A equal to R becomes the org-chart Accountable; a real choice is kept', () => {
  const res = deanonymizeMeditateResponse(
    {
      draftedTasks: [
        { title: 'Rate card', raci: { R: slot(PRIYA), A: slot(PRIYA), C: [], I: [] }, microSteps: [] },
        { title: 'Delivery', raci: { R: slot(NITIN), A: null, C: [], I: [] }, microSteps: [] },
        { title: 'Bills', raci: { R: slot(KAVITA), A: slot(ARVIND), C: [], I: [] }, microSteps: [] },
      ],
    },
    dir
  );
  assert.equal(res.draftedTasks[0].raci.A, ARVIND);
  assert.equal(res.draftedTasks[1].raci.A, ROHAN);
  assert.equal(res.draftedTasks[2].raci.A, ARVIND);
});

test('weakness support rule no longer carries a copyable example step', () => {
  assert.doesNotMatch(RESPONSIBLE_SELECTION_RULES, /voice note/i);
  assert.match(RESPONSIBLE_SELECTION_RULES, /directly affects THIS task/);
});

test('restoreNamesForRecipient: the recipient gets their "Address as" (no doubled honorific); others get full names', () => {
  const n = slot(NITIN);
  const r = slot(ROHAN);
  assert.equal(
    restoreNamesForRecipient(`Namaste {{${n}}} ji, {{${r}}} ko update bhejein.`, dir, NITIN),
    'Namaste Nitin bhai, Rohan Kulkarni ko update bhejein.'
  );
  assert.equal(restoreNamesForRecipient(`{{${n}}} bhai, thanks`, dir, NITIN), 'Nitin bhai, thanks');
  assert.equal(restoreNamesForRecipient(`Hello {{${n}}}`, dir, null), 'Hello Nitin Sharma');
  // Someone without "Address as" keeps the old behaviour.
  assert.equal(restoreNamesForRecipient(`Hello {{${slot(KAVITA)}}}`, dir, KAVITA), 'Hello Kavita Joshi');
});

test('staff-facing AI text uses "Address as": reply, suggested replies and the release message', () => {
  const n = slot(NITIN);
  const buf = deanonymizeBufferResponse(
    { whatsappReplyInPreferredLanguage: `{{${n}}} bhai, baaki jars kab tak?`, aiSuggestedReplies: [`OK {{${n}}}`] },
    dir,
    NITIN
  );
  assert.equal(buf.whatsappReplyInPreferredLanguage, 'Nitin bhai, baaki jars kab tak?');
  assert.deepEqual(buf.aiSuggestedReplies, ['OK Nitin bhai']);
  assert.equal(deanonymizeAndValidateMessageStage(`Namaste {{${n}}} ji`, dir, NITIN).text, 'Namaste Nitin bhai');
});

test('stripNonOwnerSalutation drops a greeting to a teammate at the start of an owner reply', () => {
  const p = slot(PRIYA);
  assert.equal(stripNonOwnerSalutation(`{{${p}}} ji, I have drafted the plan.`, dir), 'I have drafted the plan.');
  assert.equal(stripNonOwnerSalutation(`Namaste {{${p}}}! plan ready.`, dir), 'Plan ready.');
  assert.equal(
    stripNonOwnerSalutation(`{{${slot(ARVIND)}}} ji, plan ready.`, dir),
    `{{${slot(ARVIND)}}} ji, plan ready.`
  );
  assert.equal(
    stripNonOwnerSalutation(`I gave the rate card to {{${p}}}.`, dir),
    `I gave the rate card to {{${p}}}.`
  );
  const res = deanonymizeMeditateResponse({ chatReplyToBoss: `{{${p}}} ji, plan is ready.` }, dir);
  assert.equal(res.chatReplyToBoss, 'Plan is ready.');
});

test('intent and planner prompts say the reader is the owner', () => {
  const reader = buildOwnerReaderLine(dir);
  assert.match(reader, new RegExp(`\\{\\{${slot(ARVIND)}\\}\\}`));
  const intent = buildAnonymizedIntentPrompt({
    brainDump: 'hello',
    teamMembers: members,
    tasks: [],
    categorySops: [],
    systemMemory: [],
    ownerProfile: state.owner_profile,
  });
  assert.ok(intent.systemInstruction.includes(reader));
});

test('fixed templates use "Address as": cancel, reminder, handover', () => {
  const nitin = state.team_members[NITIN];
  const task = { taskCode: 'T-1', shortTag: 'Jars', title: 'Deliver jars' };
  assert.match(buildTaskCancelledMessage(task, nitin), /^Namaste Nitin bhai, /);
  assert.match(buildAutoReminderMessage(task, nitin), /^Namaste Nitin bhai, /);
  assert.match(formatLocalizedNotification('REASSIGN_HANDOVER', nitin, 'Jars', 'Deliver jars'), /Namaste Nitin bhai, /);
  assert.doesNotMatch(formatLocalizedNotification('INSTANT_NUDGE', nitin, 'Jars', 'Deliver jars'), /Sharma/);
});
