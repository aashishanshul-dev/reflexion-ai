# What's new since the submission version (for the City Buildathon)

**Previous version:** `v1.0-submission` (15 Nov 2026) — the one in the paper application and on the hosted demo link.
**This version:** `main` as of 20 Nov 2026 — 20 commits, 65 files, about 5,400 lines added. Not deployed yet: the hosted link still shows the old version until this is pushed (see "Run it" below).

## In one line

v1.0 could **plan** work well but was weak at **tracking** it — the half the deck says is where the owner's hours go. This version closes that loop, puts the owner on WhatsApp, adds Hindi voice notes, and the demo now tells the banquet story from the deck.

## Previous vs this version

| Area | v1.0-submission | This version |
|---|---|---|
| Demo story | Water-jar supplier in Pune, English samples | **Banquet & lawns in Jodhpur** (default) with the deck's team (owner + 5) and the Hinglish voice dump "Kal Sharma ji ki shaadi hai…"; water story kept as a switch |
| Deadlines | Date only — "before 11 AM" lived in the title | **Time of day** kept; cards show "Late by 2h 10m" / "Due in 45m" |
| Reading staff replies | Missed delays; asked about the next task's steps | Knows the time and the deadline; flags **Behind**, asks **one** "by when?" question, records the finish time they give |
| When work slips | Nothing happened; Team chart said "On track" | The **Accountable person gets a WhatsApp alert** with the AI's suggested fix and any linked approval in the same job; Team chart says "1 behind"; owner's My tasks shows it |
| Progress | Ticked steps only | **Counts** — "100/250 chairs" |
| Photos | A step could be ticked from text | A photo step stays open until a **photo actually shows** what is needed (Gemini checks the image) |
| Missing facts | Guessed dates and carried on | Asks **one short question** for must-know facts (set per task type); dates nobody gave are marked "assumed" |
| Task order | Everything went out "Now" | The planner sets what waits for what; cards show "After task" |
| Who answers for a task | Always the one default person | Follows the **org chart** (manager, then partner) |
| Names | "Nitin Sharma bhai", owner greeted as a staff member | "**Address as**" per person ("Nitin bhai"); replies to the owner never greet a staff name |
| WhatsApp message | A form ("Due Date: … \| Accountable: …") | **2–3 short lines** in the person's language |
| Owner on WhatsApp | Only the web app | **Own WhatsApp chat:** approvals arrive with numbered answers — reply **1/2/3**; "**brief**" sends today's summary; any other note (typed or spoken) is planned in Meditate |
| Voice | Owner could dictate | Tasks can go to staff as **Hindi voice notes** (Gemini text-to-speech) for people who prefer voice |
| Repeat work | New brain dump every time | **Run now / Run daily** on any task type |
| Owner learning loop | Edits were logged | "**Save as rule?**" after the owner corrects a draft |
| Visibility | Team totals | **Team scorecard** per person: on time, reply speed, behind now, overloaded tomorrow |
| Screens | WBS Heads, Dynamic Swimlane Studio, Freeze & Launch Head | **Projects, Who does what, Approve & send**; swimlane no longer cut off; WhatsApp opens on the unread chat; Shift digest says who got it |
| Models | All Flash-Lite on the free tier (timeouts, no real backup) | Chosen by live evals on a billed key: Flash-Lite to understand and read replies, Flash (capped thinking) to plan with Pro as backup, Gemini TTS for voice |
| Quality | Live eval 25/28, 201 tests | Live eval **27/28**, new reply eval **9/9**, **304 tests**, 0 busy retries |

## Run it (laptop)

1. Unzip, then `npm install`.
2. Create `.env` with `GEMINI_API_KEY=<the billed key>` and `MEDITATE_ENGINE=v2`. Never commit or share this file.
3. `npm run dev`, open `http://localhost:3000/demo` (or the port it prints).
4. Press **Reset Demo** before showing anyone.

To put it on the hosted link: set the billed key as the `GEMINI_API_KEY` secret in Firebase App Hosting, then push `main` to the GitHub repo App Hosting builds from. Checklist in `docs/BUILDATHON.md`.

## Demo

Follow the 4-minute script in **`docs/BUILDATHON.md`** (Meditate sample → Ramesh's Hindi update → voice note → reply "1" in "You (owner)" → photo check → scorecard). The in-app **Walkthrough** button has the same six steps.

Good to know on stage:
- The banquet tasks are due **today** at 4, 5 and 6 PM, so in the evening the cards show "Late by …" — that is part of the story.
- A plan takes about 5–15 seconds; a voice note about 5–8 seconds the first time.
- If the network is bad, switch to the water story in the demo bar — same flow.

## Not done yet (say so if asked)

- Real WhatsApp Business API — WhatsApp runs in the built-in simulator (next milestone, 5B).
- Asking first for missing facts depends on the model; it usually asks, not always.
- Vendors as outside contacts; draggable swimlane.
