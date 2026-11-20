/**
 * Demo story 2 (default): a banquet, lawn and catering business in Jodhpur, matching
 * the pitch deck (owner + five staff from the team-structure slide; the
 * "Kal Sharma ji ki shaadi hai…" voice dump). Data only — every business word, name
 * and number here is sample data, never logic. Names and phone numbers are fictional.
 */
import type {
  CategorySop,
  MicroStep,
  OpsDatabaseState,
  Task,
  TaskReleaseConfig,
  TeamMember,
} from '../types/ops.ts';
import { createDemoSeedState } from './demoData.ts';
import { addDaysIso, businessTodayIso } from './planDates.ts';
import { buildShortTaskBrief } from './taskBrief.ts';
import { enrichSeedTaskSteps } from './stepChecks.ts';
import { autoArrangeOrgPositions } from './teamGraph.ts';

const TENANT = 'default';

const OWNER = '919800200001';
const POOJA = '919800200002';
const GOPAL = '919800200003';
const RAMESH = '919800200004';
const SURESH = '919800200005';
const MAHESH = '919800200006';

export const BANQUET_DEMO_PHONES = { OWNER, POOJA, GOPAL, RAMESH, SURESH, MAHESH } as const;

const stats = (assigned: number, completed: number, replyCount: number, replyMins: number) => ({
  assigned,
  completed,
  partial: 0,
  overdueCount: 0,
  totalWorkHoursReplyMins: replyMins,
  replyCount,
});

