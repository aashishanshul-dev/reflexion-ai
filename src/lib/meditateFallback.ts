import type { MeditateAiResponse } from '../types/ops.ts';

/**
 * Honest fallback when the Gemini API is unreachable or GEMINI_API_KEY is not configured.
 * Never invents fake tasks or hardcoded business workflows.
 */
export function buildFallbackMeditateResponse(body: any): MeditateAiResponse {
  const dump: string = String(body?.brainDump || '').trim();
  const reason: string = String(body?.fallbackReason || '').trim();
  const userMessage: string = String(body?.userMessage || '').trim();

  const reply = userMessage
    ? userMessage
    : /JSON/i.test(reason)
    ? 'The AI’s answer came back incomplete, so nothing was changed. Please send it again.'
    : reason
    ? `AI Planner could not reach the Gemini API (${reason}). Please verify your GEMINI_API_KEY or clarify your instructions and try again.`
    : 'Live AI Planner requires a valid GEMINI_API_KEY or clearer instructions to break down this request. Please check your API key configuration or clarify the task details.';

  return {
    intentClassification: 'NEEDS_CLARIFICATION',
    chatReplyToBoss: reply,
    reasoningSummary:
      dump.length > 0
        ? 'No fake tasks generated: live Gemini API was unavailable or needed clarification.'
        : 'Empty input received.',
    agendaTitle: 'Clarification / API Setup Needed',
    agendaQuadrant: 'Q2_SCHEDULE',
    agendaMajorOrMinor: 'MINOR',
    wbsHeads: [],
    suggestedMemoryRules: [],
    draftedTasks: [],
    modelUsed: 'honest-fallback (no-fake-tasks)',
  };
}
