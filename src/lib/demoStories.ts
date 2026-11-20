/**
 * The demo's sample businesses and the words shown about each one. Data only:
 * business names, people and numbers here are sample content, not logic.
 */
import type { OpsDatabaseState } from '../types/ops.ts';
import { createBanquetDemoSeedState } from './demoBanquet.ts';
import { createDemoSeedState, DEMO_WALKTHROUGH_COPY } from './demoData.ts';
import { openReviewsOldestFirst, sendOwnerDecisionPrompts } from './ownerWhatsapp.ts';

export type DemoStoryId = 'banquet' | 'water';

/** The banquet story matches the pitch deck, so it is the default. */
export const DEFAULT_DEMO_STORY: DemoStoryId = 'banquet';

export interface DemoWalkthroughCopy {
  id: string;
  title: string;
  summary: string;
  actionLabel: string;
}

export interface DemoStoryCopy {
  id: DemoStoryId;
  /** Short label for the story switch, e.g. "Banquets & catering · Jodhpur". */
  switchLabel: string;
  businessName: string;
  kindLine: string;
  tagline: string;
  happeningNow: string;
  storyBullets: Array<{ label: string; text: string }>;
  teamButtonLabel: string;
  counts: string[];
  walkthrough: readonly DemoWalkthroughCopy[];
}

export const DEMO_STORIES: Record<DemoStoryId, DemoStoryCopy> = {
  banquet: {
    id: 'banquet',
    switchLabel: 'Banquets & catering · Jodhpur',
    businessName: 'Sunehri Bagh Lawns & Banquets',
    kindLine: 'Sample banquet & catering business',
    tagline:
      'Four lawns and two banquet halls in Jodhpur. The owner speaks in Hinglish; the team works on WhatsApp in Hindi and Hinglish. Try the voice-note sample “Kal Sharma ji ki shaadi hai…”.',
    happeningNow:
      'Tonight is the Mehta reception on Lawn 2 (8 PM, 250 guests). Lawn setup is due by 6 PM, but Ramesh just wrote in Hindi that 150 chairs arrive at 7 PM. Suresh got three quotes for the extra chairs and is waiting for your approval. Mahesh filled the generator but sent no fuel-gauge photo.',
    storyBullets: [
      {
        label: 'The business',
        text: 'Weddings, receptions and corporate events on four lawns and two halls, with in-house catering.',
      },
      {
        label: 'The team (owner + 5)',
        text: 'Owner Harsh, Ops Manager Pooja, Maintenance Lead Gopal, Ramesh (lawn & setup), Suresh (vendors) and Mahesh (power & generator).',
      },
      {
        label: 'Try first',
        text: 'In Meditate, tap “Kal Sharma ji ki shaadi hai…”. It asks one short question, then drafts tasks for Ramesh, Suresh and Mahesh.',
      },
      {
        label: 'Then track it',
        text: 'Read Ramesh’s Hindi update in WhatsApp (counted, flagged Behind, Pooja alerted), hear his task as a Hindi voice note, then approve the ₹4,500 chairs by replying 1 in your own WhatsApp.',
      },
    ],
    teamButtonLabel: 'Open team chart',
    counts: ['Owner + 5 staff', '6 task types', '5 tasks today', '1 WhatsApp update waiting'],
    walkthrough: [
      {
        id: 'meditate',
        title: '1. Plan from a Hinglish voice note',
        summary:
          'Tap the sample “Kal Sharma ji ki shaadi hai…”. Meditate asks one short question (which lawn, what time), then drafts tasks with people and times.',
        actionLabel: 'Open Meditate',
      },
      {
        id: 'team',
        title: '2. Team & who reports to whom',
        summary: 'The owner and five staff from the pitch, with what each person handles and how they like to be addressed.',
        actionLabel: 'Open Team Chart',
      },
      {
        id: 'liveOps',
        title: '3. Tonight’s reception',
        summary: 'Lawn 2 must be ready by 6 PM. Each card shows its due time and turns red when it is late or behind.',
        actionLabel: 'Open Live Ops',
      },
      {
        id: 'whatsapp',
        title: '4. Read Ramesh’s Hindi update',
        summary:
          'Process Ramesh’s message: it counts 100/250 chairs, flags the 6 PM setup Behind, asks him one question, and alerts Pooja with the linked chair approval. Tap “Hear as voice note” on his task to hear Gemini read it in Hindi.',
        actionLabel: 'Open WhatsApp Chat',
      },
      {
        id: 'approvals',
        title: '5. Approve from WhatsApp',
        summary: 'In WhatsApp, open “You (owner)”: the ₹4,500 chair approval is waiting with 3 answers. Reply 1 to approve (Suresh is told), or “brief” for today’s summary.',
        actionLabel: 'Open Boss Reviews',
      },
      {
        id: 'aiBrain',
        title: '6. Scorecard, routines & rules',
        summary: 'See the team scorecard (2x2 Matrix & Team), run a task type’s checklist with Run now / Run daily (AI Brain & Setup), and the saved rules.',
        actionLabel: 'Open AI Brain',
      },
    ],
  },
  water: {
    id: 'water',
    switchLabel: 'Water supplier · Pune',
    businessName: 'BlueDrop Water Supplies',
    kindLine: 'Sample delivery business',
    tagline:
      'See how a local office water-jar and dispenser business runs daily orders across Pune without messy spreadsheets. Type or speak instructions, assign work across a 7-person team, and track WhatsApp updates automatically.',
    happeningNow:
      'Nitin is on route with 40 water jars for Sunrise IT Park (due 11 AM; his WhatsApp update is waiting for AI review), 40 empty jars are queued to be picked up next, Kavita has monthly client bills ready to release, and Rohan asked Arvind to approve ₹2,500 for an extra afternoon van.',
    storyBullets: [
      {
        label: 'The business',
        text: 'Delivers 20-litre water jars and dispensers to Pune offices — orders, empty-jar pickups, dispenser repairs, stock buying and monthly billing.',
      },
      {
        label: 'The 7-person team',
        text: 'Founders Arvind & Priya, Operations Head Rohan, Purchase (Suresh), Quality & Service (Deepak), Delivery (Nitin) and Billing (Kavita).',
      },
      {
        label: 'Try first in Meditate',
        text: 'Pick a sample prompt (like the leaking dispenser or the Metro Hospital signup) to watch the work split across teammates.',
      },
      {
        label: 'Check live action',
        text: 'Run a scheduler tick in Live Ops to send Kavita’s monthly bills, process Nitin’s queued WhatsApp message, and approve the ₹2,500 extra van in Boss Reviews.',
      },
    ],
    teamButtonLabel: 'Open 7-person team chart',
    counts: ['7 team members', '5 task types', '7 live tasks', '1 WhatsApp update waiting'],
    walkthrough: DEMO_WALKTHROUGH_COPY,
  },
};

export const DEMO_STORY_IDS: DemoStoryId[] = ['banquet', 'water'];

export function isDemoStoryId(value: unknown): value is DemoStoryId {
  return value === 'banquet' || value === 'water';
}

/** A fresh demo workspace for the chosen story. */
export function createDemoStoryState(story: DemoStoryId, nowIso: string = new Date().toISOString()): OpsDatabaseState {
  const seed = story === 'water' ? createDemoSeedState(nowIso) : createBanquetDemoSeedState(nowIso);
  // The open decision is already waiting in the owner's WhatsApp, as it would be live.
  const askedAt = openReviewsOldestFirst(seed.boss_review_queue)[0]?.createdAt || nowIso;
  return sendOwnerDecisionPrompts(seed, askedAt).nextState;
}
