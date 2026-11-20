import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnonymizedBufferPrompt,
  buildAnonymizedMeditatePrompt,
  buildSlotDirectory,
  capConversationHistory,
  createAiCallLog,
  deanonymizeBufferResponse,
  deanonymizeMeditateResponse,
  MAX_CONVERSATION_TURNS_CAP,
  PROMPT_VERSION,
  resolveSlotToPhone,
  resolveStageModelConfig,
  restoreDisplayNamesFromSlots,
  scrubPiiToSlots,
  verifyZeroPiiInPrompt,
} from './promptBuilder';
import { appendAiLogToState, applyProcessedBufferResult } from './opsEngine';
import { createInitialSeedState } from './seedData';
import { InboundMessageBuffer, TeamMember, WbsHead } from '../types/ops';

const TEST_ROSTER: TeamMember[] = [
  {
    phone: '919900011101',
    slotId: 'P1',
    name: 'Neha Sharma',
    roleTitle: 'Operations Lead',
    authorityLevel: 'OWNER',
    skills: ['Approvals', 'Budget'],
    maxActiveTasks: 5,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '19:00',
    dailyOverviewTime: '09:00',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 0,
      completed: 0,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 0,
      replyCount: 0,
    },
    personaPrompt: 'Executive summary format.',
  },
  {
    phone: '919900011102',
    slotId: 'P2',
    name: 'Karan Gill',
    roleTitle: 'Procurement Specialist',
    authorityLevel: 'STAFF',
    skills: ['Procurement', 'Inventory'],
    maxActiveTasks: 3,
    preferredLanguage: 'HINGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '19:00',
    dailyOverviewTime: '09:30',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 1,
      completed: 2,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 20,
      replyCount: 2,
    },
    personaPrompt: 'Send short Hinglish updates.',
  },
  {
    phone: '919900011103',
    slotId: 'P3',
    name: 'Ananya Sen',
    roleTitle: 'Site Supervisor',
    authorityLevel: 'SUPERVISOR',
    skills: ['Inspection', 'Electrical', 'Safety'],
    maxActiveTasks: 4,
    preferredLanguage: 'ENGLISH',
    workShiftStart: '09:00',
    workShiftEnd: '19:00',
    dailyOverviewTime: '09:15',
    isOnLeave: false,
    lastInboundAt: '2026-11-07T08:00:00.000Z',
    bufferMode: 'STANDARD_15_MIN',
    stats: {
      assigned: 1,
      completed: 3,
      partial: 0,
      overdueCount: 0,
      totalWorkHoursReplyMins: 15,
      replyCount: 1,
    },
    personaPrompt: 'Structured checklist steps.',
  },
];

test('Phase 2 Slot Identity: buildSlotDirectory, scrubPiiToSlots, and verifyZeroPiiInPrompt remove all PII', () => {
  const dir = buildSlotDirectory(TEST_ROSTER, {
    personalOperatingPrompt: 'Always ask Ananya Sen (+919900011103) to verify field work.',
    defaultAccountablePhone: '919900011103',
  });

  assert.equal(dir.defaultAccountableSlot, 'P3');
  assert.equal(dir.defaultResponsibleSlot, 'P2');

  const rawText =
    'Ask Karan Gill (+919900011102) to source cables and have Ananya inspect before calling 9812345678.';
  const scrubbed = scrubPiiToSlots(rawText, dir);

  assert.ok(!scrubbed.includes('Karan'), 'First name must be scrubbed');
  assert.ok(!scrubbed.includes('Ananya'), 'Supervisor first name must be scrubbed');
  assert.ok(!scrubbed.includes('919900011102'), 'Registered phone must be scrubbed');
  assert.ok(!scrubbed.includes('9812345678'), 'Unregistered 10-digit phone must be redacted');
  assert.ok(scrubbed.includes('P2'), 'Must map Karan Gill to P2');
  assert.ok(scrubbed.includes('P3'), 'Must map Ananya Sen to P3');
  assert.ok(scrubbed.includes('[REDACTED_PHONE]'), 'Must redact stray phone numbers');

  const activeHead: WbsHead = {
    headId: 'head-1',
    title: 'Cable rollout with Karan Gill',
    domainCategory: 'MAINTENANCE',
    contextSummary: 'Supervised by Ananya Sen (919900011103)',
    quadrant: 'Q1_DO_FIRST',
    majorOrMinor: 'MAJOR',
    tentativeDurationDays: 2,
    tentativeStartDate: '2026-11-07',
    tentativeDeadline: '2026-11-09',
    isForcedDeadline: false,
    dynamicStages: ['Sourcing', 'Inspection'],
    involvedPhones: ['919900011102', '919900011103'],
    status: 'SWIMLANE_READY',
    subTasks: [],
  };

  const built = buildAnonymizedMeditatePrompt({
    brainDump: 'Have Karan buy 50m armored cable and Ananya sign off on installation.',
    activeHead,
    teamMembers: TEST_ROSTER,
    tasks: [],
    categorySops: [],
    systemMemory: [
      {
        memoryId: 'mem-1',
        category: 'BUSINESS_RULE',
        fact: 'Neha Sharma approves invoices above 25000.',
        active: true,
      },
    ],
    ownerProfile: {
      personalOperatingPrompt: 'Ananya Sen is accountable for site inspections.',
      defaultAccountablePhone: '919900011103',
    },
  });

  assert.equal(
    built.piiAudit.clean,
    true,
    `Expected zero PII violations, got: ${built.piiAudit.violations.join(', ')}`
  );
  const fullPrompt = `${built.systemInstruction}\n${built.prompt}`;
  assert.ok(!fullPrompt.includes('919900011101'));
  assert.ok(!fullPrompt.includes('919900011102'));
  assert.ok(!fullPrompt.includes('919900011103'));
  assert.ok(!fullPrompt.includes('Neha Sharma'));
  assert.ok(!fullPrompt.includes('Karan Gill'));
  assert.ok(!fullPrompt.includes('Ananya Sen'));
});

