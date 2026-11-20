import type { OpsDatabaseState } from '../types/ops.ts';
import { defaultStageConfig, MODEL_DEFAULTS_VERSION } from './modelConfig.ts';

export function createInitialSeedState(nowIso: string = new Date().toISOString()): OpsDatabaseState {
  const nowMs = new Date(nowIso).getTime();
  const hoursAgo = (h: number) => new Date(nowMs - h * 3600 * 1000).toISOString();
  const daysFromNowDate = (d: number) => {
    const dt = new Date(nowMs + d * 24 * 3600 * 1000);
    return dt.toISOString().slice(0, 10);
  };

  return {
    tenantId: 'default',
    principal_prompts: {
      planningPrompt: `You are OpsCommand AI Meditate Engine — an elite operations, RACI and Eisenhower planning strategist.
Given the Boss's brain-dump, team roster with workloads and personal persona prompts, and active SOP playbooks:
1. INTENT & RELEVANCE GATE: First evaluate if the input is a mic test, greeting, or meta-question (e.g. "Check the validity of the voice system", "Testing mic", "Hello"). If so, set intentClassification = 'CASUAL_OR_TEST', return draftedTasks = [] (ZERO tasks), and reply naturally in chatReplyToBoss. Never hallucinate physical workflows from software tests.
2. CLARIFICATION GATE: If the operational request lacks essential context (location, equipment, or person), set intentClassification = 'NEEDS_CLARIFICATION', return draftedTasks = [], and ask a direct clarifying question in chatReplyToBoss.
3. PROPORTIONAL TASK GENERATION (NO BLOAT): Only populate draftedTasks when intentClassification = 'ACTIONABLE_AGENDA'. For a simple 1-person task (e.g. "Ask Balbir to clean the lawn gutter"), create EXACTLY 1 task. Only split into sequential sub-tasks (Procurement -> Installation -> Accounts) when multiple people or handovers are genuinely required.
4. Assign each task to an Eisenhower Quadrant (Q1_DO_FIRST, Q2_SCHEDULE, Q3_DELEGATE, Q4_LOW) and classification (MAJOR or MINOR).
5. Assign RACI owners strictly using anonymized slot IDs (P1, P2, P3...) from the roster, respecting on-leave status, skills, capacity, and work shifts.
6. Draft localized outbound WhatsApp previews tailored to each slot's preferred language and persona prompt.`,
      evaluationPrompt: `You are OpsCommand AI Multimodal WhatsApp Batch Inspector.
Inspect the employee's chronological buffered WhatsApp messages, voice notes, photos, and short videos:
1. CHRONOLOGICAL OVERRIDE: If a later timestamped message in the batch clarifies, corrects, or retracts an earlier statement, the LATEST timestamp is ground truth.
2. Check required SOP micro-steps. If an employee claims completion or handover but skips an essential step (e.g. missing pucca GST bill photo), mark that step MISSED and alert the team.
3. Automatically escalate to Boss Review Queue for:
   - Budget variances or extra funds requests
   - Design, brand, or material choices
   - Partial handover gates where physical work was handed over without final paperwork
   - Urgent site blockers
4. Draft WhatsApp replies strictly in natural Hinglish or English, incorporating the employee's personal persona prompt for tone and style.`
    },

    business_profile: {
      businessName: 'Heritage Lawn & Hospitality Operations',
      businessType: 'Hospitality, Events & Facility Management',
      businessDescription:
        'We operate a multi-zone hospitality & event property with daily maintenance, vendor purchasing, site installations, and accounting workflows coordinated over WhatsApp.',
      workLocations: 'Main Lawn, Banquet Hall, Plant Room, Guest Rooms, Electrical Yard, Local Market',
      defaultStaffLanguage: 'HINGLISH',
      hardRules:
        'Every market purchase requires a proper tax invoice photo before vendor payment is released. Outdoor electrical work requires waterproof industrial sockets and supervisor sign-off.',
      timezone: 'Asia/Kolkata',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      batchNonUrgentIntoDigest: false,
      enforceWhatsapp24hWindow: true,
      whatsappTemplateText:
        '📋 [Approved Template] Hello {{name}}, operational update regarding [{{shortTag}}] ({{title}}) — Due: {{dueDate}}.\n{{body}}\nReply to this message to re-open your 24-hour WhatsApp session.',
    },

    owner_profile: {
      personalOperatingPrompt:
        'I focus on high-level approvals, vendor negotiations above budget, and final event sign-offs. Always delegate ground purchasing, installation, and routine repairs to the right specialist on the roster. Ask for my approval in the Boss Review Queue whenever there is a budget increase, design choice, or partial handover without paperwork.',
      defaultAccountablePhone: '919876500003',
    },

    task_splitting_rules: {
      maxChecklistStepsPerTask: 5,
      defaultMaxActiveTasksPerPerson: 3,
      taskSplittingRule:
        'If one person can complete the work continuously without waiting on another teammate or external approval gate, keep it as 1 Quick Task with up to 5 checklist steps. Only split into multiple tasks or multiple project swimlanes when work changes hands between different people/teams (e.g., Purchasing -> Installation -> Accounts) or hits a hard gate (delivery, inspection, or payment sign-off).',
    },

    sample_brain_dumps: [
      {
        id: 'sample-1',
        text: 'Ask Balbir to inspect and clean the main lawn drainage gutter before lunch and send a photo.',
        splitType: 'QUICK_TASK',
        aiInstruction: 'Single person continuous job -> Create 1 Quick Task for Balbir with 2-3 checklist steps.',
      },
      {
        id: 'sample-2',
        text: 'Tomorrow evening we have a 250-guest Lawn reception. Need 6 warm-white 100W floodlights and 40m heavy rubber cable bought from the market with proper bill, handed over to Vikram, and mounted along the walkway by Balbir before 4 PM.',
        splitType: 'PROJECT_SWIMLANES',
        aiInstruction: 'Multi-person handover (Procurement -> Site Installation -> Accounts) -> Split into sequential dependent tasks across stages.',
      },
      {
        id: 'sample-3',
        text: 'We have a water hardness problem causing flushes, showerheads, and taps to clog. Team 1 under Mohan Ram will descale all room sanitary fixtures, and Team 2 under Balbir & Vikram will overhaul the backend water softener membrane.',
        splitType: 'PROJECT_SWIMLANES',
        aiInstruction: 'Two parallel workstreams -> Create 2 distinct WBS Heads (HEAD-A for Fixture Descaling, HEAD-B for Softener Overhaul).',
      },
    ],

    team_members: {
      '919876500000': {
        phone: '919876500000',
        slotId: 'P1',
        name: 'Rajesh Sharma',
        roleTitle: 'Operations Director (Owner)',
        authorityLevel: 'OWNER',
        skills: ['Executive Approvals', 'Strategy', 'Budget Sign-Off'],
        maxActiveTasks: 5,
        preferredLanguage: 'ENGLISH',
        workShiftStart: '09:00',
        workShiftEnd: '20:00',
        dailyOverviewTime: '09:00',
        isOnLeave: false,
        lastInboundAt: hoursAgo(1),
        bufferMode: 'STANDARD_15_MIN',
        stats: {
          assigned: 1,
          completed: 1,
          partial: 0,
          overdueCount: 0,
          totalWorkHoursReplyMins: 12,
          replyCount: 2,
        },
        personaPrompt: 'Direct, crisp English. Strategic executive overview with key outcomes.',
      },
      '919876500001': {
        phone: '919876500001',
        slotId: 'P2',
        name: 'Mohan Ram',
        roleTitle: 'Procurement & Sanitary Lead',
        authorityLevel: 'STAFF',
        skills: ['Procurement', 'Market Sourcing', 'Sanitary & Plumbing'],
        maxActiveTasks: 3,
        preferredLanguage: 'HINGLISH',
        workShiftStart: '09:00',
        workShiftEnd: '19:00',
        dailyOverviewTime: '09:30',
        isOnLeave: false,
        lastInboundAt: hoursAgo(3.5),
        bufferMode: 'STANDARD_15_MIN',
        stats: {
          assigned: 6,
          completed: 4,
          partial: 1,
          overdueCount: 0,
          totalWorkHoursReplyMins: 92,
          replyCount: 4,
        },
        personaPrompt: "Address him with respect as 'Mohan Ram ji'. Keep sentences simple, direct Hinglish. Always remind him to collect pucca GST bill and inspect quality before leaving Bhagirath Palace market.",
      },
      '919876500002': {
        phone: '919876500002',
        slotId: 'P3',
        name: 'Balbir',
        roleTitle: 'Site Installation Technician',
        authorityLevel: 'STAFF',
        skills: ['Electrical', 'Installation', 'Plant & Softener Maintenance'],
        maxActiveTasks: 3,
        preferredLanguage: 'HINGLISH',
        workShiftStart: '09:00',
        workShiftEnd: '19:00',
        dailyOverviewTime: '09:30',
        isOnLeave: false,
        lastInboundAt: hoursAgo(6),
        bufferMode: 'STANDARD_15_MIN',
        stats: {
          assigned: 5,
          completed: 3,
          partial: 1,
          overdueCount: 1,
          totalWorkHoursReplyMins: 108,
          replyCount: 3,
        },
        personaPrompt: "Address him warmly as 'Balbir bhai'. Simple conversational Hinglish. Emphasize site safety gear, load testing, and sending clear working photos.",
      },
      '919876500003': {
        phone: '919876500003',
        slotId: 'P4',
        name: 'Vikram Singh',
        roleTitle: 'Site Engineer / Supervisor',
        authorityLevel: 'SUPERVISOR',
        skills: ['Site Supervision', 'Quality Inspection', 'DG & Power Systems'],
        maxActiveTasks: 4,
        preferredLanguage: 'HINGLISH',
        workShiftStart: '09:00',
        workShiftEnd: '20:00',
        dailyOverviewTime: '09:15',
        isOnLeave: false,
        lastInboundAt: hoursAgo(2),
        bufferMode: 'STANDARD_15_MIN',
        stats: {
          assigned: 7,
          completed: 6,
          partial: 0,
          overdueCount: 0,
          totalWorkHoursReplyMins: 75,
          replyCount: 5,
        },
        personaPrompt: "Professional supervisor tone in Hinglish. Address as 'Vikram ji'. Highlight handover sign-offs and team coordination.",
      },
      '919876500004': {
        phone: '919876500004',
        slotId: 'P5',
        name: 'Meera',
        roleTitle: 'Accounts & Vendor Coordinator',
        authorityLevel: 'MANAGER',
        skills: ['Accounts', 'GST & Ledger', 'Vendor Payments'],
        maxActiveTasks: 4,
        preferredLanguage: 'ENGLISH',
        workShiftStart: '10:00',
        workShiftEnd: '19:00',
        dailyOverviewTime: '10:00',
        isOnLeave: false,
        lastInboundAt: hoursAgo(29), // > 24h to demonstrate Meta Template Required window state
        bufferMode: 'STANDARD_15_MIN',
        stats: {
          assigned: 5,
          completed: 4,
          partial: 0,
          overdueCount: 0,
          totalWorkHoursReplyMins: 56,
          replyCount: 4,
        },
        personaPrompt: 'Clear corporate English/Hinglish. Remind to verify vendor GSTIN and Tally ledger entries before releasing payment UTR.',
      },
    },

    category_sops: [
      {
        categoryId: 'PROCUREMENT',
        categoryName: 'Procurement & Purchasing',
        defaultClassification: 'MAJOR',
        sopSystemPrompt:
          'Always split procurement from installation. Require 3 rate comparisons, pucca GST bill photo, and physical handover confirmation to engineer.',
        defaultMicroSteps: [
          'Collect 3 vendor rate comparisons and confirm specification',
          'Purchase approved material and upload clear pucca GST bill photo',
          'Complete physical handover to Site Engineer and confirm receipt',
        ],
      },
      {
        categoryId: 'MAINTENANCE',
        categoryName: 'Site Maintenance & Installation',
        defaultClassification: 'MAJOR',
        sopSystemPrompt:
          'Require inspection, repair execution, and clear after-photo showing the unit working.',
        defaultMicroSteps: [
          'Inspect site fixture/equipment and verify power isolation',
          'Execute installation or repair work cleanly per safety norms',
          'Send clear after-photo showing the unit switched on and working',
        ],
      },
      {
        categoryId: 'EVENT_PREP',
        categoryName: 'Event Venue Readiness',
        defaultClassification: 'MAJOR',
        sopSystemPrompt:
          'Urgent venue readiness checklist. Zero delay tolerance. Require final setup photo.',
        defaultMicroSteps: [
          'Verify venue zone cleanliness, cabling, and backup power',
          'Complete final stage/lawn readiness walkthrough',
          'Send timestamped final setup photo 2 hours prior to guest arrival',
        ],
      },
      {
        categoryId: 'ACCOUNTS',
        categoryName: 'Accounts & Vendor Ledger',
        defaultClassification: 'MINOR',
        sopSystemPrompt:
          'Invoice verification, ledger entry, and payment UTR confirmation.',
        defaultMicroSteps: [
          'Verify GSTIN, HSN codes, and physical receipt sign-off on invoice',
          'Post voucher entry in Tally/ERP ledger',
          'Share NEFT/RTGS UTR payment confirmation number',
        ],
      },
      {
        categoryId: 'AD_HOC',
        categoryName: 'Ad-Hoc Rapid Execution',
        defaultClassification: 'MINOR',
        sopSystemPrompt:
          'Urgent unscripted task. No rigid SOP process overhead — direct execution and quick confirmation.',
        defaultMicroSteps: [
          'Complete requested action directly on site',
          'Reply on WhatsApp with quick confirmation or photo',
        ],
      },
    ],

    umbrella_agendas: [
      {
        agendaId: 'AG-01',
        title: 'Main Lawn Event Floodlight Procurement & Pillar Mounting',
        rawBrainDump:
          'We have a VIP reception on the Main Lawn tomorrow evening. Need 4 heavy-duty 150W outdoor IP66 LED floodlights bought from market with proper GST invoice and installed on the 4 perimeter pillars by Balbir under Vikram supervision.',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        status: 'ACTIVE',
        createdAt: hoursAgo(5),
      },
      {
        agendaId: 'AG-02',
        title: 'Vendor Cable Invoice Verification & Daily DG Readiness',
        rawBrainDump:
          'Close pending armoured cable vendor bill with Meera and ensure Vikram runs daily morning DG fuel and distribution board check.',
        quadrant: 'Q2_SCHEDULE',
        majorOrMinor: 'MAJOR',
        status: 'ACTIVE',
        createdAt: hoursAgo(20),
      },
    ],

    wbs_heads: [
      {
        headId: 'HEAD-1',
        title: 'Main Lawn Event Floodlight Procurement & Pillar Mounting',
        domainCategory: 'EVENT_PREP',
        contextSummary:
          '250-guest VIP Lawn reception. Procure 4 heavy-duty 150W outdoor IP66 LED floodlights with proper GST invoice and mount along walkway pillars before 4 PM event cutoff.',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        tentativeDurationDays: 1.5,
        tentativeStartDate: daysFromNowDate(0),
        tentativeDeadline: daysFromNowDate(0),
        isForcedDeadline: true,
        dynamicStages: ['Market Purchase', 'Supervisor Handover', 'Pillar Mounting'],
        involvedPhones: ['919876500001', '919876500002', '919876500003'],
        status: 'FROZEN_DISPATCHED',
        subTasks: [
          {
            tempId: 'draft-head1-1',
            title: 'Purchase 4 Outdoor LED Floodlights for Main Lawn',
            shortTag: 'Lawn Floodlights',
            categoryId: 'PROCUREMENT',
            quadrant: 'Q1_DO_FIRST',
            majorOrMinor: 'MAJOR',
            taskFrequency: 'ONE_TIME',
            recurrenceRule: 'NONE',
            raci: {
              R: '919876500001',
              A: '919876500003',
              C: ['919876500003'],
              I: ['919876500002'],
            },
            dependsOnTempIdOrTaskCode: null,
            triggerCondition: 'FULL_COMPLETION',
            startDate: daysFromNowDate(0),
            durationDays: 1,
            dueDate: daysFromNowDate(0),
            isForcedDeadline: true,
            forcedDeadlineDate: daysFromNowDate(0),
            wbsHeadId: 'HEAD-1',
            swimlaneStage: 'Market Purchase',
            microSteps: [
              'Buy 4 Outdoor 150W IP66 LED Floodlights',
              'Send GST Bill photo',
              'Hand over to Engineer Vikram',
            ],
            outboundWhatsappPreview:
              'Namaste Mohan Ram ji, Task [Lawn Floodlights]: Main lawn ke liye 4 outdoor LED floodlights kharidein aur GST bill photo WhatsApp par bhejein.',
          },
          {
            tempId: 'draft-head1-2',
            title: 'Install 4 LED Floodlights at Main Lawn Pillars & Test',
            shortTag: 'Floodlight Mounting',
            categoryId: 'MAINTENANCE',
            quadrant: 'Q1_DO_FIRST',
            majorOrMinor: 'MAJOR',
            taskFrequency: 'ONE_TIME',
            recurrenceRule: 'NONE',
            raci: {
              R: '919876500002',
              A: '919876500003',
              C: ['919876500003'],
              I: ['919876500001'],
            },
            dependsOnTempIdOrTaskCode: 'draft-head1-1',
            triggerCondition: 'PARTIAL_OR_BOSS_APPROVAL',
            startDate: daysFromNowDate(0),
            durationDays: 0.5,
            dueDate: daysFromNowDate(0),
            isForcedDeadline: true,
            forcedDeadlineDate: daysFromNowDate(0),
            wbsHeadId: 'HEAD-1',
            swimlaneStage: 'Pillar Mounting',
            microSteps: [
              'Collect 4 LED Floodlights & brackets from Engineer Vikram',
              'Mount floodlights on Main Lawn Pillars 1–4 with waterproof glands',
              'Test illumination beam & send clear working night/evening photo',
            ],
            outboundWhatsappPreview:
              'Namaste Balbir bhai, Task [Floodlight Mounting]: Pillars 1-4 par waterproof fitting ke saath lights lagayein aur photo bhejein.',
          },
        ],
      },
      {
        headId: 'HEAD-2',
        title: 'Shree Electricals Armoured Cable Bill Verification & NEFT',
        domainCategory: 'ACCOUNTS',
        contextSummary:
          'Audit ₹1,300 variance on 6sqmm armoured cable invoice (₹14,800 billed vs ₹13,500 PO), record voucher in Tally, and process NEFT release.',
        quadrant: 'Q2_SCHEDULE',
        majorOrMinor: 'MINOR',
        tentativeDurationDays: 1,
        tentativeStartDate: daysFromNowDate(0),
        tentativeDeadline: daysFromNowDate(1),
        isForcedDeadline: false,
        dynamicStages: ['Invoice Audit', 'Tally Ledger', 'UTR Release'],
        involvedPhones: ['919876500004', '919876500003'],
        status: 'FROZEN_DISPATCHED',
        subTasks: [
          {
            tempId: 'draft-head2-1',
            title: 'Shree Electricals Armoured Cable Bill Verification & NEFT',
            shortTag: 'Cable Bill UTR',
            categoryId: 'ACCOUNTS',
            quadrant: 'Q2_SCHEDULE',
            majorOrMinor: 'MINOR',
            taskFrequency: 'ONE_TIME',
            recurrenceRule: 'NONE',
            raci: {
              R: '919876500004',
              A: '919876500000',
              C: ['919876500003'],
              I: [],
            },
            dependsOnTempIdOrTaskCode: null,
            triggerCondition: 'FULL_COMPLETION',
            startDate: daysFromNowDate(0),
            durationDays: 1,
            dueDate: daysFromNowDate(1),
            isForcedDeadline: false,
            forcedDeadlineDate: null,
            wbsHeadId: 'HEAD-2',
            swimlaneStage: 'Invoice Audit',
            microSteps: [
              'Verify GSTIN & check Vikram physical sign-off on invoice',
              'Obtain Boss budget approval for ₹1,300 variance',
              'Enter voucher in Tally and share NEFT UTR number',
            ],
            outboundWhatsappPreview:
              'Hello Meera, Task [Cable Bill UTR]: Please verify invoice, confirm sign-off, and process voucher.',
          },
        ],
      },
      {
        headId: 'HEAD-3',
        title: 'Daily 125kVA DG Set Readiness & Main Lawn DB Balance',
        domainCategory: 'MAINTENANCE',
        contextSummary:
          'Daily morning readiness check: verify diesel fuel volume > 75%, crank battery > 24V, and balance phases across lawn distribution panels.',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        tentativeDurationDays: 1,
        tentativeStartDate: daysFromNowDate(0),
        tentativeDeadline: daysFromNowDate(0),
        isForcedDeadline: true,
        dynamicStages: ['Inspection', 'Battery Swap', 'Load Test'],
        involvedPhones: ['919876500003', '919876500002'],
        status: 'SWIMLANE_READY',
        subTasks: [
          {
            tempId: 'draft-head3-1',
            title: 'Daily 125kVA DG Set Diesel Level & Lawn DB Breaker Check',
            shortTag: 'DG Generator Check',
            categoryId: 'EVENT_PREP',
            quadrant: 'Q1_DO_FIRST',
            majorOrMinor: 'MAJOR',
            taskFrequency: 'RECURRING',
            recurrenceRule: 'DAILY',
            raci: {
              R: '919876500003',
              A: '919876500000',
              C: [],
              I: ['919876500002'],
            },
            dependsOnTempIdOrTaskCode: null,
            triggerCondition: 'FULL_COMPLETION',
            startDate: daysFromNowDate(0),
            durationDays: 1,
            dueDate: daysFromNowDate(0),
            isForcedDeadline: true,
            forcedDeadlineDate: daysFromNowDate(0),
            wbsHeadId: 'HEAD-3',
            swimlaneStage: 'Inspection',
            microSteps: [
              'Verify DG diesel tank > 75% and battery voltage > 24V',
              'Test Main Lawn ELCB/MCB distribution board load balance',
              'Send DG control panel meter photo on WhatsApp',
            ],
            outboundWhatsappPreview:
              'Namaste Vikram ji, Task [DG Generator Check]: Daily DG check pura karke meter photo bhejein.',
          },
        ],
      },
    ],

    tasks: [
      {
        taskCode: 'T-101',
        shortTag: 'Lawn Floodlights',
        agendaId: 'AG-01',
        wbsHeadId: 'HEAD-1',
        swimlaneStage: 'Market Purchase',
        title: 'Purchase 4 Outdoor LED Floodlights for Main Lawn',
        categoryId: 'PROCUREMENT',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        taskFrequency: 'ONE_TIME',
        recurrenceRule: 'NONE',
        isFrozen: true,
        raci: {
          R: '919876500001', // Mohan Ram
          A: '919876500003', // Vikram Singh
          C: ['919876500003'],
          I: ['919876500002'], // Balbir
        },
        status: 'IN_PROGRESS',
        completionPercent: 35,
        microSteps: [
          {
            id: 'ms-101-1',
            label: 'Buy 4 Outdoor 150W IP66 LED Floodlights',
            status: 'DONE',
            evidenceNote: 'Mohan confirmed arrival at Bhagirath Electricals market; selected Havells 150W IP66.',
          },
          {
            id: 'ms-101-2',
            label: 'Send GST Bill photo',
            status: 'PENDING',
          },
          {
            id: 'ms-101-3',
            label: 'Hand over to Engineer Vikram',
            status: 'PENDING',
          },
        ],
        missingStepsAlert: '',
        dependency: {
          dependsOnTaskCode: null,
          triggerCondition: 'FULL_COMPLETION',
        },
        reminderConfig: {
          includeInDailyOverview: true,
          customIntervalHours: 2,
          lastNudgedAt: hoursAgo(3),
          nudgeCount: 1,
        },
        startDate: daysFromNowDate(0),
        durationDays: 1,
        dueDate: daysFromNowDate(0),
        isForcedDeadline: true,
        forcedDeadlineDate: daysFromNowDate(0),
        outboundWhatsappPreview:
          'Namaste Mohan Ram ji, Naya task [Lawn Floodlights]: Main lawn ke liye 4 outdoor LED floodlights purchase karni hain.\nSteps:\n1. 4 outdoor 150W IP66 LED floodlights kharidein\n2. Pucca GST bill ka photo bhejein\n3. Engineer Vikram ji ko handover karke confirm karein.\nKripya kaam pura karke clear photo/update WhatsApp par bhejein.',
        latestAiSummary:
          'Mohan Ram reached electrical market and verified stock for 4x 150W LED floodlights. Awaiting GST invoice photo and physical handover to Vikram Singh.',
        lastOutboundAt: hoursAgo(3),
        auditLogs: [
          {
            timestamp: hoursAgo(4.5),
            sender: 'SYSTEM_DISPATCH',
            rawInputSummary: 'Rubric frozen and dispatched to Mohan Ram (919876500001) in Hinglish.',
            aiDecision: 'Status -> PENDING',
          },
          {
            timestamp: hoursAgo(3.5),
            sender: 'Mohan Ram (919876500001)',
            rawInputSummary: 'Sahab, Bhagirath market pahunch gaya hoon, 4 Havells 150W floodlights pasand kar li hain.',
            mediaInspected: 'Audio 14s (Hinglish/Marwari accent): Confirmed shop arrival and 4x Havells floodlight selection.',
            aiDecision: 'Marked Step 1 DONE (35%). Prompted for GST Bill photo and handover to Vikram.',
          },
        ],
      },
      {
        taskCode: 'T-102',
        shortTag: 'Floodlight Mounting',
        agendaId: 'AG-01',
        title: 'Install 4 LED Floodlights at Main Lawn Pillars & Test',
        categoryId: 'MAINTENANCE',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        taskFrequency: 'ONE_TIME',
        recurrenceRule: 'NONE',
        isFrozen: true,
        raci: {
          R: '919876500002', // Balbir
          A: '919876500003', // Vikram Singh
          C: ['919876500003'],
          I: ['919876500001'],
        },
        status: 'LOCKED_BY_DEPENDENCY',
        completionPercent: 0,
        microSteps: [
          {
            id: 'ms-102-1',
            label: 'Collect 4 LED Floodlights & brackets from Engineer Vikram',
            status: 'PENDING',
          },
          {
            id: 'ms-102-2',
            label: 'Mount floodlights on Main Lawn Pillars 1–4 with waterproof glands',
            status: 'PENDING',
          },
          {
            id: 'ms-102-3',
            label: 'Test illumination beam & send clear working night/evening photo',
            status: 'PENDING',
          },
        ],
        missingStepsAlert: '',
        dependency: {
          dependsOnTaskCode: 'T-101',
          triggerCondition: 'PARTIAL_OR_BOSS_APPROVAL',
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
        wbsHeadId: 'HEAD-1',
        swimlaneStage: 'Pillar Mounting',
        outboundWhatsappPreview:
          'Namaste Balbir bhai, Task [Floodlight Mounting]: Main Lawn ke 4 pillars par LED Floodlights install aur test karni hain.\nSteps:\n1. Vikram sir se 4 LED floodlights collect karein\n2. Pillars 1-4 par waterproof fitting ke saath lagayein\n3. Chalu karke clear working photo WhatsApp par bhejein.',
        latestAiSummary:
          'Locked waiting on [Lawn Floodlights] (Mohan Ram procurement & handover). Will auto-dispatch to Balbir once Mohan hands over or Boss approves gate.',
        auditLogs: [
          {
            timestamp: hoursAgo(4.5),
            sender: 'SYSTEM_DEPENDENCY_GATE',
            rawInputSummary: 'Task frozen and queued behind T-101 (Trigger: PARTIAL_OR_BOSS_APPROVAL).',
            aiDecision: 'Status -> LOCKED_BY_DEPENDENCY',
          },
        ],
      },
      {
        taskCode: 'T-103',
        shortTag: 'DG Generator Check',
        agendaId: 'AG-02',
        wbsHeadId: 'HEAD-3',
        swimlaneStage: 'Inspection',
        title: 'Daily 125kVA DG Set Diesel Level & Lawn DB Breaker Check',
        categoryId: 'EVENT_PREP',
        quadrant: 'Q1_DO_FIRST',
        majorOrMinor: 'MAJOR',
        taskFrequency: 'RECURRING',
        recurrenceRule: 'DAILY',
        isFrozen: true,
        raci: {
          R: '919876500003', // Vikram Singh
          A: '919876500000', // Rajesh Sharma
          C: [],
          I: ['919876500002'],
        },
        status: 'PENDING',
        completionPercent: 0,
        microSteps: [
          {
            id: 'ms-103-1',
            label: 'Verify DG diesel tank > 75% and battery voltage > 24V',
            status: 'PENDING',
          },
          {
            id: 'ms-103-2',
            label: 'Test Main Lawn ELCB/MCB distribution board load balance',
            status: 'PENDING',
          },
          {
            id: 'ms-103-3',
            label: 'Send DG control panel meter photo on WhatsApp',
            status: 'PENDING',
          },
        ],
        missingStepsAlert: '',
        dependency: {
          dependsOnTaskCode: null,
          triggerCondition: 'FULL_COMPLETION',
        },
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
          'Namaste Vikram ji, Task [DG Generator Check] (DAILY): Daily 125kVA DG Set & Main Lawn DB check.\nSteps:\n1. DG diesel tank > 75% & battery > 24V verify karein\n2. Lawn ELCB/MCB balance test karein\n3. DG meter photo WhatsApp par share karein.',
        latestAiSummary: 'Active recurring task for today. Awaiting morning meter photo verification.',
        lastOutboundAt: hoursAgo(2.5),
        auditLogs: [
          {
            timestamp: hoursAgo(2.5),
            sender: 'DAILY_SHIFT_CRON',
            rawInputSummary: 'Dispatched in morning overview digest.',
            aiDecision: 'Status -> PENDING',
          },
        ],
      },
      {
        taskCode: 'T-104',
        shortTag: 'Cable Bill UTR',
        agendaId: 'AG-02',
        wbsHeadId: 'HEAD-2',
        swimlaneStage: 'Invoice Audit',
        title: 'Shree Electricals Armoured Cable Bill Verification & NEFT',
        categoryId: 'ACCOUNTS',
        quadrant: 'Q2_SCHEDULE',
        majorOrMinor: 'MINOR',
        taskFrequency: 'ONE_TIME',
        recurrenceRule: 'NONE',
        isFrozen: true,
        raci: {
          R: '919876500004', // Meera
          A: '919876500000', // Rajesh Sharma
          C: ['919876500003'],
          I: [],
        },
        status: 'AWAITING_BOSS_DECISION',
        completionPercent: 50,
        microSteps: [
          {
            id: 'ms-104-1',
            label: 'Verify GSTIN & check Vikram physical sign-off on invoice',
            status: 'DONE',
            evidenceNote: 'Verified GSTIN and physical site sign-off by Vikram Singh.',
          },
          {
            id: 'ms-104-2',
            label: 'Obtain Boss budget approval for ₹1,300 variance',
            status: 'PENDING',
          },
          {
            id: 'ms-104-3',
            label: 'Enter voucher in Tally and share NEFT UTR number',
            status: 'PENDING',
          },
        ],
        missingStepsAlert: 'Budget variance ₹1,300 detected against original PO estimate of ₹13,500.',
        dependency: {
          dependsOnTaskCode: null,
          triggerCondition: 'FULL_COMPLETION',
        },
        reminderConfig: {
          includeInDailyOverview: false, // Paused in Boss Review
          customIntervalHours: null,
          lastNudgedAt: null,
          nudgeCount: 0,
        },
        startDate: daysFromNowDate(0),
        durationDays: 2,
        dueDate: daysFromNowDate(1),
        isForcedDeadline: false,
        forcedDeadlineDate: null,
        outboundWhatsappPreview:
          'Hello Meera, Task [Cable Bill UTR]: Please verify Shree Electricals invoice, confirm Vikram sign-off, post voucher, and share payment UTR.',
        latestAiSummary:
          'Paused awaiting Boss approval on ₹1,300 cable size variance (₹14,800 billed vs ₹13,500 estimate). SLA reminders paused.',
        auditLogs: [
          {
            timestamp: hoursAgo(1.5),
            sender: 'Meera (919876500004)',
            rawInputSummary: 'Uploaded Invoice photo with query regarding ₹1,300 cable variance.',
            mediaInspected: 'Image: Tax_Invoice_SE884.jpg (₹14,800 total, 18% GST).',
            aiDecision: 'Escalated to Boss Review Queue. Status -> AWAITING_BOSS_DECISION (Reminders Paused).',
          },
        ],
        pausedIntervals: [
          {
            pausedAt: hoursAgo(1.5),
          },
        ],
      },
      {
        taskCode: 'T-105',
        shortTag: 'Water Pump Repair',
        agendaId: null,
        wbsHeadId: null,
        swimlaneStage: 'Repair & Test',
        title: 'Replace Contactor & Pressure Switch for Staff Quarter Water Pump',
        categoryId: 'MAINTENANCE',
        quadrant: 'Q3_DELEGATE',
        majorOrMinor: 'MINOR',
        taskFrequency: 'ONE_TIME',
        recurrenceRule: 'NONE',
        isFrozen: true,
        raci: {
          R: '919876500002', // Balbir
          A: '919876500003', // Vikram Singh
          C: [],
          I: [],
        },
        status: 'COMPLETED',
        completionPercent: 100,
        microSteps: [
          {
            id: 'ms-105-1',
            label: 'Isolate pump starter panel power',
            status: 'DONE',
            evidenceNote: 'Confirmed MCB turned off before opening panel.',
          },
          {
            id: 'ms-105-2',
            label: 'Replace faulty L&T 16A contactor & set pressure cutoff to 2.5 bar',
            status: 'DONE',
            evidenceNote: 'Replaced contactor cleanly and calibrated cutoff.',
          },
          {
            id: 'ms-105-3',
            label: 'Test automatic pump start/stop and send working photo',
            status: 'DONE',
            evidenceNote: 'Green run indicator & pressure gauge verified via photo.',
          },
        ],
        missingStepsAlert: '',
        dependency: {
          dependsOnTaskCode: null,
          triggerCondition: 'FULL_COMPLETION',
        },
        reminderConfig: {
          includeInDailyOverview: false,
          customIntervalHours: null,
          lastNudgedAt: null,
          nudgeCount: 0,
        },
        startDate: daysFromNowDate(-2),
        durationDays: 1,
        dueDate: daysFromNowDate(-1),
        isForcedDeadline: false,
        forcedDeadlineDate: null,
        outboundWhatsappPreview:
          'Namaste Balbir bhai, Task [Water Pump Repair]: Staff quarter water pump contactor aur pressure switch repair karke working photo bhejein.',
        latestAiSummary: 'Completed 100% with verified running pump panel photo.',
        auditLogs: [
          {
            timestamp: hoursAgo(26),
            sender: 'Balbir (919876500002)',
            rawInputSummary: 'Sent photo + text: "Pump chalu ho gaya sir, auto cut bhi check kar liya."',
            mediaInspected: 'Image: L&T starter panel showing 4.2A normal load current.',
            aiDecision: 'All 3 micro-steps DONE. Status -> COMPLETED (100%).',
          },
        ],
      },
    ],

    boss_review_queue: [
      {
        reviewId: 'REV-101',
        taskCode: 'T-104',
        employeePhone: '919876500004',
        reviewType: 'BUDGET_APPROVAL',
        employeeMessageSummary:
          'Meera asks approval for ₹1,300 variance on Shree Electricals Invoice #SE-884 (₹14,800 billed vs ₹13,500 estimate due to 6sqmm armoured copper cable used on site).',
        mediaVerificationNote:
          'Inspected GST Invoice #SE-884 photo: GSTIN valid, 18% GST breakup accurate, signed by Supervisor Vikram Singh.',
        aiSuggestedReplies: [
          'Approve ₹14,800 and release NEFT today; share UTR once done.',
          'Hold payment; ask vendor for 5% rate discount to match ₹14,000 cap.',
          'Release ₹13,500 base PO amount now and hold ₹1,300 pending physical measurement.',
        ],
        status: 'OPEN',
        createdAt: hoursAgo(1.5),
      },
    ],

    inbound_message_buffer: {},

    system_memory: [
      {
        tenantId: 'default',
        memoryId: 'MEM-01',
        category: 'BUSINESS_RULE',
        fact: 'Any procurement above ₹2,000 strictly requires a GST invoice photo before closure.',
        active: true,
        approved: true,
      },
      {
        tenantId: 'default',
        memoryId: 'MEM-02',
        category: 'STAFF_TRAIT',
        fact: 'Mohan Ram handles market purchasing; Balbir handles physical electrical & site installation.',
        active: true,
        approved: true,
      },
      {
        tenantId: 'default',
        memoryId: 'MEM-03',
        category: 'SOP_PREFERENCE',
        fact: 'Ground staff prefer friendly, conversational Hinglish. Always tailor outbound messages using their personal persona prompt.',
        active: true,
        approved: true,
      },
      {
        tenantId: 'default',
        memoryId: 'MEM-04',
        category: 'VENDOR_FACT',
        fact: 'Bhagirath Electricals and Shree Electricals offer 30-day credit only when PO is countersigned by Vikram Singh or Meera.',
        active: true,
        approved: true,
      },
      {
        tenantId: 'default',
        memoryId: 'MEM-05',
        category: 'BUSINESS_RULE',
        fact: 'Never penalize staff response metrics outside their shift hours or while a task sits in Boss Review Queue.',
        active: true,
        approved: true,
      },
    ],

    notes: [],

    whatsapp_messages: [
      {
        id: 'wa-seed-1',
        employeePhone: '919876500001',
        direction: 'OUTBOUND',
        timestamp: hoursAgo(4.5),
        tag: 'TASK_DISPATCH',
        taskCode: 'T-101',
        text: 'Namaste Mohan Ram ji, Naya task [Lawn Floodlights]: Main lawn ke liye 4 outdoor LED floodlights kharidein.\nSteps:\n1. 4 outdoor 150W IP66 LED floodlights kharidein\n2. Pucca GST bill photo bhejein\n3. Engineer Vikram ji ko handover karein.\nKripya kaam pura karke clear photo WhatsApp par bhejein.',
      },
      {
        id: 'wa-seed-2',
        employeePhone: '919876500001',
        direction: 'INBOUND',
        timestamp: hoursAgo(3.5),
        taskCode: 'T-101',
        mediaLabel: 'Voice Note (0:14)',
        text: 'Sahab, Bhagirath market pahunch gaya hoon, 4 Havells 150W floodlights pasand kar li hain.',
      },
      {
        id: 'wa-seed-3',
        employeePhone: '919876500001',
        direction: 'OUTBOUND',
        timestamp: hoursAgo(3.4),
        tag: 'AI_CONFIRMATION',
        taskCode: 'T-101',
        text: 'Shukriya Mohan Ram ji! [Lawn Floodlights] ka pehla step verify ho gaya (35%). Please purchase ke baad pucca GST bill ka clear photo bhejein aur Vikram ji ko handover karein.',
      },
      {
        id: 'wa-seed-4',
        employeePhone: '919876500003',
        direction: 'OUTBOUND',
        timestamp: hoursAgo(2.5),
        tag: 'DAILY_DIGEST',
        taskCode: 'T-103',
        text: 'Namaste Vikram ji, Aaj ka Shift Overview:\n• [DG Generator Check] Daily 125kVA DG set & Lawn DB check (Due Today)\n• [Lawn Floodlights] Handover: Mohan Ram se 4 LED floodlights receive karein.',
      },
      {
        id: 'wa-seed-5',
        employeePhone: '919876500004',
        direction: 'INBOUND',
        timestamp: hoursAgo(1.5),
        taskCode: 'T-104',
        mediaLabel: 'Photo: Tax_Invoice_SE884.jpg',
        text: 'Sir, Shree Electricals invoice is ₹14,800 instead of ₹13,500 due to 6sqmm armoured copper cable approved on site. Please confirm if I should release ₹14,800.',
      },
      {
        id: 'wa-seed-6',
        employeePhone: '919876500004',
        direction: 'OUTBOUND',
        timestamp: hoursAgo(1.49),
        tag: 'BOSS_ESCALATION_HOLD',
        taskCode: 'T-104',
        text: 'Received Invoice #SE-884 for [Cable Bill UTR]. Because of the ₹1,300 budget variance, this is queued for Boss approval. SLA timer paused.',
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

    ai_logs: [],
  };
}
