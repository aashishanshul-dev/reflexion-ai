import test from 'node:test';
import assert from 'node:assert/strict';
import { BANQUET_DEMO_PHONES, createBanquetDemoSeedState } from './demoBanquet';
import { createDemoStoryState, DEFAULT_DEMO_STORY, DEMO_STORIES, isDemoStoryId } from './demoStories';
import { loadDemoStory, normalizeOpsDatabaseState, saveDemoStory } from '../services/dataService';
import { applyProcessedBufferResult } from './opsEngine';
import { buildAnonymizedIntentPrompt } from './meditateV2';
import { buildAnonymizedBufferPrompt } from './promptBuilder';
import { buildMyTasks } from './myTasks';
import { buildTeamGraph, teamStatusLabel } from './teamGraph';
import { validateDraftPlan } from './validator';

const NOW = '2026-11-19T06:30:00.000Z'; // 12:00 in Jodhpur
const { OWNER, POOJA, RAMESH, SURESH, MAHESH } = BANQUET_DEMO_PHONES;

test('banquet story is the default and matches the pitch: owner + 5, slide-7 voice dump first', () => {
  assert.equal(DEFAULT_DEMO_STORY, 'banquet');
  assert.equal(isDemoStoryId('banquet') && isDemoStoryId('water') && !isDemoStoryId('x'), true);
  const seed = createDemoStoryState('banquet', NOW);
  assert.equal(seed.business_profile.businessName, DEMO_STORIES.banquet.businessName);
  assert.equal(Object.keys(seed.team_members).length, 6);
  assert.equal(Object.values(seed.team_members).filter((m) => m.authorityLevel === 'OWNER').length, 1);
  assert.match(seed.sample_brain_dumps[0].text, /^Kal Sharma ji ki shaadi hai\./);
  assert.equal(createDemoStoryState('water', NOW).business_profile.businessName, DEMO_STORIES.water.businessName);
  for (const id of ['banquet', 'water'] as const) {
    assert.equal(DEMO_STORIES[id].walkthrough.length, 6);
  }
});

test('loadDemoStory defaults to DEFAULT_DEMO_STORY even with pre-story demo state, while respecting saved story choice', () => {
  const prevStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
    removeItem(k: string) { store.delete(k); },
    setItem(k: string, v: string) { store.set(k, String(v)); },
  };
  try {
    store.set('opscommand_ai_demo_state_v1', '{"legacy":true}');
    assert.equal(loadDemoStory(), DEFAULT_DEMO_STORY);

    saveDemoStory('water');
    assert.equal(loadDemoStory(), 'water');

    saveDemoStory('banquet');
    assert.equal(loadDemoStory(), 'banquet');
  } finally {
    if (prevStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else (globalThis as { localStorage?: Storage }).localStorage = prevStorage;
  }
});

test('banquet team: valid links, everyone has an "Address as", records carry a tenantId, phones are 91XXXXXXXXXX', () => {
  const seed = createBanquetDemoSeedState(NOW);
  for (const m of Object.values(seed.team_members)) {
    assert.match(m.phone, /^91\d{10}$/);
    assert.ok(m.addressAs);
    assert.ok(m.tenantId);
    assert.ok(m.orgChartPosition);
    if (m.reportsToPhone) assert.ok(seed.team_members[m.reportsToPhone]);
    for (const peer of m.worksCloselyWithPhones || []) {
      assert.ok((seed.team_members[peer].worksCloselyWithPhones || []).includes(m.phone), `${m.name} <-> ${peer}`);
    }
  }
  for (const t of seed.tasks) {
    assert.ok(t.tenantId);
    assert.ok(seed.team_members[t.raci.R], `${t.taskCode} R`);
    assert.ok(seed.team_members[t.raci.A], `${t.taskCode} A`);
  }
  for (const r of [...seed.boss_review_queue, ...seed.whatsapp_messages, ...seed.system_memory, ...seed.notes, ...seed.wbs_heads]) {
    assert.ok((r as { tenantId?: string }).tenantId);
  }
  // Every task type's default people exist; must-know facts are set where planning needs them.
  for (const sop of seed.category_sops) {
    if (sop.defaultResponsiblePhone) assert.ok(seed.team_members[sop.defaultResponsiblePhone]);
  }
  assert.deepEqual(
    seed.category_sops.find((c) => c.categoryId === 'EVENT_SETUP')?.requiredFacts,
    ['which lawn or hall', 'event date and start time', 'guest count']
  );
  // Survives a save/load round trip.
  const normalized = normalizeOpsDatabaseState(seed, createBanquetDemoSeedState(NOW));
  assert.equal(normalized.tasks.length, seed.tasks.length);
  assert.equal(normalized.team_members[RAMESH].addressAs, 'Ramesh bhai');
});

