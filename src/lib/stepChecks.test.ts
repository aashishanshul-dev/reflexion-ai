import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStepUpdate,
  completionFromSteps,
  enrichStep,
  formatStepCount,
  GENERIC_PHOTO,
  parseStepPhotoRequirement,
  parseStepTarget,
  resolveStepUpdates,
} from './stepChecks';
import { BANQUET_DEMO_PHONES, createBanquetDemoSeedState } from './demoBanquet';
import { applyProcessedBufferResult } from './opsEngine';
import type { MicroStep } from '../types/ops';

test('parseStepTarget reads the count of things and skips times, units and money', () => {
  assert.equal(parseStepTarget('Lay out 250 items as per the plan'), 250);
  assert.equal(parseStepTarget('Load 40 filled 20L containers onto the van'), 40);
  assert.equal(parseStepTarget('Deliver all 40 boxes before 11 AM'), 40);
  assert.equal(parseStepTarget('Restock 200 caps by 5 PM'), 200);
  assert.equal(parseStepTarget('Test-run the machine for 10 minutes'), null);
  assert.equal(parseStepTarget('Approve ₹4,500 for the order'), null);
  assert.equal(parseStepTarget('Get three quotes'), null);
  assert.equal(parseStepTarget('Finish by 5 baje'), null);
  assert.equal(parseStepTarget('Use 1 ladder'), null);
  assert.equal(parseStepTarget(undefined), null);
});

test('parseStepPhotoRequirement reads what the photo must show', () => {
  assert.equal(parseStepPhotoRequirement('Send a photo of the fuel gauge'), 'fuel gauge');
  assert.equal(parseStepPhotoRequirement('Upload a clear photo of the signed delivery receipt on WhatsApp'), 'signed delivery receipt');
  assert.equal(parseStepPhotoRequirement('Send the bill photo'), 'bill');
  assert.equal(parseStepPhotoRequirement('Send a photo of the finished setup'), 'finished setup');
  assert.equal(parseStepPhotoRequirement('Share a confirmation message and photo on WhatsApp'), GENERIC_PHOTO);
  assert.equal(parseStepPhotoRequirement('गेज की फोटो भेजें'), 'गेज');
  assert.equal(parseStepPhotoRequirement('Clean the walkways'), null);
});

const step = (over: Partial<MicroStep> = {}): MicroStep =>
  enrichStep({ id: 's1', label: 'Lay out 250 items', status: 'PENDING', ...over });

test('enrichStep adds the target and photo need once, keeping values already set', () => {
  assert.deepEqual(
    { t: step().targetCount, d: step().doneCount, p: step().photoMustShow },
    { t: 250, d: 0, p: undefined }
  );
  const photo = enrichStep({ id: 'p', label: 'Send a photo of the fuel gauge', status: 'PENDING' });
  assert.equal(photo.photoMustShow, 'fuel gauge');
  assert.equal(enrichStep({ ...photo, photoMustShow: 'gauge dial' }).photoMustShow, 'gauge dial');
});

test('applyStepUpdate: counts are clamped and reaching the target marks the step DONE', () => {
  assert.equal(applyStepUpdate(step(), { status: 'PENDING', doneCount: 100 }, false).step.doneCount, 100);
  assert.equal(formatStepCount(applyStepUpdate(step(), { status: 'PENDING', doneCount: 100 }, false).step), '100/250');
  const full = applyStepUpdate(step({ doneCount: 100 }), { status: 'PENDING', doneCount: 900 }, false).step;
  assert.deepEqual([full.doneCount, full.status], [250, 'DONE']);
  // Counts never go backwards from a vague later message.
  assert.equal(applyStepUpdate(step({ doneCount: 100 }), { status: 'PENDING', doneCount: 20 }, false).step.doneCount, 100);
  // The AI saying DONE with a lower count stays PENDING.
  assert.equal(applyStepUpdate(step(), { status: 'DONE', doneCount: 120 }, false).step.status, 'PENDING');
});

