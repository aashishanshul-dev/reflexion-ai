import React, { useEffect, useState } from 'react';
import {
  Activity,
  BookOpen,
  Brain,
  Check,
  Edit2,
  Layers,
  Plus,
  RotateCcw,
  Save,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { DemoVisitorsPanel } from './DemoVisitorsPanel';
import { SECTION_EXPLAINERS } from '../lib/plainLabels';
import {
  AiModelTuningConfig,
  BusinessProfileConfig,
  CategorySop,
  Classification,
  OpsDatabaseState,
  OwnerProfileConfig,
  PreferredLanguage,
  PrincipalPrompts,
  SampleBrainDumpItem,
  StageModelConfig,
  SystemMemoryCategory,
  TaskSplittingConfig,
} from '../types/ops';
import { normalizeTaskTypeAssignment } from '../lib/taskTypeAssignment';
import { MAX_SYSTEM_MEMORY_RULES } from '../lib/opsEngine';
import { ALL_MODEL_IDS, defaultStageConfig } from '../lib/modelConfig';

interface SopsMemoryTabProps {
  state: OpsDatabaseState;
  onUpsertSop?: (sop: CategorySop) => void;
  /** Batch 4: run this task type's checklist now (or daily) for its default person. */
  onRunRoutine?: (categoryId: string, daily: boolean) => void;
  onAddMemoryRule?: (category: SystemMemoryCategory, fact: string, approved?: boolean) => void;
  onApproveMemoryRule?: (memoryId: string) => void;
  onToggleMemoryRule?: (memoryId: string) => void;
  onUpdateMemoryFact?: (memoryId: string, fact: string) => void;
  onDeleteMemoryRule?: (memoryId: string) => void;
  onUpdatePrincipalPrompts?: (prompts: PrincipalPrompts) => void;
  onUpdateBusinessProfile?: (profile: BusinessProfileConfig) => void;
  onUpdateOwnerProfile?: (profile: OwnerProfileConfig) => void;
  onUpdateTaskSplittingRules?: (rules: TaskSplittingConfig) => void;
  onUpdateSampleBrainDumps?: (samples: SampleBrainDumpItem[]) => void;
  onUpdateModelTuning?: (tuning: AiModelTuningConfig) => void;
  onClearAiLogs?: () => void;
  onOpenImport?: () => void;
  onNotify?: (msg: string) => void;
  jumpRequest?: { section: 'SOPS'; categoryId?: string; nonce: number } | null;
  canViewDemoVisitors?: boolean;
}

const DEFAULT_PRINCIPAL_PROMPTS: PrincipalPrompts = {
  planningPrompt: `You are OpsCommand AI Meditate Engine — an elite operations, RACI and Eisenhower planning strategist.
Given the Boss's brain-dump, team roster with workloads and personal persona prompts, and active SOP playbooks:
1. INTENT & RELEVANCE GATE: First evaluate if the input is a mic test, greeting, or meta-question. If so, set intentClassification = 'CASUAL_OR_TEST', return draftedTasks = [] (ZERO tasks), and reply naturally in chatReplyToBoss.
2. CLARIFICATION GATE: If the operational request lacks essential context (location, equipment, or person), set intentClassification = 'NEEDS_CLARIFICATION', return draftedTasks = [], and ask a direct clarifying question in chatReplyToBoss.
3. SMART BREAKDOWN RULE (NO BLOAT): Only populate draftedTasks when intentClassification = 'ACTIONABLE_AGENDA'. If one person can do the job continuously without waiting on another person or approval gate, keep it as 1 Quick Task with checklist steps. Only split into multiple tasks or multiple WBS Heads when ownership changes hands between different people/teams, or when there is a hard gate (purchase, delivery, client sign-off, inspection).
4. Assign each task to an Eisenhower Quadrant (Q1_DO_FIRST, Q2_SCHEDULE, Q3_DELEGATE, Q4_LOW) and classification (MAJOR or MINOR).
5. Assign RACI owners strictly using anonymized slot IDs (P1, P2, P3...) from the roster, respecting on-leave status, skills, capacity, and work shifts.
6. Draft localized outbound WhatsApp previews tailored to each slot's preferred language and persona prompt.`,
  evaluationPrompt: `You are OpsCommand AI Multimodal WhatsApp Batch Inspector.
Inspect the employee's chronological buffered WhatsApp messages, voice notes, photos, and short videos:
1. CHRONOLOGICAL OVERRIDE: If a later timestamped message in the batch clarifies, corrects, or retracts an earlier statement, the LATEST timestamp is ground truth.
2. Check required SOP micro-steps. If an employee claims completion or handover but skips an essential step, mark that step MISSED and alert the team.
3. Automatically escalate to Boss Review Queue for:
   - Budget variances or extra funds requests
   - Design, brand, or material choices
   - Partial handover gates where physical work was handed over without final paperwork
   - Urgent site blockers
4. Draft WhatsApp replies strictly in the employee's preferred language, incorporating their personal persona prompt for tone and style.`,
};

export const SopsMemoryTab: React.FC<SopsMemoryTabProps> = ({
  state,
  onUpsertSop,
  onRunRoutine,
  onAddMemoryRule,
  onApproveMemoryRule,
  onToggleMemoryRule,
  onUpdateMemoryFact,
  onDeleteMemoryRule,
  onUpdatePrincipalPrompts,
  onUpdateBusinessProfile,
  onUpdateOwnerProfile,
  onUpdateTaskSplittingRules,
  onUpdateSampleBrainDumps,
  onUpdateModelTuning,
  onClearAiLogs,
  onOpenImport,
  onNotify,
  jumpRequest,
  canViewDemoVisitors = false,
}) => {
  const [activeSection, setActiveSection] = useState<
    | 'BUSINESS_OWNER'
    | 'SPLITTING_EXAMPLES'
    | 'PROMPTS'
    | 'SOPS'
    | 'MEMORY'
    | 'MODEL_TUNING'
    | 'DEMO_VISITORS'
  >(jumpRequest?.section || 'BUSINESS_OWNER');

  useEffect(() => {
    if (!canViewDemoVisitors && activeSection === 'DEMO_VISITORS') {
      setActiveSection('BUSINESS_OWNER');
    }
  }, [canViewDemoVisitors, activeSection]);

  const defaultIntentStage: StageModelConfig = defaultStageConfig('intent');
  const defaultPlannerStage: StageModelConfig = defaultStageConfig('planner');
  // One <option> per model in src/lib/modelConfig.ts — shared by every model dropdown.
  const modelOptions = ALL_MODEL_IDS.map((id) => (
    <option key={id} value={id}>
      {id}
    </option>
  ));

  const modelTuning: AiModelTuningConfig = {
    modelDefaultsVersion: state.model_tuning?.modelDefaultsVersion,
    meditateEngine: 'v2',
    meditateEngineUserSet: false,
    intentConfidenceThreshold:
      typeof state.model_tuning?.intentConfidenceThreshold === 'number'
        ? state.model_tuning.intentConfidenceThreshold
        : 0.75,
    maxRecentConversationTurns: state.model_tuning?.maxRecentConversationTurns ?? 8,
    meditate: state.model_tuning?.meditate || defaultPlannerStage,
    intent: state.model_tuning?.intent || defaultIntentStage,
    planner: state.model_tuning?.planner || defaultPlannerStage,
    bufferEvaluation:
      state.model_tuning?.bufferEvaluation || defaultStageConfig('bufferEvaluation'),
    message:
      state.model_tuning?.message || defaultStageConfig('message'),
  };

  const pendingMemoryCount = state.system_memory.filter((r) => r.approved === false).length;

  const updateStageTuning = (
    stageKey: 'meditate' | 'intent' | 'planner' | 'bufferEvaluation' | 'message',
    patch: Partial<StageModelConfig>
  ) => {
    const existingStage =
      modelTuning[stageKey] ||
      (stageKey === 'intent'
        ? defaultIntentStage
        : stageKey === 'message'
          ? defaultStageConfig('message')
          : defaultPlannerStage);
    onUpdateModelTuning?.({
      ...modelTuning,
      [stageKey]: {
        ...existingStage,
        ...patch,
      },
    });
  };

  const aiLogs = state.ai_logs || [];

  const membersList = Object.values(state.team_members || {});
  const accountableCandidates = membersList.filter(
    (m) =>
      m.authorityLevel === 'OWNER' ||
      m.authorityLevel === 'BOSS' ||
      m.authorityLevel === 'MANAGER' ||
      m.authorityLevel === 'SUPERVISOR'
  );

  // 1. Business Profile Helpers (Immediate Save)
  const businessProfile: BusinessProfileConfig = state.business_profile || {
    businessName: '',
    businessType: '',
    businessDescription: '',
    workLocations: '',
    defaultStaffLanguage: 'HINGLISH',
    hardRules: '',
  };

  const updateBusinessField = <K extends keyof BusinessProfileConfig>(
    key: K,
    val: BusinessProfileConfig[K]
  ) => {
    onUpdateBusinessProfile?.({
      ...businessProfile,
      [key]: val,
    });
  };

  // 2. Owner Profile Helpers (Immediate Save)
  const ownerProfile: OwnerProfileConfig = state.owner_profile || {
    personalOperatingPrompt: '',
    defaultAccountablePhone: membersList[0]?.phone || '',
  };

  const updateOwnerField = <K extends keyof OwnerProfileConfig>(
    key: K,
    val: OwnerProfileConfig[K]
  ) => {
    onUpdateOwnerProfile?.({
      ...ownerProfile,
      [key]: val,
    });
  };

  // 3. Task Splitting & Capacity Helpers (Immediate Save)
  const splittingRules: TaskSplittingConfig = state.task_splitting_rules || {
    maxChecklistStepsPerTask: 5,
    defaultMaxActiveTasksPerPerson: 3,
    taskSplittingRule: '',
  };

  const updateSplittingField = <K extends keyof TaskSplittingConfig>(
    key: K,
    val: TaskSplittingConfig[K]
  ) => {
    onUpdateTaskSplittingRules?.({
      ...splittingRules,
      [key]: val,
    });
  };

  // 4. Sample Brain-Dumps State
  const sampleDumps: SampleBrainDumpItem[] = state.sample_brain_dumps || [];
  const [newSampleText, setNewSampleText] = useState('');
  const [newSampleType, setNewSampleType] = useState<'QUICK_TASK' | 'PROJECT_SWIMLANES'>(
    'QUICK_TASK'
  );
  const [newSampleInstruction, setNewSampleInstruction] = useState('');
  const [editingSampleId, setEditingSampleId] = useState<string | null>(null);
  const [editingSampleText, setEditingSampleText] = useState('');
  const [editingSampleType, setEditingSampleType] = useState<'QUICK_TASK' | 'PROJECT_SWIMLANES'>(
    'QUICK_TASK'
  );
  const [editingSampleInstruction, setEditingSampleInstruction] = useState('');

  const handleAddSampleDump = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSampleText.trim()) return;
    const item: SampleBrainDumpItem = {
      id: `sample-${Date.now()}`,
      text: newSampleText.trim(),
      splitType: newSampleType,
      aiInstruction: newSampleInstruction.trim(),
    };
    onUpdateSampleBrainDumps?.([item, ...sampleDumps]);
    setNewSampleText('');
    setNewSampleInstruction('');
    onNotify?.('Added Sample Brain-Dump example for AI Brain.');
  };

  const handleSaveEditedSample = (id: string) => {
    if (!editingSampleText.trim()) return;
    const next = sampleDumps.map((s) =>
      s.id === id
        ? {
            ...s,
            text: editingSampleText.trim(),
            splitType: editingSampleType,
            aiInstruction: editingSampleInstruction.trim(),
          }
        : s
    );
    onUpdateSampleBrainDumps?.(next);
    setEditingSampleId(null);
    onNotify?.('Updated Sample Brain-Dump example.');
  };

  const handleDeleteSample = (id: string) => {
    onUpdateSampleBrainDumps?.(sampleDumps.filter((s) => s.id !== id));
    onNotify?.('Deleted Sample Brain-Dump example.');
  };

  // 5. Principal Prompts State
  const [planningPrompt, setPlanningPrompt] = useState(
    state.principal_prompts?.planningPrompt || DEFAULT_PRINCIPAL_PROMPTS.planningPrompt
  );
  const [evaluationPrompt, setEvaluationPrompt] = useState(
    state.principal_prompts?.evaluationPrompt || DEFAULT_PRINCIPAL_PROMPTS.evaluationPrompt
  );

  const handleSavePrincipalPrompts = () => {
    onUpdatePrincipalPrompts?.({
      planningPrompt: planningPrompt.trim(),
      evaluationPrompt: evaluationPrompt.trim(),
    });
    onNotify?.('Saved Master System Prompts to database.');
  };

  const handleResetPromptsToDefault = () => {
    setPlanningPrompt(DEFAULT_PRINCIPAL_PROMPTS.planningPrompt);
    setEvaluationPrompt(DEFAULT_PRINCIPAL_PROMPTS.evaluationPrompt);
    onUpdatePrincipalPrompts?.(DEFAULT_PRINCIPAL_PROMPTS);
    onNotify?.('Reset Master System Prompts to system defaults.');
  };

  // SOP Playbooks State
  const [selectedSopId, setSelectedSopId] = useState<string>(
    state.category_sops[0]?.categoryId || 'PROCUREMENT'
  );
  const [isCreatingSop, setIsCreatingSop] = useState(false);
  const currentSop = state.category_sops.find((c) => c.categoryId === selectedSopId);

  const [sopCode, setSopCode] = useState(currentSop?.categoryId || '');
  const [sopName, setSopName] = useState(currentSop?.categoryName || '');
  const [sopClass, setSopClass] = useState<Classification>(
    currentSop?.defaultClassification || 'MAJOR'
  );
  const [sopPrompt, setSopPrompt] = useState(currentSop?.sopSystemPrompt || '');
  const [sopStepsText, setSopStepsText] = useState(
    (currentSop?.defaultMicroSteps || []).join('\n')
  );
  const [sopDefaultPhone, setSopDefaultPhone] = useState(currentSop?.defaultResponsiblePhone || '');
  const [sopBackupPhone, setSopBackupPhone] = useState(currentSop?.backupResponsiblePhone || '');
  const [sopSpendApproval, setSopSpendApproval] = useState(Boolean(currentSop?.spendApprovalRequired));
  const [sopFactsText, setSopFactsText] = useState((currentSop?.requiredFacts || []).join('\n'));
  const [sopError, setSopError] = useState('');

  const selectExistingSop = (sop: CategorySop) => {
    setIsCreatingSop(false);
    setSelectedSopId(sop.categoryId);
    setSopCode(sop.categoryId);
    setSopName(sop.categoryName);
    setSopClass(sop.defaultClassification);
    setSopPrompt(sop.sopSystemPrompt);
    setSopStepsText(sop.defaultMicroSteps.join('\n'));
    setSopDefaultPhone(sop.defaultResponsiblePhone || '');
    setSopBackupPhone(sop.backupResponsiblePhone || '');
    setSopSpendApproval(Boolean(sop.spendApprovalRequired));
    setSopFactsText((sop.requiredFacts || []).join('\n'));
    setSopError('');
  };

  useEffect(() => {
    if (!jumpRequest) return;
    setActiveSection(jumpRequest.section);
    if (jumpRequest.categoryId) {
      const targetSop = state.category_sops.find((c) => c.categoryId === jumpRequest.categoryId);
      if (targetSop) selectExistingSop(targetSop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest?.nonce]);

  const startNewSop = () => {
    setIsCreatingSop(true);
    setSopCode('');
    setSopName('');
    setSopClass('MAJOR');
    setSopPrompt('');
    setSopStepsText('');
    setSopDefaultPhone('');
    setSopBackupPhone('');
    setSopSpendApproval(false);
    setSopFactsText('');
    setSopError('');
  };

  const handleSaveSop = (e: React.FormEvent) => {
    e.preventDefault();
    const formattedCode = sopCode
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_');
    if (!formattedCode || !sopName.trim()) {
      setSopError('Category ID and Name are required.');
      return;
    }

    const steps = sopStepsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const existingSop = state.category_sops.find((c) => c.categoryId === formattedCode);
    const payload: CategorySop = {
      ...(existingSop || {}),
      categoryId: formattedCode,
      categoryName: sopName.trim(),
      defaultClassification: sopClass,
      sopSystemPrompt: sopPrompt.trim(),
      defaultMicroSteps: steps.length > 0 ? steps : ['Complete task and share confirmation'],
      requiredFacts: sopFactsText
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean),
      ...normalizeTaskTypeAssignment(
        { defaultPhone: sopDefaultPhone, backupPhone: sopBackupPhone, spendApprovalRequired: sopSpendApproval },
        membersList.map((m) => m.phone)
      ),
    };

    onUpsertSop?.(payload);
    setIsCreatingSop(false);
    setSelectedSopId(payload.categoryId);
    setSopError('');
    onNotify?.(`Saved SOP Playbook [${payload.categoryId}].`);
  };

  // System Memory State
  const [memCategory, setMemCategory] = useState<SystemMemoryCategory>('BUSINESS_RULE');
  const [memFact, setMemFact] = useState('');
  const [memError, setMemError] = useState('');
  const [editingMemId, setEditingMemId] = useState<string | null>(null);
  const [editingMemText, setEditingMemText] = useState('');

  const handleCreateRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (state.system_memory.length >= MAX_SYSTEM_MEMORY_RULES) {
      setMemError(
        `System Memory is capped at ${MAX_SYSTEM_MEMORY_RULES} rules. Remove an obsolete rule first.`
      );
      return;
    }
    if (!memFact.trim()) {
      setMemError('Enter a clear operational rule or fact.');
      return;
    }
    setMemError('');
    onAddMemoryRule?.(memCategory, memFact.trim());
    setMemFact('');
    onNotify?.('Added rule to System Memory.');
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Sub-Tab Switcher */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-hairline pb-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-ink font-display">
              AI Brain &amp; Setup
            </h1>
            <p className="text-xs text-slate mt-0.5">
              {SECTION_EXPLAINERS.aiBrain}
            </p>
            {onOpenImport && (
              <button
                type="button"
                onClick={onOpenImport}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-paper transition-colors"
              >
                <Upload className="h-3.5 w-3.5 text-signal" /> Import team setup
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-1 rounded-xl border border-hairline bg-surface-muted p-1">
          <button
            type="button"
            onClick={() => setActiveSection('BUSINESS_OWNER')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              activeSection === 'BUSINESS_OWNER'
                ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5 text-signal" />
            1. Business &amp; Owner Profile
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('SPLITTING_EXAMPLES')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              activeSection === 'SPLITTING_EXAMPLES'
                ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            <Layers className="h-3.5 w-3.5 text-info" />
            2. Task Splitting &amp; Examples ({sampleDumps.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('SOPS')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              activeSection === 'SOPS'
                ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5 text-info" />
            3. Category SOPs ({state.category_sops.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('MEMORY')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              activeSection === 'MEMORY'
                ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            <Layers className="h-3.5 w-3.5 text-warn" />
            <span className="tabular-nums">
              4. System Memory ({state.system_memory.length}/{MAX_SYSTEM_MEMORY_RULES})
            </span>
            {pendingMemoryCount > 0 && (
              <span className="rounded-md bg-warn-soft border border-warn-border text-warn px-1.5 py-0.2 text-[10px] font-bold tabular-nums">
                {pendingMemoryCount} pending
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('PROMPTS')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              activeSection === 'PROMPTS'
                ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            <Brain className="h-3.5 w-3.5 text-signal" />
            5. Master System Prompts
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('MODEL_TUNING')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              activeSection === 'MODEL_TUNING'
                ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                : 'text-slate hover:text-ink'
            }`}
          >
            <Sliders className="h-3.5 w-3.5 text-ink" />
            6. Model Tuning &amp; Telemetry ({aiLogs.length})
          </button>
          {canViewDemoVisitors && (
            <button
              type="button"
              onClick={() => setActiveSection('DEMO_VISITORS')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                activeSection === 'DEMO_VISITORS'
                  ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                  : 'text-slate hover:text-ink'
              }`}
            >
              <Users className="h-3.5 w-3.5 text-signal" />
              7. Demo Visitors
            </button>
          )}
        </div>
      </div>

      {/* SECTION 1: BUSINESS PROFILE & OWNER PROFILE */}
      {activeSection === 'BUSINESS_OWNER' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Card 1: Business Profile & How We Work */}
          <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-4">
            <div className="flex items-center justify-between border-b border-hairline pb-3">
              <div>
                <h2 className="text-sm font-bold text-ink font-display">
                  1. Business Profile &amp; How We Work
                </h2>
                <p className="text-xs text-slate mt-0.5">
                  Tell the AI about your business, work zones, default staff language, and non-negotiable rules.
                </p>
              </div>
              <span className="rounded-md bg-ok-soft border border-ok-border px-2.5 py-0.5 text-[10px] font-bold text-ok shrink-0">
                Auto-Saved
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Business Name
                </label>
                <input
                  type="text"
                  value={businessProfile.businessName}
                  onChange={(e) => updateBusinessField('businessName', e.target.value)}
                  placeholder="e.g. Sunrise Hospitality & Events"
                  className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Business Type / Industry
                </label>
                <input
                  type="text"
                  value={businessProfile.businessType}
                  onChange={(e) => updateBusinessField('businessType', e.target.value)}
                  placeholder="e.g. Hospitality, Manufacturing, Retail"
                  className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink mb-1">
                How Our Business Works (Description)
              </label>
              <textarea
                rows={3}
                value={businessProfile.businessDescription}
                onChange={(e) => updateBusinessField('businessDescription', e.target.value)}
                placeholder="Describe your daily operations, how teams coordinate, and what kind of work happens on site..."
                className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-ink mb-1">
                  Work Locations / Zones
                </label>
                <input
                  type="text"
                  value={businessProfile.workLocations}
                  onChange={(e) => updateBusinessField('workLocations', e.target.value)}
                  placeholder="e.g. Zone A, Warehouse, Equipment Room, Floor 1-3"
                  className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Default Staff Language
                </label>
                <select
                  value={businessProfile.defaultStaffLanguage}
                  onChange={(e) =>
                    updateBusinessField(
                      'defaultStaffLanguage',
                      e.target.value as PreferredLanguage
                    )
                  }
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink focus:border-signal focus:outline-none"
                >
                  <option value="HINGLISH">Hinglish (Roman Hindi)</option>
                  <option value="HINDI">Hindi (Devanagari)</option>
                  <option value="ENGLISH">English</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink mb-1">
                Hard Business Rules (Always Enforced by AI)
              </label>
              <textarea
                rows={3}
                value={businessProfile.hardRules}
                onChange={(e) => updateBusinessField('hardRules', e.target.value)}
                placeholder="e.g. Every market purchase requires a proper tax invoice photo. Safety checks must happen before power-on."
                className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
              />
            </div>

            {/* Scheduling, Digest Batching & WhatsApp 24h Window Settings */}
            <div className="rounded-xl border border-info-border bg-info-soft/50 p-3.5 space-y-3">
              <div className="text-xs font-bold text-ink">
                Release Scheduler &amp; WhatsApp 24-Hour Window Policy
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-ink mb-1">
                    Business Timezone (IANA)
                  </label>
                  <input
                    type="text"
                    value={businessProfile.timezone || 'Asia/Kolkata'}
                    onChange={(e) => updateBusinessField('timezone', e.target.value)}
                    placeholder="Asia/Kolkata"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink"
                  />
                </div>

                <div>
                  <span className="block text-[11px] font-semibold text-ink mb-1">
                    Working Days
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dayLabel, dayIdx) => {
                      const days = businessProfile.workingDays || [0, 1, 2, 3, 4, 5, 6];
                      const active = days.includes(dayIdx);
                      return (
                        <button
                          key={dayLabel}
                          type="button"
                          onClick={() => {
                            const nextDays = active
                              ? days.filter((d) => d !== dayIdx)
                              : [...days, dayIdx].sort((a, b) => a - b);
                            updateBusinessField('workingDays', nextDays);
                          }}
                          className={`rounded-md px-2 py-1 text-[10px] font-bold border transition-colors ${
                            active
                              ? 'bg-ink text-white border-ink'
                              : 'bg-surface text-slate border-hairline-strong hover:bg-paper'
                          }`}
                        >
                          {dayLabel}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2 pt-1">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-ink cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(businessProfile.batchNonUrgentIntoDigest)}
                    onChange={(e) =>
                      updateBusinessField('batchNonUrgentIntoDigest', e.target.checked)
                    }
                    className="h-3.5 w-3.5 rounded border-hairline-strong accent-signal"
                  />
                  Batch non-urgent releases into the teammate&apos;s next daily digest
                </label>

                <label className="inline-flex items-center gap-2 text-xs font-medium text-ink cursor-pointer">
                  <input
                    type="checkbox"
                    checked={businessProfile.enforceWhatsapp24hWindow !== false}
                    onChange={(e) =>
                      updateBusinessField('enforceWhatsapp24hWindow', e.target.checked)
                    }
                    className="h-3.5 w-3.5 rounded border-hairline-strong accent-signal"
                  />
                  Enforce WhatsApp 24-hour customer service window (use approved template outside 24h)
                </label>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-ink mb-1">
                  Out-of-Window Template Variant (placeholders: {'{{name}}'}, {'{{shortTag}}'}, {'{{title}}'}, {'{{dueDate}}'}, {'{{body}}'})
                </label>
                <textarea
                  rows={2}
                  value={businessProfile.whatsappTemplateText || ''}
                  onChange={(e) => updateBusinessField('whatsappTemplateText', e.target.value)}
                  placeholder="📋 [Approved Template] Hello {{name}}, update for [{{shortTag}}] ({{title}}) — Due: {{dueDate}}.\n{{body}}"
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink font-mono"
                />
              </div>
            </div>
          </div>

          {/* Card 2: Owner Profile & Delegation Style */}
          <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-4 flex flex-col justify-between">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-hairline pb-3">
                <div>
                  <h2 className="text-sm font-bold text-ink font-display">
                    2. Owner Profile &amp; Delegation Style
                  </h2>
                  <p className="text-xs text-slate mt-0.5">
                    Define how you operate, what you delegate, and who is Accountable (A) by default.
                  </p>
                </div>
                <span className="rounded-md bg-ok-soft border border-ok-border px-2.5 py-0.5 text-[10px] font-bold text-ok shrink-0">
                  Auto-Saved
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  My Personal Operating Prompt
                </label>
                <p className="text-[11px] text-slate mb-2">
                  How I work, what tasks I keep for myself, what I always delegate, and when I want to be asked for approval:
                </p>
                <textarea
                  rows={7}
                  value={ownerProfile.personalOperatingPrompt}
                  onChange={(e) => updateOwnerField('personalOperatingPrompt', e.target.value)}
                  placeholder="Describe your personal management style, what decisions should come to your Boss Review Queue, and how the AI should delegate work across your team..."
                  className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none leading-relaxed"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Who answers for tasks by default?
                </label>
                <p className="text-[11px] text-slate mb-2">
                  Select the Owner or a Manager/Supervisor who signs off on tasks by default.
                </p>
                <select
                  value={ownerProfile.defaultAccountablePhone}
                  onChange={(e) => updateOwnerField('defaultAccountablePhone', e.target.value)}
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                >
                  {(accountableCandidates.length > 0 ? accountableCandidates : membersList).map(
                    (m) => (
                      <option key={m.phone} value={m.phone}>
                        {m.name} — {m.roleTitle}
                      </option>
                    )
                  )}
                </select>
              </div>

              <div>
                <label htmlFor="owner-follow-up-hours" className="block text-xs font-semibold text-ink mb-1">
                  Follow up when a delegated task has no update for (hours)
                </label>
                <p className="text-[11px] text-slate mb-2">
                  Used by My tasks → Follow up and your daily summary. Counts clock hours since the person&apos;s last
                  WhatsApp update on the task (or since it was sent).
                </p>
                <input
                  id="owner-follow-up-hours"
                  type="number"
                  min={1}
                  max={720}
                  step={1}
                  value={ownerProfile.followUpStuckHours ?? 24}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    updateOwnerField('followUpStuckHours', Number.isFinite(n) && n >= 1 ? Math.min(720, n) : 24);
                  }}
                  className="w-32 rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs font-semibold text-ink tabular-nums focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>
            </div>

            <div className="rounded-xl border border-hairline bg-paper p-3.5 text-xs text-slate">
              <strong className="text-ink">Live AI Integration:</strong> Every brain-dump you speak or type in Meditate Studio automatically injects your Business Profile and Personal Operating Prompt into Gemini.
            </div>
          </div>
        </div>
      )}

      {/* SECTION 2: TASK SPLITTING & CAPACITY RULES + SAMPLE BRAIN-DUMPS */}
      {activeSection === 'SPLITTING_EXAMPLES' && (
        <div className="space-y-6">
          {/* Task Splitting & Capacity Rules Card */}
          <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-4">
            <div className="flex items-center justify-between border-b border-hairline pb-3">
              <div>
                <h2 className="text-sm font-bold text-ink font-display">
                  3. Task Splitting &amp; Capacity Rules (Smart Breakdown)
                </h2>
                <p className="text-xs text-slate mt-0.5">
                  Control when the AI keeps work as 1 Quick Task for one person vs. when it splits work into a Multi-Task Project.
                </p>
              </div>
              <span className="rounded-md bg-ok-soft border border-ok-border px-2.5 py-0.5 text-[10px] font-bold text-ok shrink-0">
                Auto-Saved
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-xl border border-hairline bg-paper p-4">
                <label className="block text-xs font-bold text-ink mb-1">
                  Max Checklist Steps per Task
                </label>
                <p className="text-[11px] text-slate mb-2">
                  Keeps WhatsApp checklists short and actionable (default: 5).
                </p>
                <input
                  type="number"
                  min={1}
                  max={15}
                  value={splittingRules.maxChecklistStepsPerTask}
                  onChange={(e) =>
                    updateSplittingField(
                      'maxChecklistStepsPerTask',
                      Math.max(1, Number(e.target.value) || 5)
                    )
                  }
                  className="w-28 rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-sm font-bold text-ink tabular-nums"
                />
              </div>

              <div className="rounded-xl border border-hairline bg-paper p-4">
                <label className="block text-xs font-bold text-ink mb-1">
                  Default Max Active Tasks per Person
                </label>
                <p className="text-[11px] text-slate mb-2">
                  Default capacity limit per teammate unless overridden on their roster card (default: 3).
                </p>
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={splittingRules.defaultMaxActiveTasksPerPerson}
                  onChange={(e) =>
                    updateSplittingField(
                      'defaultMaxActiveTasksPerPerson',
                      Math.max(1, Number(e.target.value) || 3)
                    )
                  }
                  className="w-28 rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-sm font-bold text-ink tabular-nums"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-ink mb-1">
                When to split work (one quick task, or a project with stages)
              </label>
              <textarea
                rows={4}
                value={splittingRules.taskSplittingRule}
                onChange={(e) => updateSplittingField('taskSplittingRule', e.target.value)}
                placeholder="Tell the AI when to keep work as 1 Quick Task vs when to split into Multiple Tasks / Project Swimlanes..."
                className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none leading-relaxed"
              />
            </div>
          </div>

          {/* Sample Brain-Dumps Card */}
          <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-5">
            <div className="border-b border-hairline pb-3">
              <h2 className="text-sm font-bold text-ink font-display">
                4. Sample Brain-Dumps (Examples for the AI &amp; Quick-Fill Chips)
              </h2>
              <p className="text-xs text-slate mt-0.5">
                Add example sentences of what you say into your phone and how the AI should split them. These also appear as 1-click sample buttons in Meditate Studio.
              </p>
            </div>

            <form
              onSubmit={handleAddSampleDump}
              className="rounded-xl border border-hairline bg-paper p-4 space-y-3"
            >
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
                <div className="lg:col-span-3">
                  <label className="block text-xs font-semibold text-ink mb-1">
                    What I Say Into My Phone (Sample Brain-Dump)
                  </label>
                  <input
                    type="text"
                    value={newSampleText}
                    onChange={(e) => setNewSampleText(e.target.value)}
                    placeholder="e.g. Bakery: restock flour by 4 pm; Clinic: confirm appointments; Warehouse: check dispatch van tyres."
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink focus:border-signal focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    How AI Should Split It
                  </label>
                  <select
                    value={newSampleType}
                    onChange={(e) =>
                      setNewSampleType(e.target.value as 'QUICK_TASK' | 'PROJECT_SWIMLANES')
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink"
                  >
                    <option value="QUICK_TASK">1 Quick Task (Single Person)</option>
                    <option value="PROJECT_SWIMLANES">Project (several people or stages)</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Expected AI Behavior / Notes (Optional)
                  </label>
                  <input
                    type="text"
                    value={newSampleInstruction}
                    onChange={(e) => setNewSampleInstruction(e.target.value)}
                    placeholder="e.g. Keep as 1 Quick Task for P2 with 2 checklist steps."
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-xs font-bold text-white hover:bg-ink-hover shrink-0 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5 text-signal" />
                  Add Example
                </button>
              </div>
            </form>

            <div className="space-y-2.5">
              {sampleDumps.map((sample) => {
                const isEditing = editingSampleId === sample.id;
                return (
                  <div
                    key={sample.id}
                    className="rounded-xl border border-hairline bg-surface p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-hairline-strong transition-all"
                  >
                    {isEditing ? (
                      <div className="flex-1 space-y-2">
                        <input
                          type="text"
                          value={editingSampleText}
                          onChange={(e) => setEditingSampleText(e.target.value)}
                          className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-xs text-ink"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={editingSampleType}
                            onChange={(e) =>
                              setEditingSampleType(
                                e.target.value as 'QUICK_TASK' | 'PROJECT_SWIMLANES'
                              )
                            }
                            className="rounded-lg border border-hairline-strong bg-surface px-2.5 py-1 text-xs font-semibold text-ink"
                          >
                            <option value="QUICK_TASK">1 Quick Task (Single Person)</option>
                            <option value="PROJECT_SWIMLANES">Project (several people or stages)</option>
                          </select>
                          <input
                            type="text"
                            value={editingSampleInstruction}
                            onChange={(e) => setEditingSampleInstruction(e.target.value)}
                            placeholder="AI splitting guidance..."
                            className="flex-1 rounded-lg border border-hairline-strong bg-paper px-2.5 py-1 text-xs text-ink"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveEditedSample(sample.id)}
                            className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1 text-xs font-bold text-white hover:bg-ink-hover"
                          >
                            <Check className="h-3 w-3 text-signal" />
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingSampleId(null)}
                            className="rounded-lg border border-hairline-strong bg-surface px-2.5 py-1 text-xs font-semibold text-slate hover:text-ink"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="space-y-1 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase border ${
                                sample.splitType === 'QUICK_TASK'
                                  ? 'bg-signal-soft text-signal-ink border-signal-border'
                                  : 'bg-info-soft text-info border-info-border'
                              }`}
                            >
                              {sample.splitType === 'QUICK_TASK'
                                ? '1 Quick Task'
                                : 'Multi-Task Project'}
                            </span>
                            {sample.aiInstruction && (
                              <span className="text-[11px] text-slate font-medium">
                                {sample.aiInstruction}
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-medium text-ink leading-relaxed">
                            "{sample.text}"
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingSampleId(sample.id);
                              setEditingSampleText(sample.text);
                              setEditingSampleType(sample.splitType);
                              setEditingSampleInstruction(sample.aiInstruction || '');
                            }}
                            className="rounded-lg border border-hairline bg-surface p-1.5 text-slate hover:bg-paper hover:text-ink"
                            title="Edit example"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSample(sample.id)}
                            className="rounded-lg border border-hairline bg-surface p-1.5 text-danger hover:bg-danger-soft"
                            title="Delete example"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}

              {sampleDumps.length === 0 && (
                <div className="rounded-xl border border-dashed border-hairline-strong bg-paper p-6 text-center text-xs text-slate">
                  No sample brain-dumps yet. Add one above to train the AI and create quick-fill buttons in Meditate Studio.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SECTION 5: MASTER SYSTEM PROMPTS */}
      {activeSection === 'PROMPTS' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-signal-border bg-signal-soft/50 p-4 text-xs text-ink flex items-start gap-3">
            <Sparkles className="h-5 w-5 text-signal shrink-0 mt-0.5" />
            <div>
              <span className="font-bold">Core AI Brain Configuration:</span>
              <p className="mt-0.5 text-slate leading-relaxed">
                These 2 master prompts directly govern the AI models alongside your Business Profile and Owner Operating Prompt.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Prompt 1 */}
            <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-card)] space-y-3 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-signal-soft border border-signal-border px-2 py-0.5 text-xs font-bold text-signal-ink">
                    Prompt 1
                  </span>
                  <h3 className="text-sm font-bold text-ink">
                    Principal Planning &amp; Classification Prompt
                  </h3>
                </div>
                <p className="text-xs text-slate">
                  Controls Eisenhower 4-quadrant assignment, Major vs. Minor scope, RACI allocation, and SOP micro-step generation in Meditate Studio.
                </p>
                <textarea
                  rows={14}
                  value={planningPrompt}
                  onChange={(e) => setPlanningPrompt(e.target.value)}
                  className="w-full font-mono text-xs rounded-xl border border-hairline bg-paper p-3 text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>

              <div className="text-[11px] font-mono tabular-nums text-slate">{planningPrompt.length} characters</div>
            </div>

            {/* Prompt 2 */}
            <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-card)] space-y-3 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-info-soft border border-info-border px-2 py-0.5 text-xs font-bold text-info">
                    Prompt 2
                  </span>
                  <h3 className="text-sm font-bold text-ink">
                    Principal WhatsApp Evaluation &amp; Communication Prompt
                  </h3>
                </div>
                <p className="text-xs text-slate">
                  Controls multimodal inspection of incoming text/voice/photos, chronological overrides, missing steps detection, and outbound replies.
                </p>
                <textarea
                  rows={14}
                  value={evaluationPrompt}
                  onChange={(e) => setEvaluationPrompt(e.target.value)}
                  className="w-full font-mono text-xs rounded-xl border border-hairline bg-paper p-3 text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>

              <div className="text-[11px] font-mono tabular-nums text-slate">{evaluationPrompt.length} characters</div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={handleResetPromptsToDefault}
              className="inline-flex items-center gap-1.5 rounded-xl border border-hairline-strong bg-surface px-4 py-2 text-xs font-semibold text-slate hover:text-ink hover:bg-surface-muted transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to Defaults
            </button>
            <button
              type="button"
              onClick={handleSavePrincipalPrompts}
              className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-5 py-2 text-xs font-bold text-white hover:bg-ink-hover shadow-[var(--shadow-card)] transition-colors"
            >
              <Save className="h-3.5 w-3.5 text-signal" />
              Save Master System Prompts
            </button>
          </div>
        </div>
      )}

      {/* SECTION 3: CATEGORY SOPS */}
      {activeSection === 'SOPS' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate">
                Department SOP Playbooks
              </h3>
              <button
                type="button"
                onClick={startNewSop}
                className="inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1 text-xs font-bold text-white hover:bg-ink-hover transition-colors"
              >
                <Plus className="h-3.5 w-3.5 text-signal" />
                New SOP
              </button>
            </div>

            <div className="space-y-2">
              {state.category_sops.map((sop) => {
                const isSelected = !isCreatingSop && sop.categoryId === selectedSopId;
                return (
                  <button
                    key={sop.categoryId}
                    type="button"
                    onClick={() => selectExistingSop(sop)}
                    className={`w-full text-left rounded-xl border p-3.5 transition-all ${
                      isSelected
                        ? 'border-ink bg-ink text-white shadow-[var(--shadow-card)]'
                        : 'border-hairline bg-surface text-ink hover:border-hairline-strong'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold">{sop.categoryId}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          isSelected
                            ? 'bg-white/20 text-white'
                            : sop.defaultClassification === 'MAJOR'
                              ? 'bg-warn-soft border border-warn-border text-warn'
                              : 'bg-surface-muted text-slate'
                        }`}
                      >
                        {sop.defaultClassification}
                      </span>
                    </div>
                    <div className="text-xs font-medium mt-1 opacity-95">{sop.categoryName}</div>
                    <div className="text-[11px] mt-1 opacity-75 tabular-nums">
                      {sop.defaultMicroSteps.length} standard verification steps
                    </div>
                    {(sop.defaultResponsiblePhone || sop.spendApprovalRequired) && (
                      <div className="text-[11px] mt-1 opacity-85">
                        {sop.defaultResponsiblePhone && (
                          <>
                            Default: {state.team_members[sop.defaultResponsiblePhone]?.name || 'removed person'}
                            {sop.backupResponsiblePhone &&
                              ` · Backup: ${state.team_members[sop.backupResponsiblePhone]?.name || 'removed person'}`}
                          </>
                        )}
                        {sop.defaultResponsiblePhone && sop.spendApprovalRequired && ' · '}
                        {sop.spendApprovalRequired && 'Approval before spending'}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="lg:col-span-8">
            <form
              onSubmit={handleSaveSop}
              className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-4"
            >
              <div className="border-b border-hairline pb-3 flex items-center justify-between">
                <h3 className="text-sm font-bold text-ink">
                  {isCreatingSop ? 'Create New Category SOP' : `Edit SOP: ${sopCode}`}
                </h3>
                <span className="text-xs text-slate">Injected into AI task generation</span>
              </div>

              {sopError && (
                <div className="rounded-lg bg-danger-soft border border-danger-border p-2.5 text-xs text-danger">
                  {sopError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Category Code
                  </label>
                  <input
                    type="text"
                    value={sopCode}
                    disabled={!isCreatingSop}
                    onChange={(e) => setSopCode(e.target.value)}
                    placeholder="e.g. LOGISTICS"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-mono uppercase text-ink focus:border-signal focus:outline-none disabled:bg-surface-muted disabled:text-slate"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={sopName}
                    onChange={(e) => setSopName(e.target.value)}
                    placeholder="Logistics & Transport"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Default Scope
                  </label>
                  <select
                    value={sopClass}
                    onChange={(e) => setSopClass(e.target.value as Classification)}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                  >
                    <option value="MAJOR">MAJOR</option>
                    <option value="MINOR">MINOR</option>
                  </select>
                </div>
              </div>

              <div className="rounded-xl border border-hairline bg-paper p-3.5 space-y-3">
                <div>
                  <h4 className="text-xs font-bold text-ink">Who does this type of task</h4>
                  <p className="text-[11px] text-slate mt-0.5">
                    The AI gives this task type to the default person. If they are on leave or at their task limit, it uses the
                    backup. If neither is set or free, it picks someone using each person&apos;s &quot;What they handle&quot;
                    (edit that in 2x2 Matrix &amp; Team).
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="sop-default-responsible" className="block text-xs font-semibold text-ink mb-1">
                      Default Responsible
                    </label>
                    <select
                      id="sop-default-responsible"
                      value={sopDefaultPhone}
                      onChange={(e) => setSopDefaultPhone(e.target.value)}
                      className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                    >
                      <option value="">Not set — AI chooses</option>
                      {membersList.map((m) => (
                        <option key={m.phone} value={m.phone}>
                          {m.name} — {m.roleTitle}
                          {m.isOnLeave ? ' (on leave)' : ''}
                        </option>
                      ))}
                      {sopDefaultPhone && !state.team_members[sopDefaultPhone] && (
                        <option value={sopDefaultPhone}>Removed person</option>
                      )}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="sop-backup-responsible" className="block text-xs font-semibold text-ink mb-1">
                      Backup (optional)
                    </label>
                    <select
                      id="sop-backup-responsible"
                      value={sopBackupPhone}
                      onChange={(e) => setSopBackupPhone(e.target.value)}
                      className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                    >
                      <option value="">No backup</option>
                      {membersList
                        .filter((m) => m.phone !== sopDefaultPhone)
                        .map((m) => (
                          <option key={m.phone} value={m.phone}>
                            {m.name} — {m.roleTitle}
                            {m.isOnLeave ? ' (on leave)' : ''}
                          </option>
                        ))}
                      {sopBackupPhone && !state.team_members[sopBackupPhone] && (
                        <option value={sopBackupPhone}>Removed person</option>
                      )}
                    </select>
                  </div>
                </div>
                <label className="flex items-start gap-2 text-xs text-ink">
                  <input
                    id="sop-spend-approval"
                    type="checkbox"
                    checked={sopSpendApproval}
                    onChange={(e) => setSopSpendApproval(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-hairline-strong accent-signal"
                  />
                  <span>
                    <span className="font-semibold">Approval needed before spending</span>
                    <span className="block text-[11px] text-slate">
                      When a task of this type involves buying or paying, the first step is getting approval from the
                      Accountable person.
                    </span>
                  </span>
                </label>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  SOP AI System Directive (optional)
                </label>
                <textarea
                  rows={3}
                  value={sopPrompt}
                  onChange={(e) => setSopPrompt(e.target.value)}
                  className="w-full rounded-lg border border-hairline-strong bg-surface p-3 text-xs text-ink focus:border-signal focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Default Micro-Steps Checklist (One per line)
                </label>
                <textarea
                  rows={5}
                  value={sopStepsText}
                  onChange={(e) => setSopStepsText(e.target.value)}
                  className="w-full rounded-lg border border-hairline-strong bg-surface p-3 text-xs font-mono text-ink focus:border-signal focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Must know before planning (one per line)
                </label>
                <p className="text-[11px] text-slate mb-1">
                  If your message leaves one of these out, Meditate asks you one short question instead of guessing.
                </p>
                <textarea
                  rows={3}
                  value={sopFactsText}
                  onChange={(e) => setSopFactsText(e.target.value)}
                  placeholder={'Quantity\nAddress\nDate'}
                  className="w-full rounded-lg border border-hairline-strong bg-surface p-3 text-xs text-ink focus:border-signal focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {onRunRoutine && !isCreatingSop && currentSop && (
                  <>
                    <button
                      type="button"
                      onClick={() => onRunRoutine(currentSop.categoryId, false)}
                      className="rounded-xl border border-hairline bg-paper px-3 py-2 text-xs font-semibold text-ink hover:bg-surface-muted"
                      title="Send this checklist now to the task type's default person"
                    >
                      Run now
                    </button>
                    <button
                      type="button"
                      onClick={() => onRunRoutine(currentSop.categoryId, true)}
                      className="rounded-xl border border-hairline bg-paper px-3 py-2 text-xs font-semibold text-ink hover:bg-surface-muted"
                      title="Repeat this checklist every day for the default person"
                    >
                      Run daily
                    </button>
                  </>
                )}
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-xs font-bold text-white hover:bg-ink-hover transition-colors"
                >
                  <Save className="h-3.5 w-3.5 text-signal" />
                  Save SOP Playbook
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SECTION 4: SYSTEM MEMORY */}
      {activeSection === 'MEMORY' && (
        <div className="space-y-5">
          <form
            onSubmit={handleCreateRule}
            className="rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-card)] space-y-3"
          >
            <h3 className="text-sm font-bold text-ink">
              Add Persistent Organizational Memory Rule
            </h3>
            {memError && (
              <div className="rounded-lg bg-danger-soft border border-danger-border p-2.5 text-xs text-danger">
                {memError}
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-3">
              <select
                value={memCategory}
                onChange={(e) => setMemCategory(e.target.value as SystemMemoryCategory)}
                className="rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
              >
                <option value="BUSINESS_RULE">BUSINESS_RULE</option>
                <option value="VENDOR_FACT">VENDOR_FACT</option>
                <option value="STAFF_TRAIT">STAFF_TRAIT</option>
                <option value="SOP_PREFERENCE">SOP_PREFERENCE</option>
              </select>
              <input
                type="text"
                value={memFact}
                onChange={(e) => setMemFact(e.target.value)}
                placeholder="Enter a permanent business rule, vendor preference, or team fact..."
                className="flex-1 rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink focus:border-signal focus:outline-none"
              />
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-xs font-bold text-white hover:bg-ink-hover transition-colors"
              >
                <Plus className="h-3.5 w-3.5 text-signal" />
                Save Rule
              </button>
            </div>
          </form>

          <div className="space-y-2.5">
            {state.system_memory.map((rule) => {
              const isEditing = editingMemId === rule.memoryId;
              const isPendingApproval = rule.approved === false;
              return (
                <div
                  key={rule.memoryId}
                  className={`rounded-xl border p-4 flex items-center justify-between gap-4 ${
                    isPendingApproval
                      ? 'border-warn-border bg-warn-soft/50'
                      : 'border-hairline bg-surface'
                  }`}
                >
                  <div className="flex items-center gap-3 flex-1 flex-wrap">
                    <input
                      type="checkbox"
                      checked={!isPendingApproval && rule.active}
                      disabled={isPendingApproval}
                      onChange={() => onToggleMemoryRule?.(rule.memoryId)}
                      className="h-4 w-4 rounded border-hairline-strong accent-signal disabled:opacity-40"
                      title={
                        isPendingApproval
                          ? 'Approve rule first to activate in AI prompts'
                          : 'Toggle rule active status'
                      }
                    />
                    <span className="rounded bg-surface-muted px-2 py-0.5 text-[10px] font-bold text-slate">
                      {rule.category}
                    </span>
                    {isPendingApproval && (
                      <span className="rounded-full bg-warn-soft border border-warn-border text-warn px-2 py-0.5 text-[10px] font-bold">
                        Pending Approval
                      </span>
                    )}
                    {isEditing ? (
                      <input
                        type="text"
                        value={editingMemText}
                        onChange={(e) => setEditingMemText(e.target.value)}
                        className="flex-1 rounded border border-hairline-strong bg-surface px-2 py-1 text-xs text-ink focus:border-signal focus:outline-none"
                      />
                    ) : (
                      <span
                        className={`text-xs font-medium ${
                          isPendingApproval
                            ? 'text-ink'
                            : rule.active
                              ? 'text-ink'
                              : 'line-through text-slate'
                        }`}
                      >
                        {rule.fact}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {isPendingApproval && !isEditing && (
                      <button
                        type="button"
                        onClick={() => onApproveMemoryRule?.(rule.memoryId)}
                        className="inline-flex items-center gap-1 rounded-lg bg-ok-solid px-2.5 py-1 text-xs font-bold text-white hover:bg-ok transition-colors"
                        title="Approve rule and activate in AI prompts"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Approve
                      </button>
                    )}
                    {isEditing ? (
                      <button
                        type="button"
                        onClick={() => {
                          onUpdateMemoryFact?.(rule.memoryId, editingMemText);
                          setEditingMemId(null);
                        }}
                        className="rounded bg-ok-solid px-2.5 py-1 text-xs font-bold text-white hover:bg-ok transition-colors"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMemId(rule.memoryId);
                          setEditingMemText(rule.fact);
                        }}
                        className="rounded border border-hairline bg-surface p-1.5 text-slate hover:text-ink hover:bg-surface-muted transition-colors"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDeleteMemoryRule?.(rule.memoryId)}
                      className="rounded border border-hairline bg-surface p-1.5 text-danger hover:bg-danger-soft transition-colors"
                      title={isPendingApproval ? 'Dismiss pending rule' : 'Delete rule'}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SECTION 6: MODEL TUNING, CONTEXT CAP & TELEMETRY LOGS */}
      {activeSection === 'MODEL_TUNING' && (
        <div className="space-y-6">
          {/* Context Capping Card */}
          <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-hairline pb-3">
              <div>
                <h2 className="text-sm font-bold text-ink">
                  Conversation Context Cap &amp; Slot Anonymization
                </h2>
                <p className="text-xs text-slate mt-0.5">
                  All prompts replace staff names and phone numbers with anonymized Slot IDs (P1, P2...) before calling Gemini. Older conversation turns beyond the cap are condensed into a concise summary.
                </p>
              </div>
              <span className="rounded-full bg-ok-soft border border-ok-border px-2.5 py-0.5 text-[11px] font-bold text-ok shrink-0">
                Zero-PII Slot Identity Active
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-ink mb-1">
                  Max Recent Conversation Turns Sent Verbatim (Max 8)
                </label>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={modelTuning.maxRecentConversationTurns}
                  onChange={(e) => {
                    const clamped = Math.max(1, Math.min(8, Number(e.target.value) || 8));
                    onUpdateModelTuning?.({
                      ...modelTuning,
                      maxRecentConversationTurns: clamped,
                    });
                  }}
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                />
                <p className="text-[11px] text-slate mt-1">
                  Hard-capped at 8 turns; turns older than this cap are automatically summarized.
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-ink mb-1 tabular-nums">
                  Meditate v2 Intent Confidence Threshold (
                  {(modelTuning.intentConfidenceThreshold ?? 0.75).toFixed(2)})
                </label>
                <input
                  type="number"
                  step={0.05}
                  min={0}
                  max={1}
                  value={modelTuning.intentConfidenceThreshold ?? 0.75}
                  onChange={(e) => {
                    const rawVal = Number.parseFloat(e.target.value);
                    const clamped = Number.isFinite(rawVal)
                      ? Math.max(0, Math.min(1, Number(rawVal.toFixed(2))))
                      : 0.75;
                    onUpdateModelTuning?.({
                      ...modelTuning,
                      intentConfidenceThreshold: clamped,
                    });
                  }}
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                />
                <p className="text-[11px] text-slate mt-1">
                  Below this threshold (default 0.75), Meditate v2 shows confirm chips in chat.
                </p>
              </div>
            </div>
          </div>

          {/* Per-Stage Model & Temperature Controls */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Meditate v2 Stage A: INTENT */}
            <div className="rounded-2xl border border-signal-border bg-surface p-6 shadow-[var(--shadow-card)] space-y-4">
              <div className="border-b border-hairline pb-3">
                <h3 className="text-sm font-bold text-ink">
                  Meditate v2 Stage 1: Semantic Intent Gate (`INTENT`)
                </h3>
                <p className="text-xs text-slate mt-0.5">
                  Classifies TASK / NOTE / RULE / QUESTION / CASUAL and checks missingCritical before planning.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Primary Model</label>
                  <select
                    value={modelTuning.intent?.model || defaultIntentStage.model}
                    onChange={(e) => updateStageTuning('intent', { model: e.target.value })}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {modelOptions}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Fallback Model</label>
                  <select
                    value={modelTuning.intent?.fallbackModel || defaultIntentStage.fallbackModel}
                    onChange={(e) => updateStageTuning('intent', { fallbackModel: e.target.value })}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {modelOptions}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1 tabular-nums">
                    Temperature ({(modelTuning.intent?.temperature ?? 0.1).toFixed(2)})
                  </label>
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    max={1.5}
                    value={modelTuning.intent?.temperature ?? 0.1}
                    onChange={(e) =>
                      updateStageTuning('intent', {
                        temperature: Math.max(0, Math.min(1.5, Number(e.target.value) || 0)),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">
                    Max Output Tokens
                  </label>
                  <input
                    type="number"
                    step={256}
                    min={256}
                    max={8192}
                    value={modelTuning.intent?.maxOutputTokens ?? 1024}
                    onChange={(e) =>
                      updateStageTuning('intent', {
                        maxOutputTokens: Math.max(256, Math.min(8192, Number(e.target.value) || 1024)),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Meditate v2 Stage B: PLANNER */}
            <div className="rounded-2xl border border-signal-border bg-surface p-6 shadow-[var(--shadow-card)] space-y-4">
              <div className="border-b border-hairline pb-3">
                <h3 className="text-sm font-bold text-ink">
                  Meditate v2 Stage 2: Task &amp; Lane Planner (`PLANNER`)
                </h3>
                <p className="text-xs text-slate mt-0.5">
                  Runs only for confirmed tasks and outputs QUICK or PROJECT lane with nullable arithmetic fields.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Primary Model</label>
                  <select
                    value={modelTuning.planner?.model || defaultPlannerStage.model}
                    onChange={(e) => updateStageTuning('planner', { model: e.target.value })}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {modelOptions}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Fallback Model</label>
                  <select
                    value={modelTuning.planner?.fallbackModel || defaultPlannerStage.fallbackModel}
                    onChange={(e) => updateStageTuning('planner', { fallbackModel: e.target.value })}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {modelOptions}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1 tabular-nums">
                    Temperature ({(modelTuning.planner?.temperature ?? 0.2).toFixed(2)})
                  </label>
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    max={1.5}
                    value={modelTuning.planner?.temperature ?? 0.2}
                    onChange={(e) =>
                      updateStageTuning('planner', {
                        temperature: Math.max(0, Math.min(1.5, Number(e.target.value) || 0)),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">
                    Max Output Tokens
                  </label>
                  <input
                    type="number"
                    step={256}
                    min={256}
                    max={8192}
                    value={modelTuning.planner?.maxOutputTokens ?? 4096}
                    onChange={(e) =>
                      updateStageTuning('planner', {
                        maxOutputTokens: Math.max(256, Math.min(8192, Number(e.target.value) || 4096)),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Legacy Stage: Meditate Planning */}
            <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-4">
              <div className="border-b border-hairline pb-3">
                <h3 className="text-sm font-bold text-ink">
                  Fallback Single-Pass Planning (`MEDITATE_PLANNING`)
                </h3>
                <p className="text-xs text-slate mt-0.5">
                  Model, temperature, and output token budget for fallback single-pass planning.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Primary Model</label>
                  <select
                    value={modelTuning.meditate.model}
                    onChange={(e) => updateStageTuning('meditate', { model: e.target.value })}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {modelOptions}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Fallback Model</label>
                  <select
                    value={modelTuning.meditate.fallbackModel}
                    onChange={(e) => updateStageTuning('meditate', { fallbackModel: e.target.value })}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {modelOptions}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1 tabular-nums">
                    Temperature ({modelTuning.meditate.temperature.toFixed(2)})
                  </label>
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    max={1.5}
                    value={modelTuning.meditate.temperature}
                    onChange={(e) =>
                      updateStageTuning('meditate', {
                        temperature: Math.max(0, Math.min(1.5, Number(e.target.value) || 0)),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">
                    Max Output Tokens
                  </label>
                  <input
                    type="number"
                    step={256}
                    min={256}
                    max={8192}
                    value={modelTuning.meditate.maxOutputTokens}
                    onChange={(e) =>
                      updateStageTuning('meditate', {
                        maxOutputTokens: Math.max(256, Math.min(8192, Number(e.target.value) || 4096)),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Stage 2: Buffer Evaluation */}
            <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-4">
              <div className="border-b border-hairline pb-3">
                <h3 className="text-sm font-bold text-ink">
                  Stage 2: WhatsApp Buffer Inspector (`BUFFER_EVALUATION`)
                </h3>
                <p className="text-xs text-slate mt-0.5">
                  Controls model, temperature, and output token budget for multimodal WhatsApp batch checks.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Primary Model</label>
                  <select
                    value={modelTuning.bufferEvaluation.model}
                    onChange={(e) => updateStageTuning('bufferEvaluation', { model: e.target.value })}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {modelOptions}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Fallback Model</label>
                  <select
                    value={modelTuning.bufferEvaluation.fallbackModel}
                    onChange={(e) =>
                      updateStageTuning('bufferEvaluation', { fallbackModel: e.target.value })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {modelOptions}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1 tabular-nums">
                    Temperature ({modelTuning.bufferEvaluation.temperature.toFixed(2)})
                  </label>
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    max={1.5}
                    value={modelTuning.bufferEvaluation.temperature}
                    onChange={(e) =>
                      updateStageTuning('bufferEvaluation', {
                        temperature: Math.max(0, Math.min(1.5, Number(e.target.value) || 0)),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">
                    Max Output Tokens
                  </label>
                  <input
                    type="number"
                    step={256}
                    min={256}
                    max={8192}
                    value={modelTuning.bufferEvaluation.maxOutputTokens}
                    onChange={(e) =>
                      updateStageTuning('bufferEvaluation', {
                        maxOutputTokens: Math.max(256, Math.min(8192, Number(e.target.value) || 2048)),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Stage 5: MESSAGE (Release Message Writer) */}
            <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-card)] space-y-4">
              <div className="flex items-center justify-between border-b border-hairline pb-3">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-info bg-info-soft border border-info-border px-2 py-0.5 rounded">
                    Stage 5 · MESSAGE
                  </span>
                  <h3 className="text-sm font-bold text-ink mt-1">
                    Release Message Writer
                  </h3>
                  <p className="text-xs text-slate">
                    Writes localized WhatsApp task messages at release time using higher temperature.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">
                    Primary Model
                  </label>
                  <select
                    value={modelTuning.message?.model || defaultStageConfig('message').model}
                    onChange={(e) => updateStageTuning('message', { model: e.target.value })}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {ALL_MODEL_IDS.map((mId) => (
                      <option key={mId} value={mId}>
                        {mId}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">
                    Fallback Model
                  </label>
                  <select
                    value={
                      modelTuning.message?.fallbackModel ||
                      defaultStageConfig('message').fallbackModel
                    }
                    onChange={(e) =>
                      updateStageTuning('message', { fallbackModel: e.target.value })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-2 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
                  >
                    {ALL_MODEL_IDS.map((mId) => (
                      <option key={mId} value={mId}>
                        {mId}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1 tabular-nums">
                    Temperature ({(modelTuning.message?.temperature ?? 0.65).toFixed(2)})
                  </label>
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    max={1.5}
                    value={modelTuning.message?.temperature ?? 0.65}
                    onChange={(e) =>
                      updateStageTuning('message', {
                        temperature: Math.max(0, Math.min(1.5, Number(e.target.value) || 0)),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">
                    Max Output Tokens
                  </label>
                  <input
                    type="number"
                    step={128}
                    min={256}
                    max={8192}
                    value={modelTuning.message?.maxOutputTokens ?? 512}
                    onChange={(e) =>
                      updateStageTuning('message', {
                        maxOutputTokens: Math.max(
                          256,
                          Math.min(8192, Number(e.target.value) || 512)
                        ),
                      })
                    }
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold tabular-nums text-ink focus:border-signal focus:outline-none"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Live Telemetry Logs Table (`state.ai_logs`) */}
          <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-4">
            <div className="flex items-center justify-between border-b border-hairline pb-3">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-signal" />
                <div>
                  <h3 className="text-sm font-bold text-ink tabular-nums">
                    AI Call Telemetry Logs (`state.ai_logs` · {aiLogs.length})
                  </h3>
                  <p className="text-xs text-slate">
                    Tracks stage, model, temperature, prompt version, latency, and validation status for every AI invocation.
                  </p>
                </div>
              </div>
              {aiLogs.length > 0 && (
                <button
                  type="button"
                  onClick={() => onClearAiLogs?.()}
                  className="rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-slate hover:text-ink hover:bg-surface-muted transition-colors"
                >
                  Clear Logs
                </button>
              )}
            </div>

            {aiLogs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-hairline bg-paper p-6 text-center text-xs text-slate">
                No AI calls logged yet in this session. Send a Brain-Dump in Meditate Studio or flush a WhatsApp batch to record telemetry.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-hairline text-[11px] font-bold text-slate">
                      <th className="py-2 pr-3">Time</th>
                      <th className="py-2 pr-3">Stage</th>
                      <th className="py-2 pr-3">Model</th>
                      <th className="py-2 pr-3">Temp / Tokens</th>
                      <th className="py-2 pr-3">Prompt Version</th>
                      <th className="py-2 pr-3">Latency</th>
                      <th className="py-2 pr-3">Validation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {aiLogs.slice(0, 50).map((log) => (
                      <tr key={log.logId} className="text-ink hover:bg-paper/60 transition-colors">
                        <td className="py-2 pr-3 font-mono tabular-nums text-[11px] text-slate">
                          {new Date(log.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </td>
                        <td className="py-2 pr-3 font-semibold">{log.stage}</td>
                        <td className="py-2 pr-3 font-mono text-[11px]">{log.model}</td>
                        <td className="py-2 pr-3 font-mono tabular-nums text-[11px]">
                          {log.temperature} / {log.maxOutputTokens}
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-slate">
                          {log.promptVersion}
                        </td>
                        <td className="py-2 pr-3 font-mono tabular-nums text-[11px]">{log.latencyMs}ms</td>
                        <td className="py-2 pr-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold border ${
                              log.validationStatus === 'VALID'
                                ? 'bg-ok-soft border-ok-border text-ok'
                                : log.validationStatus === 'SCHEMA_REPAIRED'
                                  ? 'bg-info-soft border-info-border text-info'
                                  : log.validationStatus === 'FALLBACK_USED'
                                    ? 'bg-warn-soft border-warn-border text-warn'
                                    : 'bg-danger-soft border-danger-border text-danger'
                            }`}
                            title={log.validationNote}
                          >
                            {log.validationStatus}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* SECTION 7: OWNER-ONLY DEMO VISITORS */}
      {activeSection === 'DEMO_VISITORS' && canViewDemoVisitors && (
        <DemoVisitorsPanel timezone={businessProfile.timezone} onNotify={onNotify} />
      )}
    </div>
  );
};