test('Phase 2 Slot Identity: deanonymizeMeditateResponse and deanonymizeBufferResponse map slots back to phones and names', () => {
  const dir = buildSlotDirectory(TEST_ROSTER, {
    personalOperatingPrompt: 'Delegate cleanly.',
    defaultAccountablePhone: '919900011103',
  });

  assert.equal(resolveSlotToPhone('P2', dir, 'fallback'), '919900011102');
  assert.equal(resolveSlotToPhone('{{P3}}', dir, 'fallback'), '919900011103');
  assert.equal(
    restoreDisplayNamesFromSlots('Assigned to {{P2}} with sign-off by [P3] and P1.', dir),
    'Assigned to Karan Gill with sign-off by Ananya Sen and Neha Sharma.'
  );

  const rawMeditate = {
    intentClassification: 'ACTIONABLE_AGENDA',
    chatReplyToBoss: 'Staged 2 tasks: {{P2}} will procure cables and {{P3}} will inspect.',
    reasoningSummary: 'Ownership transfers from P2 to P3 after delivery.',
    agendaTitle: 'Armored Cable Procurement & Inspection',
    agendaQuadrant: 'Q1_DO_FIRST',
    agendaMajorOrMinor: 'MAJOR',
    suggestedMemoryRules: [{ category: 'SOP_PREFERENCE', fact: '{{P3}} signs off on cable trays.' }],
    draftedTasks: [
      {
        title: 'Procure 50m armored cable',
        shortTag: 'Cable Buy',
        categoryId: 'PROCUREMENT',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        taskFrequency: 'ONE_TIME',
        recurrenceRule: 'NONE',
        raci: { R: 'P2', A: 'P3', C: ['P1'], I: ['P1'] },
        dependsOnSubtaskIndex: null,
        triggerCondition: 'FULL_COMPLETION',
        dueDateOffsetDays: 1,
        wbsHeadId: 'head-cable',
        swimlaneStage: 'Procurement',
        microSteps: ['Confirm vendor stock', 'Upload invoice photo for {{P3}}'],
        outboundWhatsappPreview: 'Namaste {{P2}}, please procure 50m armored cable today.',
      },
    ],
    wbsHeads: [
      {
        headId: 'head-cable',
        title: 'Cable Rollout ({{P2}} -> {{P3}})',
        domainCategory: 'PROCUREMENT',
        contextSummary: '{{P2}} procures and {{P3}} inspects.',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        tentativeDurationDays: 2,
        tentativeStartDate: '2026-11-07',
        tentativeDeadline: '2026-11-09',
        isForcedDeadline: false,
        dynamicStages: ['Procurement', 'Inspection'],
        involvedPhones: ['P2', 'P3'],
        status: 'SWIMLANE_READY',
      },
    ],
  };

  const restored = deanonymizeMeditateResponse(rawMeditate, dir, 5);
  assert.equal(restored.draftedTasks[0].raci.R, '919900011102');
  assert.equal(restored.draftedTasks[0].raci.A, '919900011103');
  assert.deepEqual(restored.draftedTasks[0].raci.C, ['919900011101']);
  assert.deepEqual(restored.wbsHeads[0].involvedPhones, ['919900011102', '919900011103']);
  assert.ok(restored.chatReplyToBoss.includes('Karan Gill'));
  assert.ok(restored.chatReplyToBoss.includes('Ananya Sen'));
  assert.ok(restored.draftedTasks[0].outboundWhatsappPreview.includes('Karan Gill'));

  const mockBuffer: InboundMessageBuffer = {
    employeePhone: '919900011102',
    bufferMode: 'STANDARD_15_MIN',
    firstMessageAt: '2026-11-07T10:00:00.000Z',
    processAt: '2026-11-07T10:15:00.000Z',
    messages: [
      {
        id: 'm1',
        timestamp: '2026-11-07T10:01:00.000Z',
        type: 'text',
        textContent: 'Hi, this is Karan Gill (919900011102), cable stock confirmed.',
      },
    ],
  };

  const builtBuf = buildAnonymizedBufferPrompt({
    employee: TEST_ROSTER[1],
    teamMembers: TEST_ROSTER,
    buffer: mockBuffer,
    activeTasks: [],
    systemMemory: [],
  });
  assert.equal(builtBuf.employeeSlot, 'P2');
  assert.equal(builtBuf.piiAudit.clean, true);

  const restoredBuf = deanonymizeBufferResponse(
    {
      englishBossSummary: '{{P2}} confirmed cable stock and notified {{P3}}.',
      mediaVerificationNote: 'Verified text update from {{P2}}.',
      missingStepsAlert: 'Invoice upload pending from {{P2}}.',
      whatsappReplyInPreferredLanguage: 'Shukriya {{P2}}, kripya bill photo bhejein.',
      aiSuggestedReplies: ['{{P2}}, proceed with purchase.'],
      updatedMicroSteps: [{ id: 's1', status: 'DONE', evidenceNote: 'Confirmed by {{P2}}' }],
    },
    dir
  );
  assert.ok(restoredBuf.englishBossSummary.includes('Karan Gill'));
  assert.ok(restoredBuf.whatsappReplyInPreferredLanguage.includes('Karan Gill'));
  assert.equal(restoredBuf.updatedMicroSteps[0].evidenceNote, 'Confirmed by Karan Gill');
});

