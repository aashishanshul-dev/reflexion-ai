# OpsCommand AI

A WhatsApp-first operations command center for small-business owners. The owner captures
messy goals by text or voice ("Siddharth DG is making noise, get it checked"); the app turns
them into owned, scheduled, RACI-assigned tasks, and staff work entirely inside WhatsApp. It is
driven by configuration (business profile, team, task types, SOPs), so it works for any business
without code changes. AI judges meaning; deterministic code checks facts and does the arithmetic
(dates, shifts, workload, capacity, dependencies), and nothing the AI produces reaches state
without passing the validator.

AI Studio app: https://ai.studio/apps/b0e131a1-cf11-43b7-8116-95f14c8c2d5c

## What's built (v1.0 — submission)

- **Meditate & Task Studio** — conversational brain-dump → tasks. Two engines (`legacy`, `v2`);
  v2 has an intent gate (TASK / NOTE / RULE / QUESTION / CASUAL), QUICK and PROJECT lanes, confirm
  chips, notes and owner-approved rules. Drafts are fully editable before sending and can be
  discarded without saving.
- **Assignment by meaning** — the planner picks the Responsible person from each person's role,
  "what they handle" and strengths, plus task-type default/backup owners. Weaknesses are used only
  by the owner and AI and never appear in any staff-facing text.
- **Release engine** — freezing schedules tasks; the engine decides when to send (now, at a time,
  after another task, when free, owner confirmation, shift, leave, task limit, digest batching).
  `POST /api/jobs/tick` plus a dev "Run tick" button.
- **Live Ops board** — list, 2×2 matrix, Gantt and split views; a Scheduled/Held lane; cancel and
  archive; automatic reminders inside shift hours.
- **My tasks** — the owner's Do / Decide / Follow-up lists and a daily digest.
- **Team** — visual org chart with reporting/partner/works-closely lines, a capacity strip, add/edit
  people, and a team-setup import (preview, phone entry, backup/undo, audit).
- **AI Brain & Setup** — business/owner profile, task-splitting rules, sample brain-dumps, category
  SOPs, system memory, master prompts, and per-stage model tuning + telemetry.
- **WhatsApp simulator** — a built-in drawer that plays the staff side of the conversation.
- **Cloud sign-in & storage (Milestone 5A)** — Google sign-in, an allow-list, and a private
  per-record Firestore workspace per owner with optimistic version checks. Without Firebase values
  the app runs in local mode.
- **Quality** — a golden eval (28 cases, simulated and live), a deterministic validator with a
  repair loop, slot anonymisation so no names or phone numbers reach the AI, and 201 unit tests.

## Run locally

**Prerequisites:** Node.js

1. Install dependencies: `npm install`
2. Set `GEMINI_API_KEY` in `.env` (see `.env.example`).
3. Run the app: `npm run dev`

Without Firebase values the app runs in **local mode**: no sign-in, seeded demo data, everything
stays in the browser. Add the Firebase values (below) for Google sign-in and cloud storage.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app (Vite + Express) |
| `npm test` | Unit tests (201) |
| `npm run lint` | Type check (`tsc --noEmit`) |
| `npm run build` | Production build |
| `npm run eval` | Golden eval, simulated (checks the pipeline) |
| `npm run eval:live` | Golden eval against live Gemini (checks AI quality) |
| `npm run models:check` | List the Gemini models your key can use |

## Cloud sign-in and storage (Firebase)

Without Firebase values the app runs in **local mode**: no sign-in, data stays in the browser.
With them, every owner signs in with Google and gets a private workspace in Firestore
(one document per record under `tenants/{uid}/...`). New workspaces start with a short setup:
business → your role → your people → task types → your first tasks.

1. In the Firebase console (free Spark plan is enough):
   - **Authentication → Sign-in method**: enable **Google**.
   - **Authentication → Settings → Authorized domains**: make sure `localhost` (and your hosting domain) is listed.
   - **Firestore Database**: create the database.
2. **Browser values** — Project settings → General → Your apps → your web app →
   SDK setup and configuration → Config. Copy them into `.env`:
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`,
   `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`.
3. **Server values (secret)** — Project settings → Service accounts → **Generate new private key**.
   From the downloaded JSON copy `project_id`, `client_email` and `private_key` into
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
   (private key on one line, in double quotes, keeping the `\n` sequences). Do not keep the JSON in the project.
4. **Who may sign in** — add `ALLOWED_EMAILS="you@example.com,partner@example.com"` (comma-separated
   Google account emails). Anyone else sees "Not authorised" and is signed out, and the server refuses
   their requests (403). If it is empty or missing, nobody can sign in.
5. **Rules** — Firestore Database → Rules: paste the contents of `firestore.rules` and **Publish**.
6. Restart `npm run dev` (also after changing `ALLOWED_EMAILS`).

The scheduler tick (`POST /api/jobs/tick`) and the AI endpoints require the signed-in user's
token, from an account in `ALLOWED_EMAILS`, in cloud mode; the tick reads and writes the stored workspace with a version check, so a
stale tab or device can never overwrite newer changes. Note: Firestore rules cannot read `.env`,
so the allow-list is enforced by the app and the server; the rules still keep every account
confined to its own private workspace.

## Known limitations (planned after submission)

- **WhatsApp is the built-in simulator.** Messages play in the in-app WhatsApp drawer. Sending and
  receiving on the real WhatsApp Business Cloud API (inbound webhook, 15-minute buffer processed
  automatically, proof media, a 5-minute scheduled tick) is **Milestone 5B — next**.
- **The swimlane canvas is not yet draggable.** Sub-tasks are configured through the cards; a
  drag-and-drop canvas is planned.
- **Deployment comes after submission.** The app runs locally (and in cloud mode against a Firebase
  project); a hosted deployment is not part of this version.
- **Bundle is not code-split** yet (the build prints a chunk-size warning); code-splitting is on the
  "Later" list.

See `MILESTONES.md` for the full status and the remaining roadmap, and `OPSCOMMAND_CONTEXT.md` for
the frozen architecture and rules.
