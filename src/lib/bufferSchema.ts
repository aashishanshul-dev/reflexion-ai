/**
 * The JSON shape Gemini returns when reading a staff WhatsApp batch. Shared by the
 * server endpoint and the reply eval so both test the same contract.
 */
import { Type } from '@google/genai';

export const BUFFER_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    matchedTaskCode: { type: Type.STRING, nullable: true },
    englishBossSummary: { type: Type.STRING },
    mediaVerificationNote: { type: Type.STRING },
    updatedMicroSteps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          status: { type: Type.STRING, enum: ['PENDING', 'DONE', 'MISSED'] },
          evidenceNote: { type: Type.STRING },
          doneCount: { type: Type.INTEGER, nullable: true },
          photoShows: { type: Type.BOOLEAN, nullable: true },
        },
        required: ['id', 'status'],
      },
    },
    completionPercent: { type: Type.INTEGER },
    missingStepsAlert: { type: Type.STRING },
    whatsappReplyInPreferredLanguage: { type: Type.STRING },
    escalateToBossReview: { type: Type.BOOLEAN },
    escalationSignal: {
      type: Type.STRING,
      enum: [
        'NONE',
        'REFUSAL',
        'ON_LEAVE',
        'TIMELINE_SLIP',
        'REASSIGNMENT',
        'BLOCKER',
        'CAPACITY',
        'CONFUSION',
      ],
      nullable: true,
    },
    staffQuote: { type: Type.STRING, nullable: true },
    reviewType: {
      type: Type.STRING,
      enum: [
        'BUDGET_APPROVAL',
        'DESIGN_SELECTION',
        'PARTIAL_HANDOVER_GATE',
        'BLOCKER_ESCALATION',
      ],
    },
    aiSuggestedReplies: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    delayReported: { type: Type.BOOLEAN },
    reportedEta: { type: Type.STRING, nullable: true },
    suggestedFix: { type: Type.STRING, nullable: true },
  },
  required: [
    'matchedTaskCode',
    'englishBossSummary',
    'mediaVerificationNote',
    'updatedMicroSteps',
    'completionPercent',
    'missingStepsAlert',
    'whatsappReplyInPreferredLanguage',
    'escalateToBossReview',
    'delayReported',
  ],
};
