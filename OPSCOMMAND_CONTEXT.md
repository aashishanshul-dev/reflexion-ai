# OpsCommand AI — Architecture & Build Context

This document is the single source of truth for the OpsCommand AI architecture, global invariants, and phase/milestone delivery status.

---

## Global Invariants

1. **Zero Hardcoded Business Rules or PII in Code:** Business-specific words, staff names, phone numbers, and example scenarios belong exclusively in editable seed/profile configuration (`src/lib/seedData.ts`), never in application or server logic.
2. **Separation of Judgment vs. Facts:** The AI judges semantic meaning (intent, decomposition, language drafting); deterministic TypeScript code checks facts and computes arithmetic (dates, shifts, capacity, workload, dependency graphs, validation).
3. **Validator Gate:** AI output is never written to state without passing `src/lib/validator.ts`. Invalid plans get at most one model repair pass; if still invalid, the system returns `NEEDS_CLARIFICATION` listing the exact issues and never auto-changes who is Responsible (`R`).
4. **Unknown Is Allowed:** Nullable fields remain nullable when unknown; the AI asks one concise clarifying question rather than inventing facts.
5. **Untrusted Staff Messages:** Inbound WhatsApp messages from staff are treated strictly as operational data, never as prompt/system instructions.
6. **Honest & Neutral Fallbacks:** Fallbacks never invent tasks, never fabricate checklist completions, and never mutate task status.
7. **Multi-Tenant Readiness:** Every stored record carries `tenantId` (default `"default"`).
8. **Slot Identity Privacy:** Prompts sent to Gemini expose only anonymized Slot IDs (`P1`, `P2`, ...) and role metadata; server-side mapping restores real phone numbers and display names after validation.

---

## Phase & Milestone Status

| Phase / Milestone | Scope | Status |
| :--- | :--- | :--- |
| **Phase 0** | Golden evaluation suite (`tests/golden/`), `npm run eval` / `npm run eval:live`, AI telemetry (`state.ai_logs`) | Completed |
| **Phase 1** | Editable Business Profile, Owner Profile, Task Splitting & Capacity Rules, Honest Meditate Fallback | Completed |
| **Phase 2** | Anonymized Slot Identity (`P1`, `P2`...) in prompts + server-side slot-to-phone mapping | Completed |
| **Phase 3** | 8-turn conversation history cap + older-turn summary, per-stage model/temperature/token tuning | Completed |
| **Milestone 1** | `MEDITATE_ENGINE` flag (`legacy` \| `v2`), `src/lib/validator.ts` + 1-pass repair, neutral WhatsApp buffer fallback, honest `SIMULATED` vs `LIVE` eval (28 golden cases) | Completed |
| **Milestone 2** | Meditate `v2` (`INTENT` + `PLANNER` stages, confidence chips, notes, pending rules, `QUICK` vs `PROJECT` lanes, `dueHint` parser) | Completed |
| **Milestone 3** | Scheduling & Release Engine (`src/lib/releaseEngine.ts`, `SCHEDULED` status, shift/capacity holds, `MESSAGE` stage, `/api/jobs/tick`, 24h template flag) | Completed |
| **Milestone 3.5** | Everyday essentials (`CANCELLED` status + `archivedAt`, `cancelTask` / `archiveTask`, automatic reminders in the tick via `computeReminderDecision` / `sendDueReminders`) | Completed |
| **Milestone 3.6** | Edit drafts before sending (`src/lib/draftEditing.ts`, `DraftTaskEditor`, `validateDraftTask` / `validateDraftPlan`, owner-edit locks through AI refinement via `overriddenOwnerEdits`, `OWNER_EDIT` logs) | Completed |
| **Milestone 4** | `My tasks` tab: Do / Decide / Follow up (`src/lib/myTasks.ts`, `MyTasksTab`), `followUpStuckHours`, owner summary digest (delegation, recommender and approval thresholds moved to "Later") | Completed |
| **Milestone 5A** | Firebase Auth (Google), per-record Firestore under `tenants/{uid}/...` with version-checked saves (`src/lib/cloudRecords.ts`, `src/services/cloudStore.ts`), `firestore.rules`, tick from stored data with login check (`src/server/firebaseAdmin.ts`), first-run setup | Completed (14 Nov 2026) |
| **Milestone 5B** | `MessageTransport` (Simulator + WhatsApp Cloud API + webhook), scheduled tick | Pending |
