# City Buildathon kit — reflexion.ai (OpsCommand AI)

Two days, one working prototype on Google's stack, a live demo to the jury. This page is the script, the proof points and the checklist. Everything below runs in the app today.

## The 4-minute live demo (banquet story, the default demo)

Open `/demo`, enter, keep **Walkthrough** open. Times are rough.

| # | Show | Say | Jury point |
|---|---|---|---|
| 1 (0:00) | Meditate → tap **"Kal Sharma ji ki shaadi hai…"** (or speak it) | "I talk like this all day. It asks the one thing it can't guess — which lawn, what time — then drafts tasks for Ramesh, Suresh and Mahesh." | Live Gemini output, real user interaction |
| 2 (0:50) | The draft cards: owner, Accountable, due time, short Hindi/Hinglish message | "Code checks every AI plan: who answers for it comes from my org chart, times are real, nothing invented." | Gemini is the core, not a wrapper |
| 3 (1:20) | WhatsApp → Ramesh → **Flush & Evaluate** | "Ramesh wrote in Hindi: 100 chairs up, 150 at 7. It counted 100/250, flagged the 6 PM setup behind, asked him one question — and told Pooja, linking Suresh's pending chair approval." | Track half of the product, multimodal reading |
| 4 (2:10) | Ramesh's task → **Hear as voice note** | "Ramesh prefers voice. Gemini reads his task in Hindi. Names never leave our server." | Gemini TTS, privacy |
| 5 (2:40) | WhatsApp → **You (owner)** → reply **1** | "I never open the web app if I don't want to. The approval came to my WhatsApp; '1' approves and Suresh is told." | Owner on WhatsApp |
| 6 (3:10) | Mahesh says "done" without a photo → task stays open, he's asked for the fuel-gauge photo | "A photo counts as proof; text alone doesn't close a photo step." | Gemini vision as a gate |
| 7 (3:30) | 2x2 Matrix & Team → **Team scorecard**; AI Brain → **Run daily** on a task type | "Who's behind, who's overloaded tomorrow; repeat work runs without a new brain dump." | Commercial value |

Fallback if the network is slow: the water-supplier story (switch in the demo bar) shows the same flow with Nitin's "second trip" reply.

## Google stack (what to say when asked)

| Where | Google piece | Why that model |
|---|---|---|
| Is this a task, a note, a rule? What's missing? | Gemini **Flash-Lite** (backup Flash) | Most consistent judge in our live eval (Flash for this step scored lower) |
| Turning a brain dump into tasks | Gemini **Flash**, thinking capped at 1,024 tokens (backup **Pro**) | Fixed multi-person plans; capped thinking keeps it ~3× faster |
| Reading staff WhatsApp text, voice notes and photos | Gemini **Flash-Lite** (backup Flash) | 9/9 on our reply eval at 1.7 s (Flash: 9/9 at 12.3 s) |
| Task messages | Gemini Flash-Lite | Short, in each person's language |
| Voice notes to staff | **Gemini 3.8 Flash-Lite TTS** (backup 3.8 Flash TTS) | Hindi voice briefs, made on demand |
| Sign-in and data | **Firebase Authentication** (Google), **Cloud Firestore** (one private workspace per owner) | |
| Hosting | **Firebase App Hosting** (`apphosting.yaml`) | |
| Built with | **Google AI Studio**, Gemini API via the Google Gen AI SDK | |

Evals you can quote: golden plan eval **27/28 live** (`npm run eval -- --live`; baseline was 25/28), reply eval **9/9 live** (`npm run eval:replies`), **304 unit tests**, simulated pipeline eval 28/28.

## Where else this applies (configuration only, no code changes)

Any owner-led team of 5–50 that works on WhatsApp: caterers and banquets (demo 1), distributors and delivery (demo 2), hotels and restaurants, contractors and interior firms (site photos as proof), clinics and labs (sample pickup, calibration), schools and coaching centres (admin, fees), retail chains (opening checklist as a daily routine), small manufacturers (job cards, QC photos). A business only fills in its team, task types (steps, default person, must-know facts, approval rule) and rules.

## Pricing and go-to-market (from the deck)

Free tier (one owner, capped tasks, daily brief on WhatsApp) → **₹499/month** for owner + 5 staff → ₹1,499 Pro. Model cost ≈ ₹0.40 per plan; replies and voice notes are a fraction of that. First 50 pilots through the founder's hospitality network and trade associations in Rajasthan, then accountants and software resellers.

## Deploy checklist (Day 2 morning)

1. **Billing key on the host.** In Firebase → App Hosting → your backend, set the `GEMINI_API_KEY` secret to the key whose project has billing on (Pro must answer). Keep `MEDITATE_ENGINE=v2`.
2. **Push the code.** App Hosting builds from the connected GitHub repo. This folder is a local git repo with no remote: add the repo as `origin` and push `main` (your call — nothing has been pushed).
3. **Allow-list.** `ALLOWED_EMAILS` in `apphosting.yaml` lists who can sign in; `/demo` needs no sign-in.
4. **Smoke test the live URL:** `/demo` → Reset Demo → steps 1–6 above. Check one voice note plays.
5. **Before judging:** Reset Demo so the story starts clean; keep the water story as a backup.

## For the mentors (what's open)

- Real WhatsApp Business API (Milestone 5B): today WhatsApp runs in the built-in simulator; the message transport is one interface away.
- Asking first for missing facts is model-dependent (Metro sample asked in 2 of 3 runs on Flash-Lite).
- Vendors as outside contacts (three-quotes flow end to end) is not built.
- The swimlane is not draggable; the bundle is not code-split.