test('applyStepUpdate: a photo step is DONE only with an image that shows what is required', () => {
  const photo = enrichStep({ id: 'p', label: 'Send a photo of the fuel gauge', status: 'PENDING' });
  const noImage = applyStepUpdate(photo, { status: 'DONE' }, false);
  assert.deepEqual([noImage.step.status, noImage.heldBack], ['PENDING', true]);
  assert.match(noImage.step.evidenceNote || '', /Waiting for a photo showing fuel gauge/);
  const wrong = applyStepUpdate(photo, { status: 'DONE', photoShows: false }, true);
  assert.deepEqual([wrong.step.status, wrong.heldBack], ['PENDING', true]);
  assert.match(wrong.step.evidenceNote || '', /does not clearly show fuel gauge/);
  const right = applyStepUpdate(photo, { status: 'DONE', photoShows: true }, true);
  assert.deepEqual([right.step.status, right.step.photoVerified, right.heldBack], ['DONE', true, false]);
});

test('completionFromSteps gives partial credit for counts', () => {
  assert.equal(
    completionFromSteps([
      { id: 'a', label: 'a', status: 'DONE' },
      { id: 'b', label: 'b', status: 'PENDING', targetCount: 250, doneCount: 100 },
      { id: 'c', label: 'c', status: 'PENDING' },
      { id: 'd', label: 'd', status: 'PENDING' },
    ]),
    35
  );
  assert.equal(completionFromSteps([]), 0);
});

const NOW = '2026-11-20T04:30:00.000Z';
const { RAMESH, MAHESH } = BANQUET_DEMO_PHONES;
const base = {
  englishBossSummary: 'Update',
  mediaVerificationNote: '',
  missingStepsAlert: '',
  whatsappReplyInPreferredLanguage: 'Theek hai',
  escalateToBossReview: false,
  delayReported: false,
  reportedEta: null,
};

test('banquet: "100 chairs are up" shows 100/250 and the task percent comes from the steps', () => {
  const state = createBanquetDemoSeedState(NOW);
  const t301 = state.tasks.find((t) => t.taskCode === 'T-301')!;
  assert.equal(formatStepCount(t301.microSteps[1]), '0/250');
  const next = applyProcessedBufferResult(
    state,
    RAMESH,
    { ...base, matchedTaskCode: 'T-301', completionPercent: 90, updatedMicroSteps: [{ id: t301.microSteps[1].id, status: 'PENDING', doneCount: 100 }] },
    NOW
  );
  const after = next.tasks.find((t) => t.taskCode === 'T-301')!;
  assert.equal(formatStepCount(after.microSteps[1]), '100/250');
  assert.equal(after.completionPercent, 35); // 1 of 4 steps + 100/250 of another — not the AI's 90
});

test('banquet: Mahesh says "done" without a photo, so the gauge step and the task stay open', () => {
  const state = createBanquetDemoSeedState(NOW);
  const t303 = state.tasks.find((t) => t.taskCode === 'T-303')!;
  const photoStep = t303.microSteps[3];
  assert.equal(photoStep.photoMustShow, 'fuel gauge');
  const buffer = { ...state.inbound_message_buffer[RAMESH], employeePhone: MAHESH, messages: [{ id: 'm1', timestamp: NOW, type: 'text' as const, textContent: 'Sab ho gaya' }] };
  const reply = {
    ...base,
    matchedTaskCode: 'T-303',
    completionPercent: 100,
    updatedMicroSteps: t303.microSteps.map((s) => ({ id: s.id, status: 'DONE' as const })),
  };
  const textOnly = applyProcessedBufferResult({ ...state, inbound_message_buffer: { [MAHESH]: buffer } }, MAHESH, reply, NOW);
  const held = textOnly.tasks.find((t) => t.taskCode === 'T-303')!;
  assert.notEqual(held.status, 'COMPLETED');
  assert.equal(held.microSteps[3].status, 'PENDING');
  assert.match(held.microSteps[3].evidenceNote || '', /Waiting for a photo showing fuel gauge/);

  const withPhoto = { ...buffer, messages: [{ id: 'm2', timestamp: NOW, type: 'image' as const, fileName: 'gauge.jpg', base64Data: 'AAAA', mimeType: 'image/jpeg' }] };
  const photoReply = { ...reply, updatedMicroSteps: reply.updatedMicroSteps.map((u) => (u.id === photoStep.id ? { ...u, photoShows: true } : u)) };
  const done = applyProcessedBufferResult({ ...state, inbound_message_buffer: { [MAHESH]: withPhoto } }, MAHESH, photoReply, NOW);
  const closed = done.tasks.find((t) => t.taskCode === 'T-303')!;
  assert.equal(closed.status, 'COMPLETED');
  assert.equal(closed.microSteps[3].photoVerified, true);
});

