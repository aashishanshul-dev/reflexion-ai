import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Calendar,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Layers,
  Mic,
  MicOff,
  MoveHorizontal,
  Plus,
  Send,
  Sparkles,
  Trash2,
  User,
  Users,
  Zap,
} from 'lucide-react';
import {
  AiCallLogEntry,
  CategorySop,
  Classification,
  DependencyTrigger,
  MeditateAiResponse,
  MeditateConfirmChip,
  DraftEditableField,
  FreezeDispatchResult,
  MeditateDraftTaskInput,
  OwnerEditOverride,
  MeditateIntentClassification,
  MeditateV2IntentKind,
  MeditateV2Lane,
  MeditateV2RouteOutcome,
  OpsDatabaseState,
  Quadrant,
  RecurrenceRule,
  SystemMemoryCategory,
  TaskFrequency,
  TaskReleaseConfig,
  WbsHead,
} from '../types/ops';
import { DraftReleasePicker } from './DraftReleasePicker';
import { BrandEmptyState } from './BrandLogo';
import { addDaysIso, businessTodayIso, normalizeMeditatePlanDates } from '../lib/planDates';
import { applyAiTaskOrder, toShortHeadId } from '../lib/planOrder';
import { suggestRuleFromOwnerEdit, type RuleSuggestion } from '../lib/ruleSuggestions';
import { formatDueLabel } from '../lib/taskTiming';
import {
  computeDueDate,
  computeStartDateFromDeadline,
  generateOutboundWhatsappMessage,
  getActiveTaskWorkload,
  recalculateWbsHeadDates,
} from '../lib/opsEngine';
import {
  addDraftToHead,
  applyDraftEdit,
  buildDraftValidationContext,
  buildManualEditLog,
  deleteDraftHead,
  DraftEditPatch,
  isQuickDraftHeadId,
  mergeRefinedHead,
  mergeRefinedQuickDraft,
  newBlankDraft,
  quickDraftAsHead,
  removeDraftFromHead,
  renameHead, withGeneratedDraftMessages } from '../lib/draftEditing';
import { DraftTaskEditor } from './DraftTaskEditor';
import { summarizeWbsHeadRelease } from '../lib/releaseEngine';
import { runMeditateAgentApi } from '../services/dataService';
import { useVoiceRecorder } from '../lib/useVoiceRecorder';
import {
  buildValidationFailureClarification,
  validateDraftPlan,
  validateDraftTask,
  validateMeditatePlan,
} from '../lib/validator';

interface MeditateStudioTabProps {
  state: OpsDatabaseState;
  onFreezeAndDispatch: (
    drafts: MeditateDraftTaskInput[],
    agenda?: {
      title: string;
      rawBrainDump: string;
      quadrant: Quadrant;
      majorOrMinor: Classification;
    },
    wbsHead?: any
  ) => FreezeDispatchResult;
  onSaveMemoryRule: (category: SystemMemoryCategory, fact: string, approved?: boolean) => void;
  onAddNote?: (text: string) => void;
  onDeleteNote?: (noteId: string) => void;
  onUpdateWbsHeads: (heads: WbsHead[]) => void;
  onAppendAiLog?: (log: AiCallLogEntry) => void;
  onNotify: (message: string) => void;
  prefillPrompt?: { text: string; nonce: number; autoSend?: boolean } | null;
  onAiCallTriggered?: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  intentClassification?: MeditateIntentClassification;
  v2Route?: MeditateV2RouteOutcome;
  lane?: MeditateV2Lane;
  confirmChips?: MeditateConfirmChip[];
  confirmedChipKind?: MeditateV2IntentKind;
  sourceBrainDump?: string;
  priorMissingCritical?: string[];
  priorFollowUpForHeadId?: string | null;
  taskCount?: number;
}


/** Swimlane columns: a person column, then one column per stage (each at least 180px). */
function swimlaneGridStyle(stageCount: number): React.CSSProperties {
  return { gridTemplateColumns: `200px repeat(${Math.max(1, stageCount)}, minmax(180px, 1fr))` };
}

/** The table is as wide as its columns need (never less than 760px), so it scrolls instead of clipping. */
function swimlaneTableStyle(stageCount: number): React.CSSProperties {
  return { minWidth: `${Math.max(760, 200 + Math.max(1, stageCount) * 192)}px` };
}