export function createBanquetDemoSeedState(nowIso: string = new Date().toISOString()): OpsDatabaseState {
  const base = createDemoSeedState(nowIso); // shared app settings (models, tuning); content replaced below
  const nowMs = new Date(nowIso).getTime();
  const hoursAgo = (h: number) => new Date(nowMs - h * 3600 * 1000).toISOString();
  const today = businessTodayIso('Asia/Kolkata', new Date(nowMs));
  const day = (d: number) => addDaysIso(today, d);

  const sentRelease = (releasedAt: string): TaskReleaseConfig => ({
    mode: 'NOW',
    releaseAt: null,
    afterTaskCode: null,
    afterTrigger: 'FULL_COMPLETION',
    delayMinutes: 0,
    requireOwnerConfirm: false,
    releasedAt,
    holdReason: null,
  });

  const member = (m: Omit<TeamMember, 'tenantId' | 'bufferMode' | 'isOnLeave'>): TeamMember => ({
    tenantId: TENANT,
    bufferMode: 'STANDARD_15_MIN',
    isOnLeave: false,
    ...m,
  });

  const rawMembers: Record<string, TeamMember> = {
    [OWNER]: member({
      phone: OWNER,
      slotId: 'P1',
      name: 'Harsh Bhandari',
      addressAs: 'Harsh ji',
      roleTitle: 'Owner',
      authorityLevel: 'OWNER',
      skills: ['Family relations', 'Approvals', 'Pricing'],
      maxActiveTasks: 5,
      preferredLanguage: 'HINGLISH',
      workShiftStart: '09:00',
      workShiftEnd: '22:00',
      dailyOverviewTime: '09:00',
      lastInboundAt: hoursAgo(1),
      responsibilities: 'Sets the methods, approves spending above ₹2,000, and talks to families for big weddings.',
      strengths: ['Family relations', 'Quick decisions'],
      weaknesses: ['Says yes to last-minute changes'],
      reportsToPhone: null,
      partnerOfPhone: null,
      worksCloselyWithPhones: [POOJA],
      stats: stats(3, 2, 3, 15),
      personaPrompt: 'Short Hinglish, cost first, clear yes/no options.',
    }),
    [POOJA]: member({
      phone: POOJA,
      slotId: 'P2',
      name: 'Pooja Mehta',
      addressAs: 'Pooja ji',
      roleTitle: 'Ops Manager — Events & Banquets',
      authorityLevel: 'MANAGER',
      skills: ['Event planning', 'Run sheets', 'Family coordination'],
      maxActiveTasks: 5,
      preferredLanguage: 'HINGLISH',
      workShiftStart: '10:00',
      workShiftEnd: '22:00',
      dailyOverviewTime: '10:00',
      lastInboundAt: hoursAgo(2),
      responsibilities:
        'Plans every event: confirms guest count, menu and timings with the family, makes the run sheet, and supervises lawn, vendor and power work.',
      strengths: ['Planning', 'Calm under pressure'],
      weaknesses: ['Takes on too many events at once'],
      reportsToPhone: OWNER,
      partnerOfPhone: null,
      worksCloselyWithPhones: [OWNER, RAMESH, SURESH],
      stats: stats(6, 5, 6, 40),
      personaPrompt: 'Clear Hinglish text, short lines.',
    }),
    [GOPAL]: member({
      phone: GOPAL,
      slotId: 'P3',
      name: 'Gopal Singh',
      addressAs: 'Gopal ji',
      prefersVoiceNotes: true,
      roleTitle: 'Maintenance Lead — Rooms & Property',
      authorityLevel: 'SUPERVISOR',
      skills: ['AC repair', 'Plumbing', 'Electrical'],
      maxActiveTasks: 4,
      preferredLanguage: 'HINDI',
      workShiftStart: '08:00',
      workShiftEnd: '20:00',
      dailyOverviewTime: '08:30',
      lastInboundAt: hoursAgo(20),
      responsibilities: 'Fixes AC, plumbing, lights and furniture across the halls, rooms and lawns.',
      strengths: ['Quick fixes'],
      weaknesses: ['Forgets to log spare-part costs'],
      reportsToPhone: OWNER,
      partnerOfPhone: null,
      worksCloselyWithPhones: [MAHESH],
      stats: stats(5, 5, 4, 30),
      personaPrompt: 'Simple, respectful Hindi. Short lines.',
    }),
    [RAMESH]: member({
      phone: RAMESH,
      slotId: 'P4',
      name: 'Ramesh Choudhary',
      addressAs: 'Ramesh bhai',
      prefersVoiceNotes: true,
      roleTitle: 'Lawn & Setup',
      authorityLevel: 'STAFF',
      skills: ['Lawn setup', 'Seating layout', 'Stage & décor'],
      maxActiveTasks: 3,
      preferredLanguage: 'HINDI',
      workShiftStart: '08:00',
      workShiftEnd: '21:00',
      dailyOverviewTime: '08:30',
      lastInboundAt: hoursAgo(0.1),
      responsibilities: 'Cleans the lawns, lays out chairs and tables, and sets up the stage, lights and décor before events.',
      strengths: ['Speed'],
      weaknesses: ['Skips steps when rushed'],
      reportsToPhone: POOJA,
      partnerOfPhone: null,
      worksCloselyWithPhones: [POOJA, SURESH, MAHESH],
      stats: stats(7, 5, 6, 55),
      personaPrompt: 'Simple Hindi, friendly. Short lines.',
    }),
    [SURESH]: member({
      phone: SURESH,
      slotId: 'P5',
      name: 'Suresh Jain',
      addressAs: 'Suresh ji',
      roleTitle: 'Vendors & Purchase',
      authorityLevel: 'STAFF',
      skills: ['Chair & tent vendors', 'Flowers', 'Quotes & bills'],
      maxActiveTasks: 4,
      preferredLanguage: 'HINGLISH',
      workShiftStart: '10:00',
      workShiftEnd: '20:00',
      dailyOverviewTime: '10:00',
      lastInboundAt: hoursAgo(1.2),
      responsibilities: 'Buys and hires chairs, tents, flowers and supplies; gets three quotes and sends the bills.',
      strengths: ['Gets good deals'],
      weaknesses: ['Replies late'],
      reportsToPhone: POOJA,
      partnerOfPhone: null,
      worksCloselyWithPhones: [POOJA, RAMESH],
      stats: stats(6, 4, 5, 95),
      personaPrompt: 'Practical Hinglish text, short lines.',
    }),
    [MAHESH]: member({
      phone: MAHESH,
      slotId: 'P6',
      name: 'Mahesh Prajapat',
      addressAs: 'Mahesh ji',
      prefersVoiceNotes: true,
      roleTitle: 'Power & Generator',
      authorityLevel: 'STAFF',
      skills: ['Generators', 'Diesel stock', 'Event lighting power'],
      maxActiveTasks: 3,
      preferredLanguage: 'HINDI',
      workShiftStart: '09:00',
      workShiftEnd: '23:00',
      dailyOverviewTime: '09:30',
      lastInboundAt: hoursAgo(0.8),
      responsibilities: 'Runs the generators, keeps the diesel stock, and powers the event lighting.',
      strengths: ['Steady and reliable'],
      weaknesses: ['Forgets to send photos'],
      reportsToPhone: GOPAL,
      partnerOfPhone: null,
      worksCloselyWithPhones: [GOPAL, RAMESH],
      stats: stats(5, 4, 4, 35),
      personaPrompt: 'Simple Hindi. Short lines.',
    }),
  };

  const category_sops: CategorySop[] = [
    {
      categoryId: 'EVENT_SETUP',
      categoryName: 'Lawn & event setup',
      defaultClassification: 'MAJOR',
      defaultResponsiblePhone: RAMESH,
      backupResponsiblePhone: POOJA,
      spendApprovalRequired: false,
      sopSystemPrompt:
        'Set up the lawn or hall for an event: clean, lay out seating as per the plan, set up stage, lights and décor, and send a photo of the finished setup. Finish 2 hours before guests arrive.',
      defaultMicroSteps: [
        'Clean the lawn and walkways',
        'Lay out chairs and tables as per the seating plan',
        'Set up the stage, lights and décor',
        'Send a photo of the finished setup',
      ],
      requiredFacts: ['which lawn or hall', 'event date and start time', 'guest count'],
    },
    {
      categoryId: 'VENDOR_PURCHASE',
      categoryName: 'Vendors & purchase',
      defaultClassification: 'MAJOR',
      defaultResponsiblePhone: SURESH,
      backupResponsiblePhone: POOJA,
      spendApprovalRequired: true,
      sopSystemPrompt:
        'Purchase method: get three quotes, send them for approval, place the order with a delivery time, and send the bill photo.',
      defaultMicroSteps: [
        'Get three quotes',
        'Send the quotes for approval',
        'Place the order and confirm the delivery time',
        'Send the bill photo',
      ],
      requiredFacts: ['what and how many', 'needed by when'],
    },
    {
      categoryId: 'POWER',
      categoryName: 'Power & generator',
      defaultClassification: 'MINOR',
      defaultResponsiblePhone: MAHESH,
      backupResponsiblePhone: GOPAL,
      spendApprovalRequired: false,
      sopSystemPrompt:
        'Before every evening event: check and fill diesel, test-run the generator for 10 minutes, and send a photo of the fuel gauge.',
      defaultMicroSteps: [
        'Check the diesel level',
        'Fill diesel if below half',
        'Test-run the generator for 10 minutes',
        'Send a photo of the fuel gauge',
      ],
      requiredFacts: [],
    },
    {
      categoryId: 'MAINTENANCE',
      categoryName: 'Rooms & property repairs',
      defaultClassification: 'MINOR',
      defaultResponsiblePhone: GOPAL,
      backupResponsiblePhone: MAHESH,
      spendApprovalRequired: false,
      sopSystemPrompt: 'Check the problem on site, fix it or call the technician, and send a photo after the fix.',
      defaultMicroSteps: ['Check the problem on site', 'Fix it or call the technician', 'Send a photo after the fix'],
      requiredFacts: ['which room, hall or lawn'],
    },
    {
      categoryId: 'EVENT_PLANNING',
      categoryName: 'Event planning & families',
      defaultClassification: 'MAJOR',
      defaultResponsiblePhone: POOJA,
      backupResponsiblePhone: OWNER,
      spendApprovalRequired: false,
      sopSystemPrompt:
        'Confirm guest count, menu and timings with the family, share the run sheet with the team, and confirm the advance payment.',
      defaultMicroSteps: [
        'Confirm guest count, menu and timings with the family',
        'Share the run sheet with the team',
        'Confirm the advance payment',
      ],
      requiredFacts: ['family name', 'event date', 'guest count'],
    },
    {
      categoryId: 'GENERAL',
      categoryName: 'General',
      defaultClassification: 'MINOR',
      defaultResponsiblePhone: null,
      backupResponsiblePhone: null,
      spendApprovalRequired: true,
      sopSystemPrompt: 'Any other work. Pick the person by what they handle.',
      defaultMicroSteps: ['Do the work', 'Send an update'],
    },
  ];

  const steps = (code: string, items: Array<[string, MicroStep['status'], string?]>): MicroStep[] =>
    items.map(([label, status, evidenceNote], i) => ({
      id: `ms-${code.toLowerCase()}-${i + 1}`,
      label,
      status,
      ...(evidenceNote ? { evidenceNote } : {}),
    }));

  const brief = (t: Pick<Task, 'taskCode' | 'shortTag' | 'title' | 'dueDate' | 'quadrant' | 'microSteps'> & { dueTime?: string | null }, phone: string) =>
    buildShortTaskBrief({ ...t, taskFrequency: 'ONE_TIME', recurrenceRule: 'NONE' }, rawMembers[phone]);

  const baseTask = (t: Partial<Task> & Pick<Task, 'taskCode' | 'title' | 'categoryId' | 'raci' | 'status'>): Task => ({
    tenantId: TENANT,
    shortTag: '',
    agendaId: 'AG-301',
    wbsHeadId: null,
    swimlaneStage: '',
    quadrant: 'Q1_DO_FIRST',
    majorOrMinor: 'MAJOR',
    taskFrequency: 'ONE_TIME',
    recurrenceRule: 'NONE',
    isFrozen: true,
    completionPercent: 0,
    microSteps: [],
    missingStepsAlert: '',
    dependency: { dependsOnTaskCode: null, triggerCondition: 'FULL_COMPLETION' },
    reminderConfig: { includeInDailyOverview: true, customIntervalHours: 2, lastNudgedAt: null, nudgeCount: 0 },
    startDate: day(0),
    durationDays: 1,
    dueDate: day(0),
    dueTime: null,
    isForcedDeadline: false,
    forcedDeadlineDate: null,
    outboundWhatsappPreview: '',
    latestAiSummary: '',
    auditLogs: [],
    ...t,
  });

  const t301 = baseTask({
    taskCode: 'T-301',
    shortTag: 'Lawn 2 Setup',
    wbsHeadId: 'HEAD-B1',
    swimlaneStage: 'Lawn setup',
    title: 'Set up Lawn 2 for the Mehta reception (250 guests)',
    categoryId: 'EVENT_SETUP',
    raci: { R: RAMESH, A: POOJA, C: [SURESH], I: [OWNER] },
    status: 'IN_PROGRESS',
    completionPercent: 25,
    microSteps: steps('T-301', [
      ['Clean the lawn and walkways', 'DONE', 'Lawn cleaned by noon.'],
      ['Lay out 250 chairs and tables as per the seating plan', 'PENDING'],
      ['Set up the stage, lights and décor', 'PENDING'],
      ['Send a photo of the finished setup', 'PENDING'],
    ]),
    release: sentRelease(hoursAgo(5)),
    lastOutboundAt: hoursAgo(5),
    dueTime: '18:00',
    isForcedDeadline: true,
    forcedDeadlineDate: day(0),
    latestAiSummary: 'Lawn cleaned. Seating, stage and décor still to do; must be ready 2 hours before the 8 PM reception.',
    auditLogs: [
      { timestamp: hoursAgo(5), sender: 'Owner Meditate', rawInputSummary: 'Lawn 2 setup for tonight’s Mehta reception.', aiDecision: 'Assigned to Ramesh Choudhary (lawn setup).' },
      { timestamp: hoursAgo(3), sender: `Ramesh Choudhary (${RAMESH})`, rawInputSummary: 'लॉन की सफ़ाई हो गई।', aiDecision: 'Step 1 DONE -> IN_PROGRESS (25%).' },
    ],
  });
  t301.outboundWhatsappPreview = brief(t301, RAMESH);

  const t302 = baseTask({
    taskCode: 'T-302',
    shortTag: '150 Extra Chairs',
    wbsHeadId: 'HEAD-B1',
    swimlaneStage: 'Chairs & vendors',
    title: 'Hire 150 extra chairs for the Mehta reception',
    categoryId: 'VENDOR_PURCHASE',
    raci: { R: SURESH, A: POOJA, C: [], I: [OWNER, RAMESH] },
    status: 'AWAITING_BOSS_DECISION',
    completionPercent: 50,
    microSteps: steps('T-302', [
      ['Get three quotes', 'DONE', '₹4,500 (Shree Tent House), ₹5,200, ₹5,800 — all with transport.'],
      ['Send the quotes for approval', 'DONE'],
      ['Place the order and confirm delivery by 5 PM', 'PENDING'],
      ['Send the bill photo', 'PENDING'],
    ]),
    release: sentRelease(hoursAgo(4)),
    lastOutboundAt: hoursAgo(4),
    dueTime: '17:00',
    pausedIntervals: [{ pausedAt: hoursAgo(1.1) }],
    latestAiSummary: 'Three quotes in; cheapest is ₹4,500 with transport. Waiting for the owner’s approval.',
    auditLogs: [
      { timestamp: hoursAgo(1.2), sender: `Suresh Jain (${SURESH})`, rawInputSummary: '3 quotes: 4500, 5200, 5800. Shree Tent House sasta hai.', aiDecision: 'Spend above ₹2,000 -> Boss Review REV-301.' },
    ],
  });
  t302.outboundWhatsappPreview = brief(t302, SURESH);

  const t303 = baseTask({
    taskCode: 'T-303',
    shortTag: 'Generator Check',
    wbsHeadId: 'HEAD-B1',
    swimlaneStage: 'Power check',
    title: 'Diesel and test-run for the Lawn 2 generator',
    categoryId: 'POWER',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    raci: { R: MAHESH, A: GOPAL, C: [], I: [POOJA] },
    status: 'PARTIALLY_DONE',
    completionPercent: 75,
    microSteps: steps('T-303', [
      ['Check the diesel level', 'DONE'],
      ['Fill diesel if below half', 'DONE', '40 litres filled.'],
      ['Test-run the generator for 10 minutes', 'DONE'],
      ['Send a photo of the fuel gauge', 'MISSED'],
    ]),
    release: sentRelease(hoursAgo(5)),
    lastOutboundAt: hoursAgo(5),
    dueTime: '16:00',
    missingStepsAlert: 'Fuel gauge photo not sent.',
    latestAiSummary: 'Diesel filled and test-run done; the fuel gauge photo is still missing.',
    auditLogs: [
      { timestamp: hoursAgo(0.8), sender: `Mahesh Prajapat (${MAHESH})`, rawInputSummary: 'डीज़ल भर दिया, जनरेटर 10 मिनट चला लिया।', aiDecision: 'Steps 1–3 DONE, photo MISSED -> PARTIALLY_DONE (75%).' },
    ],
  });
  t303.outboundWhatsappPreview = brief(t303, MAHESH);

  const t304 = baseTask({
    taskCode: 'T-304',
    shortTag: 'Hall A AC',
    agendaId: null,
    title: 'Fix the AC leak in Banquet Hall A',
    categoryId: 'MAINTENANCE',
    quadrant: 'Q2_SCHEDULE',
    majorOrMinor: 'MINOR',
    raci: { R: GOPAL, A: OWNER, C: [], I: [] },
    status: 'COMPLETED',
    completionPercent: 100,
    microSteps: steps('T-304', [
      ['Check the problem on site', 'DONE'],
      ['Fix it or call the technician', 'DONE', 'Drain pipe cleaned.'],
      ['Send a photo after the fix', 'DONE', 'Photo received.'],
    ]),
    release: sentRelease(hoursAgo(26)),
    lastOutboundAt: hoursAgo(26),
    startDate: day(-1),
    dueDate: day(-1),
    latestAiSummary: 'AC drain pipe cleaned; photo received. Done.',
    auditLogs: [
      { timestamp: hoursAgo(25), sender: `Gopal Singh (${GOPAL})`, rawInputSummary: 'AC ka drain pipe saaf kar diya, photo bhej di.', aiDecision: 'Updated to COMPLETED (100%).' },
    ],
  });
  t304.outboundWhatsappPreview = brief(t304, GOPAL);

  const t305 = baseTask({
    taskCode: 'T-305',
    shortTag: 'Sharma Call',
    agendaId: null,
    title: 'Call the Sharma family about tomorrow’s wedding: final guest count and décor',
    categoryId: 'EVENT_PLANNING',
    quadrant: 'Q1_DO_FIRST',
    raci: { R: OWNER, A: OWNER, C: [POOJA], I: [] },
    status: 'PENDING',
    microSteps: steps('T-305', [
      ['Confirm the final guest count', 'PENDING'],
      ['Confirm marigold décor at the entrance', 'PENDING'],
    ]),
    release: sentRelease(hoursAgo(2)),
    dueTime: '19:00',
    latestAiSummary: 'Your call: the Sharma wedding is tomorrow.',
  });
  t305.outboundWhatsappPreview = '';

  const tasks: Task[] = enrichSeedTaskSteps([t301, t302, t303, t304, t305]);

  const draftOf = (t: Task, tempId: string) => ({
    tempId,
    title: t.title,
    shortTag: t.shortTag,
    categoryId: t.categoryId,
    quadrant: t.quadrant,
    majorOrMinor: t.majorOrMinor,
    taskFrequency: t.taskFrequency,
    recurrenceRule: t.recurrenceRule,
    raci: t.raci,
    dependsOnTempIdOrTaskCode: null,
    triggerCondition: 'FULL_COMPLETION' as const,
    startDate: t.startDate,
    durationDays: t.durationDays,
    dueDate: t.dueDate,
    dueTime: t.dueTime ?? null,
    isForcedDeadline: t.isForcedDeadline,
    forcedDeadlineDate: t.forcedDeadlineDate,
    wbsHeadId: 'HEAD-B1',
    swimlaneStage: t.swimlaneStage,
    microSteps: t.microSteps.map((s) => s.label),
    outboundWhatsappPreview: t.outboundWhatsappPreview,
  });

  const arranged = autoArrangeOrgPositions(Object.values(rawMembers), category_sops, tasks, today);
  const team_members: Record<string, TeamMember> = Object.fromEntries(
    Object.entries(rawMembers).map(([phone, m]) => [phone, { ...m, orgChartPosition: arranged[phone] || null }])
  );

  return {
    ...base,
    tenantId: TENANT,
    principal_prompts: {
      planningPrompt: `You are reflexion.ai Meditate for a banquet, lawn and catering business in Jodhpur.
Given the owner's message (often Hinglish or Hindi, often a voice note), the team roster with reporting lines and workloads, and the task-type playbooks:
1. If it is a greeting, a test or a question, answer naturally with no tasks.
2. If a must-know fact for the task type is missing (which lawn, date and start time, guest count, how many), ask ONE short question first.
3. One person, one job -> one quick task. Work for several people for the same event -> a project; jobs that can happen at the same time go in the same stage.
4. Plain everyday words. Never reveal private weaknesses in anything staff will see.`,
      evaluationPrompt: `You are reflexion.ai WhatsApp reader for a banquet and lawn business.
Read the teammate's messages, voice notes and photos:
1. The latest message wins if it corrects an earlier one.
2. Check the task's own steps: seating count, setup photo, quotes and bill photo, fuel gauge photo. Mark skipped steps MISSED.
3. Send any spend above ₹2,000 to Boss Review.
4. Reply in the teammate's language (Hindi or Hinglish), in 1–3 short lines.`,
    },
    business_profile: {
      businessName: 'Sunehri Bagh Lawns & Banquets',
      businessType: 'Banquets, lawns & catering',
      businessDescription:
        'Runs four lawns and two banquet halls in Jodhpur for weddings, receptions and corporate events, with in-house catering. Daily work: event setup, vendor hiring, power backup, repairs and family coordination.',
      workLocations: 'Lawn 1, Lawn 2, Lawn 3, Lawn 4, Banquet Hall A, Banquet Hall B, Main Kitchen, Store',
      defaultStaffLanguage: 'HINDI',
      hardRules:
        'Lawn setup must be ready 2 hours before guests arrive. Every purchase above ₹2,000 needs three quotes and the owner’s approval. Test-run the generator before every evening event.',
      timezone: 'Asia/Kolkata',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      batchNonUrgentIntoDigest: false,
      enforceWhatsapp24hWindow: true,
      whatsappTemplateText:
        'Sunehri Bagh update for {{name}}: [{{shortTag}}] {{title}} — {{dueDate}}.\n{{body}}\nReply here to continue.',
    },
    owner_profile: {
      personalOperatingPrompt:
        'I approve spending above ₹2,000 and talk to families for big weddings. Pooja runs events; Ramesh does lawn setup; Suresh handles vendors and purchases; Mahesh runs power and generators; Gopal fixes anything broken.',
      defaultAccountablePhone: POOJA,
      alwaysDelegatesCategories: ['EVENT_SETUP', 'VENDOR_PURCHASE', 'POWER', 'MAINTENANCE'],
      keepsCategories: [],
      followUpStuckHours: 6,
    },
    task_splitting_rules: {
      maxChecklistStepsPerTask: 5,
      defaultMaxActiveTasksPerPerson: 4,
      taskSplittingRule:
        'One person doing one job stays one quick task. When several people work on the same event (setup, chairs, power), make a project; jobs that can happen at the same time go in the same stage, and a job that needs another one finished goes in a later stage.',
    },
    sample_brain_dumps: [
      {
        id: 'banquet-dump-1',
        text: 'Kal Sharma ji ki shaadi hai. Lawn ready karwao, 300 chairs lagwao, aur generator ka diesel check kar lo.',
        splitType: 'PROJECT_SWIMLANES',
        aiInstruction:
          'Three people at the same time: lawn setup -> Ramesh (EVENT_SETUP), 300 chairs from the vendor -> Suresh (VENDOR_PURCHASE), generator diesel -> Mahesh (POWER). Ask once for any must-know fact that is missing (which lawn, start time).',
      },
      {
        id: 'banquet-dump-2',
        text: 'Banquet Hall B ka AC theek se thanda nahi kar raha, aaj shaam ke event se pehle theek karwao.',
        splitType: 'QUICK_TASK',
        aiInstruction: 'One repair job -> 1 quick task for Gopal (MAINTENANCE), due before this evening.',
      },
      {
        id: 'banquet-dump-3',
        text: 'Next Saturday Jain family ka reception hai, Lawn 1, shaam 7 baje, 400 guests. Family se menu confirm karo, 400 chairs aur tent book karo, lawn setup karwao aur generator test karo.',
        splitType: 'PROJECT_SWIMLANES',
        aiInstruction:
          'Project in order: Pooja confirms menu with the family -> Suresh books chairs and tent (needs approval) -> Ramesh sets up the lawn and Mahesh tests the generator on the day.',
      },
    ],
    team_members,
    category_sops,
    umbrella_agendas: [
      {
        agendaId: 'AG-301',
        title: 'Mehta reception tonight — Lawn 2, 8 PM, 250 guests',
        rawBrainDump: 'Aaj raat Mehta reception hai Lawn 2 par, 8 baje, 250 guests. Lawn 6 baje tak ready, 150 extra chairs mangwao, generator check karwao.',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        status: 'ACTIVE',
        createdAt: hoursAgo(5),
      },
    ],
    wbs_heads: [
      {
        tenantId: TENANT,
        headId: 'HEAD-B1',
        title: 'Mehta reception — Lawn 2, tonight 8 PM',
        domainCategory: 'EVENT_SETUP',
        contextSummary: '250 guests at 8 PM. Lawn ready by 6 PM; 150 extra chairs from a vendor; generator test before the event.',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        tentativeDurationDays: 1,
        tentativeStartDate: day(0),
        tentativeDeadline: day(0),
        isForcedDeadline: true,
        dynamicStages: ['Chairs & vendors', 'Lawn setup', 'Power check'],
        involvedPhones: [SURESH, RAMESH, MAHESH],
        status: 'FROZEN_DISPATCHED',
        subTasks: [draftOf(t302, 'draft-b1-1'), draftOf(t301, 'draft-b1-2'), draftOf(t303, 'draft-b1-3')],
      },
    ],
    tasks,
    boss_review_queue: [
      {
        tenantId: TENANT,
        reviewId: 'REV-301',
        taskCode: 'T-302',
        employeePhone: SURESH,
        reviewType: 'BUDGET_APPROVAL',
        employeeMessageSummary:
          'Suresh got three quotes for 150 extra chairs with transport: ₹4,500 (Shree Tent House), ₹5,200 and ₹5,800. Asks to approve ₹4,500.',
        mediaVerificationNote: 'Three quotes listed in the message; no photo needed at this step.',
        aiSuggestedReplies: [
          'Approved — book Shree Tent House for ₹4,500 and get the chairs to Lawn 2 by 5 PM.',
          'Approve only if they can deliver by 5 PM; confirm first.',
          'Not approved — move 150 chairs from Banquet Hall B instead.',
        ],
        status: 'OPEN',
        createdAt: hoursAgo(1.1),
      },
    ],
    inbound_message_buffer: {
      [RAMESH]: {
        tenantId: TENANT,
        employeePhone: RAMESH,
        bufferMode: 'STANDARD_15_MIN',
        firstMessageAt: hoursAgo(0.1),
        processAt: new Date(nowMs + 15 * 60_000).toISOString(),
        messages: [
          {
            id: 'buf-banquet-1',
            timestamp: hoursAgo(0.1),
            type: 'text',
            textContent: 'लॉन साफ़ हो गया। 100 कुर्सियाँ लग गईं, बाकी 150 कुर्सियाँ वेंडर से शाम 7 बजे आएँगी।',
          },
        ],
      },
    },
    system_memory: [
      { tenantId: TENANT, memoryId: 'MEM-B1', category: 'BUSINESS_RULE', fact: 'Lawn setup must be ready 2 hours before guests arrive.', active: true, approved: true },
      { tenantId: TENANT, memoryId: 'MEM-B2', category: 'BUSINESS_RULE', fact: 'Every purchase above ₹2,000 needs three quotes and Harsh’s approval.', active: true, approved: true },
      { tenantId: TENANT, memoryId: 'MEM-B3', category: 'SOP_PREFERENCE', fact: 'Test-run the generator for 10 minutes before every evening event.', active: true, approved: true },
      { tenantId: TENANT, memoryId: 'MEM-B4', category: 'VENDOR_FACT', fact: 'Chair vendors need 4 hours’ notice for more than 100 chairs.', active: true, approved: true },
      { tenantId: TENANT, memoryId: 'MEM-B5', category: 'STAFF_TRAIT', fact: 'Ramesh, Gopal and Mahesh prefer Hindi; Pooja and Suresh prefer Hinglish text.', active: true, approved: true },
    ],
    notes: [
      { tenantId: TENANT, noteId: 'NOTE-B1', text: 'Sharma wedding tomorrow: the family wants marigold décor at the entrance.', createdAt: hoursAgo(6) },
    ],
    whatsapp_messages: [
      { tenantId: TENANT, id: 'wa-b-1', employeePhone: RAMESH, direction: 'OUTBOUND', timestamp: hoursAgo(5), tag: 'TASK_DISPATCH', taskCode: 'T-301', text: t301.outboundWhatsappPreview },
      { tenantId: TENANT, id: 'wa-b-2', employeePhone: MAHESH, direction: 'OUTBOUND', timestamp: hoursAgo(5), tag: 'TASK_DISPATCH', taskCode: 'T-303', text: t303.outboundWhatsappPreview },
      { tenantId: TENANT, id: 'wa-b-3', employeePhone: SURESH, direction: 'OUTBOUND', timestamp: hoursAgo(4), tag: 'TASK_DISPATCH', taskCode: 'T-302', text: t302.outboundWhatsappPreview },
      { tenantId: TENANT, id: 'wa-b-4', employeePhone: RAMESH, direction: 'INBOUND', timestamp: hoursAgo(3), taskCode: 'T-301', text: 'लॉन की सफ़ाई हो गई।' },
      { tenantId: TENANT, id: 'wa-b-5', employeePhone: SURESH, direction: 'INBOUND', timestamp: hoursAgo(1.2), taskCode: 'T-302', text: '3 quotes aa gaye: 4500, 5200, 5800 (transport ke saath). Shree Tent House sabse sasta hai, book kar doon?' },
      { tenantId: TENANT, id: 'wa-b-6', employeePhone: SURESH, direction: 'OUTBOUND', timestamp: hoursAgo(1.15), tag: 'BOSS_ESCALATION_HOLD', taskCode: 'T-302', text: 'Suresh ji, ₹4,500 ₹2,000 se zyada hai — Harsh ji ki approval ke liye bhej diya hai.' },
      { tenantId: TENANT, id: 'wa-b-7', employeePhone: MAHESH, direction: 'INBOUND', timestamp: hoursAgo(0.8), taskCode: 'T-303', text: 'डीज़ल भर दिया, जनरेटर 10 मिनट चला लिया।' },
      { tenantId: TENANT, id: 'wa-b-8', employeePhone: MAHESH, direction: 'OUTBOUND', timestamp: hoursAgo(0.78), tag: 'AI_CONFIRMATION', taskCode: 'T-303', text: 'धन्यवाद Mahesh ji! कृपया फ्यूल गेज की एक फोटो भी भेज दें।' },
    ],
    ai_logs: [],
  };
}
