# Remaining milestones

Done and verified: business/owner profile config, slot anonymisation with server-side slot→phone mapping, 8-turn history cap, per-stage model settings, honest fallbacks, golden eval (28 cases, SIMULATED/LIVE labels), AI call logging, validator with repair loop, MEDITATE_ENGINE flag, Meditate v2 (intent gate, confirm chips, notes, rule approval, QUICK/PROJECT lanes, dueHint), release engine wired into the app (Milestone 3), owner profile fields. Do NOT redo or restructure this work.

## Status
| Milestone | Status | Live eval score after | Notes |
|---|---|---|---|
| Baseline | Recorded (9 Nov 2026) | flash-lite, free tier: 25/28 (89.3%) | `npm run eval:live`, MEDITATE_ENGINE=v2, every stage (primary and backup) on `gemini-flash-lite-latest` for this run only. Intent 27/28, lane 25/28, validator/PII/slot-map/history cap 28/28. 46 calls, 6 busy-retries (free-tier limit / overloaded), 0 backup. Failing cases listed below the table. |
| 0 Fix-ups | Done (9 Nov 2026) | | Items 1, 3–8 done; item 2 checked, no change needed. Commits `7fe22e5`, `2845b46`. Lint 0 errors, 61 tests pass. `npm run eval` not run. |
| 1 Validator, engine switch, honest eval | Done | | |
| 2 Meditate v2 | Done | | |
| 3 Wire the release engine into the app | Done (14 Nov 2026) | not run | All 7 items done; see the Milestone 3 section. Commits `c514d25`, `20a86fa`, `957635d`. Lint 0 errors, 96 tests pass. 2 follow-ups listed there. |
| 3.5 Everyday essentials | Done (14 Nov 2026) | not run | Cancel/archive any task; automatic reminders in the tick. Lint 0 errors, 107 tests pass, simulated eval 28/28 (legacy and v2). Checked in the browser. |
| 3.6 Edit drafts before sending | Done (14 Nov 2026) | not run | Edit every draft field in place (incl. the exact WhatsApp message), add/delete tasks, rename/delete plans, validator on every edit, freeze blocked by real errors, edits logged without names/phones, AI refinement keeps owner edits. Lint 0 errors, 127 tests pass, simulated eval 28/28 (legacy and v2). Checked in the browser. |
| 4 My tasks tab | Done (14 Nov 2026) | not run | "My tasks" tab (Do / Decide / Follow up) with nav badge; follow-up hours setting; owner's daily summary digest. Lint 0 errors, 137 tests pass, simulated eval 28/28 (legacy and v2). Checked in the browser. |
| 5A Login and proper storage | Done (14 Nov 2026) | not run | Checked with the real Firebase project: Google sign-in, first-run setup saved to Firestore, two tabs editing different tasks both saved, a stale edit form refused, cancel/archive saved, sign-out in both tabs, signed-out API calls refused (401), and the scheduler tick from stored data (released a queued task, change saved and shown after reload) once the server key had the Cloud Datastore User role. Lint 0 errors, 151 tests pass. |
| Team (org chart, import, assignment) | Done (14 Nov 2026) | not run | Visual org chart with reporting/partner/works-closely lines + capacity strip; add/edit people; assignment by task-type default/backup owners and each person's "what they handle"; strengths/weaknesses (weaknesses never in staff-facing text); team-setup import with preview, phone entry, backup/undo and audit. On branch `team-view`, merged to `main` at submission. |
| **Submission freeze** | **v1.0-submission (15 Nov 2026)** | sim 28/28 | Pre-submission integrity check (A–C) + 3 fixes: phone normalisation to `91XXXXXXXXXX` on every save path (`normalizeIndianPhone`), a "General" task type, and `.gitignore` for `opscommand-backup-*.json`. `main` fast-forwarded from `team-view`; lint 0 errors, 201 tests pass, build OK. Tagged `v1.0-submission`. See the Submission section below. |
| Batch 1 Review fixes (demo matches the pitch) | Done (19 Nov 2026) | not run | Freeze lifted by the owner for this batch. Local git repo created (`main` = starting point, work on `batch-1`). Due times + late/behind, reply timing, task order, must-know questions, names/Address-as/Accountable, short WhatsApp brief, screen fixes, plain labels, banquet demo story. Lint 0 errors, 271 tests pass, simulated eval 28/28, build OK. Checked in the browser (local mode, no Gemini key). See the Batch 1 section. |
| Models after billing | Done (20 Nov 2026) | flash-lite intent + flash planner (paid): 26/28 | Gemini billing active. Defaults: intent, reply reading and messages on Flash-Lite (backup Flash); planner on Flash (backup Pro, 8192 output tokens). Each stage has a different backup. Saved Flash-Lite/Flash-Lite stages migrate once (v4). A cut-off JSON answer now goes to the backup model. 0 busy-retries (was 11–13), 11.8 s average per case (was 20.8 s). Failing: GOLD-06 (as baseline), GOLD-20 (asks a question when the eval's 12-turn history is present; passes without it). Flash for intent scored lower (25/28), so it stays on Flash-Lite. |
| Batch 2 Tracking loop | Done (20 Nov 2026) | reply eval 9/9 | Behind alerts to the Accountable (once, with AI suggested fix and linked approval in the same job), from replies and the tick; count progress (100/250) and per-step photo checks (code gate: no image or wrong image keeps the step open). |
| Batch 4 Scorecard, rules, routines | Done (20 Nov 2026) | | Team scorecard (on-time, reply speed, behind now, overloaded tomorrow); "Save as rule?" after owner corrections; Run now / Run daily routines per task type. Not built: vendors as outside contacts. |
| Batch 3 Owner and voice on WhatsApp | Done (20 Nov 2026) | | Owner chat in the simulator: decision prompts with 1/2/3 replies, "brief", any note planned in Meditate; task briefs as Hindi voice notes via Gemini TTS (names dropped before sending). |
| Final model setup | Done (20 Nov 2026) | golden 27/28, replies 9/9 | Intent Flash-Lite (Flash backup); planner Flash with thinking capped at 1024 (Pro backup, 8192 tokens; uncapped Flash once hit the 45 s limit live, capped it is ~3x faster and scored 27/28 — only GOLD-06 fails, as in every run); replies Flash-Lite (1.7 s vs Flash 12.3 s, both 9/9); messages Flash-Lite; voice notes gemini-3.8-flash-lite-tts (gemini-3.8-flash-tts backup). `npm run eval:replies` (live) added. |
| 5B Real WhatsApp and the scheduler | Not started (next) | | WhatsApp currently runs in the built-in simulator. |

Build order: **5A → Team → submission → 5B**, then items from "Later" as needed.

## Batch 1 — Review fixes: make the demo match the pitch — Done (19 Nov 2026)
From an outside review of the demo against the pitch deck. The owner lifted the submission freeze for this batch only. Work is on the `batch-1` branch of a new local git repo (this folder was an unzipped copy; `main` holds the starting point).

**What was built:**
1. **Replies read the clock.** Tasks keep a due time (`dueTime`, HH:mm, business timezone), read by code from the timing phrase or the title and editable on drafts and live tasks. The reply prompt gets the current time, each task's due time and a code-computed "Late by …" label, plus rules (that a custom evaluation prompt cannot remove) to ask one finish-time question and never ask about another task's steps. The AI reports `delayReported` / `reportedEta`; code decides "behind" (`assessReplyScheduleRisk`) and stores `scheduleRisk` on the task. Shown as a red "Late by" / "Behind" badge on Live Ops, a BEHIND reason in My tasks → Follow up, and "N behind" on the Team chart. Staff "style" notes are tone only.
2. **Task order.** Both planners are told to set which task waits for which; code fills "After task" for later-stage tasks with no order yet (`applyStageOrderDefaults`, no loops, owner choices kept) and stores it as the release so the card shows it. New plans get `HEAD-n` labels instead of raw AI IDs.
3. **One question for missing facts.** Task types have "Must know before planning" facts (`requiredFacts`, editable in AI Brain & Setup); the intent gate and both planners ask one combined question instead of guessing. Dates nobody gave are flagged `dueDateAssumed` and shown as a note on the draft.
4. **Names and Accountable.** Prompts say the reader is the owner; code strips a leading greeting to a teammate from owner replies. The weakness support step no longer has a copyable example. New "Address as" per person (`addressAs`, e.g. "Nitin bhai") used in AI replies, release messages and every fixed template. Accountable follows the org chart (`suggestAccountablePhone`: manager, then partner, then default).
5. **Short WhatsApp brief** (`buildShortTaskBrief`): greeting + [tag] + task + by when, steps on one line, one closing ask; no "Due Date:" / "Accountable:" labels. The AI message writer is asked for the same shape.
6. **Screen fixes.** WhatsApp panel opens on the chat with waiting messages; Shift digest counts fixed (were read before the state update), business-day date, toast names who got it; swimlane width grows with the number of stages; plain labels (Projects, Who does what, Approve & send, Voice typing, Send today's digest).
7. **Banquet demo story (default)** matching the deck: Jodhpur banquets/lawns/catering, owner + five staff from the team slide, task types with must-know facts, tonight's reception (lawn due 6 PM, Ramesh's Hindi update that 150 chairs come at 7 PM, Suresh's three-quote chair approval, Mahesh's generator check without a photo), and "Kal Sharma ji ki shaadi hai…" as the first sample. A story switch keeps the water-supplier story.

**Tests changed (not deleted):** three assertions in `draftEditing.test.ts` / `releaseEngine.test.ts` moved from the old numbered-steps message format to the new one-line steps.

**Live Gemini check (19 Nov 2026, flash-lite, v2):** live eval 25/28 — the same three cases as the baseline fail (GOLD-06, GOLD-14, GOLD-19); validator 28/28, intent 27/28. Review scenarios run live against the server: Nitin's reply flagged late with a finish-time question; Ramesh's Hindi update flagged with its ETA; Metro plan ordered (delivery after rate card, billing after delivery) with org-chart Accountables and addressed messages; Sharma plan with the generator in parallel and lawn after chairs. Fixes from this check: empty must-know block removed from the intent prompt (it stopped clarifying questions, GOLD-24); drafts start from the generated short brief; code no longer invents task links from stages (a note instead); server-filled dates marked assumed. Not consistent on flash-lite: asking first for missing facts (Metro asked in 2 of 3 runs). Not verified: the "Kal Sharma ji…" sample without lawn/time (Google timed out 4 times), the hosted demo.

**Later batches (from the same review):**
- Batch 2 — close the tracking loop: raise "behind" to the Accountable person with a suggested fix and link related items (e.g. a late delivery and a spend request for it); count-based progress (20/40); photo checks per step.
- Batch 3 — WhatsApp for staff and owner: Hindi voice-note briefs for "Voice · Hindi" people; owner's daily brief in WhatsApp; reply "1/2/3" to a Boss Review; owner voice note as a brain dump (simulator first; real WhatsApp is 5B).
- Batch 4 — moat: "Save as rule?" from owner edits; ready-made routines; per-person scorecard (on-time rate, reply speed, tomorrow's load); vendors as outside contacts.

## Submission (v1.0-submission, 15 Nov 2026)

Frozen for submission and tagged `v1.0-submission` on `main` (not pushed).

**Pre-submission integrity check** (read-only against the live cloud workspace, plus code and a browser smoke test). Results: people/hierarchy/task-type/RACI/privacy all clean after fixes; all tabs load with no app console errors; the three Meditate assignment spot-checks matched (Mohan Ram / Ramesh Sikhwal / Balbir). Three findings were fixed:
1. **Phone format.** A co-founder's number was stored as a bare 10-digit Indian mobile. Normalised to `91XXXXXXXXXX` across the live workspace (profile, RACI, reporting/partner/works-closely links, WhatsApp history, WBS head, import backup). Code fix: `normalizeIndianPhone` in `src/lib/phoneText.ts` now runs in the setup wizard, roster editor, Team panel and import so no save path can store a bare 10-digit number again (with a test).
2. **"General" task type** added (Minor, no default/backup owner so the AI picks by "what they handle", approval-before-spending on).
3. **`.gitignore`** now ignores `opscommand-backup-*.json` (downloaded workspace backups hold private team details). No secrets or real staff phone numbers are committed; committed `91…`-style numbers are synthetic seed/test data.

**Known limitations (planned, not in v1.0):**
- WhatsApp runs in the **built-in simulator**; real WhatsApp Business Cloud API is **Milestone 5B — next**.
- The **swimlane canvas is not draggable** yet (sub-tasks are edited via cards).
- **Deployment** is planned **after submission** (runs locally and in cloud mode today).
- The production **bundle is not code-split** (build prints a chunk-size warning) — on the "Later" list.

**After the submission freeze, make no code changes unless the owner explicitly asks.**

**Baseline failing cases (flash-lite, free tier, 9 Nov 2026), not fixed:**
- GOLD-06 (daily recurring cold-room log): intent gate called it CASUAL_OR_TEST, so no task was made (expected one QUICK_TASK).
- GOLD-14 (two parallel workstreams): planner merged both workstreams into 1 WBS head (expected 2 heads, 3–4 tasks).
- GOLD-19 (two-head inspection prep): 2 heads but only 2 tasks (expected 4 tasks, one per person).

## Milestone 0 — Fix-ups — Done (9 Nov 2026)
1. ✅ Fix the type error in `src/components/LiveOpsBoardTab.tsx`: the status label map is missing `SCHEDULED`. Add a label ("Scheduled") and a badge style. `npm run lint` must pass with zero errors. — Done: "Scheduled" label with an indigo badge; lint passes with 0 errors.
2. ✔️ `server.ts` registers `app.get('*')` twice. Keep one correct catch-all and make sure API routes still work. — Checked, no change needed: the two catch-alls are in separate branches (development with Vite, production serving `dist/`), so only one is registered. API routes are registered before them and work in development; production mode was not run.
3. ✅ Add a visible indicator in the Meditate tab showing which engine is active (legacy or v2). — Already present before today: "Engine: legacy/v2" badge in the Meditate header.

Added and done the same day (found while testing):

4. ✅ Gemini model names: retired `gemini-2.5-*` names replaced. All defaults live in `src/lib/modelConfig.ts` (flash-lite for intent/inbound, flash for planner; Pro is offered but not a default because the free tier has 0 Pro quota). The "AI Brain & Setup" dropdowns use the same list. Saved settings with retired names are swapped for the defaults. `npm run models:check` lists the models the API key can use.
5. ✅ Meditate hang: every Gemini call is limited to 45 seconds, then the backup model is tried; a model that just hung is skipped for 2 minutes; the browser stops waiting after 3 minutes. Failures show a plain-language message instead of a spinner. Stand-in `@google/genai`, `vite` and `dotenv` replaced with the real packages (`esbuild` raised to ^0.28.0 for Vite 8); `package-lock.json` is the only lock file.
6. ✅ Phone leaks: phone numbers in any format (`+91 98765 00002`, `98765-00002`) are scrubbed before prompts reach the AI. Replies to the owner show names instead of numbers; staff-facing text still blocks any phone number.
7. ✅ Stale topics: Meditate starts with no active WBS head; a "New topic" button clears the active head and earlier chat history; a new plan can no longer overwrite an older head that reuses the same ID.
8. ✅ Due dates: the AI is told today's date; date words ("tomorrow", "Friday", "next week") and past dates the AI guessed become real YYYY-MM-DD dates counted from today in the business timezone (`src/lib/planDates.ts`).

## Milestone 3 — Wire the release engine into the app — Done (14 Nov 2026)
**What was built:** freezing now schedules tasks and the release engine decides when to send them (set time, after another task, when free, owner confirmation, shift, leave, task limit, digest batching). All unlock paths, including completing in the edit form, go through the engine. Release picker on every draft card (business-timezone default; empty or past choices are blocked with a clear message). The pop-up and project badges say "Scheduled for <time>" or "Sent on WhatsApp" truthfully. A Scheduled lane on the Live Ops Board shows each held or waiting task with its planned send time and hold reason. Edits and reassignments re-notify only for tasks already sent, and tell the previous person on a reassignment. `POST /api/jobs/tick` plus a development-only "Run tick" button. Checked in the browser: a task set for 09:00 stays Scheduled until a tick at or after 09:00, and a person at their limit gets a new task only when one of theirs closes.

**Follow-ups (now in the plan):**
- Show the Scheduled lane in the Matrix and Gantt views too (today it is only in the List and Split views) — in "Later".
- Login/tenant check on `POST /api/jobs/tick` — in Milestone 5A.

Original checklist:
The library `src/lib/releaseEngine.ts` exists and is tested but nothing imports it. Connect it — do not rewrite it.
1. `freezeAndDispatchStagingTasks` in `opsEngine.ts` stops sending immediately: set SCHEDULED (or LOCKED_BY_DEPENDENCY for AFTER_TASK), then call `releaseDueTasks` once so NOW tasks still go out straight away.
2. Route the three unlock paths (boss review resolution, WhatsApp completion, manual completion) through the release engine instead of sending directly (use `promoteUnlockedDependentsToScheduled` + `releaseDueTasks`).
3. Release picker on draft task cards in the Meditate tab: Now / At a time / After a task / When free, plus "ask me before sending".
4. "Scheduled" lane or column on the Live Ops Board showing each task's planned release and hold reason.
5. Any edit to a released task (title, steps, deadline, responsible person) re-notifies the person through the simulator and is logged.
6. `POST /api/jobs/tick` in `server.ts` calling `runScheduledJobsTick`; plus a "Run tick now" button for development.
7. Optional setting: batch non-urgent releases into the person's daily digest.
Done when: a task set for "tomorrow 09:00" stays Scheduled until a tick at or after that time; a person at their cap gets new tasks only when one closes; all tests and lint pass.

## Milestone 3.5 — Everyday essentials — Done (14 Nov 2026)
**What was built:** "Cancel" and "Archive" buttons on every Live Ops card (with a confirm). Cancelling sets the task to CANCELLED, tells the person to stop only if it had been sent (short, polite, in their language: English, Hinglish or Hindi), closes its open owner reviews, keeps tasks that wait on it held as "Waiting: parent task cancelled", and frees the slot so a held task goes out. Archive hides finished tasks; on a live task it cancels first. An "Archived" status filter shows them. Replies about a cancelled task are logged only. Each tick sends automatic reminders: released, unfinished tasks only; inside the person's shift on working days; not on leave; never to the owner; after the task's interval (2h Q1 / 4h others by default), counted from the latest of release, last nudge or the person's last update; at most 3 a day (Q1 has no cap); every reminder logged. Decisions: archive works on any task (acts like cancel when live); Q1 reminders have no daily cap; a reply restarts the reminder clock.

Original checklist:
1. **Cancel or archive a live task.**
   - Cancelling notifies the Responsible person on WhatsApp (simulator) that they can stop, frees their task slot so held tasks can release (run the release engine), and is logged on the task.
   - Archived and cancelled tasks leave the active board but stay viewable in an "Archived" filter.
   - Tasks waiting on a cancelled task stay held and show "Waiting: parent task cancelled" until the owner reassigns or cancels them.
2. **Automatic reminders.**
   - Each tick checks released, unfinished tasks against their reminder interval (`reminderConfig`, `lastNudgedAt`) and sends a short nudge.
   - Only inside the person's shift; never more often than the interval allows; at most 3 nudges per task per day. Q1 tasks may nudge more often.
   - Owner tasks are never nudged.
   - Every nudge is logged.

Done when: a cancelled task disappears from the active board, the person is told, and a held task for them releases; a pending task gets a nudge after its interval inside shift hours but not outside them; all tests and lint pass.

## Milestone 3.6 — Edit drafts before sending — Done (14 Nov 2026)
**What was built:** an in-place editor (Edit → Save/Cancel, one column on phones) on the quick-task card, the single-task card and a "Plan tasks" list under each draft plan. Every field can be changed: title, short tag, the exact WhatsApp message (sent word for word; "Reset to generated" goes back), checklist steps (add, remove, move up/down), R/A/C/I from the roster, category, quadrant, major/minor, due date, duration, one-time/recurring, release choice. "+ Add task", "Delete" on a draft task, "Rename" and "Delete plan" (deletes its draft tasks; nothing is sent). The validator runs on every edit and shows red "Fix" and amber "Note" items on the card; send/freeze buttons are disabled and freezing is refused while real errors remain. Draft edits send no WhatsApp messages. Each Save writes an OWNER_EDIT entry to the AI logs (field, AI value, owner value, time) with people as slot IDs and names/phones removed. When Meditate refines a plan, it is told which fields the owner edited and must keep them unless the new message explicitly asks (it must list such changes); the app puts the owner's values back otherwise, keeps deleted tasks deleted and owner-added tasks in place. Decisions: "instructions" means editing the exact message; the AI may change an owner edit only when explicitly asked; deleting a plan deletes its tasks.

Original scope:
**Already possible today (checked 14 Nov 2026):**
- v2 quick-task draft card: title, Responsible, due date, quadrant, add/remove checklist steps, release choice.
- WBS head subtask cards: title (inline), duration, swimlane stage, Responsible, add/remove checklist steps, release choice. Head: hard-deadline toggle and deadline date.
- Not possible yet: short tag, instructions, reordering steps, Accountable / Consulted / Informed, category, major/minor, one-time vs recurring; adding or deleting a draft task; renaming or deleting a head; validation while editing; recording edits; telling the AI to keep the owner's edits.

**Scope:**
1. Edit any draft task before freezing: title, short tag, instructions, checklist steps (add, remove, reorder), Responsible, Accountable, Consulted, Informed (chosen from the team roster), category, Eisenhower quadrant, major/minor, due date, duration, release choice, one-time vs recurring.
2. Add a new task to a plan by hand, delete a draft task, and rename or delete a WBS head (deleting a head asks what to do with its tasks).
3. Run the validator on every edit and show problems on the card (for example: no Responsible, a phone number in the text, a broken dependency). Freezing is blocked only by real errors.
4. Edits to drafts send no WhatsApp messages. Editing already-sent tasks keeps the existing re-notify behaviour.
5. If the owner asks Meditate to refine a plan after editing it, the AI starts from the edited version and must not undo the owner's edits.
6. Record each manual edit (field, AI value, owner value, time) in the AI logs, so corrections can later become golden test cases. No names or phone numbers in those logs.
7. Simple, mobile-friendly editing: edit in place on the card, with Save and Cancel.

Done when: every field above can be changed on a draft, tasks can be added and deleted, heads renamed, and the frozen tasks match the edits exactly; tests, lint and the simulated eval pass; checked in the browser.

## Milestone 4 — My tasks tab — Done (14 Nov 2026)
**What was built:** a "My tasks" tab (badge = total) for people with authority level OWNER. **Do**: open tasks where the owner is Responsible (scheduled ones included), with a tickable checklist. **Decide**: open owner reviews on open tasks, oldest first, with a link to Boss Reviews. **Follow up**: open delegated tasks where the owner is Accountable that are overdue, have had no update for N clock hours (since the person's last WhatsApp update, or since sent), are partly done, or wait for a decision — each with reason badges and Nudge / Open buttons. N is set in AI Brain & Setup → Owner profile (default 24). The owner's daily digest (scheduler tick and the Shift Digest button) is now a three-part summary (own tasks, decisions waiting, follow-ups with reasons) in the owner's language; it is skipped when empty. Owner tasks are still never auto-reminded. Also fixed: the Shift Digest's new daily copies now record their own send time. Decisions: only authority level OWNER counts as the owner; stuck = clock hours, default 24; digest = all three parts. Note: the owner profile has keepsCategories and alwaysDelegatesCategories only — approvalThresholds and ownReminder do not exist yet (they are in "Later").

Original scope:
1. New "My tasks" tab with three sections:
   - **Do** — the owner is Responsible.
   - **Decide** — open Boss Review items.
   - **Follow up** — the owner is Accountable and the task is overdue, stuck longer than a configurable number of hours, partially done, or awaiting a decision.
2. Owner tasks are not nudged like staff tasks; they appear in the owner's digest.

Done when: owner-kept work lands in "Do", open reviews in "Decide", and stuck or overdue delegated work in "Follow up"; all tests and lint pass.

## Milestone 5A — Login and proper storage — Done (14 Nov 2026)
**Cloud check (14 Nov 2026, project commandops-559d7):** passed — Google sign-in; first-run setup saved and reloaded from Firestore (no demo data; local data untouched); two tabs editing different tasks both saved and saw each other's change live; an edit form opened on an older version was refused with "changed in another tab or device" (fix added during the check); cancel and archive saved; sign-out cleared the workspace in both tabs; signed-out calls to the AI endpoints and the tick return 401. **Sign-in allow-list (added 14 Nov 2026):** only Google accounts listed in `ALLOWED_EMAILS` (comma-separated, in `.env`) may sign in; anyone else sees "Not authorised" and is signed out, and every AI, scheduler and auth-check request from them gets 403. Empty or missing means nobody can sign in. Firestore rules cannot read `.env`, so a non-listed account could still reach its own (empty) private workspace directly through the Firebase SDK, but never anyone else's.
**Tick:** `POST /api/jobs/tick` in cloud mode loaded the stored workspace, released a queued task (WhatsApp message and audit entry written) and saved it; the change showed after reload. It first failed with `PERMISSION_DENIED` until the firebase-adminsdk service account was given the IAM roles Cloud Datastore User and Firebase Authentication Admin. At startup the server logs `[firebase-admin] Firestore read check: OK.` and `Firestore write check: OK.` when the key's access is right; a failing tick shows its error in cloud mode instead of silently running in the browser. The three TEST tasks used for the check were cancelled and archived.
**What was built:** with the `VITE_FIREBASE_*` and `FIREBASE_*` values in `.env` the app shows a Google sign-in screen; any Google account gets its own private workspace under `tenants/{uid}/` with one Firestore document per record (settings, members, tasks, wbsHeads, agendas, reviews, buffers, messages, notes, memory, aiLogs), each carrying `tenantId` and a `version`. Saves write only the changed records in a transaction and are refused (with a plain message, then the latest data is shown) when another tab or device changed those records first. Other tabs' changes appear live. A new workspace starts with a first-run setup (business → your role → your people → task types → first tasks in Meditate) and contains no demo data. `firestore.rules` lets only the signed-in owner read/write their workspace. In cloud mode the AI endpoints and `POST /api/jobs/tick` require the user's token; the tick loads the stored workspace, runs, and saves only changed records with the version check. Without the values the app runs in local mode exactly as before. The old pasted-config single-document sync was removed. Decisions: any Google account may sign in (own private workspace); no migration — new workspaces start with the setup; `firebase-admin` with the key in `.env`.

Original checklist:
1. Firebase Authentication (owner login). Local mode keeps working for development.
2. One Firestore document per record under `tenants/{tenantId}/` (profile, tasks, wbsHeads, reviews, buffers, messages, notes, aiLogs) instead of one big document. One-time migration from the old single document.
3. `firestore.rules` so only the signed-in owner of a tenant can read or write it.
4. The tick (`POST /api/jobs/tick`) reads from the stored data instead of server memory, and checks login/tenant before running.
5. Protection against sessions overwriting each other (e.g. per-record writes with a version check, so a stale tab cannot overwrite newer changes).
6. `.env.example` placeholders and README setup steps.
Done when: two browser tabs editing different tasks don't overwrite each other; signed-out access is denied; the tick works from stored data.

## Milestone 5B — Real WhatsApp and the scheduler
1. A `MessageTransport` interface with two implementations: the simulator (default in development) and the WhatsApp Business Platform Cloud API sender. Credentials from environment variables only; approved templates outside the 24-hour window.
2. Inbound webhook endpoint (with verification) that writes incoming messages into the existing 15-minute buffer.
3. Process the WhatsApp buffer automatically when its countdown ends (no button press needed).
4. Never send the plain fallback message before the AI-written message is ready (send one message, not two).
5. Store proof photos/media so the owner can view them from the task.
6. A scheduled job that calls `/api/jobs/tick` every 5 minutes.
7. README steps for creating the Meta app, phone number, templates and webhook.
Done when: a real test phone receives a released task, its reply lands in the buffer and is processed automatically, and a proof photo can be viewed by the owner.

## Later
Not scheduled; pick up after 5B or when needed.
- Delegation and assignee suggestions: `delegateSubtask(parentTaskCode, description, chosenSlot, release)` + a "Delegate a part" button; top-3 assignee suggestions (skills × free capacity × on shift, one-line reason each); child links to parent, parent's Responsible becomes the child's Accountable, goes through the release engine; warning when completing a parent with open children.
- Approval thresholds and the delegation-list editor (keepsCategories / alwaysDelegatesCategories); planner prompt applies the owner rules (owner is Responsible only for keepsCategories or "I'll do it", never for alwaysDelegatesCategories).
- AI-written update, nudge and reassignment messages (today they use fixed templates).
- Work-hours timezone fix in response-time stats.
- Keep media out of browser memory.
- Scheduled lane in the Matrix and Gantt views.
- Screen (UI) and endpoint tests.
- Code-splitting the bundle.