export const MeditateStudioTab: React.FC<MeditateStudioTabProps> = ({
  state,
  onFreezeAndDispatch,
  onSaveMemoryRule,
  onAddNote,
  onDeleteNote,
  onUpdateWbsHeads,
  onAppendAiLog,
  onNotify,
  prefillPrompt,
  onAiCallTriggered,
}) => {
  const [studioMode, setStudioMode] = useState<'CHAT_MEDITATE' | 'QUICK_ADHOC'>('CHAT_MEDITATE');
  // Start with no active head: a new request starts a new plan unless the owner
  // picks a head to refine (or the AI just created one in this conversation).
  const [activeHeadId, setActiveHeadId] = useState<string | null>(null);
  const [showSwimlaneForSingleTask, setShowSwimlaneForSingleTask] = useState<boolean>(false);

  // "Today" in the business timezone (not UTC), so near midnight dates don't shift by a day.
  const businessTimezone = state.business_profile?.timezone;
  const todayDate = useMemo(() => businessTodayIso(businessTimezone), [businessTimezone]);
  const membersList = useMemo(() => Object.values(state.team_members), [state.team_members]);
  const staffMembers = useMemo(
    () => membersList.filter((m) => !m.isOnLeave),
    [membersList]
  );
  const sampleBrainDumps = useMemo(() => state.sample_brain_dumps || [], [state.sample_brain_dumps]);

  // WBS Heads list (from state or seeded)
  const [wbsHeads, setWbsHeads] = useState<WbsHead[]>(() => {
    if (state.wbs_heads && state.wbs_heads.length > 0) {
      return state.wbs_heads;
    }
    return [];
  });

  const updateAndSyncWbsHeads = (newHeads: WbsHead[]) => {
    setWbsHeads(newHeads);
    onUpdateWbsHeads?.(newHeads);
  };

  // Sync wbsHeads with state if changed remotely
  useEffect(() => {
    if (state.wbs_heads && state.wbs_heads.length > 0) {
      setWbsHeads((prev) => {
        // Keep any active in-memory updates if head matches
        const existingMap = new Map(prev.map((h) => [h.headId, h]));
        return state.wbs_heads.map((sh) => existingMap.get(sh.headId) || sh);
      });
    }
  }, [state.wbs_heads]);

  // Chat conversation state
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: 'init-1',
      role: 'assistant',
      text: state.business_profile?.businessName
        ? `Namaste! Tell me what needs doing at ${state.business_profile.businessName} — by voice or text, in Hindi, Hinglish or English. I will turn it into tasks with the right person, steps and a time, and ask one short question if something is missing.`
        : 'Namaste! Tell me what needs doing — by voice or text, in Hindi, Hinglish or English. I will turn it into tasks with the right person, steps and a time, and ask one short question if something is missing.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [inputVal, setInputVal] = useState('');
  const [isMeditating, setIsMeditating] = useState(false);

  useEffect(() => {
    if (!prefillPrompt?.text) return;
    setStudioMode('CHAT_MEDITATE');
    if (prefillPrompt.autoSend) {
      // A note the owner sent on WhatsApp: plan it straight away.
      void handleSendChatMessage(prefillPrompt.text);
      return;
    }
    setInputVal(prefillPrompt.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillPrompt]);
  // Index into `messages` where the current topic begins; earlier turns are not
  // sent as conversation history, so an old topic can't steer a new request.
  const [topicStartIndex, setTopicStartIndex] = useState(0);
  const hasTopicContext = Boolean(activeHeadId) || messages.length > topicStartIndex + 1;
  const [selectedSwimlaneTaskId, setSelectedSwimlaneTaskId] = useState<string | null>(null);

  const formatReleaseBadge = (release?: { mode?: string }): string => {
    switch (release?.mode) {
      case 'SCHEDULED':
        return 'Scheduled';
      case 'AFTER_TASK':
        return 'After task';
      case 'WHEN_FREE':
        return 'When free';
      case 'OWNER_CONFIRM':
        return 'Confirm';
      default:
        return 'Now';
    }
  };

  const handleSelectSwimlaneCard = (tempId: string) => {
    setSelectedSwimlaneTaskId(tempId);
    requestAnimationFrame(() => {
      document.getElementById(`draft-editor-${tempId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    });
  };

  const handleStartNewTopic = () => {
    setActiveHeadId(null);
    setShowSwimlaneForSingleTask(false);
    const divider: ChatMessage = {
      id: `topic-${Date.now()}`,
      role: 'assistant',
      text: 'New topic started. Your next message will be planned from scratch.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    // History for the next request starts after this divider message.
    setTopicStartIndex(messages.length + 1);
    setMessages((prev) => [...prev, divider]);
    onNotify('New topic: the next message starts a new plan.');
  };
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  // Tentative Staging State (fallback direct staging)
  const [stagingDrafts, setStagingDrafts] = useState<MeditateDraftTaskInput[]>([]);
  const [agendaMeta, setAgendaMeta] = useState<{
    title: string;
    quadrant: Quadrant;
    majorOrMinor: Classification;
  } | null>(null);
  const [suggestedRules, setSuggestedRules] = useState<
    Array<{ category: SystemMemoryCategory; fact: string; saved?: boolean }>
  >([]);
  const [newStepInputs, setNewStepInputs] = useState<Record<string, string>>({});

  // Meditate v2 Quick Lane Single-Task Review Card State (no extra WBS heads)
  const [v2QuickDraft, setV2QuickDraft] = useState<MeditateDraftTaskInput | null>(null);
  const [v2QuickRawDump, setV2QuickRawDump] = useState<string>('');
  const [v2QuickNewStep, setV2QuickNewStep] = useState<string>('');

  // Meditate Notes State
  const [manualNoteText, setManualNoteText] = useState<string>('');
  const notesList = useMemo(() => state.notes || [], [state.notes]);

  // Quick Ad-Hoc Form State
  const [quickTitle, setQuickTitle] = useState('');
  const [quickTag, setQuickTag] = useState('');
  const [quickCategory, setQuickCategory] = useState('AD_HOC');
  const [quickQuadrant, setQuickQuadrant] = useState<Quadrant>('Q1_DO_FIRST');
  const [quickClass, setQuickClass] = useState<Classification>('MINOR');
  const [quickFreq, setQuickFreq] = useState<TaskFrequency>('ONE_TIME');
  const [quickRecurrence, setQuickRecurrence] = useState<RecurrenceRule>('DAILY');
  const [quickR, setQuickR] = useState(() => staffMembers[0]?.phone || membersList[0]?.phone || '');
  const [quickA, setQuickA] = useState(
    () => state.owner_profile?.defaultAccountablePhone || staffMembers[0]?.phone || membersList[0]?.phone || ''
  );
  const [quickDueDate, setQuickDueDate] = useState(todayDate);
  const [quickChecklistLine, setQuickChecklistLine] = useState('');
  const [quickRelease, setQuickRelease] = useState<Partial<TaskReleaseConfig>>({ mode: 'NOW' });
  const [quickError, setQuickError] = useState('');

  // 0-Token Web Dictation Hook (final results only; interim shown separately)
  const {
    isRecording: isListening,
    recordingSeconds: listeningSeconds,
    isSupported: isVoiceSupported,
    interimTranscript,
    errorMessage: voiceErrorMessage,
    toggleRecording,
    stopRecording,
  } = useVoiceRecorder({
    lang: 'en-IN',
    onNotify,
  });

  // Auto-scroll chat
  useEffect(() => {
    chatScrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isMeditating]);

  const toggleVoiceRecording = async () => {
    await toggleRecording(inputVal, (newText) => {
      setInputVal(newText);
    });
  };

  // Currently active WBS Head
  // Quotes in the AI's override list use slot IDs ({{P2}}); show team names to the owner.
  const ownerOverridesWithNames = (
    overrides: OwnerEditOverride[] | undefined
  ): OwnerEditOverride[] => {
    const bySlot = new Map(Object.values(state.team_members).map((m) => [m.slotId, m.name]));
    return (overrides || []).map((o) => ({
      ...o,
      quote: o.quote?.replace(/\{\{\s*(P\d+)\s*\}\}/g, (_, slot) => bySlot.get(slot) || slot),
    }));
  };

  const currentHead = useMemo(() => {
    return activeHeadId ? wbsHeads.find((h) => h.headId === activeHeadId) || null : null;
  }, [wbsHeads, activeHeadId]);

  // A staged quick task is sent to Meditate as a one-task plan, so a follow-up can refine it
  // (and keep the owner's edits). Never stored as a head.
  const quickRefineHead = useMemo(
    () => (v2QuickDraft && !activeHeadId ? quickDraftAsHead(v2QuickDraft) : null),
    [v2QuickDraft, activeHeadId]
  );

  const applyValidatedMeditateResponse = (
    aiRes: MeditateAiResponse,
    sourceText: string
  ) => {
    if (Array.isArray(aiRes.aiLogs) && aiRes.aiLogs.length > 0) {
      for (const entry of aiRes.aiLogs) {
        onAppendAiLog?.(entry);
      }
    } else if (aiRes.aiLog) {
      onAppendAiLog?.(aiRes.aiLog);
    }

    // Date words from the AI ("Tomorrow", "Friday", "next week") become real dates
    // in the business timezone before anything is validated or saved.
    const datedRes = normalizeMeditatePlanDates(aiRes, {
      timezone: businessTimezone,
      sourceText,
    });

    // Client-side validator gate: AI output is never written to state without passing the validator
    const clientValidation = validateMeditatePlan(datedRes, {
      roster: membersList,
      categoryIds: state.category_sops.map((c) => c.categoryId),
      existingTasks: state.tasks,
      defaultAccountablePhone: state.owner_profile?.defaultAccountablePhone,
      ownerProfile: state.owner_profile,
      maxChecklistStepsPerTask: state.task_splitting_rules?.maxChecklistStepsPerTask ?? 5,
      allowResolvedPhonesInRaci: true,
    });

    const safeAiRes: MeditateAiResponse = clientValidation.valid
      ? (clientValidation.normalizedPlan as MeditateAiResponse)
      : buildValidationFailureClarification(clientValidation.issues);

    const replyText = safeAiRes.chatReplyToBoss || safeAiRes.reasoningSummary;
    const tasksCount = Array.isArray(safeAiRes.draftedTasks) ? safeAiRes.draftedTasks.length : 0;

    const assistantMsg: ChatMessage = {
      id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      text: replyText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      intentClassification: safeAiRes.intentClassification,
      v2Route: safeAiRes.v2Route,
      lane: safeAiRes.lane,
      confirmChips:
        safeAiRes.v2Route === 'AWAIT_OWNER_CONFIRMATION' &&
        Array.isArray(safeAiRes.confirmChips) &&
        safeAiRes.confirmChips.length > 0
          ? safeAiRes.confirmChips
          : undefined,
      sourceBrainDump: sourceText,
      priorMissingCritical: safeAiRes.v2Intent?.missingCritical || [],
      priorFollowUpForHeadId: safeAiRes.v2Intent?.followUpForHeadId ?? null,
      taskCount: tasksCount,
    };
    setMessages((prev) => [...prev, assistantMsg]);

    // Meditate v2 non-task side-effects (only after passing validator)
    if (safeAiRes.v2Route === 'SAVE_NOTE' && safeAiRes.noteToSave?.text) {
      onAddNote?.(safeAiRes.noteToSave.text);
      onNotify('Saved note to Meditate Notes.');
    }

    if (safeAiRes.v2Route === 'STAGE_PENDING_RULE' && safeAiRes.pendingRuleToSave?.fact) {
      onSaveMemoryRule(
        safeAiRes.pendingRuleToSave.category,
        safeAiRes.pendingRuleToSave.fact,
        false
      );
      onNotify(
        'Added pending rule (approved=false). Review & approve it in AI Brain & Setup → System Memory.'
      );
    }

    if (tasksCount > 0) {
      const batchTs = Date.now();
      const totalDrafted = safeAiRes.draftedTasks.length;
      // When refining the active plan, keep the tempIds the AI echoed for existing tasks so
      // the owner's edits can be matched; everything else gets a fresh tempId.
      const refinableIds = new Set([
        ...(currentHead?.subTasks || []).map((st) => st.tempId),
        ...(currentHead?.ownerDeletedTempIds || []),
        ...(quickRefineHead ? [quickRefineHead.subTasks[0].tempId] : []),
      ]);
      const draftTempIds = safeAiRes.draftedTasks.map((t, idx) =>
        t.tempId && refinableIds.has(t.tempId) ? t.tempId : `draft-${batchTs}-${idx}`
      );
      const aiParsedDrafts: MeditateDraftTaskInput[] = safeAiRes.draftedTasks.map((t, idx) => {
        const tAny = t as any;
        const offset = typeof t.dueDateOffsetDays === 'number' ? t.dueDateOffsetDays : 0;
        const due = tAny.dueDate || addDaysIso(todayDate, offset);
        return {
          tempId: draftTempIds[idx],
          title: t.title,
          shortTag: t.shortTag || t.title.split(/[:\-–]/)[0].trim().slice(0, 20) || 'Task',
          categoryId: t.categoryId,
          quadrant: t.quadrant,
          majorOrMinor: t.majorOrMinor,
          taskFrequency: t.taskFrequency,
          recurrenceRule: t.recurrenceRule,
          raci: t.raci,
          dependsOnTempIdOrTaskCode:
            typeof t.dependsOnSubtaskIndex === 'number' &&
            t.dependsOnSubtaskIndex >= 0 &&
            t.dependsOnSubtaskIndex < totalDrafted &&
            t.dependsOnSubtaskIndex !== idx
              ? draftTempIds[t.dependsOnSubtaskIndex]
              : null,
          triggerCondition: t.triggerCondition,
          startDate: t.startDate || todayDate,
          durationDays: t.durationDays || 1,
          dueDate: due,
          dueTime: t.dueTime ?? null,
          dueDateAssumed: Boolean(t.dueDateAssumed),
          dueHint: t.dueHint ?? null,
          isForcedDeadline: !!t.isForcedDeadline,
          forcedDeadlineDate: t.forcedDeadlineDate || null,
          wbsHeadId: t.wbsHeadId || null,
          swimlaneStage: t.swimlaneStage || '',
          microSteps: t.microSteps || [],
          outboundWhatsappPreview: t.outboundWhatsappPreview,
          assignmentReason: (t as any).assignmentReason || undefined,
        };
      });
      // Start every draft from the generated short brief (addressed, steps, due time).
      const parsedDrafts = withGeneratedDraftMessages(aiParsedDrafts, state.team_members);

      setStagingDrafts(parsedDrafts);
      setAgendaMeta({
        title: safeAiRes.agendaTitle,
        quadrant: safeAiRes.agendaQuadrant,
        majorOrMinor: safeAiRes.agendaMajorOrMinor,
      });

      if (safeAiRes.suggestedMemoryRules && safeAiRes.suggestedMemoryRules.length > 0) {
        setSuggestedRules(safeAiRes.suggestedMemoryRules.map((r) => ({ ...r, saved: false })));
      }

      // Meditate v2 QUICK lane: single task card with one-tap "Send" and NO extra WBS heads
      if (safeAiRes.lane === 'QUICK' && parsedDrafts.length === 1) {
        const refinedDraft = { ...parsedDrafts[0], wbsHeadId: null };
        // Refining the staged quick task: keep the owner's edits, exactly like plans.
        const singleDraft =
          (v2QuickDraft &&
            mergeRefinedQuickDraft({
              previous: v2QuickDraft,
              refined: refinedDraft,
              overrides: ownerOverridesWithNames(safeAiRes.overriddenOwnerEdits),
              teamMembers: state.team_members,
            })) ||
          refinedDraft;
        setV2QuickDraft(singleDraft);
        setV2QuickRawDump(sourceText);
        onNotify(`Staged Quick Task "${singleDraft.title}" — review and tap Send.`);
        return;
      }

      setV2QuickDraft(null);

      // Integrate with WBS Heads (PROJECT lane & legacy flow)
      if (safeAiRes.wbsHeads && safeAiRes.wbsHeads.length > 0) {
        const totalHeads = safeAiRes.wbsHeads.length;
        // The AI sometimes reuses an existing head ID for an unrelated request. Only the
        // head being refined may be replaced; any other clash gets a fresh ID so a new
        // topic never overwrites an old plan.
        const existingHeadIds = new Set(wbsHeads.map((h) => h.headId));
        const takenHeadIds = new Set(existingHeadIds);
        const finalHeadId = (rawId: string) => {
          const base = isQuickDraftHeadId(rawId)
            ? `HEAD-${batchTs.toString(36).toUpperCase()}` // quick task grown into a plan
            : existingHeadIds.has(rawId) && rawId !== activeHeadId
              ? `${rawId}-${batchTs.toString(36).slice(-5).toUpperCase()}`
              : rawId;
          if (base === activeHeadId) return base; // refining: keep the plan's own label
          // Short readable label (HEAD-3) instead of a raw AI-made ID.
          const short = toShortHeadId(base, takenHeadIds);
          takenHeadIds.add(short);
          return short;
        };

        const populatedHeads: WbsHead[] = safeAiRes.wbsHeads.map((rawHead) => {
          const headId = finalHeadId(rawHead.headId);
          const stages =
            rawHead.dynamicStages && rawHead.dynamicStages.length > 0
              ? rawHead.dynamicStages
              : ['Procurement', 'Dispatch', 'Execution', 'Verification'];

          let matchedDrafts = parsedDrafts.filter(
            (d) => d.wbsHeadId === rawHead.headId || (!d.wbsHeadId && totalHeads === 1)
          );

          if (
            matchedDrafts.length === 0 &&
            Array.isArray(rawHead.subTasks) &&
            rawHead.subTasks.length > 0
          ) {
            matchedDrafts = rawHead.subTasks.map((st: any, stIdx: number) => ({
              tempId: st.tempId || `draft-${rawHead.headId}-${Date.now()}-${stIdx}`,
              title: st.title,
              shortTag:
                st.shortTag || st.title?.split(/[:\-–]/)[0]?.trim()?.slice(0, 20) || 'Task',
              categoryId: st.categoryId || rawHead.domainCategory || 'MAINTENANCE',
              quadrant: st.quadrant || rawHead.quadrant || 'Q1_DO_FIRST',
              majorOrMinor: st.majorOrMinor || rawHead.majorOrMinor || 'MAJOR',
              taskFrequency: st.taskFrequency || 'ONE_TIME',
              recurrenceRule: st.recurrenceRule || 'NONE',
              raci: st.raci,
              dependsOnTempIdOrTaskCode: st.dependsOnTempIdOrTaskCode || null,
              triggerCondition: st.triggerCondition || 'FULL_COMPLETION',
              startDate: st.startDate || todayDate,
              durationDays: st.durationDays || 1,
              dueDate: st.dueDate || rawHead.tentativeDeadline || todayDate,
              dueTime: st.dueTime ?? null,
              dueDateAssumed: Boolean(st.dueDateAssumed),
              isForcedDeadline: !!st.isForcedDeadline,
              forcedDeadlineDate: st.forcedDeadlineDate || null,
              wbsHeadId: rawHead.headId,
              swimlaneStage: st.swimlaneStage || stages[stIdx % stages.length],
              microSteps: st.microSteps || [],
              outboundWhatsappPreview: st.outboundWhatsappPreview,
              assignmentReason: st.assignmentReason || undefined,
            }));
          }

          const stagedSubTasks = withGeneratedDraftMessages(matchedDrafts, state.team_members).map((d, dIdx) => {
            const validStage =
              d.swimlaneStage && stages.includes(d.swimlaneStage)
                ? d.swimlaneStage
                : stages[dIdx % stages.length] || 'Execution';
            return {
              ...d,
              wbsHeadId: headId,
              swimlaneStage: validStage,
            };
          });
          // Show the AI's "waits for" links as "After task" (code never invents links).
          const headSubTasks = applyAiTaskOrder(stagedSubTasks);

          const involved = Array.from(
            new Set([
              ...(rawHead.involvedPhones || []),
              ...headSubTasks.map((st) => st.raci.R),
            ])
          ).filter(Boolean);

          const initializedHead: WbsHead = {
            ...rawHead,
            headId,
            status: rawHead.status || 'SWIMLANE_READY',
            dynamicStages: stages,
            involvedPhones: involved.length
              ? involved
              : [staffMembers[0]?.phone || membersList[0]?.phone || ''],
            subTasks: headSubTasks,
          };

          // Refining the active plan: keep the owner's edits unless explicitly asked otherwise.
          const previousHead =
            headId === activeHeadId
              ? wbsHeads.find((h) => h.headId === headId)
              : isQuickDraftHeadId(rawHead.headId) && quickRefineHead
                ? quickRefineHead
                : undefined;
          if (previousHead && previousHead.status !== 'FROZEN_DISPATCHED') {
            const merged = mergeRefinedHead({
              previous: previousHead,
              refined: initializedHead,
              overrides: ownerOverridesWithNames(safeAiRes.overriddenOwnerEdits),
              teamMembers: state.team_members,
            });
            return recalculateWbsHeadDates(merged);
          }
          return recalculateWbsHeadDates(initializedHead);
        });

        const nextHeads = [
          ...populatedHeads,
          ...wbsHeads.filter((p) => !populatedHeads.some((h) => h.headId === p.headId)),
        ];
        updateAndSyncWbsHeads(nextHeads);
        setActiveHeadId(populatedHeads[0].headId);
      } else {
        // Legacy fallback: auto-wrap into a WBS Head if no heads were returned in legacy mode
        const singleHeadId = `HEAD-${Date.now()}`;
        const headSubTasks = parsedDrafts.map((d) => ({
          ...d,
          wbsHeadId: singleHeadId,
          swimlaneStage: d.swimlaneStage || 'Execution',
        }));
        const involved = Array.from(new Set(headSubTasks.map((st) => st.raci.R))).filter(Boolean);

        const wrappedHead: WbsHead = {
          headId: singleHeadId,
          title: safeAiRes.agendaTitle || 'Operational Action Plan',
          domainCategory: parsedDrafts[0]?.categoryId || 'OPERATIONS',
          contextSummary: sourceText,
          quadrant: safeAiRes.agendaQuadrant || 'Q1_DO_FIRST',
          majorOrMinor: safeAiRes.agendaMajorOrMinor || 'MINOR',
          tentativeDurationDays: 1,
          tentativeStartDate: todayDate,
          tentativeDeadline: todayDate,
          isForcedDeadline: false,
          dynamicStages: ['Procurement', 'Dispatch', 'Execution', 'Verification'],
          involvedPhones: involved.length
            ? involved
            : [staffMembers[0]?.phone || membersList[0]?.phone || ''],
          status: 'SWIMLANE_READY',
          subTasks: headSubTasks,
        };
        const calculatedHead = recalculateWbsHeadDates(wrappedHead);

        const nextHeads = [calculatedHead, ...wbsHeads];
        updateAndSyncWbsHeads(nextHeads);
        setActiveHeadId(singleHeadId);
      }

      onNotify(
        safeAiRes.wbsHeads && safeAiRes.wbsHeads.length > 1
          ? `Drafted ${safeAiRes.wbsHeads.length} projects with ${parsedDrafts.length} task(s). Check them, then Approve & send.`
          : `Drafted "${safeAiRes.agendaTitle}" with ${parsedDrafts.length} task(s). Check it, then Approve & send.`
      );
    } else {
      setStagingDrafts([]);
      setAgendaMeta(null);
      setV2QuickDraft(null);
    }
  };

  const handleSendChatMessage = async (textToSend?: string) => {
    if (isListening) {
      stopRecording();
    }
    const text = (textToSend || inputVal).trim();
    if (!text) return;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputVal('');
    setIsMeditating(true);
    onAiCallTriggered?.();

    try {
      const historyPayload = messages.slice(topicStartIndex).map((m) => ({
        role: m.role,
        text: m.text,
      }));
      historyPayload.push({ role: 'user', text });

      const aiRes = await runMeditateAgentApi({
        tenantId: state.tenantId,
        brainDump: text,
        teamMembers: membersList,
        tasks: state.tasks,
        categorySops: state.category_sops,
        systemMemory: state.system_memory,
        principalPrompts: state.principal_prompts,
        businessProfile: state.business_profile,
        ownerProfile: state.owner_profile,
        taskSplittingRules: state.task_splitting_rules,
        sampleBrainDumps: state.sample_brain_dumps,
        modelTuning: state.model_tuning,
        conversationHistory: historyPayload,
        activeHead: activeHeadId ? currentHead : quickRefineHead,
        wbsHeads: quickRefineHead ? [...wbsHeads, quickRefineHead] : wbsHeads,
      });

      applyValidatedMeditateResponse(aiRes, text);
    } catch (err: any) {
      const errMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        text: err?.message || 'Could not reach the Meditate Agent. Please try again.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setIsMeditating(false);
    }
  };

  const handleSelectConfirmChip = async (targetMsg: ChatMessage, chip: MeditateConfirmChip) => {
    if (isMeditating || targetMsg.confirmedChipKind) return;
    const sourceText = targetMsg.sourceBrainDump?.trim() || '';
    if (!sourceText) return;

    setMessages((prev) =>
      prev.map((m) => (m.id === targetMsg.id ? { ...m, confirmedChipKind: chip.kind } : m))
    );
    setIsMeditating(true);

    try {
      const historyPayload = messages.slice(topicStartIndex).map((m) => ({
        role: m.role,
        text: m.text,
      }));

      const aiRes = await runMeditateAgentApi({
        tenantId: state.tenantId,
        brainDump: sourceText,
        confirmedIntentKind: chip.kind,
        priorMissingCritical: targetMsg.priorMissingCritical || [],
        priorFollowUpForHeadId: targetMsg.priorFollowUpForHeadId ?? null,
        teamMembers: membersList,
        tasks: state.tasks,
        categorySops: state.category_sops,
        systemMemory: state.system_memory,
        principalPrompts: state.principal_prompts,
        businessProfile: state.business_profile,
        ownerProfile: state.owner_profile,
        taskSplittingRules: state.task_splitting_rules,
        sampleBrainDumps: state.sample_brain_dumps,
        modelTuning: state.model_tuning,
        conversationHistory: historyPayload,
        activeHead: activeHeadId ? currentHead : quickRefineHead,
        wbsHeads: quickRefineHead ? [...wbsHeads, quickRefineHead] : wbsHeads,
      });

      applyValidatedMeditateResponse(aiRes, sourceText);
    } catch (err: any) {
      const errMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        text: `Error confirming intent: ${err?.message || 'Could not process confirmation.'}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setIsMeditating(false);
    }
  };

  const handleUpdateV2QuickDraft = (patch: Partial<MeditateDraftTaskInput>) => {
    setV2QuickDraft((prev) => {
      if (!prev) return null;
      const merged: MeditateDraftTaskInput = {
        ...prev,
        ...patch,
      };
      const rMember = state.team_members[merged.raci.R];
      const aMember = state.team_members[merged.raci.A];
      merged.outboundWhatsappPreview = generateOutboundWhatsappMessage(
        {
          taskCode: 'QUICK',
          shortTag: merged.shortTag,
          title: merged.title,
          microSteps: (merged.microSteps || []).map((label, idx) => ({
            id: `ms-${idx + 1}`,
            label,
            status: 'PENDING' as const,
          })),
          dueDate: merged.dueDate,
          dueTime: merged.dueTime ?? null,
          quadrant: merged.quadrant,
          taskFrequency: merged.taskFrequency,
          recurrenceRule: merged.recurrenceRule,
        },
        rMember,
        aMember
      );
      return merged;
    });
  };

  const handleSendV2QuickDraft = () => {
    if (!v2QuickDraft) return;
    const result = onFreezeAndDispatch(
      [
        {
          ...v2QuickDraft,
          wbsHeadId: null,
        },
      ],
      {
        title: agendaMeta?.title || v2QuickDraft.title,
        rawBrainDump: v2QuickRawDump || v2QuickDraft.title,
        quadrant: v2QuickDraft.quadrant,
        majorOrMinor: v2QuickDraft.majorOrMinor,
      }
    );
    // Blocked (unfinished release choice): keep the draft so the owner can fix it.
    if (!result.ok) return;
    setV2QuickDraft(null);
    setStagingDrafts([]);
  };

  const handleAddManualNoteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = manualNoteText.trim();
    if (!cleaned) return;
    onAddNote?.(cleaned);
    setManualNoteText('');
    onNotify('Added note to Meditate Notes.');
  };

  // Inline Swimlane editing state
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [expandedMicroStepsTaskId, setExpandedMicroStepsTaskId] = useState<string | null>(null);
  const [newMicroStepText, setNewMicroStepText] = useState('');

  // ---------------------------------------------------------------------------
  // Milestone 3.6: owner edits to drafts (no WhatsApp messages; every Save is logged)
  // ---------------------------------------------------------------------------
  const draftValidationCtx = useMemo(() => buildDraftValidationContext(state), [state]);
  const validateCandidateDraft = useCallback(
    (d: MeditateDraftTaskInput) => validateDraftTask(d, draftValidationCtx),
    [draftValidationCtx]
  );
  const draftCategories = useMemo(
    () => (state.category_sops || []).map((c) => ({ categoryId: c.categoryId, categoryName: c.categoryName })),
    [state.category_sops]
  );
  const [justAddedTempId, setJustAddedTempId] = useState<string | null>(null);
  const [renamingHeadId, setRenamingHeadId] = useState<string | null>(null);
  const [renameHeadText, setRenameHeadText] = useState('');
  const [confirmDeleteHeadId, setConfirmDeleteHeadId] = useState<string | null>(null);

  const logOwnerEdit = (after: MeditateDraftTaskInput, changedFields: DraftEditableField[]) => {
    const log = buildManualEditLog({
      after,
      changedFields,
      teamMembers: Object.values(state.team_members),
      ownerProfile: state.owner_profile,
      tenantId: state.tenantId,
      nowIso: new Date().toISOString(),
    });
    if (log) onAppendAiLog?.(log);
  };

  /** Applies an owner edit to the quick draft (target 'QUICK') or a draft in a head. */
  // Batch 4: after an owner correction, offer to keep it as a rule (owner decides).
  const [ruleSuggestion, setRuleSuggestion] = useState<RuleSuggestion | null>(null);
  const offerRuleFromEdit = (draft: MeditateDraftTaskInput, changedFields: DraftEditableField[]) => {
    const suggestion = suggestRuleFromOwnerEdit({
      draft,
      changedFields,
      teamMembers: state.team_members,
      categories: state.category_sops,
    });
    const known = (state.system_memory || []).some(
      (r) => r.fact.trim().toLowerCase() === suggestion?.fact.trim().toLowerCase()
    );
    if (suggestion && !known) setRuleSuggestion(suggestion);
  };

  const saveDraftEdit = (target: 'QUICK' | string, tempId: string, patch: DraftEditPatch) => {
    if (target === 'QUICK') {
      if (!v2QuickDraft || v2QuickDraft.tempId !== tempId) return;
      const res = applyDraftEdit(v2QuickDraft, patch, state.team_members);
      if (res.changedFields.length === 0) return;
      setV2QuickDraft(res.draft);
      logOwnerEdit(res.draft, res.changedFields);
      offerRuleFromEdit(res.draft, res.changedFields);
      return;
    }
    const head = wbsHeads.find((h) => h.headId === target);
    const sub = head?.subTasks?.find((t) => t.tempId === tempId);
    if (!head || !sub) return;
    const res = applyDraftEdit(sub, patch, state.team_members);
    if (res.changedFields.length === 0) return;
    const r = res.draft.raci.R;
    const updated = recalculateWbsHeadDates({
      ...head,
      involvedPhones: r && !head.involvedPhones.includes(r) ? [...head.involvedPhones, r] : head.involvedPhones,
      subTasks: head.subTasks.map((t) => (t.tempId === tempId ? res.draft : t)),
    });
    updateAndSyncWbsHeads(wbsHeads.map((h) => (h.headId === head.headId ? updated : h)));
    logOwnerEdit(res.draft, res.changedFields);
    offerRuleFromEdit(res.draft, res.changedFields);
  };

  const handleAddDraftTask = (headId: string) => {
    const head = wbsHeads.find((h) => h.headId === headId);
    if (!head) return;
    const blank = newBlankDraft({
      head,
      defaultAccountablePhone: state.owner_profile?.defaultAccountablePhone,
      todayDate,
      idSuffix: Date.now().toString(36),
    });
    updateAndSyncWbsHeads(wbsHeads.map((h) => (h.headId === headId ? addDraftToHead(h, blank) : h)));
    setJustAddedTempId(blank.tempId);
    onNotify('Added a new draft task. Fill it in and Save.');
  };

  const handleDeleteDraftTask = (headId: string, tempId: string) => {
    const head = wbsHeads.find((h) => h.headId === headId);
    const sub = head?.subTasks?.find((t) => t.tempId === tempId);
    if (!head || !sub) return;
    const updated = recalculateWbsHeadDates(removeDraftFromHead(head, tempId));
    updateAndSyncWbsHeads(wbsHeads.map((h) => (h.headId === headId ? updated : h)));
    onNotify(`Deleted draft task "${sub.title || 'Untitled task'}". Nothing was sent.`);
  };

  const handleRenameHead = (headId: string) => {
    const head = wbsHeads.find((h) => h.headId === headId);
    if (!head) return;
    const renamed = renameHead(head, renameHeadText);
    if (renamed !== head) {
      updateAndSyncWbsHeads(wbsHeads.map((h) => (h.headId === headId ? renamed : h)));
      onNotify(`Renamed plan to "${renamed.title}".`);
    }
    setRenamingHeadId(null);
  };

  const handleDeleteHead = (headId: string) => {
    const head = wbsHeads.find((h) => h.headId === headId);
    if (!head || head.status === 'FROZEN_DISPATCHED') return;
    updateAndSyncWbsHeads(deleteDraftHead(wbsHeads, headId));
    if (activeHeadId === headId) setActiveHeadId(null);
    setConfirmDeleteHeadId(null);
    onNotify(`Deleted plan "${head.title}" and its ${head.subTasks?.length || 0} draft task(s). Nothing was sent.`);
  };

  const currentHeadCheck = useMemo(
    () =>
      currentHead && currentHead.status !== 'FROZEN_DISPATCHED'
        ? validateDraftPlan(currentHead.subTasks || [], {
            ...draftValidationCtx,
            stages: currentHead.dynamicStages,
          })
        : null,
    [currentHead, draftValidationCtx]
  );
  const quickDraftCheck = useMemo(
    () => (v2QuickDraft ? validateDraftPlan([v2QuickDraft], draftValidationCtx) : null),
    [v2QuickDraft, draftValidationCtx]
  );

  // Handle stage change (drag-and-drop or column select)
  const handleMoveSubTaskStage = (tempId: string, newStage: string) => {
    if (!currentHead) return;
    const updated = structuredClone(currentHead);
    const task = updated.subTasks?.find((t) => t.tempId === tempId);
    if (!task) return;
    task.swimlaneStage = newStage;
    const fresh = wbsHeads.map((h) => (h.headId === currentHead.headId ? updated : h));
    updateAndSyncWbsHeads(fresh);
    onNotify(`Moved [${task.shortTag || 'Task'}] to stage "${newStage}".`);
  };

  // Handle teammate re-assignment in Swimlane
  const handleReassignSubTaskPhone = (tempId: string, newPhone: string) => {
    if (!currentHead) return;
    const task = currentHead.subTasks?.find((t) => t.tempId === tempId);
    saveDraftEdit(currentHead.headId, tempId, { 'raci.R': newPhone });
    onNotify(`Assigned [${task?.shortTag || 'Task'}] to ${state.team_members[newPhone]?.name || 'the selected person'}.`);
  };

  // Toggle forced deadline on active WBS head
  const handleToggleForcedDeadline = (forced: boolean) => {
    if (!currentHead) return;
    let updated = { ...currentHead, isForcedDeadline: forced };
    if (forced && !updated.tentativeDeadline) {
      updated.tentativeDeadline = todayDate;
    }
    updated = recalculateWbsHeadDates(updated);
    const fresh = wbsHeads.map((h) => (h.headId === currentHead.headId ? updated : h));
    updateAndSyncWbsHeads(fresh);
    onNotify(
      forced
        ? `Forced deadline locked: subtasks back-calculated from ${updated.tentativeDeadline}.`
        : `Forced deadline removed: subtasks scheduled forward from ${updated.tentativeStartDate}.`
    );
  };

  // Change tentative deadline and back-calculate
  const handleChangeTentativeDeadline = (newDeadline: string) => {
    if (!currentHead) return;
    let updated = { ...currentHead, tentativeDeadline: newDeadline };
    updated = recalculateWbsHeadDates(updated);
    const fresh = wbsHeads.map((h) => (h.headId === currentHead.headId ? updated : h));
    updateAndSyncWbsHeads(fresh);
  };

  // Change task duration in Swimlane
  const handleChangeSubTaskDuration = (tempId: string, durationDays: number) => {
    if (!currentHead) return;
    const task = currentHead.subTasks?.find((t) => t.tempId === tempId);
    saveDraftEdit(currentHead.headId, tempId, { durationDays });
    onNotify(`Updated duration for [${task?.shortTag || 'Task'}] to ${durationDays}d.`);
  };

  // Handle inline subtask title edit
  const handleStartEditTitle = (task: MeditateDraftTaskInput) => {
    setEditingTaskId(task.tempId);
    setEditingTitle(task.title);
  };

  const handleSaveSubTaskTitle = (tempId: string) => {
    if (!currentHead) return;
    const cleanTitle = editingTitle.trim();
    if (cleanTitle) saveDraftEdit(currentHead.headId, tempId, { title: cleanTitle });
    setEditingTaskId(null);
  };

  const handleAddSubTaskMicroStep = (tempId: string) => {
    if (!currentHead || !newMicroStepText.trim()) return;
    const task = currentHead.subTasks?.find((t) => t.tempId === tempId);
    if (!task) return;
    saveDraftEdit(currentHead.headId, tempId, {
      microSteps: [...(task.microSteps || []), newMicroStepText.trim()],
    });
    setNewMicroStepText('');
  };

  const handleRemoveSubTaskMicroStep = (tempId: string, stepIndex: number) => {
    if (!currentHead) return;
    const task = currentHead.subTasks?.find((t) => t.tempId === tempId);
    if (!task?.microSteps) return;
    saveDraftEdit(currentHead.headId, tempId, {
      microSteps: task.microSteps.filter((_, idx) => idx !== stepIndex),
    });
  };

  // Freeze and launch active WBS Head
  const handleFreezeAndLaunchHead = () => {
    if (!currentHead || !currentHead.subTasks || currentHead.subTasks.length === 0) {
      if (stagingDrafts.length > 0) {
        // The app shows the real outcome (sent / scheduled / blocked) as a pop-up.
        onFreezeAndDispatch(
          stagingDrafts,
          agendaMeta
            ? {
                title: agendaMeta.title,
                rawBrainDump: messages.filter((m) => m.role === 'user').map((m) => m.text).join('\n'),
                quadrant: agendaMeta.quadrant,
                majorOrMinor: agendaMeta.majorOrMinor,
              }
            : undefined
        );
      }
      return;
    }

    const draftsToDispatch: MeditateDraftTaskInput[] = currentHead.subTasks.map((st) => ({
      ...st,
      wbsHeadId: currentHead.headId,
      swimlaneStage: st.swimlaneStage || currentHead.dynamicStages[0] || 'Execution',
    }));

    const result = onFreezeAndDispatch(
      draftsToDispatch,
      {
        title: currentHead.title,
        rawBrainDump: currentHead.contextSummary,
        quadrant: currentHead.quadrant,
        majorOrMinor: currentHead.majorOrMinor,
      },
      currentHead
    );
    // Blocked (unfinished release choice): leave the head staged so it can be fixed.
    if (!result.ok) return;

    // Update status and persist
    const fresh = wbsHeads.map((h) =>
      h.headId === currentHead.headId ? { ...h, status: 'FROZEN_DISPATCHED' as const } : h
    );
    updateAndSyncWbsHeads(fresh);
  };

  // Quick Ad-Hoc submit
  const handleQuickSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setQuickError('');
    if (!quickTitle.trim()) {
      setQuickError('Please enter a task title.');
      return;
    }
    const steps = quickChecklistLine
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const rMember = state.team_members[quickR];
    const aMember = state.team_members[quickA];

    const tag = quickTag.trim() || quickTitle.trim().slice(0, 20);

    const newDraft: MeditateDraftTaskInput = {
      tempId: `quick-${Date.now()}`,
      title: quickTitle.trim(),
      shortTag: tag,
      categoryId: quickCategory,
      quadrant: quickQuadrant,
      majorOrMinor: quickClass,
      taskFrequency: quickFreq,
      recurrenceRule: quickFreq === 'RECURRING' ? quickRecurrence : 'NONE',
      raci: {
        R: quickR,
        A: quickA,
        C: [],
        I: [],
      },
      dependsOnTempIdOrTaskCode: null,
      triggerCondition: 'FULL_COMPLETION',
      startDate: todayDate,
      durationDays: 1,
      dueDate: quickDueDate || todayDate,
      isForcedDeadline: false,
      forcedDeadlineDate: null,
      wbsHeadId: null,
      swimlaneStage: 'Execution',
      microSteps: steps.length > 0 ? steps : ['Complete task and confirm on WhatsApp'],
      release: quickRelease,
    };

    newDraft.outboundWhatsappPreview = generateOutboundWhatsappMessage(
      { ...newDraft, taskCode: 'QUICK' },
      rMember,
      aMember
    );

    const result = onFreezeAndDispatch([newDraft], {
      title: quickTitle.trim(),
      rawBrainDump: `Quick Ad-Hoc Task: ${quickTitle.trim()}`,
      quadrant: quickQuadrant,
      majorOrMinor: quickClass,
    });

    // Blocked (unfinished release choice): keep the form filled and show why.
    if (!result.ok) {
      setQuickError(result.error);
      return;
    }
    // The app's pop-up says whether it was sent on WhatsApp or only scheduled.
    setQuickTitle('');
    setQuickTag('');
    setQuickChecklistLine('');
    setQuickRelease({ mode: 'NOW' });
  };

  return (
    <div className="min-w-0 space-y-6">
      {/* Top Header & Mode Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-hairline pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink font-display">
            Meditate &amp; Task Studio
          </h1>
          <p className="text-xs text-slate mt-0.5">
            Say what needs doing. Meditate turns it into tasks, shows who does what and when, and sends them on WhatsApp after you approve.
          </p>
        </div>

        <div className="inline-flex rounded-xl border border-hairline bg-surface-muted p-1">
          <button
            type="button"
            onClick={() => setStudioMode('CHAT_MEDITATE')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              studioMode === 'CHAT_MEDITATE'
                ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            <Brain className="h-3.5 w-3.5 text-signal" />
            Plan by voice or text
          </button>
          <button
            type="button"
            onClick={() => setStudioMode('QUICK_ADHOC')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              studioMode === 'QUICK_ADHOC'
                ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            <Zap className="h-3.5 w-3.5 text-signal" />
            Quick task
          </button>
        </div>
      </div>

      {studioMode === 'CHAT_MEDITATE' ? (
        <div className="space-y-6">
          {ruleSuggestion && (
            <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-signal-border bg-signal-soft px-4 py-3 text-xs text-signal-ink sm:flex-row sm:items-center sm:justify-between">
              <span>
                <strong>Save as rule?</strong> &ldquo;{ruleSuggestion.fact}&rdquo; — so the AI does it this way next time.
              </span>
              <span className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onSaveMemoryRule(ruleSuggestion.category, ruleSuggestion.fact, true);
                    onNotify('Saved as a rule. Meditate will follow it from now on.');
                    setRuleSuggestion(null);
                  }}
                  className="rounded-lg bg-ink px-3 py-1.5 font-bold text-white hover:bg-ink-hover"
                >
                  Save as rule
                </button>
                <button
                  type="button"
                  onClick={() => setRuleSuggestion(null)}
                  className="rounded-lg border border-hairline bg-surface px-3 py-1.5 font-semibold text-ink hover:bg-surface-muted"
                >
                  Not now
                </button>
              </span>
            </div>
          )}

          {/* Level 1: Conversational Brain Dump & WBS Heads Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Column: Conversational Voice & Text Chat Stream */}
            <div className="lg:col-span-5 flex flex-col h-[520px] rounded-2xl border border-hairline bg-surface shadow-[var(--shadow-card)] overflow-hidden">
              {/* Chat Header */}
              <div className="flex items-center justify-between border-b border-hairline bg-paper px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-signal-soft text-signal border border-signal-border">
                    <Brain className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-ink font-display">Meditate</h3>
                    <p className="text-[10px] text-slate">{state.model_tuning?.meditate?.model || 'Gemini'} · Voice typing</p>
                  </div>
                </div>
              </div>

              {/* Chat Messages Log */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-paper/55">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${
                      msg.role === 'user' ? 'items-end' : 'items-start'
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed shadow-[var(--shadow-card)] ${
                        msg.role === 'user'
                          ? 'bg-ink text-white rounded-br-xs'
                          : msg.intentClassification === 'CASUAL_OR_TEST'
                            ? 'bg-info-soft text-ink border border-info-border rounded-bl-xs'
                            : 'bg-surface text-ink border border-hairline rounded-bl-xs'
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{msg.text}</p>

                      {msg.confirmChips && msg.confirmChips.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5 pt-2 border-t border-hairline">
                          {msg.confirmChips.map((chip) => {
                            const isChosen = msg.confirmedChipKind === chip.kind;
                            const isDisabled = Boolean(msg.confirmedChipKind) || isMeditating;
                            return (
                              <button
                                key={chip.kind}
                                type="button"
                                disabled={isDisabled}
                                onClick={() => void handleSelectConfirmChip(msg, chip)}
                                className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors border ${
                                  isChosen
                                    ? 'bg-ink text-white border-ink'
                                    : isDisabled
                                      ? 'bg-surface-muted text-slate/60 border-hairline cursor-not-allowed'
                                      : 'bg-surface text-ink border-hairline-strong hover:bg-signal-soft hover:text-signal-ink hover:border-signal-border'
                                }`}
                              >
                                {chip.label}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] opacity-75 tabular-nums">
                        <span>{msg.timestamp}</span>
                        {msg.taskCount !== undefined && msg.taskCount > 0 && (
                          <span className="font-semibold text-ok bg-ok-soft border border-ok-border px-1.5 py-0.2 rounded-md">
                            Staged {msg.taskCount} task{msg.taskCount > 1 ? 's' : ''}
                            {msg.lane ? ` (${msg.lane})` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {isMeditating && (
                  <div className="flex items-center gap-2 text-xs text-slate bg-surface border border-hairline rounded-xl px-3 py-2 w-fit">
                    <Sparkles className="h-3.5 w-3.5 animate-spin text-signal" />
                    <span>Reading your note and drafting the plan...</span>
                  </div>
                )}
                <div ref={chatScrollRef} />
              </div>

              {/* Chat Input Bar with Live Voice Mic Button */}
              <div className="border-t border-hairline bg-surface p-3 space-y-2">
                {/* Active WBS Head Scoping Badge */}
                <div
                  className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1 text-[11px] ${
                    currentHead
                      ? 'bg-signal-soft border-signal-border text-signal-ink'
                      : 'bg-paper border-hairline text-slate'
                  }`}
                >
                  <span className="truncate font-medium">
                    {currentHead ? (
                      <>
                        Changing project: <strong>[{currentHead.title}]</strong>
                      </>
                    ) : (
                      'New plan: your next message starts a new topic.'
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={handleStartNewTopic}
                    disabled={isMeditating || !hasTopicContext}
                    title="Start a new topic (the current project stays in the list)"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-hairline-strong bg-surface px-2 py-0.5 text-[11px] font-semibold text-ink hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                    New topic
                  </button>
                </div>

                {/* Voice Status & Live Interim Preview (separate from committed input) */}
                {isListening && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between rounded-lg bg-danger-soft border border-danger-border px-3 py-1.5 text-xs text-danger">
                      <div className="flex items-center gap-2">
                        <span className="flex h-2 w-2 rounded-full bg-danger-solid" />
                        <span className="font-semibold tabular-nums">
                          Listening... ({listeningSeconds}s)
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={stopRecording}
                        className="text-[11px] font-bold text-danger underline hover:no-underline whitespace-nowrap"
                      >
                        Done Speaking
                      </button>
                    </div>
                    {interimTranscript && (
                      <p
                        aria-live="polite"
                        className="rounded-lg border border-hairline bg-paper px-3 py-1.5 text-xs italic text-slate"
                      >
                        Hearing: {interimTranscript}
                      </p>
                    )}
                  </div>
                )}

                {(!isVoiceSupported || voiceErrorMessage) && (
                  <p className="text-[11px] text-slate px-0.5" role="status">
                    {voiceErrorMessage || "Voice input isn't supported in this browser."}
                  </p>
                )}

                <div className="flex items-end gap-2">
                  {/* Voice Button (hidden when SpeechRecognition is unavailable) */}
                  {isVoiceSupported && (
                    <button
                      type="button"
                      onClick={toggleVoiceRecording}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all shadow-[var(--shadow-card)] ${
                        isListening
                          ? 'bg-danger-solid text-white ring-2 ring-danger-border'
                          : 'border border-hairline-strong bg-paper text-ink hover:bg-signal-soft hover:text-signal-ink hover:border-signal-border'
                      }`}
                      title={isListening ? 'Stop recording voice' : 'Speak instructions'}
                      aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
                    >
                      {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4 text-signal" />}
                    </button>
                  )}

                  <textarea
                    rows={2}
                    value={inputVal}
                    onChange={(e) => setInputVal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendChatMessage();
                      }
                    }}
                    placeholder="Type or speak instructions..."
                    className="flex-1 resize-none rounded-xl border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink placeholder:text-slate/70 focus:border-signal focus:bg-surface focus:outline-none"
                  />

                  <button
                    type="button"
                    disabled={!inputVal.trim() || isMeditating}
                    onClick={() => handleSendChatMessage()}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink text-white shadow-[var(--shadow-card)] hover:bg-signal-hover disabled:opacity-40 transition-colors"
                    aria-label="Send message"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>

                {/* Live Sample Brain-Dump Quick-Try Chips */}
                {sampleBrainDumps.length > 0 && (
                  <div className="flex items-center gap-1.5 overflow-x-auto pt-1 pb-0.5">
                    <span className="text-[10px] font-bold text-slate shrink-0">Try Sample:</span>
                    {sampleBrainDumps.map((sample) => (
                      <button
                        key={sample.id}
                        type="button"
                        onClick={() => handleSendChatMessage(sample.text)}
                        disabled={isMeditating}
                        className="shrink-0 rounded-full border border-hairline bg-paper px-2.5 py-0.5 text-[10px] font-semibold text-ink hover:border-signal-border hover:bg-signal-soft hover:text-signal-ink transition-colors"
                        title={sample.text}
                      >
                        {sample.splitType === 'QUICK_TASK' ? '⚡ Quick: ' : '🗂️ Project: '}
                        {sample.text.slice(0, 32)}...
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Level 1 WBS Heads Summary Cards */}
            <div className="lg:col-span-7 flex flex-col h-[520px] rounded-2xl border border-hairline bg-surface shadow-[var(--shadow-card)] overflow-hidden">
              <div className="flex items-center justify-between border-b border-hairline bg-paper px-5 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-ink font-display">
                      Projects
                    </h3>
                    <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs font-semibold text-ink tabular-nums">
                      {wbsHeads.length} project{wbsHeads.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate">
                    Pick a project to see who does what, and to edit its tasks before sending.
                  </p>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {wbsHeads.length === 0 ? (
                  <div className="h-full flex items-center justify-center">
                    <BrandEmptyState
                      compact
                      title="No projects yet"
                      description="Speak or type what needs doing on the left. Jobs that pass between people become projects here."
                    />
                  </div>
                ) : (
                  wbsHeads.map((head) => {
                    const isSelected = head.headId === activeHeadId;
                    return (
                      <div
                        key={head.headId}
                        onClick={() => setActiveHeadId(head.headId)}
                        className={`cursor-pointer rounded-xl border p-4 transition-all ${
                          isSelected
                            ? 'border-signal bg-signal-soft/35 ring-1 ring-signal shadow-[var(--shadow-card)]'
                            : 'border-hairline bg-surface hover:border-hairline-strong shadow-[var(--shadow-card)]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="rounded-md bg-ink text-white px-2 py-0.5 text-[10px] font-mono font-bold">
                                {head.headId}
                              </span>
                              <span className="rounded-md bg-paper border border-hairline text-ink px-2 py-0.5 text-[10px] font-semibold">
                                {head.domainCategory}
                              </span>
                              {head.isForcedDeadline && (
                                <span className="rounded-md bg-danger-soft text-danger border border-danger-border px-2 py-0.5 text-[10px] font-bold flex items-center gap-1 tabular-nums">
                                  <Clock className="h-3 w-3" /> Hard Deadline: {head.tentativeDeadline}
                                </span>
                              )}
                              {(() => {
                                const release = summarizeWbsHeadRelease(head, state);
                                const toneClass =
                                  release.tone === 'sent'
                                    ? 'bg-ok-soft text-ok border border-ok-border'
                                    : release.tone === 'scheduled'
                                      ? 'bg-info-soft text-info border border-info-border'
                                      : release.tone === 'mixed'
                                        ? 'bg-info-soft text-info border border-info-border'
                                        : 'bg-warn-soft text-warn border border-warn-border';
                                return (
                                  <span
                                    className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${toneClass}`}
                                    title={release.details.join('\n') || undefined}
                                  >
                                    {release.label}
                                  </span>
                                );
                              })()}
                            </div>
                            <h4 className="text-sm font-bold text-ink font-display">{head.title}</h4>
                            <p className="text-xs text-slate line-clamp-2">{head.contextSummary}</p>
                          </div>

                          <div className="text-right shrink-0 tabular-nums">
                            <span className="text-xs font-semibold text-ink block">
                              {head.subTasks?.length || 0} sub-tasks
                            </span>
                            <span className="text-[10px] text-slate block mt-0.5">
                              ~{head.tentativeDurationDays} day{head.tentativeDurationDays !== 1 ? 's' : ''}
                            </span>
                          </div>
                        </div>

                        {/* Stages Preview Chips */}
                        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] font-medium text-slate">Stages:</span>
                          {head.dynamicStages.map((stg, i) => (
                            <span
                              key={i}
                              className="rounded-md bg-paper border border-hairline text-ink px-2 py-0.5 text-[10px] font-medium"
                            >
                              {stg}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Meditate v2 QUICK Lane: Single Task Review Card with One-Tap "Send" (zero extra WBS heads) */}
          {v2QuickDraft && (
            <div className="rounded-2xl border-2 border-signal bg-surface p-5 shadow-[var(--shadow-card)] space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-hairline pb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center gap-1 rounded-md bg-signal-hover px-2.5 py-0.5 text-xs font-bold text-white">
                    <Zap className="h-3.5 w-3.5" /> Quick Task Lane
                  </span>
                  <span className="rounded-md bg-paper border border-signal-border px-2 py-0.5 text-[11px] font-mono font-bold text-signal-ink">
                    [{v2QuickDraft.shortTag || 'Task'}]
                  </span>
                  {v2QuickDraft.dueHint && (
                    <span className="rounded-md bg-warn-soft border border-warn-border px-2 py-0.5 text-[11px] font-semibold text-warn tabular-nums">
                      Due hint: &ldquo;{v2QuickDraft.dueHint}&rdquo; → {v2QuickDraft.dueDate}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setV2QuickDraft(null)}
                    className="rounded-xl border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink hover:bg-paper transition-colors"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={handleSendV2QuickDraft}
                    disabled={(quickDraftCheck?.errorCount || 0) > 0}
                    title={quickDraftCheck?.firstError?.issue.message}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-5 py-2 text-xs font-bold text-white shadow-[var(--shadow-card)] hover:bg-ink-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5 text-signal" />
                    <span>Send</span>
                  </button>
                </div>
              </div>
              {(quickDraftCheck?.errorCount || 0) > 0 && (
                <p role="status" className="text-xs font-medium text-danger">
                  Fix {quickDraftCheck!.errorCount} problem(s) below before sending.
                </p>
              )}

              <DraftTaskEditor
                key={v2QuickDraft.tempId}
                draft={v2QuickDraft}
                teamMembers={state.team_members}
                categories={draftCategories}
                issues={quickDraftCheck?.byTempId[v2QuickDraft.tempId] || []}
                validate={validateCandidateDraft}
                onSave={(patch) => saveDraftEdit('QUICK', v2QuickDraft.tempId, patch)}
                existingTasks={state.tasks}
                businessTimezone={state.business_profile?.timezone}
              />
            </div>
          )}

          {/* Level 2: 1-Tap Quick Dispatch Card (for Single-Person Task) & Dynamic Swimlane Canvas */}
          {currentHead && (
            <div className="space-y-4">
              {(currentHead.subTasks?.length || 0) === 1 && currentHead.subTasks?.[0] && (
                <div className="rounded-2xl border-2 border-signal bg-surface p-5 shadow-[var(--shadow-card)]">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1 rounded-md bg-signal-hover px-2.5 py-0.5 text-xs font-bold text-white">
                          <Zap className="h-3.5 w-3.5" /> 1-Tap Quick Dispatch Card
                        </span>
                        <span className="rounded-md bg-paper border border-signal-border px-2 py-0.5 text-[11px] font-mono font-bold text-signal-ink">
                          [{currentHead.subTasks[0].shortTag || 'Task'}]
                        </span>
                        <span className="text-xs font-semibold text-ink">
                          Assigned to:{' '}
                          <strong>
                            {state.team_members[currentHead.subTasks[0].raci.R]?.name ||
                              currentHead.subTasks[0].raci.R}
                          </strong>
                        </span>
                        <span className="text-xs text-slate tabular-nums">
                          · Due {currentHead.subTasks[0].dueDate}
                        </span>
                      </div>
                      <h3 className="text-base font-bold text-ink font-display">
                        {currentHead.subTasks[0].title}
                      </h3>
                      {(currentHead.subTasks[0].microSteps || []).length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-xs text-slate">
                          {currentHead.subTasks[0].microSteps.map((step, idx) => (
                            <li key={idx}>• {step}</li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setShowSwimlaneForSingleTask((prev) => !prev)}
                        className="rounded-xl border border-hairline-strong bg-surface px-3.5 py-2.5 text-xs font-semibold text-ink hover:bg-paper transition-colors"
                      >
                        {showSwimlaneForSingleTask ? 'Hide who does what' : 'Show who does what'}
                      </button>
                      <button
                        type="button"
                        onClick={handleFreezeAndLaunchHead}
                        disabled={(currentHeadCheck?.errorCount || 0) > 0}
                        title={currentHeadCheck?.firstError?.issue.message}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-5 py-2.5 text-xs font-bold text-white shadow-[var(--shadow-card)] hover:bg-ink-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Zap className="h-4 w-4 text-signal" />
                        <span>Approve &amp; send</span>
                      </button>
                    </div>
                  </div>
                  {currentHead.status !== 'FROZEN_DISPATCHED' && (
                    <div className="mt-3">
                      <DraftTaskEditor
                        key={currentHead.subTasks[0].tempId}
                        draft={currentHead.subTasks[0]}
                        teamMembers={state.team_members}
                        categories={draftCategories}
                        issues={currentHeadCheck?.byTempId[currentHead.subTasks[0].tempId] || []}
                        validate={validateCandidateDraft}
                        onSave={(patch) =>
                          saveDraftEdit(currentHead.headId, currentHead.subTasks[0].tempId, patch)
                        }
                        onDelete={() =>
                          handleDeleteDraftTask(currentHead.headId, currentHead.subTasks[0].tempId)
                        }
                        existingTasks={state.tasks}
                        businessTimezone={state.business_profile?.timezone}
                        startEditing={justAddedTempId === currentHead.subTasks[0].tempId}
                      />
                    </div>
                  )}
                </div>
              )}

              {((currentHead.subTasks?.length || 0) !== 1 || showSwimlaneForSingleTask) && (
                <div className="min-w-0 w-full rounded-2xl border border-hairline bg-surface shadow-[var(--shadow-card)] overflow-hidden">
                  {/* Swimlane Top Bar */}
                  <div className="border-b border-hairline bg-paper px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-signal-hover text-white px-2 py-0.5 text-xs font-bold">
                          Who does what, and when
                        </span>
                        <span className="text-xs font-semibold text-ink">
                          {currentHead.title}
                        </span>
                      </div>
                      <p className="text-xs text-slate">
                        X-axis: Dynamic Process Stages · Y-axis: Involved Teammates. Drag or re-assign tasks below.
                      </p>
                    </div>

                    <div className="flex items-center gap-3 flex-wrap">
                      {/* Hard Deadline Toggle & Anchor */}
                      <div className="flex items-center gap-2 bg-surface px-3 py-1.5 rounded-xl border border-hairline text-xs">
                        <label className="flex items-center gap-1.5 cursor-pointer font-medium text-ink">
                          <input
                            type="checkbox"
                            checked={currentHead.isForcedDeadline}
                            onChange={(e) => handleToggleForcedDeadline(e.target.checked)}
                            className="rounded border-hairline-strong accent-signal"
                          />
                          <span>Hard Event Cutoff</span>
                        </label>
                        {currentHead.isForcedDeadline && (
                          <input
                            type="date"
                            value={currentHead.tentativeDeadline}
                            onChange={(e) => handleChangeTentativeDeadline(e.target.value)}
                            className="rounded border border-hairline-strong bg-paper px-2 py-0.5 text-xs font-semibold text-ink"
                          />
                        )}
                      </div>

                      {/* Freeze & Launch Head Button */}
                      <button
                        type="button"
                        onClick={handleFreezeAndLaunchHead}
                        disabled={(currentHeadCheck?.errorCount || 0) > 0}
                        title={currentHeadCheck?.firstError?.issue.message}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-xs font-bold text-white shadow-[var(--shadow-card)] hover:bg-ink-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Zap className="h-4 w-4 text-signal" />
                        <span>Approve &amp; send</span>
                      </button>
                    </div>
                  </div>

              {/* Swimlane 2D Matrix Grid */}
              <div className="overflow-x-auto p-3 sm:p-6">
                {/* Width grows with the number of stages so the last stage is never cut off; the box scrolls sideways. */}
                <div style={swimlaneTableStyle(currentHead.dynamicStages.length)}>
                  {/* Table Header: Dynamic Process Columns (X-axis) */}
                  <div
                    className="grid gap-3 pb-3 border-b border-hairline text-xs font-bold text-slate"
                    style={swimlaneGridStyle(currentHead.dynamicStages.length)}
                  >
                    <div>Person</div>
                    {currentHead.dynamicStages.map((stg, idx) => (
                      <div
                        key={idx}
                        title={`Stage ${idx + 1}: ${stg}`}
                        className="truncate rounded-lg bg-surface-muted py-1.5 px-3 text-center text-ink font-semibold"
                      >
                        Stage {idx + 1}: {stg}
                      </div>
                    ))}
                  </div>

                  {/* Table Rows: Involved Teammates (Y-axis) */}
                  <div className="divide-y divide-hairline">
                    {currentHead.involvedPhones.map((phone) => {
                      const member = state.team_members[phone];
                      return (
                        <div
                          key={phone}
                          className="grid gap-3 py-4 items-start"
                          style={swimlaneGridStyle(currentHead.dynamicStages.length)}
                        >
                          {/* Teammate Header Cell */}
                          <div className="pr-2 min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-paper text-ink font-bold text-xs border border-hairline">
                                {member?.name?.[0] || 'T'}
                              </div>
                              <div>
                                <h5 className="text-xs font-bold text-ink">{member?.name || phone}</h5>
                                <p className="text-[10px] text-slate">{member?.roleTitle || 'Field Team'}</p>
                              </div>
                            </div>
                            <span className="mt-1 inline-block text-[10px] text-slate">
                              {member?.preferredLanguage || 'HINGLISH'}
                            </span>
                          </div>

                          {/* Stage Cells (X-axis) */}
                          <>
                            {currentHead.dynamicStages.map((stg) => {
                              const matchingTasks = (currentHead.subTasks || []).filter(
                                (t) => t.raci.R === phone && (t.swimlaneStage === stg || (!t.swimlaneStage && stg === currentHead.dynamicStages[0]))
                              );

                              return (
                                <div
                                  key={stg}
                                  className="min-h-[128px] min-w-0 rounded-xl border border-dashed border-hairline-strong bg-paper/70 p-2 space-y-2 hover:bg-surface-muted/40 transition-colors"
                                >
                                  {matchingTasks.map((t) => {
                                    const stepCount = t.microSteps?.length || 0;
                                    const isSelected = selectedSwimlaneTaskId === t.tempId;
                                    return (
                                      <button
                                        key={t.tempId}
                                        type="button"
                                        onClick={() => handleSelectSwimlaneCard(t.tempId)}
                                        data-testid="swimlane-compact-card"
                                        className={`h-[116px] w-full flex flex-col justify-between overflow-hidden rounded-lg border p-2.5 text-left shadow-[var(--shadow-card)] transition-colors cursor-pointer ${
                                          isSelected
                                            ? 'border-signal ring-1 ring-signal/30 bg-signal-soft/20'
                                            : 'border-hairline bg-surface hover:border-hairline-strong hover:bg-paper/60'
                                        }`}
                                        title="Click to edit task details below"
                                      >
                                        <div className="space-y-1.5 min-w-0 w-full">
                                          <div className="flex items-center justify-between gap-1.5 min-w-0">
                                            <span className="truncate rounded-md bg-signal-soft text-signal-ink px-1.5 py-0.5 text-[10px] font-mono font-bold border border-signal-border">
                                              {t.shortTag || 'Task'}
                                            </span>
                                            <span className="shrink-0 rounded-full bg-paper border border-hairline px-1.5 py-0.5 text-[10px] font-semibold text-slate">
                                              {formatReleaseBadge(t.release)}
                                            </span>
                                          </div>
                                          <p className="line-clamp-2 text-xs font-semibold text-ink leading-snug break-words">
                                            {t.title}
                                          </p>
                                        </div>

                                        <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-hairline/60 text-[10px] text-slate min-w-0 w-full">
                                          <span className="truncate font-medium text-ink/80">
                                            {member?.name || 'Unassigned'}
                                          </span>
                                          <span className="shrink-0 tabular-nums whitespace-nowrap">
                                            {stepCount} {stepCount === 1 ? 'step' : 'steps'} · {formatDueLabel(t)}
                                          </span>
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
              )}

              {/* Milestone 3.6: edit the plan before sending (mobile-friendly list) */}
              {currentHead.status !== 'FROZEN_DISPATCHED' && (
                <div className="rounded-2xl border border-hairline bg-surface p-4 shadow-[var(--shadow-card)] space-y-3" aria-label="Plan tasks">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {renamingHeadId === currentHead.headId ? (
                      <form
                        className="flex flex-1 flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleRenameHead(currentHead.headId);
                        }}
                      >
                        <input
                          autoFocus
                          aria-label="Plan name"
                          value={renameHeadText}
                          onChange={(e) => setRenameHeadText(e.target.value)}
                          className="min-w-0 flex-1 rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-sm text-ink focus:border-signal focus:bg-surface focus:outline-none"
                        />
                        <button type="submit" className="rounded-lg bg-ink px-3 py-2 text-xs font-bold text-white hover:bg-ink-hover">
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingHeadId(null)}
                          className="rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink hover:bg-paper"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <div className="min-w-0">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-slate">Plan tasks · edit before sending</p>
                        <p className="text-sm font-bold text-ink break-words font-display">{currentHead.title}</p>
                      </div>
                    )}
                    {renamingHeadId !== currentHead.headId && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setRenameHeadText(currentHead.title);
                            setRenamingHeadId(currentHead.headId);
                          }}
                          className="rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-paper"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAddDraftTask(currentHead.headId)}
                          className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink-hover transition-colors"
                        >
                          + Add task
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteHeadId(currentHead.headId)}
                          className="rounded-lg border border-danger-border bg-surface px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger-soft"
                        >
                          Delete plan
                        </button>
                      </div>
                    )}
                  </div>

                  {confirmDeleteHeadId === currentHead.headId && (
                    <div role="alertdialog" className="flex flex-wrap items-center gap-2 rounded-lg border border-danger-border bg-danger-soft px-3 py-2">
                      <span className="text-xs font-medium text-danger">
                        Delete this plan and its {currentHead.subTasks?.length || 0} draft task(s)? Nothing is sent.
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDeleteHead(currentHead.headId)}
                        className="rounded-md bg-danger-solid px-2.5 py-1 text-xs font-semibold text-white hover:bg-danger"
                      >
                        Yes, delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteHeadId(null)}
                        className="rounded-md border border-hairline-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink"
                      >
                        Keep
                      </button>
                    </div>
                  )}

                  {(currentHeadCheck?.errorCount || 0) > 0 && (
                    <p role="status" className="text-xs font-medium text-danger">
                      Fix {currentHeadCheck!.errorCount} problem(s) before sending. First: “
                      {currentHeadCheck!.firstError?.title}” — {currentHeadCheck!.firstError?.issue.message}
                    </p>
                  )}

                  {(currentHead.subTasks?.length || 0) === 0 && (
                    <p className="text-xs text-slate">This plan has no tasks yet. Use “+ Add task”.</p>
                  )}

                  {(currentHead.subTasks?.length || 0) !== 1 &&
                    (currentHead.subTasks || []).map((t) => (
                      <div key={t.tempId} id={`draft-editor-${t.tempId}`}>
                        <DraftTaskEditor
                          draft={t}
                          teamMembers={state.team_members}
                          categories={draftCategories}
                          issues={currentHeadCheck?.byTempId[t.tempId] || []}
                          validate={validateCandidateDraft}
                          onSave={(patch) => saveDraftEdit(currentHead.headId, t.tempId, patch)}
                          onDelete={() => handleDeleteDraftTask(currentHead.headId, t.tempId)}
                          existingTasks={state.tasks}
                          otherDrafts={currentHead.subTasks}
                          businessTimezone={state.business_profile?.timezone}
                          startEditing={justAddedTempId === t.tempId || selectedSwimlaneTaskId === t.tempId}
                          swimlaneStages={currentHead.dynamicStages}
                          onStageChange={(newStage) => handleMoveSubTaskStage(t.tempId, newStage)}
                          onEditingClose={() =>
                            setSelectedSwimlaneTaskId((prev) => (prev === t.tempId ? null : prev))
                          }
                        />
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {/* Meditate Notes List (`state.notes`) */}
          <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-card)] space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-hairline pb-3">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-signal" />
                <div>
                  <h3 className="text-sm font-bold text-ink font-display tabular-nums">
                    Meditate Notes ({notesList.length})
                  </h3>
                  <p className="text-[11px] text-slate">
                    Observations and reference facts saved via Meditate without creating tasks.
                  </p>
                </div>
              </div>
            </div>

            <form onSubmit={handleAddManualNoteSubmit} className="flex items-center gap-2">
              <input
                type="text"
                value={manualNoteText}
                onChange={(e) => setManualNoteText(e.target.value)}
                placeholder="Save a quick operational note..."
                className="flex-1 rounded-xl border border-hairline bg-paper px-3 py-2 text-xs text-ink placeholder:text-slate/70 focus:border-signal focus:bg-surface focus:outline-none"
              />
              <button
                type="submit"
                disabled={!manualNoteText.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-xs font-bold text-white hover:bg-ink-hover disabled:opacity-40 transition-colors"
              >
                <Plus className="h-3.5 w-3.5 text-signal" />
                Save Note
              </button>
            </form>

            {notesList.length === 0 ? (
              <p className="text-xs text-slate py-2">
                No notes saved yet. Messages classified as NOTE (or confirmed via &ldquo;Save as note&rdquo;) appear here.
              </p>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {notesList.map((note) => (
                  <div
                    key={note.noteId}
                    className="flex items-start justify-between gap-3 rounded-xl border border-hairline bg-paper px-3.5 py-2.5"
                  >
                    <div className="space-y-0.5">
                      <p className="text-xs font-medium text-ink whitespace-pre-wrap">
                        {note.text}
                      </p>
                      <span className="text-[10px] text-slate block tabular-nums">
                        {new Date(note.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onDeleteNote?.(note.noteId)}
                      className="rounded-lg border border-hairline bg-surface p-1.5 text-slate hover:text-danger hover:border-danger-border shrink-0"
                      title="Delete note"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Quick Ad-Hoc Rapid Creation Mode */
        <div className="max-w-2xl mx-auto rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)]">
          <div className="mb-5">
            <h3 className="text-base font-bold text-ink font-display">Create Quick Task</h3>
            <p className="text-xs text-slate mt-0.5">
              Rapid direct dispatch to WhatsApp without full conversational meditation.
            </p>
          </div>

          {quickError && (
            <div className="mb-4 rounded-lg bg-danger-soft border border-danger-border p-3 text-xs text-danger">
              {quickError}
            </div>
          )}

          <form onSubmit={handleQuickSubmit} className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-bold text-ink mb-1">Task Title</label>
                <input
                  type="text"
                  value={quickTitle}
                  onChange={(e) => setQuickTitle(e.target.value)}
                  placeholder="e.g. Replace Staff Quarter Water Pump Contactor"
                  className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-ink mb-1">Human Tag</label>
                <input
                  type="text"
                  value={quickTag}
                  onChange={(e) => setQuickTag(e.target.value)}
                  placeholder="e.g. Water Pump"
                  className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-ink mb-1">Category SOP</label>
                <select
                  value={quickCategory}
                  onChange={(e) => setQuickCategory(e.target.value)}
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink focus:border-signal focus:outline-none"
                >
                  {state.category_sops.map((sop) => (
                    <option key={sop.categoryId} value={sop.categoryId}>
                      {sop.categoryName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-ink mb-1">Quadrant</label>
                <select
                  value={quickQuadrant}
                  onChange={(e) => setQuickQuadrant(e.target.value as Quadrant)}
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink focus:border-signal focus:outline-none"
                >
                  <option value="Q1_DO_FIRST">Q1 Urgent &amp; Important (Do First)</option>
                  <option value="Q2_SCHEDULE">Q2 Important (Schedule)</option>
                  <option value="Q3_DELEGATE">Q3 Urgent (Delegate)</option>
                  <option value="Q4_LOW">Q4 Routine / Low</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-ink mb-1">Responsible (R)</label>
                <select
                  value={quickR}
                  onChange={(e) => setQuickR(e.target.value)}
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink focus:border-signal focus:outline-none"
                >
                  {staffMembers.map((m) => (
                    <option key={m.phone} value={m.phone}>
                      {m.name} ({m.roleTitle})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-ink mb-1">Due Date</label>
                <input
                  type="date"
                  value={quickDueDate}
                  onChange={(e) => setQuickDueDate(e.target.value)}
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink focus:border-signal focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-ink mb-1">
                Micro-Steps (Comma or newline separated)
              </label>
              <textarea
                rows={2}
                value={quickChecklistLine}
                onChange={(e) => setQuickChecklistLine(e.target.value)}
                placeholder="Inspect pipe joint, Replace seal, Send photo proof"
                className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
              />
            </div>

            <DraftReleasePicker
              release={quickRelease}
              onChange={setQuickRelease}
              existingTasks={state.tasks}
              businessTimezone={state.business_profile?.timezone}
            />

            <button
              type="submit"
              className="w-full rounded-xl bg-ink py-2.5 text-xs font-bold text-white shadow-[var(--shadow-card)] hover:bg-ink-hover transition-colors"
            >
              Approve &amp; send
            </button>
            {quickError && (
              <p role="alert" className="text-xs font-medium text-danger">
                {quickError}
              </p>
            )}
          </form>
        </div>
      )}
    </div>
  );
};