test('Phase 3 Context & Model Tuning: capConversationHistory enforces <= 8 recent turns + older summary, and resolveStageModelConfig clamps tuning', () => {
  const dir = buildSlotDirectory(TEST_ROSTER);

  // 14 turns -> 8 recent verbatim + 6 older turns condensed into olderTurnsSummary
  const fourteenTurns = Array.from({ length: 14 }, (_, idx) => ({
    role: idx % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `Turn #${idx + 1} with Karan Gill (+919900011102)`,
  }));

  const capped = capConversationHistory(fourteenTurns, dir, 12); // configured 12 still clamps to MAX_CONVERSATION_TURNS_CAP (8)
  assert.equal(MAX_CONVERSATION_TURNS_CAP, 8);
  assert.equal(capped.recentTurnsCount, 8);
  assert.equal(capped.olderTurnsSummarizedCount, 6);
  assert.ok(capped.olderTurnsSummary.length > 0);
  assert.ok(!capped.formattedBlock.includes('Karan Gill'), 'History block must scrub names to slots');
  assert.ok(!capped.formattedBlock.includes('919900011102'), 'History block must scrub phones to slots');
  assert.ok(capped.formattedBlock.includes('EARLIER CONVERSATION SUMMARY (6 older turn(s) condensed)'));
  assert.ok(capped.formattedBlock.includes('Turn #14 with P2'));

  // Custom UI lower cap (e.g. 5 turns) is respected
  const customCapped = capConversationHistory(fourteenTurns, dir, 5);
  assert.equal(customCapped.recentTurnsCount, 5);
  assert.equal(customCapped.olderTurnsSummarizedCount, 9);

  // Per-stage temperature & token enforcement
  const meditateCfg = resolveStageModelConfig('MEDITATE_PLANNING', {
    maxRecentConversationTurns: 8,
    meditate: {
      model: 'gemini-pro-latest',
      fallbackModel: 'gemini-flash-latest',
      temperature: 0.45,
      maxOutputTokens: 6144,
    },
  });
  assert.equal(meditateCfg.model, 'gemini-pro-latest');
  assert.equal(meditateCfg.temperature, 0.45);
  assert.equal(meditateCfg.maxOutputTokens, 6144);

  // Out-of-range clamping check
  const clampedBufCfg = resolveStageModelConfig('BUFFER_EVALUATION', {
    bufferEvaluation: {
      model: 'gemini-flash-lite-latest',
      fallbackModel: 'gemini-flash-latest',
      temperature: 9.9,
      maxOutputTokens: 50,
    },
  });
  assert.equal(clampedBufCfg.temperature, 1.5);
  assert.equal(clampedBufCfg.maxOutputTokens, 256);
});