test('banquet story: briefs are short and address people by "Address as"; the frozen plan validates', () => {
  const seed = createBanquetDemoSeedState(NOW);
  const t301 = seed.tasks.find((t) => t.taskCode === 'T-301')!;
  assert.match(t301.outboundWhatsappPreview, /^ज़रूरी: नमस्ते Ramesh bhai, \[Lawn 2 Setup\] .* — \d+ Nov, 18:00 तक।/);
  assert.equal(t301.dueTime, '18:00');
  const head = seed.wbs_heads[0];
  const check = validateDraftPlan(head.subTasks, {
    teamMembers: Object.values(seed.team_members),
    categoryIds: seed.category_sops.map((c) => c.categoryId),
    timezone: 'Asia/Kolkata',
  });
  assert.equal(check.errorCount, 0, JSON.stringify(check));
});

test('banquet story: Ramesh\'s Hindi update (150 chairs at 7 PM) flags the 6 PM lawn setup behind', () => {
  const seed = createBanquetDemoSeedState(NOW);
  const prompt = buildAnonymizedBufferPrompt({
    employee: seed.team_members[RAMESH],
    teamMembers: Object.values(seed.team_members),
    buffer: seed.inbound_message_buffer[RAMESH],
    activeTasks: seed.tasks.filter((t) => t.raci.R === RAMESH && t.status === 'IN_PROGRESS'),
    systemMemory: seed.system_memory,
    businessProfile: seed.business_profile,
    ownerProfile: seed.owner_profile,
    nowIso: NOW,
  });
  assert.match(prompt.textPart, /"due": "\d{4}-\d{2}-\d{2} 18:00"/);
  assert.match(prompt.textPart, /"timing": "Due in 6h"/);
  assert.equal(prompt.piiAudit.clean, true);

  const next = applyProcessedBufferResult(
    seed,
    RAMESH,
    {
      matchedTaskCode: 'T-301',
      englishBossSummary: 'Lawn clean, 100 chairs placed; 150 chairs arrive from the vendor at 7 PM.',
      mediaVerificationNote: '',
      updatedMicroSteps: [],
      completionPercent: 40,
      missingStepsAlert: '',
      whatsappReplyInPreferredLanguage: 'धन्यवाद Ramesh bhai! क्या कुर्सियाँ 6 बजे तक आ सकती हैं?',
      escalateToBossReview: false,
      delayReported: true,
      reportedEta: 'शाम 7 बजे',
    },
    NOW
  );
  const t301 = next.tasks.find((t) => t.taskCode === 'T-301')!;
  assert.match(t301.scheduleRisk!.reason, /will finish later\. Expected finish: शाम 7 बजे\./);
  const graph = buildTeamGraph(Object.values(next.team_members), next.category_sops, next.tasks, t301.dueDate, {
    nowMs: Date.parse(NOW),
    timezone: 'Asia/Kolkata',
  });
  assert.equal(teamStatusLabel(graph.nodes.find((n) => n.phone === RAMESH)!).text, '1 behind');
});

test('banquet story: the owner has a call to make and a chair approval to decide', () => {
  const seed = createBanquetDemoSeedState(NOW);
  const mine = buildMyTasks(seed, { nowIso: NOW, todayStr: seed.tasks[0].dueDate, timezone: 'Asia/Kolkata' });
  assert.deepEqual(mine.do.map((t) => t.taskCode), ['T-305']);
  assert.deepEqual(mine.decide.map((d) => d.review.reviewId), ['REV-301']);
  assert.equal(seed.boss_review_queue[0].employeePhone, SURESH);
  assert.equal(seed.team_members[MAHESH].reportsToPhone !== null, true);
  assert.equal(seed.owner_profile.defaultAccountablePhone, POOJA);
  assert.ok(seed.team_members[OWNER]);
});

test('banquet intent prompt: the Hinglish voice dump stays anonymous and carries must-know facts', () => {
  const seed = createBanquetDemoSeedState(NOW);
  const built = buildAnonymizedIntentPrompt({
    brainDump: seed.sample_brain_dumps[0].text,
    teamMembers: Object.values(seed.team_members),
    tasks: seed.tasks,
    categorySops: seed.category_sops,
    systemMemory: seed.system_memory,
    businessProfile: seed.business_profile,
    ownerProfile: seed.owner_profile,
  });
  assert.match(built.prompt, /- EVENT_SETUP \(Lawn & event setup\): which lawn or hall; event date and start time; guest count/);
  assert.equal(built.piiAudit.clean, true, JSON.stringify(built.piiAudit));
});