test('resolveStepUpdates: matches exact id and unambiguous 1-based position, skips collisions', () => {
  const steps: MicroStep[] = [
    { id: 'ms-a', label: 'Review dispatch log', status: 'PENDING' },
    { id: 'ms-b', label: 'List client offices', status: 'PENDING' },
    { id: 'ms-c', label: 'Share list on WhatsApp', status: 'PENDING' },
  ];
  const mapped = resolveStepUpdates(steps, [
    { id: '1', status: 'DONE' },
    { id: 'ms-c', status: 'PENDING' },
  ]);
  assert.equal(mapped.get('ms-a')?.status, 'DONE');
  assert.equal(mapped.get('ms-b'), undefined);
  assert.equal(mapped.get('ms-c')?.status, 'PENDING');

  // Collision: two updates pointing at step 1 -> neither applied
  const collided = resolveStepUpdates(steps, [
    { id: '1', status: 'DONE' },
    { id: 'step_1', status: 'PENDING' },
  ]);
  assert.equal(collided.get('ms-a'), undefined);
});

test('checklist progress: specific step ticks only that step & recomputes %; vague "sab theek hai" ticks nothing', () => {
  const state = createBanquetDemoSeedState(NOW);
  const t303 = state.tasks.find((t) => t.taskCode === 'T-303')!;
  const resetTask = {
    ...t303,
    status: 'IN_PROGRESS' as const,
    completionPercent: 0,
    microSteps: t303.microSteps.map((s) => ({ ...s, status: 'PENDING' as const })),
  };
  const seeded = {
    ...state,
    tasks: state.tasks.map((t) => (t.taskCode === 'T-303' ? resetTask : t)),
    inbound_message_buffer: {
      [MAHESH]: {
        ...state.inbound_message_buffer[RAMESH],
        employeePhone: MAHESH,
        messages: [{ id: 'm1', timestamp: NOW, type: 'text' as const, textContent: 'Sab theek hai' }],
      },
    },
  };

  // Vague reply -> empty updatedMicroSteps -> 0/4 done, 0%
  const vagueRes = applyProcessedBufferResult(
    seeded,
    MAHESH,
    { ...base, matchedTaskCode: 'T-303', completionPercent: 100, updatedMicroSteps: [] },
    NOW
  );
  const afterVague = vagueRes.tasks.find((t) => t.taskCode === 'T-303')!;
  assert.equal(afterVague.microSteps.filter((s) => s.status === 'DONE').length, 0);
  assert.equal(afterVague.completionPercent, 0);

  // Specific step 1 done -> only step 1 ticks -> 25% (even if AI said 100)
  const step1Res = applyProcessedBufferResult(
    seeded,
    MAHESH,
    {
      ...base,
      matchedTaskCode: 'T-303',
      completionPercent: 100,
      updatedMicroSteps: [{ id: '1', status: 'DONE' }],
    },
    NOW
  );
  const afterStep1 = step1Res.tasks.find((t) => t.taskCode === 'T-303')!;
  assert.equal(afterStep1.microSteps[0].status, 'DONE');
  assert.equal(afterStep1.microSteps[1].status, 'PENDING');
  assert.equal(afterStep1.completionPercent, 25);
});
