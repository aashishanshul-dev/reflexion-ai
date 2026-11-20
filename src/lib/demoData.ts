import {
  DEFAULT_TENANT_ID,
  type CategorySop,
  type OpsDatabaseState,
  type Task,
  type TaskReleaseConfig,
  type TeamMember,
} from '../types/ops.ts';
import { defaultStageConfig, MODEL_DEFAULTS_VERSION } from './modelConfig.ts';
import { normalizeIndianPhone } from './phoneText.ts';
import { autoArrangeOrgPositions } from './teamGraph.ts';
import { addDaysIso, businessTodayIso } from './planDates.ts';
import { enrichSeedTaskSteps } from './stepChecks.ts';

export interface DemoLead {
  leadId?: string;
  name: string;
  email: string;
  phone: string;
  registeredAt: string;
}

export interface DemoLeadValidationResult {
  ok: true;
  lead: DemoLead;
}

export interface DemoLeadValidationError {
  ok: false;
  error: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validates and normalizes guest demo registration fields (Name, Email, Phone).
 */
export function validateDemoLeadInput(
  input: { name?: unknown; email?: unknown; phone?: unknown },
  nowIso: string = new Date().toISOString()
): DemoLeadValidationResult | DemoLeadValidationError {
  const name = String(input?.name ?? '').trim();
  const email = String(input?.email ?? '').trim().toLowerCase();
  const rawPhone = String(input?.phone ?? '').trim();
  const normalizedPhone = normalizeIndianPhone(rawPhone);
  const digitsOnly = rawPhone.replace(/\D/g, '');

  if (name.length < 2) {
    return { ok: false, error: 'Please enter your full name (at least 2 characters).' };
  }
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  if (digitsOnly.length < 7 || digitsOnly.length > 15) {
    return { ok: false, error: 'Please enter a valid phone number (7 to 15 digits).' };
  }

  return {
    ok: true,
    lead: {
      name,
      email,
      phone: normalizedPhone || digitsOnly,
      registeredAt: nowIso,
    },
  };
}

export const DEMO_WALKTHROUGH_COPY = [
  {
    id: 'meditate',
    title: '1. Ask AI to Plan & Split Work',
    summary: 'Try any sample prompt (like the leaking dispenser) to see AI assign steps and people.',
    actionLabel: 'Open Meditate',
  },
  {
    id: 'team',
    title: '2. Team & Hierarchy Chart',
    summary: 'See all 7 BlueDrop teammates, who reports to whom, and what each person handles.',
    actionLabel: 'Open Team Chart',
  },
  {
    id: 'liveOps',
    title: '3. Deliveries & Scheduler Tick',
    summary: 'Check empty jars (T-202) waiting on T-201, and click Run Scheduler Tick to send monthly bills (T-204).',
    actionLabel: 'Open Live Ops',
  },
  {
    id: 'whatsapp',
    title: '4. WhatsApp Field Chat',
    summary: "Process Nitin's queued van message ('Van left, 20 jars loaded, remaining 20 in second trip.') with AI.",
    actionLabel: 'Open WhatsApp Chat',
  },
  {
    id: 'approvals',
    title: '5. My Tasks & Boss Approvals',
    summary: "Approve or review Rohan's ₹2,500 extra van rental request in Boss Reviews.",
    actionLabel: 'Open Boss Reviews',
  },
  {
    id: 'aiBrain',
    title: '6. Playbooks, Rules & AI Settings',
    summary: 'View the 5 BlueDrop playbooks, simple rules, system prompts, and temperature sliders.',
    actionLabel: 'Open AI Brain',
  },
] as const;

/**
 * Static, self-contained demo workspace for "BlueDrop Water Supplies" (Pune).
 * Delivers 20-litre drinking-water jars and water dispensers to offices.
 * Completely isolated from any signed-in tenant workspace.
 */
export function createDemoSeedState(nowIso: string = new Date().toISOString()): OpsDatabaseState {
  const nowMs = new Date(nowIso).getTime();
  const hoursAgo = (h: number) => new Date(nowMs - h * 3600 * 1000).toISOString();
  // Dates count from today in the demo business's timezone (not UTC), so early-morning
  // visits in India don't see "today" tasks dated yesterday.
  const demoToday = businessTodayIso('Asia/Kolkata', new Date(nowMs));
  const daysFromNowDate = (d: number) => addDaysIso(demoToday, d);

  const nowRelease = (releasedAt: string): TaskReleaseConfig => ({
    mode: 'NOW',
    releaseAt: null,
    afterTaskCode: null,
    afterTrigger: 'FULL_COMPLETION',
    delayMinutes: 0,
    requireOwnerConfirm: false,
    releasedAt,
    holdReason: null,
  });

  const rawMembers: Record<string, TeamMember> = {
    '919820100001': {
      phone: '919820100001',
      slotId: 'P1',
      name: 'Arvind Deshmukh',
      roleTitle: 'Founder & Managing Director',
      authorityLevel: 'OWNER',
      skills: ['Client Contracts', 'Expense Approvals', 'Business Growth'],
      maxActiveTasks: 5,
      preferredLanguage: 'ENGLISH',
      workShiftStart: '09:00',
      workShiftEnd: '20:00',
      dailyOverviewTime: '09:00',
      isOnLeave: false,
      lastInboundAt: hoursAgo(1),
      bufferMode: 'STANDARD_15_MIN',
      responsibilities:
        'Runs the business, approves extra expenses above ₹2,000, and closes large office water contracts.',
      strengths: ['Fast Decisions', 'Key Client Deals'],
      weaknesses: ['Sometimes promises same-day delivery before checking van space'],
      reportsToPhone: null,
      partnerOfPhone: '919820100002',
      worksCloselyWithPhones: ['919820100003'],
      stats: {
        assigned: 3,
        completed: 2,
        partial: 0,
        overdueCount: 0,
        totalWorkHoursReplyMins: 16,
        replyCount: 3,
      },
      personaPrompt:
        'Short, clear executive English. Highlight total cost, client name, and clear Yes/No options.',
    },
    '919820100002': {
      phone: '919820100002',
      slotId: 'P2',
      name: 'Priya Nair',
      roleTitle: 'Co-founder, Sales & Customers',
      authorityLevel: 'MANAGER',
      skills: ['New Office Leads', 'Rate Cards', 'Client Care'],
      maxActiveTasks: 4,
      preferredLanguage: 'ENGLISH',
      workShiftStart: '09:30',
      workShiftEnd: '19:30',
      dailyOverviewTime: '09:30',
      isOnLeave: false,
      lastInboundAt: hoursAgo(4),
      bufferMode: 'STANDARD_15_MIN',
      responsibilities:
        'Signs up new office clients, sends rate cards, and checks on monthly customer accounts.',
      strengths: ['Warm Client Follow-Up', 'Clear Pricing'],
      weaknesses: ['Prefers detailed emails over quick phone calls'],
      reportsToPhone: null,
      partnerOfPhone: '919820100001',
      worksCloselyWithPhones: ['919820100007'],
      stats: {
        assigned: 4,
        completed: 3,
        partial: 0,
        overdueCount: 0,
        totalWorkHoursReplyMins: 36,
        replyCount: 4,
      },
      personaPrompt:
        'Polite, upbeat business English.',
    },
    '919820100003': {
      phone: '919820100003',
      slotId: 'P3',
      name: 'Rohan Kulkarni',
      roleTitle: 'Operations Head',
      authorityLevel: 'SUPERVISOR',
      skills: ['Daily Dispatch', 'Warehouse Ops', 'Route Planning'],
      maxActiveTasks: 5,
      preferredLanguage: 'HINGLISH',
      workShiftStart: '08:00',
      workShiftEnd: '19:30',
      dailyOverviewTime: '08:30',
      isOnLeave: false,
      lastInboundAt: hoursAgo(2),
      bufferMode: 'STANDARD_15_MIN',
      responsibilities:
        'Oversees morning warehouse loading, van routes, and urgent client deliveries across Pune.',
      strengths: ['Calm Under Rush', 'Smart Route Planning'],
      weaknesses: ['Sometimes books extra help before logging the cost'],
      reportsToPhone: '919820100001',
      partnerOfPhone: null,
      worksCloselyWithPhones: ['919820100001', '919820100005', '919820100006'],
      stats: {
        assigned: 7,
        completed: 5,
        partial: 1,
        overdueCount: 0,
        totalWorkHoursReplyMins: 52,
        replyCount: 6,
      },
      personaPrompt:
        'Clear Hinglish, short lines.',
      addressAs: 'Rohan ji',
    },
    '919820100004': {
      phone: '919820100004',
      slotId: 'P4',
      name: 'Suresh Yadav',
      roleTitle: 'Purchase & Stock',
      authorityLevel: 'STAFF',
      skills: ['Jar & Cap Buying', 'Store Inventory', 'Supplier Orders'],
      maxActiveTasks: 4,
      preferredLanguage: 'HINGLISH',
      workShiftStart: '09:00',
      workShiftEnd: '19:00',
      dailyOverviewTime: '09:15',
      isOnLeave: false,
      lastInboundAt: hoursAgo(2.5),
      bufferMode: 'STANDARD_15_MIN',
      responsibilities:
        'Buys 20-litre water jars, sealing caps, and water dispensers, and keeps store stock counted.',
      strengths: ['Good Vendor Rates', 'Neat Stock Count'],
      weaknesses: ['Occasionally buys extra supplies without asking first'],
      reportsToPhone: '919820100003',
      partnerOfPhone: null,
      worksCloselyWithPhones: ['919820100005', '919820100007'],
      stats: {
        assigned: 6,
        completed: 5,
        partial: 0,
        overdueCount: 0,
        totalWorkHoursReplyMins: 64,
        replyCount: 5,
      },
      personaPrompt:
        'Warm, practical Hinglish, short lines.',
      addressAs: 'Suresh ji',
    },
    '919820100005': {
      phone: '919820100005',
      slotId: 'P5',
      name: 'Deepak Verma',
      roleTitle: 'Quality & Service',
      authorityLevel: 'STAFF',
      skills: ['Water Quality Tests', 'Dispenser Repairs', 'Sanitizing'],
      maxActiveTasks: 4,
      preferredLanguage: 'HINGLISH',
      workShiftStart: '08:00',
      workShiftEnd: '18:30',
      dailyOverviewTime: '08:15',
      isOnLeave: false,
      lastInboundAt: hoursAgo(3),
      bufferMode: 'STANDARD_15_MIN',
      responsibilities:
        'Runs daily morning water-quality checks before vans leave and fixes or cleans office water dispensers.',
      strengths: ['Thorough Water Checks', 'Quick Dispenser Fixes'],
      weaknesses: ['Takes extra time writing long messages after site visits'],
      reportsToPhone: '919820100003',
      partnerOfPhone: null,
      worksCloselyWithPhones: ['919820100003', '919820100004', '919820100006'],
      stats: {
        assigned: 6,
        completed: 5,
        partial: 0,
        overdueCount: 0,
        totalWorkHoursReplyMins: 48,
        replyCount: 4,
      },
      personaPrompt:
        'Simple Hinglish, short lines.',
      addressAs: 'Deepak ji',
    },
    '919820100006': {
      phone: '919820100006',
      slotId: 'P6',
      name: 'Nitin Sharma',
      roleTitle: 'Delivery Lead',
      authorityLevel: 'STAFF',
      skills: ['20L Jar Delivery', 'Empty Jar Pickup', 'Van Drivers'],
      maxActiveTasks: 4,
      preferredLanguage: 'HINGLISH',
      workShiftStart: '08:00',
      workShiftEnd: '19:00',
      dailyOverviewTime: '08:30',
      isOnLeave: false,
      lastInboundAt: hoursAgo(0.1),
      bufferMode: 'STANDARD_15_MIN',
      responsibilities:
        'Manages delivery vans and drivers, drops full 20L jars at offices, collects empty jars, and uploads signed receipts.',
      strengths: ['On-Time Deliveries', 'Tracks Empty Jars'],
      weaknesses: ['Often driving and forgets to upload signed slips right away'],
      reportsToPhone: '919820100003',
      partnerOfPhone: null,
      worksCloselyWithPhones: ['919820100003', '919820100005', '919820100007'],
      stats: {
        assigned: 8,
        completed: 6,
        partial: 1,
        overdueCount: 0,
        totalWorkHoursReplyMins: 60,
        replyCount: 6,
      },
      personaPrompt:
        'Friendly Hinglish, short lines.',
      addressAs: 'Nitin bhai',
    },
    '919820100007': {
      phone: '919820100007',
      slotId: 'P7',
      name: 'Kavita Joshi',
      roleTitle: 'Accounts & Billing',
      authorityLevel: 'MANAGER',
      skills: ['Monthly Client Bills', 'Payment Follow-Up', 'Vendor Payments'],
      maxActiveTasks: 4,
      preferredLanguage: 'ENGLISH',
      workShiftStart: '09:30',
      workShiftEnd: '18:30',
      dailyOverviewTime: '09:45',
      isOnLeave: false,
      lastInboundAt: hoursAgo(27), // >24h demonstrates WhatsApp 24h template banner cleanly
      bufferMode: 'STANDARD_15_MIN',
      responsibilities:
        'Sends monthly water jar bills to offices, tracks received payments, and pays suppliers and van drivers.',
      strengths: ['Accurate Monthly Bills', 'Steady Payment Follow-Up'],
      weaknesses: ['Holds any unapproved extra expense until Arvind clears it'],
      reportsToPhone: '919820100002',
      partnerOfPhone: null,
      worksCloselyWithPhones: ['919820100002', '919820100004', '919820100006'],
      stats: {
        assigned: 5,
        completed: 4,
        partial: 0,
        overdueCount: 0,
        totalWorkHoursReplyMins: 40,
        replyCount: 4,
      },
      personaPrompt:
        'Clear, polite business English. Put totals and counts first.',
    },
  };

  const category_sops: CategorySop[] = [
    {
      categoryId: 'DELIVERIES',
      categoryName: 'Deliveries',
      defaultClassification: 'MAJOR',
      defaultResponsiblePhone: '919820100006', // Nitin
      backupResponsiblePhone: '919820100003', // Rohan
      spendApprovalRequired: false,
      sopSystemPrompt:
        'Deliver filled 20L water jars on time, collect the matching number of empty jars at the office, and upload a signed delivery receipt photo on WhatsApp.',
      defaultMicroSteps: [
        'Load filled 20L water jars onto the delivery van',
        'Deliver full jars to the client office reception or pantry',
        'Collect empty jars from the office and confirm the count',
        'Upload a clear photo of the signed delivery receipt on WhatsApp',
      ],
      requiredFacts: ['how many jars', 'which office or address', 'delivery date'],
    },
    {
      categoryId: 'PURCHASE_STOCK',
      categoryName: 'Purchase & Stock',
      defaultClassification: 'MAJOR',
      defaultResponsiblePhone: '919820100004', // Suresh
      backupResponsiblePhone: '919820100003', // Rohan
      spendApprovalRequired: true,
      sopSystemPrompt:
        'Count current jars, caps, or dispensers in the store, get Arvind approval before spending money, buy stock, and upload the bill photo.',
      defaultMicroSteps: [
        'Check existing jars, caps, or dispensers in the warehouse',
        'Confirm supplier quote and get Arvind approval before paying',
        'Receive stock into the warehouse and upload the purchase bill photo',
      ],
    },
    {
      categoryId: 'QUALITY_SERVICE',
      categoryName: 'Quality & Service',
      defaultClassification: 'MAJOR',
      defaultResponsiblePhone: '919820100005', // Deepak
      backupResponsiblePhone: '919820100003', // Rohan
      spendApprovalRequired: false,
      sopSystemPrompt:
        'Check water freshness every morning before vans leave, or clean and repair office water dispensers cleanly and confirm with a photo.',
      defaultMicroSteps: [
        'Test morning water batch or inspect the office dispenser problem',
        'Complete cleaning, filter check, or leak repair work',
        'Share a confirmation message and photo on WhatsApp',
      ],
    },
    {
      categoryId: 'BILLING_PAYMENTS',
      categoryName: 'Billing & Payments',
      defaultClassification: 'MINOR',
      defaultResponsiblePhone: '919820100007', // Kavita
      backupResponsiblePhone: '919820100002', // Priya
      spendApprovalRequired: true,
      sopSystemPrompt:
        'Count signed office delivery slips for the month, send monthly client bills, and get owner approval before paying extra vendor or van charges.',
      defaultMicroSteps: [
        'Match monthly jar count against signed office delivery receipts',
        'Prepare and send monthly client bills or verify vendor charge',
        'Confirm payment sent or received and share update on WhatsApp',
      ],
    },
    {
      categoryId: 'SALES_CLIENTS',
      categoryName: 'Sales & New Clients',
      defaultClassification: 'MAJOR',
      defaultResponsiblePhone: '919820100002', // Priya
      backupResponsiblePhone: '919820100001', // Arvind
      spendApprovalRequired: false,
      sopSystemPrompt:
        'Share BlueDrop office jar and dispenser rates with prospects, confirm weekly jar count and dispensers needed, and hand over to Deliveries and Billing.',
      defaultMicroSteps: [
        'Send BlueDrop monthly rate card and jar plan to the client',
        'Confirm weekly jar count, dispenser quantity, and start date',
        'Share confirmed office address and contact with Nitin and Kavita',
      ],
      requiredFacts: ['jars needed per week', 'office address', 'start date'],
    },
  ];

  const tasks: Task[] = [
    {
      taskCode: 'T-201',
      shortTag: 'Sunrise 40 Jars',
      agendaId: 'AG-201',
      wbsHeadId: 'HEAD-D1',
      swimlaneStage: 'Jar Delivery',
      title: 'Deliver 40 jars to Sunrise IT Park before 11 AM',
      categoryId: 'DELIVERIES',
      quadrant: 'Q1_DO_FIRST',
      majorOrMinor: 'MAJOR',
      taskFrequency: 'ONE_TIME',
      recurrenceRule: 'NONE',
      isFrozen: true,
      raci: {
        R: '919820100006', // Nitin Sharma
        A: '919820100003', // Rohan Kulkarni
        C: ['919820100003'],
        I: ['919820100001'],
      },
      status: 'IN_PROGRESS',
      completionPercent: 50,
      microSteps: [
        {
          id: 'ms-201-1',
          label: 'Load 40 filled 20L water jars onto morning vans',
          status: 'DONE',
          evidenceNote: '20 jars loaded in first trip; second trip queued.',
        },
        {
          id: 'ms-201-2',
          label: 'Deliver all 40 jars to Sunrise IT Park before 11 AM',
          status: 'PENDING',
        },
        {
          id: 'ms-201-3',
          label: 'Upload photo confirmation on WhatsApp',
          status: 'PENDING',
        },
      ],
      missingStepsAlert: '',
      dependency: {
        dependsOnTaskCode: null,
        triggerCondition: 'FULL_COMPLETION',
      },
      release: nowRelease(hoursAgo(3)),
      reminderConfig: {
        includeInDailyOverview: true,
        customIntervalHours: 2,
        lastNudgedAt: hoursAgo(1),
        nudgeCount: 1,
      },
      startDate: daysFromNowDate(0),
      durationDays: 1,
      dueDate: daysFromNowDate(0),
      dueTime: '11:00',
      isForcedDeadline: true,
      forcedDeadlineDate: daysFromNowDate(0),
      outboundWhatsappPreview:
        'Namaste Nitin bhai, Task [Sunrise 40 Jars]: Aaj 11 AM se pehle Sunrise IT Park mein 40 paani ke jars deliver karein aur photo update bhejein.',
      latestAiSummary:
        'First trip departed with 20 jars. Nitin sent a queued WhatsApp reply about the second trip — open WhatsApp Field Chat to evaluate it.',
      lastOutboundAt: hoursAgo(1.5),
      auditLogs: [
        {
          timestamp: hoursAgo(3),
          sender: 'SYSTEM_DISPATCH',
          rawInputSummary: 'Assigned urgent 40-jar morning delivery to Nitin Sharma.',
          aiDecision: 'Status -> PENDING',
        },
        {
          timestamp: hoursAgo(1.5),
          sender: 'Nitin Sharma (919820100006)',
          rawInputSummary: 'Started morning loading for Sunrise IT Park.',
          aiDecision: 'Status -> IN_PROGRESS',
        },
      ],
    },
    {
      taskCode: 'T-202',
      shortTag: 'Empty Jars & Slip',
      agendaId: 'AG-201',
      wbsHeadId: 'HEAD-D1',
      swimlaneStage: 'Empties & Receipt',
      title: 'Collect 40 empty jars and get the delivery receipt signed',
      categoryId: 'DELIVERIES',
      quadrant: 'Q1_DO_FIRST',
      majorOrMinor: 'MAJOR',
      taskFrequency: 'ONE_TIME',
      recurrenceRule: 'NONE',
      isFrozen: true,
      raci: {
        R: '919820100006', // Nitin Sharma
        A: '919820100003', // Rohan Kulkarni
        C: [],
        I: ['919820100007'], // Kavita Joshi needs signed slip for billing
      },
      status: 'LOCKED_BY_DEPENDENCY',
      completionPercent: 0,
      microSteps: [
        {
          id: 'ms-202-1',
          label: 'Collect 40 empty 20L jars from Sunrise IT Park store room',
          status: 'PENDING',
        },
        {
          id: 'ms-202-2',
          label: 'Get client stamp & signature on delivery slip',
          status: 'PENDING',
        },
        {
          id: 'ms-202-3',
          label: 'Send signed receipt photo on WhatsApp for Kavita billing',
          status: 'PENDING',
        },
      ],
      missingStepsAlert: '',
      dependency: {
        dependsOnTaskCode: 'T-201',
        triggerCondition: 'FULL_COMPLETION',
      },
      release: {
        mode: 'AFTER_TASK',
        releaseAt: null,
        afterTaskCode: 'T-201',
        afterTrigger: 'FULL_COMPLETION',
        delayMinutes: 0,
        requireOwnerConfirm: false,
        releasedAt: null,
        holdReason: 'Waiting for T-201 (Sunrise 40 Jars) delivery to finish',
      },
      reminderConfig: {
        includeInDailyOverview: true,
        customIntervalHours: 2,
        lastNudgedAt: null,
        nudgeCount: 0,
      },
      startDate: daysFromNowDate(0),
      durationDays: 1,
      dueDate: daysFromNowDate(0),
      isForcedDeadline: true,
      forcedDeadlineDate: daysFromNowDate(0),
      outboundWhatsappPreview:
        'Namaste Nitin bhai, Task [Empty Jars & Slip]: Sunrise IT Park se 40 khali jars wapas lein aur signed receipt ki photo WhatsApp par bhejein.',
      latestAiSummary:
        'Locked until [Sunrise 40 Jars] (T-201) completes. Releases automatically as soon as delivery finishes.',
      auditLogs: [
        {
          timestamp: hoursAgo(3),
          sender: 'SYSTEM_DEPENDENCY_GATE',
          rawInputSummary: 'Waiting on T-201 completion.',
          aiDecision: 'Status -> LOCKED_BY_DEPENDENCY',
        },
      ],
    },
    {
      taskCode: 'T-203',
      shortTag: 'Extra Van Hire',
      agendaId: 'AG-202',
      wbsHeadId: 'HEAD-D2',
      swimlaneStage: 'Owner Approval',
      title: "Rent an extra van for today's rush (₹2,500 over usual cost)",
      categoryId: 'DELIVERIES',
      quadrant: 'Q1_DO_FIRST',
      majorOrMinor: 'MINOR',
      taskFrequency: 'ONE_TIME',
      recurrenceRule: 'NONE',
      isFrozen: true,
      raci: {
        R: '919820100003', // Rohan Kulkarni
        A: '919820100001', // Arvind Deshmukh
        C: ['919820100007'], // Kavita Joshi
        I: ['919820100006'],
      },
      status: 'AWAITING_BOSS_DECISION',
      completionPercent: 35,
      microSteps: [
        {
          id: 'ms-203-1',
          label: 'Confirm local backup tempo van availability for afternoon deliveries',
          status: 'DONE',
          evidenceNote: 'Tempo driver confirmed availability for ₹2,500 extra.',
        },
        {
          id: 'ms-203-2',
          label: 'Get Arvind approval for ₹2,500 extra van cost',
          status: 'PENDING',
        },
        {
          id: 'ms-203-3',
          label: 'Dispatch backup van and share driver bill with Kavita',
          status: 'PENDING',
        },
      ],
      missingStepsAlert: 'Extra van rental costs ₹2,500 above normal daily transport budget.',
      dependency: {
        dependsOnTaskCode: null,
        triggerCondition: 'FULL_COMPLETION',
      },
      release: nowRelease(hoursAgo(2.5)),
      reminderConfig: {
        includeInDailyOverview: false,
        customIntervalHours: null,
        lastNudgedAt: null,
        nudgeCount: 0,
      },
      startDate: daysFromNowDate(0),
      durationDays: 1,
      dueDate: daysFromNowDate(0),
      isForcedDeadline: false,
      forcedDeadlineDate: null,
      outboundWhatsappPreview:
        'Namaste Rohan ji, Task [Extra Van Hire]: Extra van booking ke ₹2,500 approval ke liye Arvind ji ko bhej diya hai.',
      latestAiSummary:
        'Waiting in Boss Reviews for Arvind approval on renting an extra van (₹2,500 over usual cost).',
      auditLogs: [
        {
          timestamp: hoursAgo(1.5),
          sender: 'Rohan Kulkarni (919820100003)',
          rawInputSummary: 'Asked to hire a backup tempo van for ₹2,500 due to heavy afternoon rush.',
          aiDecision: 'Created Boss Review REV-201. Status -> AWAITING_BOSS_DECISION.',
        },
      ],
      pausedIntervals: [{ pausedAt: hoursAgo(1.5) }],
    },
    {
      taskCode: 'T-204',
      shortTag: 'Monthly Client Bills',
      agendaId: 'AG-202',
      wbsHeadId: 'HEAD-D2',
      swimlaneStage: 'Monthly Billing',
      title: 'Send monthly bills to all office clients',
      categoryId: 'BILLING_PAYMENTS',
      quadrant: 'Q2_SCHEDULE',
      majorOrMinor: 'MAJOR',
      taskFrequency: 'ONE_TIME',
      recurrenceRule: 'NONE',
      isFrozen: true,
      raci: {
        R: '919820100007', // Kavita Joshi
        A: '919820100002', // Priya Nair
        C: [],
        I: ['919820100001'],
      },
      status: 'SCHEDULED',
      completionPercent: 0,
      microSteps: [
        {
          id: 'ms-204-1',
          label: 'Count signed jar delivery slips for every office client',
          status: 'PENDING',
        },
        {
          id: 'ms-204-2',
          label: 'Send monthly bills on WhatsApp and email',
          status: 'PENDING',
        },
      ],
      missingStepsAlert: '',
      dependency: {
        dependsOnTaskCode: null,
        triggerCondition: 'FULL_COMPLETION',
      },
      release: {
        mode: 'AT_TIME',
        // Set slightly in the past so clicking "Run Scheduler Tick" immediately releases it
        releaseAt: hoursAgo(0.25),
        afterTaskCode: null,
        afterTrigger: 'FULL_COMPLETION',
        delayMinutes: 0,
        requireOwnerConfirm: false,
        releasedAt: null,
        holdReason: 'Scheduled: ready to send on next scheduler tick',
      },
      reminderConfig: {
        includeInDailyOverview: true,
        customIntervalHours: 4,
        lastNudgedAt: null,
        nudgeCount: 0,
      },
      startDate: daysFromNowDate(0),
      durationDays: 1,
      dueDate: daysFromNowDate(1),
      isForcedDeadline: false,
      forcedDeadlineDate: null,
      outboundWhatsappPreview:
        'Hello Kavita, Task [Monthly Client Bills]: Please match signed delivery slips and send monthly bills to all office clients.',
      latestAiSummary:
        'Scheduled to go out now. Click "Run Scheduler Tick" in Live Operations to release this task to Kavita.',
      auditLogs: [
        {
          timestamp: hoursAgo(4),
          sender: 'SYSTEM_SCHEDULER',
          rawInputSummary: 'Queued monthly client billing task.',
          aiDecision: 'Status -> SCHEDULED',
        },
      ],
    },
    {
      taskCode: 'T-205',
      shortTag: 'Morning Water Check',
      agendaId: null,
      wbsHeadId: null,
      swimlaneStage: 'Daily Quality',
      title: 'Morning water-quality test before vans leave',
      categoryId: 'QUALITY_SERVICE',
      quadrant: 'Q1_DO_FIRST',
      majorOrMinor: 'MAJOR',
      taskFrequency: 'RECURRING',
      recurrenceRule: 'DAILY',
      isFrozen: true,
      raci: {
        R: '919820100005', // Deepak Verma
        A: '919820100003', // Rohan Kulkarni
        C: ['919820100006'],
        I: [],
      },
      status: 'PENDING',
      completionPercent: 0,
      microSteps: [
        {
          id: 'ms-205-1',
          label: 'Test TDS and taste on morning filled jar batch',
          status: 'PENDING',
        },
        {
          id: 'ms-205-2',
          label: 'Confirm water is clear to load onto delivery vans',
          status: 'PENDING',
        },
      ],
      missingStepsAlert: '',
      dependency: {
        dependsOnTaskCode: null,
        triggerCondition: 'FULL_COMPLETION',
      },
      release: nowRelease(hoursAgo(2)),
      reminderConfig: {
        includeInDailyOverview: true,
        customIntervalHours: 4,
        lastNudgedAt: null,
        nudgeCount: 0,
      },
      startDate: daysFromNowDate(0),
      durationDays: 1,
      dueDate: daysFromNowDate(0),
      isForcedDeadline: true,
      forcedDeadlineDate: daysFromNowDate(0),
      outboundWhatsappPreview:
        'Namaste Deepak ji, Daily Task [Morning Water Check]: Vans nikalne se pehle subah ka water-quality test karke OK photo bhejein.',
      latestAiSummary: 'Daily morning water check assigned to Deepak before vans depart.',
      lastOutboundAt: hoursAgo(2),
      auditLogs: [
        {
          timestamp: hoursAgo(2),
          sender: 'DAILY_SHIFT_CRON',
          rawInputSummary: 'Dispatched daily morning check.',
          aiDecision: 'Status -> PENDING',
        },
      ],
    },
    {
      taskCode: 'T-206',
      shortTag: 'Restock 200 Caps',
      agendaId: null,
      wbsHeadId: null,
      swimlaneStage: 'Warehouse Stock',
      title: 'Restock 200 new jar caps',
      categoryId: 'PURCHASE_STOCK',
      quadrant: 'Q3_DELEGATE',
      majorOrMinor: 'MINOR',
      taskFrequency: 'ONE_TIME',
      recurrenceRule: 'NONE',
      isFrozen: true,
      raci: {
        R: '919820100004', // Suresh Yadav
        A: '919820100003', // Rohan Kulkarni
        C: [],
        I: ['919820100007'],
      },
      status: 'COMPLETED',
      completionPercent: 100,
      microSteps: [
        {
          id: 'ms-206-1',
          label: 'Buy 200 sealed blue jar caps from approved vendor',
          status: 'DONE',
          evidenceNote: '200 caps picked up.',
        },
        {
          id: 'ms-206-2',
          label: 'Count and stack caps in warehouse shelf',
          status: 'DONE',
          evidenceNote: 'Stored in packaging shelf.',
        },
        {
          id: 'ms-206-3',
          label: 'Send purchase bill photo on WhatsApp',
          status: 'DONE',
          evidenceNote: 'Bill photo verified.',
        },
      ],
      missingStepsAlert: '',
      dependency: {
        dependsOnTaskCode: null,
        triggerCondition: 'FULL_COMPLETION',
      },
      release: nowRelease(hoursAgo(24)),
      reminderConfig: {
        includeInDailyOverview: false,
        customIntervalHours: null,
        lastNudgedAt: null,
        nudgeCount: 0,
      },
      startDate: daysFromNowDate(-1),
      durationDays: 1,
      dueDate: daysFromNowDate(-1),
      isForcedDeadline: false,
      forcedDeadlineDate: null,
      outboundWhatsappPreview:
        'Namaste Suresh ji, Task [Restock 200 Caps]: Store ke liye 200 naye jar caps le aayein aur bill photo bhejein.',
      latestAiSummary: 'Completed 100%: 200 new jar caps stocked and vendor bill verified.',
      auditLogs: [
        {
          timestamp: hoursAgo(18),
          sender: 'Suresh Yadav (919820100004)',
          rawInputSummary: 'Bought 200 jar caps, kept in store, bill photo attached.',
          mediaInspected: 'Image: Jar_Caps_Bill.jpg',
          aiDecision: 'All 3 steps DONE. Status -> COMPLETED (100%).',
        },
      ],
    },
    {
      taskCode: 'T-207',
      shortTag: 'Metro Hospital Call',
      agendaId: null,
      wbsHeadId: null,
      swimlaneStage: 'New Contract',
      title: 'Call Metro Hospital about a monthly water contract',
      categoryId: 'SALES_CLIENTS',
      quadrant: 'Q1_DO_FIRST',
      majorOrMinor: 'MAJOR',
      taskFrequency: 'ONE_TIME',
      recurrenceRule: 'NONE',
      isFrozen: true,
      raci: {
        R: '919820100001', // Arvind Deshmukh (OWNER -> populates "Do" in My tasks)
        A: '919820100001',
        C: ['919820100002'],
        I: [],
      },
      status: 'PENDING',
      completionPercent: 0,
      microSteps: [
        {
          id: 'ms-207-1',
          label: 'Call Metro Hospital purchase manager about daily jar needs',
          status: 'PENDING',
        },
        {
          id: 'ms-207-2',
          label: 'Share monthly contract quote with Priya for follow-up',
          status: 'PENDING',
        },
      ],
      missingStepsAlert: '',
      dependency: {
        dependsOnTaskCode: null,
        triggerCondition: 'FULL_COMPLETION',
      },
      release: nowRelease(hoursAgo(4)),
      reminderConfig: {
        includeInDailyOverview: false,
        customIntervalHours: null,
        lastNudgedAt: null,
        nudgeCount: 0,
      },
      startDate: daysFromNowDate(0),
      durationDays: 1,
      dueDate: daysFromNowDate(0),
      isForcedDeadline: true,
      forcedDeadlineDate: daysFromNowDate(0),
      outboundWhatsappPreview:
        'Owner Task [Metro Hospital Call]: Call Metro Hospital admin team to discuss a monthly 20L water jar contract.',
      latestAiSummary: 'Waiting for Arvind to call Metro Hospital today.',
      auditLogs: [
        {
          timestamp: hoursAgo(4),
          sender: 'SYSTEM_DISPATCH',
          rawInputSummary: 'Added owner follow-up call for Metro Hospital.',
          aiDecision: 'Status -> PENDING',
        },
      ],
    },
  ];

  // Pre-compute non-overlapping hierarchical coordinates for the Team org chart canvas
  const arrangedPositions = autoArrangeOrgPositions(
    Object.values(rawMembers),
    category_sops,
    tasks,
    daysFromNowDate(0)
  );
  const team_members: Record<string, TeamMember> = Object.fromEntries(
    Object.entries(rawMembers).map(([phone, member]) => [
      phone,
      {
        ...member,
        orgChartPosition: arrangedPositions[phone] || null,
      },
    ])
  );

  const seededTasks = enrichSeedTaskSteps(tasks);

  return {
    tenantId: DEFAULT_TENANT_ID,
    principal_prompts: {
      planningPrompt: `You are reflexion.ai Meditate Engine for BlueDrop Water Supplies — delivering 20-litre drinking-water jars and water dispensers to offices in Pune.
Given the owner's instruction, team roster with reporting lines, workloads, strengths, and 5 SOP playbooks:
1. INTENT & RELEVANCE GATE: If the input is a greeting, test message, or question, answer naturally in chatReplyToBoss with draftedTasks = [].
2. CLARIFICATION GATE: If a request misses crucial details (which client office, jar count, or service needed), ask one clear question with draftedTasks = [].
3. PROPORTIONAL TASK SPLITTING:
   - Single-person job (e.g. a dispenser leak repair or single follow-up call) -> create EXACTLY 1 Quick Task assigned to the right person (e.g. Deepak for dispenser fixes).
   - Multi-step workflow across people (Sales rate card -> First delivery -> Monthly billing) -> split into connected dependent tasks across stages.
   - Multi-team event or large order needing separate tracks (extra jars + extra dispensers + cleaning visit) -> split cleanly into parallel workstreams.
4. Use plain everyday language, assign Eisenhower Quadrant and MAJOR/MINOR, and never reveal private weaknesses in staff messages.`,
      evaluationPrompt: `You are reflexion.ai WhatsApp Inspector for BlueDrop Water Supplies.
Inspect the teammate's WhatsApp messages, voice notes, and photos:
1. CHRONOLOGICAL OVERRIDE: Latest message in the batch is ground truth.
2. Check SOP steps: signed delivery receipt photos, empty jars collected, water check pass, or dispenser repair confirmation. Mark skipped steps as MISSED.
3. Escalate to Boss Review Queue whenever extra money or an unapproved spend above ₹2,000 is requested.
4. Reply naturally in friendly Hinglish or clear English matching the teammate's preference.`,
    },

    business_profile: {
      businessName: 'BlueDrop Water Supplies',
      businessType: 'Office 20L Drinking-Water Jars & Dispenser Delivery',
      businessDescription:
        'BlueDrop delivers 20-litre drinking-water jars and water dispensers to offices across Pune. Daily work covers taking orders, delivering jars, collecting empty jars, fixing dispensers, buying stock, and monthly billing.',
      workLocations: 'Pune Warehouse, Sunrise IT Park, Greenleaf Office, Metro Hospital, Office Delivery Routes',
      defaultStaffLanguage: 'HINGLISH',
      hardRules:
        'Every delivery needs a signed receipt photo. Collect empty jars on every delivery. Spends above ₹2,000 need Arvind approval.',
      timezone: 'Asia/Kolkata',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      batchNonUrgentIntoDigest: false,
      enforceWhatsapp24hWindow: true,
      whatsappTemplateText:
        'BlueDrop Update for {{name}} regarding [{{shortTag}}] ({{title}}) — Due: {{dueDate}}.\n{{body}}\nReply to re-open your 24-hour WhatsApp chat.',
    },

    owner_profile: {
      personalOperatingPrompt:
        'I focus on big office contracts and approve extra spends above ₹2,000. Delegate jar deliveries to Nitin, stock purchases to Suresh, water quality and dispenser repairs to Deepak, client onboarding to Priya, and monthly billing to Kavita under Rohan supervision.',
      defaultAccountablePhone: '919820100003',
      alwaysDelegatesCategories: ['DELIVERIES', 'PURCHASE_STOCK', 'QUALITY_SERVICE'],
      keepsCategories: [],
      followUpStuckHours: 24,
    },

    task_splitting_rules: {
      maxChecklistStepsPerTask: 5,
      defaultMaxActiveTasksPerPerson: 4,
      taskSplittingRule:
        'Keep single-person work (like fixing one leaking dispenser) as 1 Quick Task with up to 5 clear steps. Split into connected stages when work passes from one teammate to another (e.g. Sales -> Delivery -> Billing) or separate parallel tracks when multiple teams prepare different items for an event.',
    },

    sample_brain_dumps: [
      {
        id: 'demo-dump-1',
        text: 'The water dispenser at Greenleaf Office is leaking. Send someone to fix it today.',
        splitType: 'QUICK_TASK',
        aiInstruction:
          'Single-person repair job -> Create 1 Quick Task assigned to Deepak Verma (Quality & Service) under QUALITY_SERVICE.',
      },
      {
        id: 'demo-dump-2',
        text: 'Sign up Metro Hospital as a new client: send our rate card, confirm their first order, make the first delivery, and set up monthly billing.',
        splitType: 'PROJECT_SWIMLANES',
        aiInstruction:
          'Step-by-step workflow -> Split into sequential dependent tasks led by Priya Nair (rate card & order confirmation) -> Nitin Sharma (first delivery) -> Kavita Joshi (monthly billing).',
      },
      {
        id: 'demo-dump-3',
        text: 'Sunrise IT Park has a big conference next week. They need 100 extra jars, 5 more dispensers, and a cleaning visit before the event.',
        splitType: 'PROJECT_SWIMLANES',
        aiInstruction:
          'Parallel workstreams -> Split into distinct parallel project heads/tracks across stock/dispensers (Suresh), cleaning visit (Deepak), and extra jar delivery (Nitin).',
      },
    ],

    team_members,
    category_sops,

    umbrella_agendas: [
      {
        agendaId: 'AG-201',
        title: 'Sunrise IT Park Morning 40-Jar Delivery & Empties Pickup',
        rawBrainDump:
          'Deliver 40 jars to Sunrise IT Park before 11 AM, then collect 40 empty jars and get the receipt signed.',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        status: 'ACTIVE',
        createdAt: hoursAgo(3),
      },
      {
        agendaId: 'AG-202',
        title: 'Rush Van Hire & Monthly Office Billing',
        rawBrainDump:
          'Rohan needs approval to rent an extra van for ₹2,500 over usual cost, and Kavita needs to send monthly bills to all office clients.',
        quadrant: 'Q2_SCHEDULE',
        majorOrMinor: 'MAJOR',
        status: 'ACTIVE',
        createdAt: hoursAgo(4),
      },
    ],

    wbs_heads: [
      {
        headId: 'HEAD-D1',
        title: 'Sunrise IT Park 40-Jar Delivery & Empty Return',
        domainCategory: 'DELIVERIES',
        contextSummary:
          'Deliver 40 full 20L water jars before 11 AM, then collect 40 empty jars with a signed delivery receipt.',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        tentativeDurationDays: 1,
        tentativeStartDate: daysFromNowDate(0),
        tentativeDeadline: daysFromNowDate(0),
        isForcedDeadline: true,
        dynamicStages: ['Jar Delivery', 'Empties & Receipt'],
        involvedPhones: ['919820100006', '919820100003', '919820100007'],
        status: 'FROZEN_DISPATCHED',
        subTasks: [
          {
            tempId: 'draft-d1-1',
            title: 'Deliver 40 jars to Sunrise IT Park before 11 AM',
            shortTag: 'Sunrise 40 Jars',
            categoryId: 'DELIVERIES',
            quadrant: 'Q1_DO_FIRST',
            majorOrMinor: 'MAJOR',
            taskFrequency: 'ONE_TIME',
            recurrenceRule: 'NONE',
            raci: {
              R: '919820100006',
              A: '919820100003',
              C: ['919820100003'],
              I: ['919820100001'],
            },
            dependsOnTempIdOrTaskCode: null,
            triggerCondition: 'FULL_COMPLETION',
            startDate: daysFromNowDate(0),
            durationDays: 0.5,
            dueDate: daysFromNowDate(0),
            dueTime: '11:00',
            isForcedDeadline: true,
            forcedDeadlineDate: daysFromNowDate(0),
            wbsHeadId: 'HEAD-D1',
            swimlaneStage: 'Jar Delivery',
            microSteps: [
              'Load 40 filled 20L water jars onto morning vans',
              'Deliver all 40 jars to Sunrise IT Park before 11 AM',
              'Upload photo confirmation on WhatsApp',
            ],
            outboundWhatsappPreview:
              'Namaste Nitin bhai, Task [Sunrise 40 Jars]: Aaj 11 AM se pehle Sunrise IT Park mein 40 jars deliver karein aur photo bhejein.',
          },
          {
            tempId: 'draft-d1-2',
            title: 'Collect 40 empty jars and get the delivery receipt signed',
            shortTag: 'Empty Jars & Slip',
            categoryId: 'DELIVERIES',
            quadrant: 'Q1_DO_FIRST',
            majorOrMinor: 'MAJOR',
            taskFrequency: 'ONE_TIME',
            recurrenceRule: 'NONE',
            raci: {
              R: '919820100006',
              A: '919820100003',
              C: [],
              I: ['919820100007'],
            },
            dependsOnTempIdOrTaskCode: 'draft-d1-1',
            triggerCondition: 'FULL_COMPLETION',
            startDate: daysFromNowDate(0),
            durationDays: 0.5,
            dueDate: daysFromNowDate(0),
            isForcedDeadline: true,
            forcedDeadlineDate: daysFromNowDate(0),
            wbsHeadId: 'HEAD-D1',
            swimlaneStage: 'Empties & Receipt',
            microSteps: [
              'Collect 40 empty 20L jars from Sunrise IT Park store room',
              'Get client stamp & signature on delivery slip',
              'Send signed receipt photo on WhatsApp for Kavita billing',
            ],
            outboundWhatsappPreview:
              'Namaste Nitin bhai, Task [Empty Jars & Slip]: 40 khali jars lein aur signed receipt photo WhatsApp par bhejein.',
          },
        ],
      },
      {
        headId: 'HEAD-D2',
        title: 'Extra Van Rental & Monthly Client Billing',
        domainCategory: 'BILLING_PAYMENTS',
        contextSummary:
          'Approve ₹2,500 extra van hire for today rush and release monthly client billing.',
        quadrant: 'Q2_SCHEDULE',
        majorOrMinor: 'MAJOR',
        tentativeDurationDays: 1,
        tentativeStartDate: daysFromNowDate(0),
        tentativeDeadline: daysFromNowDate(1),
        isForcedDeadline: false,
        dynamicStages: ['Owner Approval', 'Monthly Billing'],
        involvedPhones: ['919820100003', '919820100007', '919820100001'],
        status: 'FROZEN_DISPATCHED',
        subTasks: [
          {
            tempId: 'draft-d2-1',
            title: "Rent an extra van for today's rush (₹2,500 over usual cost)",
            shortTag: 'Extra Van Hire',
            categoryId: 'DELIVERIES',
            quadrant: 'Q1_DO_FIRST',
            majorOrMinor: 'MINOR',
            taskFrequency: 'ONE_TIME',
            recurrenceRule: 'NONE',
            raci: {
              R: '919820100003',
              A: '919820100001',
              C: ['919820100007'],
              I: ['919820100006'],
            },
            dependsOnTempIdOrTaskCode: null,
            triggerCondition: 'FULL_COMPLETION',
            startDate: daysFromNowDate(0),
            durationDays: 1,
            dueDate: daysFromNowDate(0),
            isForcedDeadline: false,
            forcedDeadlineDate: null,
            wbsHeadId: 'HEAD-D2',
            swimlaneStage: 'Owner Approval',
            microSteps: [
              'Confirm local backup tempo van availability',
              'Get Arvind approval for ₹2,500 extra van cost',
              'Dispatch backup van and share driver bill with Kavita',
            ],
            outboundWhatsappPreview:
              'Namaste Rohan ji, Task [Extra Van Hire]: Extra van ka ₹2,500 kharch Arvind ji ke approval ke liye bhej diya hai.',
          },
        ],
      },
    ],

    tasks: seededTasks,

    boss_review_queue: [
      {
        reviewId: 'REV-201',
        taskCode: 'T-203',
        employeePhone: '919820100003',
        reviewType: 'BUDGET_APPROVAL',
        employeeMessageSummary:
          "Rohan asks to approve ₹2,500 above usual van cost to rent an extra delivery van for today's afternoon office rush.",
        mediaVerificationNote:
          'Local tempo quote verified: ₹2,500 above standard route cost for extra afternoon trips across Pune.',
        aiSuggestedReplies: [
          'Approved — book the extra van for ₹2,500 and share the driver bill with Kavita.',
          'Hold the extra van; shift non-urgent drops to tomorrow morning first trip.',
          'Approved up to ₹2,000 max — negotiate with the van owner and confirm.',
        ],
        status: 'OPEN',
        createdAt: hoursAgo(1.5),
      },
    ],

    // Pre-queued inbound WhatsApp buffer from Nitin so guests can run AI evaluation right away
    inbound_message_buffer: {
      '919820100006': {
        tenantId: DEFAULT_TENANT_ID,
        employeePhone: '919820100006',
        bufferMode: 'STANDARD_15_MIN',
        firstMessageAt: hoursAgo(0.1),
        processAt: new Date(nowMs + 15 * 60_000).toISOString(),
        messages: [
          {
            id: 'buf-demo-1',
            timestamp: hoursAgo(0.1),
            type: 'text',
            textContent: 'Van left, 20 jars loaded, remaining 20 in second trip.',
          },
        ],
      },
    },

    system_memory: [
      {
        tenantId: DEFAULT_TENANT_ID,
        memoryId: 'MEM-D1',
        category: 'BUSINESS_RULE',
        fact: 'Every delivery needs a signed receipt photo.',
        active: true,
        approved: true,
      },
      {
        tenantId: DEFAULT_TENANT_ID,
        memoryId: 'MEM-D2',
        category: 'BUSINESS_RULE',
        fact: "Spends above ₹2,000 need Arvind's approval.",
        active: true,
        approved: true,
      },
      {
        tenantId: DEFAULT_TENANT_ID,
        memoryId: 'MEM-D3',
        category: 'BUSINESS_RULE',
        fact: 'Collect empty jars on every delivery.',
        active: true,
        approved: true,
      },
      {
        tenantId: DEFAULT_TENANT_ID,
        memoryId: 'MEM-D4',
        category: 'STAFF_TRAIT',
        fact: 'Deepak checks morning water quality and handles office dispenser repairs; Nitin leads jar delivery vans.',
        active: true,
        approved: true,
      },
      {
        tenantId: DEFAULT_TENANT_ID,
        memoryId: 'MEM-D5',
        category: 'SOP_PREFERENCE',
        fact: 'Delivery, purchase, and service teams prefer friendly Hinglish; Sales and Accounts prefer clear English.',
        active: true,
        approved: true,
      },
    ],

    notes: [
      {
        tenantId: DEFAULT_TENANT_ID,
        noteId: 'NOTE-D1',
        text: 'Greenleaf Office mentioned one reception water dispenser has a slow tap leak — check with Deepak today.',
        createdAt: hoursAgo(5),
      },
    ],

    whatsapp_messages: [
      {
        id: 'wa-demo-1',
        employeePhone: '919820100006',
        direction: 'OUTBOUND',
        timestamp: hoursAgo(3),
        tag: 'TASK_DISPATCH',
        taskCode: 'T-201',
        text: 'Namaste Nitin bhai, Task [Sunrise 40 Jars]: Aaj 11 AM se pehle Sunrise IT Park mein 40 paani ke jars deliver karein.\nSteps:\n1. 40 filled 20L jars van mein load karein\n2. 11 AM se pehle deliver karein\n3. Photo update bhejein.',
      },
      {
        id: 'wa-demo-2',
        employeePhone: '919820100003',
        direction: 'INBOUND',
        timestamp: hoursAgo(1.5),
        taskCode: 'T-203',
        text: 'Arvind, aaj dopahar ka load zyada hai — extra tempo van ₹2,500 mein mil rahi hai. Book kar lein kya?',
      },
      {
        id: 'wa-demo-3',
        employeePhone: '919820100003',
        direction: 'OUTBOUND',
        timestamp: hoursAgo(1.48),
        tag: 'BOSS_ESCALATION_HOLD',
        taskCode: 'T-203',
        text: 'Rohan ji, ₹2,500 extra van kharch ₹2,000 limit se zyada hai — Arvind ji ke Boss Review mein bhej diya hai.',
      },
      {
        id: 'wa-demo-4',
        employeePhone: '919820100005',
        direction: 'OUTBOUND',
        timestamp: hoursAgo(2),
        tag: 'DAILY_DIGEST',
        taskCode: 'T-205',
        text: 'Namaste Deepak ji, Aaj ka Daily Task:\n• [Morning Water Check] Vans nikalne se pehle subah ka water-quality test karke OK photo bhejein.',
      },
      {
        id: 'wa-demo-5',
        employeePhone: '919820100004',
        direction: 'INBOUND',
        timestamp: hoursAgo(18.1),
        taskCode: 'T-206',
        mediaLabel: 'Photo: Jar_Caps_Bill.jpg',
        text: 'Sir, 200 naye jar caps store mein rakh diye hain aur bill photo bhej raha hoon.',
      },
      {
        id: 'wa-demo-6',
        employeePhone: '919820100004',
        direction: 'OUTBOUND',
        timestamp: hoursAgo(18),
        tag: 'AI_COMPLETION',
        taskCode: 'T-206',
        text: 'Bahut badhiya Suresh ji! [Restock 200 Caps] complete mark ho gaya hai.',
      },
    ],

    model_tuning: {
      modelDefaultsVersion: MODEL_DEFAULTS_VERSION,
      meditateEngine: 'v2',
      meditateEngineUserSet: false,
      intentConfidenceThreshold: 0.75,
      maxRecentConversationTurns: 8,
      meditate: defaultStageConfig('meditate'),
      intent: defaultStageConfig('intent'),
      planner: defaultStageConfig('planner'),
      bufferEvaluation: defaultStageConfig('bufferEvaluation'),
      message: defaultStageConfig('message'),
    },

    ai_logs: [
      {
        tenantId: DEFAULT_TENANT_ID,
        logId: 'AI-DEMO-1',
        timestamp: hoursAgo(1.5),
        stage: 'BUFFER_EVALUATION',
        model: defaultStageConfig('bufferEvaluation').model,
        temperature: defaultStageConfig('bufferEvaluation').temperature,
        maxOutputTokens: defaultStageConfig('bufferEvaluation').maxOutputTokens,
        promptVersion: 'v3.0.0-slot-identity',
        latencyMs: 840,
        validationStatus: 'VALID',
        validationNote: 'Detected ₹2,500 extra van cost above limit; created Boss Review REV-201.',
      },
      {
        tenantId: DEFAULT_TENANT_ID,
        logId: 'AI-DEMO-2',
        timestamp: hoursAgo(18),
        stage: 'BUFFER_EVALUATION',
        model: defaultStageConfig('bufferEvaluation').model,
        temperature: defaultStageConfig('bufferEvaluation').temperature,
        maxOutputTokens: defaultStageConfig('bufferEvaluation').maxOutputTokens,
        promptVersion: 'v3.0.0-slot-identity',
        latencyMs: 790,
        validationStatus: 'VALID',
        validationNote: 'Verified Suresh 200 jar caps bill photo; marked T-206 COMPLETED (100%).',
      },
    ],
  };
}