test('Phase 0 Telemetry: createAiCallLog and appendAiLogToState record full AI call telemetry in state.ai_logs', () => {
  let state = createInitialSeedState();
  assert.deepEqual(state.ai_logs, []);

  const logEntry = createAiCallLog({
    stage: 'MEDITATE_PLANNING',
    model: 'gemini-flash-latest',
    temperature: 0.2,
    maxOutputTokens: 4096,
    latencyMs: 342.7,
    validationStatus: 'VALID',
    validationNote: 'Verified ACTIONABLE_AGENDA (1 task(s))',
    turnsSent: 4,
    olderTurnsSummarized: 0,
  });

  assert.equal(logEntry.promptVersion, PROMPT_VERSION);
  assert.equal(logEntry.latencyMs, 343);
  assert.equal(logEntry.stage, 'MEDITATE_PLANNING');
  assert.equal(logEntry.validationStatus, 'VALID');

  state = appendAiLogToState(state, logEntry);
  assert.equal(state.ai_logs.length, 1);
  assert.equal(state.ai_logs[0].logId, logEntry.logId);

  // Verify applyProcessedBufferResult also records aiResult.aiLog into state.ai_logs
  const firstPhone = Object.keys(state.team_members)[0];
  const sampleBuf: InboundMessageBuffer = {
    employeePhone: firstPhone,
    bufferMode: 'STANDARD_15_MIN',
    firstMessageAt: '2026-11-07T10:00:00.000Z',
    processAt: '2026-11-07T10:15:00.000Z',
    messages: [
      {
        id: 'm-t1',
        timestamp: '2026-11-07T10:01:00.000Z',
        type: 'text',
        textContent: 'Status update received.',
      },
    ],
  };
  state = {
    ...state,
    inbound_message_buffer: { [firstPhone]: sampleBuf },
  };

  const bufferLog = createAiCallLog({
    stage: 'BUFFER_EVALUATION',
    model: 'gemini-flash-lite-latest',
    temperature: 0.1,
    maxOutputTokens: 2048,
    latencyMs: 185,
    validationStatus: 'VALID',
    validationNote: 'Matched active task',
  });

  const afterBufState = applyProcessedBufferResult(state, firstPhone, {
    matchedTaskCode: null,
    englishBossSummary: 'Routine check-in.',
    completionPercent: 0,
    updatedMicroSteps: [],
    mediaVerificationNote: 'None',
    missingStepsAlert: '',
    whatsappReplyInPreferredLanguage: 'Noted, thank you.',
    escalateToBossReview: false,
    aiSuggestedReplies: [],
    aiLog: bufferLog,
  });

  assert.equal(afterBufState.ai_logs.length, 2);
  assert.equal(afterBufState.ai_logs[0].stage, 'BUFFER_EVALUATION');
  assert.equal(afterBufState.ai_logs[1].stage, 'MEDITATE_PLANNING');
});

test('Milestone 3.6: a refined plan carries owner-edit markers and rules, with no names or phones', () => {
  const editedHead: WbsHead = {
    headId: 'HEAD-77',
    title: 'Cable work for Karan Gill',
    titleEditedByOwner: true,
    ownerDeletedTempIds: ['draft-gone'],
    domainCategory: 'MAINTENANCE',
    contextSummary: 'Summary',
    quadrant: 'Q1_DO_FIRST',
    majorOrMinor: 'MAJOR',
    tentativeDurationDays: 1,
    tentativeStartDate: '2026-11-07',
    tentativeDeadline: '2026-11-07',
    isForcedDeadline: false,
    dynamicStages: ['Sourcing'],
    involvedPhones: ['919900011102'],
    status: 'SWIMLANE_READY',
    subTasks: [
      {
        tempId: 'draft-a',
        title: 'Karan Gill buys cable',
        shortTag: 'Ananya Sen check',
        categoryId: 'MAINTENANCE',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        taskFrequency: 'ONE_TIME',
        recurrenceRule: 'NONE',
        raci: { R: '919900011102', A: '919900011103', C: [], I: [] },
        dependsOnTempIdOrTaskCode: null,
        triggerCondition: 'FULL_COMPLETION',
        dueDate: '2026-11-07',
        microSteps: ['Call 919900011103 first'],
        outboundWhatsappPreview: 'Namaste Karan Gill ji, please buy cable.',
        messageIsCustom: true,
        ownerEditedFields: ['raci.R', 'outboundWhatsappPreview'],
        aiSnapshot: { 'raci.R': '919900011101', title: 'Neha Sharma buys cable' },
        aiOverrideNotes: ['Changed title because you asked: "Neha Sharma"'],
      },
    ],
  };
  const built = buildAnonymizedMeditatePrompt({
    brainDump: 'Make it two days',
    activeHead: editedHead,
    teamMembers: TEST_ROSTER,
    tasks: [],
    categorySops: [],
    systemMemory: [],
    ownerProfile: { personalOperatingPrompt: '', defaultAccountablePhone: '919900011103' },
  });
  const fullPrompt = `${built.systemInstruction}\n${built.prompt}`;
  assert.equal(built.piiAudit.clean, true, built.piiAudit.violations.join(', '));
  assert.ok(fullPrompt.includes('"ownerEditedFields"'));
  assert.ok(fullPrompt.includes('"raci.R"'));
  assert.ok(fullPrompt.includes('"ownerDeletedTempIds"'));
  assert.ok(fullPrompt.includes('"titleEditedByOwner": true'));
  assert.ok(fullPrompt.includes('overriddenOwnerEdits'));
  assert.ok(fullPrompt.includes('"tempId": "draft-a"'));
  assert.ok(!fullPrompt.includes('aiSnapshot'));
  assert.ok(!fullPrompt.includes('aiOverrideNotes'));
  for (const leak of ['Karan Gill', 'Ananya Sen', 'Neha Sharma', '919900011101', '919900011102', '919900011103']) {
    assert.ok(!fullPrompt.includes(leak), `prompt leaks ${leak}`);
  }
});

test('Roster graph links: ClosePeers and ReportsTo render slot IDs with zero PII leak', () => {
  const linkedRoster: TeamMember[] = [
    TEST_ROSTER[0],
    {
      ...TEST_ROSTER[1],
      reportsToPhone: TEST_ROSTER[2].phone,
      worksCloselyWithPhones: [TEST_ROSTER[0].phone, TEST_ROSTER[2].phone],
    },
    TEST_ROSTER[2],
  ];
  const built = buildAnonymizedMeditatePrompt({
    brainDump: 'Have Karan coordinate cable inventory.',
    activeHead: null,
    teamMembers: linkedRoster,
    tasks: [],
    categorySops: [],
    systemMemory: [],
    ownerProfile: { personalOperatingPrompt: '', defaultAccountablePhone: '919900011103' },
  });
  const fullPrompt = `${built.systemInstruction}\n${built.prompt}`;
  assert.equal(built.piiAudit.clean, true, built.piiAudit.violations.join(', '));
  assert.ok(fullPrompt.includes('ReportsTo: P3'));
  assert.ok(fullPrompt.includes('ClosePeers: P1, P3'));
});

test('GEN-05 regression: promptBuilder and SopsMemoryTab contain zero hard-coded venue/industry terms', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const forbidden = /\b(banquet|lawn|catering|wedding|shaadi|reception|generator|chairs|hotel)\b/i;
  for (const rel of ['src/lib/promptBuilder.ts', 'src/components/SopsMemoryTab.tsx']) {
    const content = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
    assert.equal(forbidden.test(content), false, `${rel} should not contain hard-coded GEN-05 industry words`);
  }
});

