import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Brain,
  CheckCircle2,
  ClipboardList,
  Database,
  ListChecks,
  Menu,
  MessageSquare,
  Network,
  ShieldAlert,
  X,
} from 'lucide-react';
import { ReflexionWordmark } from './components/BrandLogo';
import {
  AiCallLogEntry,
  AiModelTuningConfig,
  BusinessProfileConfig,
  CategorySop,
  Classification,
  InboundMessageBuffer,
  MeditateDraftTaskInput,
  OpsDatabaseState,
  OwnerProfileConfig,
  PrincipalPrompts,
  Quadrant,
  SampleBrainDumpItem,
  SystemMemoryCategory,
  Task,
  TaskSplittingConfig,
  TaskStatus,
  TeamMember,
  WbsHead,
  FreezeDispatchResult,
} from './types/ops';
import {
  addMemoryRuleToState,
  addNoteToState,
  appendAiLogToState,
  applyProcessedBufferResult,
  approveMemoryRuleInState,
  deleteNoteFromState,
  enqueueInboundSimulatorMessage,
  archiveTask,
  cancelTask,
  forceUnlockTask,
  freezeAndDispatchStagingTasks,
  handleOversizedVideoEscalation,
  reassignTaskResponsible,
  resolveBossReviewItem,
  sendInstantNudge,
  toggleTaskMicroStepManual,
  triggerDailyOverviewCron,
  updateTaskAndNotify,
  hasTaskBeenSent,
} from './lib/opsEngine';
import {
  applyWhatsapp24hWindowPolicy,
  buildIncompleteReleaseNotice,
  isTaskClosed,
  releaseDueTasks,
  summarizeFreezeOutcome,
  validateDraftReleaseChoices,
} from './lib/releaseEngine';
import { isDevToolsEnabled } from './lib/devFlags';
import { buildDraftValidationContext } from './lib/draftEditing';
import { validateDraftPlan } from './lib/validator';
import {
  clearDemoSession,
  draftReleaseMessagesApi,
  loadDemoLead,
  loadDemoState,
  loadDemoStory,
  loadLocalState,
  normalizeOpsDatabaseState,
  resetToDemoSandboxState,
  resetToDemoSeedState,
  runJobsTickApi,
  saveDemoLead,
  saveDemoState,
  saveLocalState,
  setDemoApiMode,
  checkCloudAccessApi,
} from './services/dataService';
import { type DemoLead } from './lib/demoData';
import { buildRoutineDraft } from './lib/routines';
import { handleOwnerWhatsappMessage as handleOwnerWhatsapp } from './lib/ownerWhatsapp';
import { DEMO_STORIES, type DemoStoryId } from './lib/demoStories';
import { DemoEntryScreen } from './components/DemoEntryScreen';
import { DemoSandboxBar, type DemoWalkthroughStep } from './components/DemoSandboxBar';
import {
  cloudProjectId,
  isCloudConfigured,
  signInWithGoogle,
  signOutOfCloud,
  watchSignedInUser,
} from './services/firebaseClient';
import { LoadedWorkspace, loadWorkspace, saveChanges, subscribeWorkspace } from './services/cloudStore';
import { describeConflicts, hasTaskChangedSince } from './lib/cloudRecords';
import { formatFirebaseSignInError } from './lib/firebaseClientConfig';
import { SetupWizard } from './components/SetupWizard';
import { SignInScreen } from './components/SignInScreen';
import { MeditateStudioTab } from './components/MeditateStudioTab';
import { MyTasksTab } from './components/MyTasksTab';
import { buildMyTasks, DEFAULT_FOLLOW_UP_STUCK_HOURS } from './lib/myTasks';
import { businessTodayIso } from './lib/planDates';
import { LiveOpsBoardTab } from './components/LiveOpsBoardTab';
import { BossReviewQueueTab } from './components/BossReviewQueueTab';
import { AnalyticsRosterTab } from './components/AnalyticsRosterTab';
import { TeamViewTab } from './components/TeamViewTab';
import { applyPersonRemovalWithSops, RemovePlan, SopRoleReplacement } from './lib/teamGraph';
import { TeamImportModal } from './components/TeamImportModal';
import { ImportResult, restoreImportBackup } from './lib/teamImport';
import { createAiCallLog } from './lib/promptBuilder';
import { SopsMemoryTab } from './components/SopsMemoryTab';
import { WhatsAppSimulatorDrawer } from './components/WhatsAppSimulatorDrawer';
import { FirebaseConfigModal } from './components/FirebaseConfigModal';

function isDemoUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/demo') return true;
  const params = new URLSearchParams(window.location.search);
  return params.get('demo') === '1';
}

type NavTabId =
  | 'MY_TASKS'
  | 'LIVE_OPS'
  | 'MEDITATE_STUDIO'
  | 'BOSS_REVIEW'
  | 'TEAM_VIEW'
  | 'ANALYTICS_ROSTER'
  | 'SOPS_MEMORY';

const TAB_LABELS: Record<NavTabId, string> = {
  MY_TASKS: 'My tasks',
  MEDITATE_STUDIO: 'Meditate & Brain Dump',
  LIVE_OPS: 'Live Operations',
  BOSS_REVIEW: 'Boss Reviews & Approvals',
  TEAM_VIEW: 'Team',
  ANALYTICS_ROSTER: '2x2 Matrix & Team Roster',
  SOPS_MEMORY: 'AI Brain & Setup',
};

export default function App() {
  const [isDemoMode, setIsDemoMode] = useState<boolean>(() => isDemoUrl());
  const [demoLead, setDemoLead] = useState<DemoLead | null>(() => loadDemoLead());
  const [demoStory, setDemoStory] = useState<DemoStoryId>(() => loadDemoStory());
  const [demoResetNonce, setDemoResetNonce] = useState(0);
  const [meditatePrefill, setMeditatePrefill] = useState<{ text: string; nonce: number; autoSend?: boolean } | null>(null);
  const [demoProgress, setDemoProgress] = useState<Record<string, boolean>>({});
  const isDemoActive = isDemoMode && Boolean(demoLead);
  const isDemoActiveRef = useRef(isDemoActive);
  isDemoActiveRef.current = isDemoActive;
  setDemoApiMode(isDemoActive);

  const [state, setState] = useState<OpsDatabaseState>(() =>
    isDemoUrl() && loadDemoLead() ? loadDemoState() : loadLocalState()
  );
  const [activeTab, setActiveTab] = useState<NavTabId>(() =>
    isDemoUrl() && loadDemoLead() ? 'MEDITATE_STUDIO' : 'LIVE_OPS'
  );
  const [isSimulatorOpen, setIsSimulatorOpen] = useState(false);
  const [isFirebaseModalOpen, setIsFirebaseModalOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [sopsJumpRequest, setSopsJumpRequest] = useState<{
    section: 'SOPS';
    categoryId?: string;
    nonce: number;
  } | null>(null);
  // Milestone 5A: cloud mode (Google sign-in + per-record Firestore) when VITE_FIREBASE_* is set.
  const cloudMode = isCloudConfigured();
  const [cloudUser, setCloudUser] = useState<{ uid: string; email: string | null } | null>(null);
  const [cloudPhase, setCloudPhase] = useState<'CHECKING' | 'SIGNED_OUT' | 'LOADING' | 'SETUP' | 'READY'>(
    cloudMode ? 'CHECKING' : 'READY'
  );
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudErrorDomain, setCloudErrorDomain] = useState<string | null>(null);
  const [cloudErrorConsoleUrl, setCloudErrorConsoleUrl] = useState<string | null>(null);
  /** Ignores results of an access check that a newer sign-in or sign-out replaced. */
  const signInAttemptRef = useRef(0);
  const cloudUidRef = useRef<string | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSavesRef = useRef(0);
  const pendingRemoteRef = useRef<LoadedWorkspace | null>(null);
  const savedPrevRef = useRef(new WeakSet<object>());
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // "Run tick" and similar controls are for development builds only (and Demo Sandbox).
  const showDevTools = isDevToolsEnabled(import.meta.env);

  const markDemoStep = useCallback((stepId: string) => {
    setDemoProgress((prev) => (prev[stepId] ? prev : { ...prev, [stepId]: true }));
  }, []);

  useEffect(() => {
    setDemoApiMode(isDemoActive);
  }, [isDemoActive]);

  useEffect(() => {
    if (!isDemoActive) return;
    if (activeTab === 'TEAM_VIEW') markDemoStep('team');
    if (activeTab === 'LIVE_OPS') markDemoStep('liveOps');
    if (activeTab === 'BOSS_REVIEW' || activeTab === 'MY_TASKS') markDemoStep('approvals');
    if (activeTab === 'SOPS_MEMORY') markDemoStep('aiBrain');
  }, [isDemoActive, activeTab, markDemoStep]);

  useEffect(() => {
    if (isDemoActive && isSimulatorOpen) {
      markDemoStep('whatsapp');
    }
  }, [isDemoActive, isSimulatorOpen, markDemoStep]);

  useEffect(() => {
    const onPopState = () => {
      const nextDemo = isDemoUrl();
      setIsDemoMode(nextDemo);
      if (nextDemo) {
        const existingLead = loadDemoLead();
        setDemoLead(existingLead);
        setDemoApiMode(Boolean(existingLead));
        if (existingLead) {
          setState(loadDemoState());
          setActiveTab('MEDITATE_STUDIO');
        }
      } else {
        setDemoApiMode(false);
        if (!cloudMode) {
          setState(loadLocalState());
        }
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [cloudMode]);

  const notify = useCallback((msg: string) => {
    setToastMessage(msg);
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const t = window.setTimeout(() => setToastMessage(null), 4200);
    return () => window.clearTimeout(t);
  }, [toastMessage]);

  // Cloud mode: follow sign-in, load the workspace, then listen for changes from other tabs.
  const applyRemote = useCallback((loaded: LoadedWorkspace) => {
    if (isDemoActiveRef.current) return;
    if (!loaded.state || !loaded.setupComplete) return;
    setState(normalizeOpsDatabaseState(loaded.state));
  }, []);

  useEffect(() => {
    if (!cloudMode) return;
    let unsubscribeWorkspace: (() => void) | null = null;
    const stop = watchSignedInUser((user) => {
      unsubscribeWorkspace?.();
      unsubscribeWorkspace = null;
      if (!user) {
        signInAttemptRef.current += 1;
        cloudUidRef.current = null;
        setCloudUser(null);
        setCloudPhase('SIGNED_OUT');
        return;
      }
      const attempt = ++signInAttemptRef.current;
      setCloudPhase('LOADING');
      // Only accounts in the server's ALLOWED_EMAILS get in; anyone else is signed out.
      checkCloudAccessApi()
        .then((access) => {
          if (attempt !== signInAttemptRef.current) return null;
          if (!access.allowed) {
            cloudUidRef.current = null;
            setCloudUser(null);
            setCloudError(access.message);
            setCloudPhase('SIGNED_OUT');
            void signOutOfCloud();
            return null;
          }
          cloudUidRef.current = user.uid;
          setCloudUser({ uid: user.uid, email: user.email });
          return loadWorkspace(user.uid);
        })
        .then((loaded) => {
          if (!loaded || attempt !== signInAttemptRef.current) return;
          if (!loaded.state || !loaded.setupComplete) {
            setCloudPhase('SETUP');
            return;
          }
          applyRemote(loaded);
          setCloudPhase('READY');
          unsubscribeWorkspace = subscribeWorkspace(user.uid, (remote) => {
            // Apply other tabs' changes when this tab has no save in flight.
            if (pendingSavesRef.current > 0) pendingRemoteRef.current = remote;
            else applyRemote(remote);
          });
        })
        .catch((err) => {
          setCloudError(err?.message || 'Could not load your workspace.');
          setCloudPhase('SIGNED_OUT');
        });
    });
    return () => {
      unsubscribeWorkspace?.();
      stop();
    };
  }, [cloudMode, applyRemote]);

  /** Saves one change to the cloud (queued, so each save sees the previous one's versions). */
  const queueCloudSave = useCallback(
    (uid: string, prev: OpsDatabaseState, next: OpsDatabaseState) => {
      if (savedPrevRef.current.has(prev)) return; // never save the same change twice
      savedPrevRef.current.add(prev);
      pendingSavesRef.current += 1;
      saveQueueRef.current = saveQueueRef.current
        .then(async () => {
          const result = await saveChanges(uid, prev, next);
          if (result.conflicts.length > 0) {
            setToastMessage(describeConflicts(result.conflicts));
            const latest = await loadWorkspace(uid);
            applyRemote(latest);
          }
        })
        .catch((err) => {
          setToastMessage(`Could not save to the cloud: ${err?.message || 'unknown error'}. Reloading the latest data.`);
          return loadWorkspace(uid).then(applyRemote).catch(() => undefined);
        })
        .finally(() => {
          pendingSavesRef.current -= 1;
          if (pendingSavesRef.current === 0 && pendingRemoteRef.current) {
            const remote = pendingRemoteRef.current;
            pendingRemoteRef.current = null;
            applyRemote(remote);
          }
        });
    },
    [applyRemote]
  );

  const commitState = useCallback(
    (updater: (prev: OpsDatabaseState) => OpsDatabaseState) => {
      setState((prev) => {
        const next = updater(prev);
        if (next === prev) return prev;
        if (isDemoMode) {
          saveDemoState(next);
          return next;
        }
        const uid = cloudUidRef.current;
        if (cloudMode && uid) {
          queueCloudSave(uid, prev, next); // cloud data never touches this browser's local data
        } else if (!cloudMode) {
          saveLocalState(next);
        }
        return next;
      });
    },
    [cloudMode, isDemoMode, queueCloudSave]
  );

  const handleCloudSignIn = async () => {
    setCloudError(null);
    setCloudErrorDomain(null);
    setCloudErrorConsoleUrl(null);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      const formatted = formatFirebaseSignInError(
        err,
        typeof window !== 'undefined' ? window.location.hostname : null,
        cloudProjectId()
      );
      setCloudError(formatted.message);
      setCloudErrorDomain(formatted.unauthorizedDomain);
      setCloudErrorConsoleUrl(formatted.consoleUrl);
    }
  };

  const handleCloudSignOut = async () => {
    setIsFirebaseModalOpen(false);
    await signOutOfCloud();
    setState(normalizeOpsDatabaseState(null));
  };

  const handleSetupFinished = async (workspace: OpsDatabaseState) => {
    const uid = cloudUidRef.current;
    if (!uid) return;
    await saveChanges(uid, null, workspace, { setupComplete: true });
    const loaded = await loadWorkspace(uid);
    applyRemote(loaded);
    setCloudPhase('READY');
    setActiveTab('MEDITATE_STUDIO');
    notify('Your workspace is ready. Describe your first tasks in Meditate.');
  };

  // Operational Counts for Navigation Badges
  const openReviewCount = useMemo(
    () => state.boss_review_queue.filter((r) => r.status === 'OPEN').length,
    [state.boss_review_queue]
  );

  const activeOpsCount = useMemo(
    () =>
      state.tasks.filter(
        (t) =>
          !isTaskClosed(t.status) &&
          t.status !== 'STAGING_DRAFT'
      ).length,
    [state.tasks]
  );

  // Milestone 4: the owner's Do / Decide / Follow up lists (refreshed each minute for "stuck" hours).
  const [clockTick, setClockTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClockTick(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const myTasks = useMemo(
    () =>
      buildMyTasks(state, {
        nowIso: new Date(clockTick).toISOString(),
        todayStr: businessTodayIso(state.business_profile?.timezone, new Date(clockTick)),
        timezone: state.business_profile?.timezone,
      }),
    [state, clockTick]
  );
  const followUpStuckHours =
    Number(state.owner_profile?.followUpStuckHours) > 0
      ? Number(state.owner_profile?.followUpStuckHours)
      : DEFAULT_FOLLOW_UP_STUCK_HOURS;

  const totalBufferedMessages = useMemo(
    () =>
      Object.values(state.inbound_message_buffer).reduce(
        (acc, b) => acc + b.messages.length,
        0
      ),
    [state.inbound_message_buffer]
  );

  // Handlers
  const handleFreezeAndDispatch = (
    drafts: MeditateDraftTaskInput[],
    agenda?: {
      title: string;
      rawBrainDump: string;
      quadrant: Quadrant;
      majorOrMinor: Classification;
    },
    wbsHead?: any
  ): FreezeDispatchResult => {
    // Block unfinished release choices ("At a time" with no time, "After task" with no task).
    // ...or an "At a time" that has already passed.
    const nowIso = new Date().toISOString();
    const problems = validateDraftReleaseChoices(drafts, state.business_profile?.timezone, nowIso);
    if (problems.length > 0) {
      const error = buildIncompleteReleaseNotice(problems);
      notify(error);
      return { ok: false, error };
    }

    // Every other real error on a draft (no Responsible, phone number, broken dependency...).
    const planCheck = validateDraftPlan(drafts, buildDraftValidationContext(state, nowIso));
    if (planCheck.firstError) {
      const more = planCheck.errorCount > 1 ? ` (${planCheck.errorCount - 1} more problem(s) to fix)` : '';
      const error = `Not sent: fix "${planCheck.firstError.title}". ${planCheck.firstError.issue.message}${more}`;
      notify(error);
      return { ok: false, error };
    }

    const existingCodes = new Set(state.tasks.map((t) => t.taskCode));
    const freezeFrom = (base: OpsDatabaseState): OpsDatabaseState => {
      const next = freezeAndDispatchStagingTasks(base, drafts, agenda, nowIso);
      if (wbsHead) {
        const existingHeads = next.wbs_heads || [];
        const filtered = existingHeads.filter((h) => h.headId !== wbsHead.headId);
        next.wbs_heads = [{ ...wbsHead, status: 'FROZEN_DISPATCHED' }, ...filtered];
      }
      return next;
    };

    // Work out the result now (not inside the state updater) so the pop-up reports
    // what really happened: sent on WhatsApp, or only scheduled.
    const precomputed = freezeFrom(state);
    const outcome = summarizeFreezeOutcome(state, precomputed, nowIso);
    const snapshotForMessageStage: OpsDatabaseState = precomputed;
    const newlyReleasedCodes = outcome.tasks
      .filter((t) => t.outcome === 'SENT')
      .map((t) => t.taskCode)
      .filter((code) => !existingCodes.has(code))
      // The owner's own message is sent exactly as written: no AI rewrite afterwards.
      .filter((code) => !precomputed.tasks.find((t) => t.taskCode === code)?.messageIsCustom);

    commitState((prev) => (prev === state ? precomputed : freezeFrom(prev)));
    if (isDemoActive) markDemoStep('meditate');
    setActiveTab('LIVE_OPS');
    notify(outcome.notice);

    // Hydrate MESSAGE stage copy asynchronously if any tasks released immediately
    if (snapshotForMessageStage && newlyReleasedCodes.length > 0) {
      void draftReleaseMessagesApi({
        state: snapshotForMessageStage,
        taskCodes: newlyReleasedCodes,
      })
        .then(({ messagesByTaskCode, aiLogs }) => {
          if (Object.keys(messagesByTaskCode).length === 0 && (!aiLogs || aiLogs.length === 0)) {
            return;
          }
          commitState((prev) => {
            let next = prev;
            const nowIso = new Date().toISOString();
            next = {
              ...next,
              tasks: next.tasks.map((t) => {
                const body = messagesByTaskCode[t.taskCode];
                if (!body) return t;
                const person = next.team_members[t.raci.R];
                const formatted = applyWhatsapp24hWindowPolicy({
                  rawText: body,
                  person,
                  shortTag: t.shortTag || t.taskCode,
                  title: t.title,
                  dueDate: t.dueDate,
                  businessProfile: next.business_profile,
                  nowIso,
                });
                return { ...t, outboundWhatsappPreview: formatted.text };
              }),
              whatsapp_messages: next.whatsapp_messages.map((m) => {
                if (m.tag !== 'TASK_DISPATCH' || !m.taskCode) return m;
                const body = messagesByTaskCode[m.taskCode];
                if (!body) return m;
                const task = next.tasks.find((t) => t.taskCode === m.taskCode);
                const person = next.team_members[m.employeePhone];
                const formatted = applyWhatsapp24hWindowPolicy({
                  rawText: body,
                  person,
                  shortTag: task?.shortTag || m.taskCode,
                  title: task?.title || m.taskCode,
                  dueDate: task?.dueDate || '',
                  businessProfile: next.business_profile,
                  nowIso,
                });
                return {
                  ...m,
                  text: formatted.text,
                  isTemplateMessage: formatted.isTemplateMessage,
                };
              }),
            };
            for (const log of aiLogs || []) {
              next = appendAiLogToState(next, log);
            }
            return next;
          });
        })
        .catch(() => {
          // Plain deterministic template already dispatched synchronously
        });
    }

    return {
      ok: true,
      notice: outcome.notice,
      sentCount: outcome.sentCount,
      scheduledCount: outcome.scheduledCount,
      waitingCount: outcome.waitingCount,
    };
  };

  const handleInstantNudge = (taskCode: string) => {
    commitState((prev) => sendInstantNudge(prev, taskCode));
    const task = state.tasks.find((t) => t.taskCode === taskCode);
    const owner = task ? state.team_members[task.raci.R]?.name || task.raci.R : 'Staff';
    notify(`Sent Instant WhatsApp Nudge for "${task?.shortTag || task?.title || 'Task'}" to ${owner}.`);
  };

  const handleReassignResponsible = (taskCode: string, newPhone: string) => {
    commitState((prev) => reassignTaskResponsible(prev, taskCode, newPhone));
    const newOwner = state.team_members[newPhone]?.name || newPhone;
    const task = state.tasks.find((t) => t.taskCode === taskCode);
    const previousOwner = task ? state.team_members[task.raci.R]?.name || task.raci.R : '';
    notify(
      hasTaskBeenSent(task)
        ? `Reassigned "${task?.shortTag || 'Task'}" to ${newOwner}: sent them the brief and told ${previousOwner}.`
        : `Reassigned "${task?.shortTag || 'Task'}" to ${newOwner}. Not sent yet, so no WhatsApp messages; ${newOwner} gets it when it is released.`
    );
  };

  const handleForceUnlock = (taskCode: string) => {
    commitState((prev) => forceUnlockTask(prev, taskCode));
    const task = state.tasks.find((t) => t.taskCode === taskCode);
    notify(`Unlocked "${task?.shortTag || 'Task'}" & sent WhatsApp instructions.`);
  };

  const describeCloseResult = (
    verb: 'Cancelled' | 'Archived' | 'Cancelled and archived',
    task: Task | undefined,
    res: { personNotified: boolean; releasedTaskCodes: string[]; waitingTaskCodes: string[] }
  ): string => {
    const label = task?.shortTag || task?.taskCode || 'Task';
    const name = task ? state.team_members[task.raci.R]?.name || task.raci.R : '';
    const parts = [`${verb} "${label}".`];
    if (res.personNotified) parts.push(`Told ${name} to stop.`);
    else if (task && !isTaskClosed(task.status)) parts.push('It was not sent yet, so no message was sent.');
    if (res.releasedTaskCodes.length > 0) {
      parts.push(`Freed slot: sent ${res.releasedTaskCodes.join(', ')}.`);
    }
    if (res.waitingTaskCodes.length > 0) {
      parts.push(`${res.waitingTaskCodes.join(', ')} still waiting (parent task cancelled).`);
    }
    return parts.join(' ');
  };

  const handleCancelTask = (taskCode: string) => {
    const task = state.tasks.find((t) => t.taskCode === taskCode);
    const res = cancelTask(state, taskCode);
    commitState((prev) => (prev === state ? res.nextState : cancelTask(prev, taskCode).nextState));
    notify(describeCloseResult('Cancelled', task, res));
  };

  const handleArchiveTask = (taskCode: string) => {
    const task = state.tasks.find((t) => t.taskCode === taskCode);
    const res = archiveTask(state, taskCode);
    commitState((prev) => (prev === state ? res.nextState : archiveTask(prev, taskCode).nextState));
    notify(
      describeCloseResult(
        task && !isTaskClosed(task.status) ? 'Cancelled and archived' : 'Archived',
        task,
        res
      )
    );
  };

  const handleTriggerDailyDigest = () => {
    // Work out what will be sent from the current state first: React may run the
    // state updater later, so counts read inside it would still be 0 here.
    const nowIso = new Date().toISOString();
    const preview = triggerDailyOverviewCron(state, nowIso);
    commitState((prev) => triggerDailyOverviewCron(prev, nowIso).nextState);
    const expiredNote =
      preview.expiredCount > 0 ? ` ${preview.expiredCount} missed repeating task(s) were closed.` : '';
    if (preview.digestsSent === 0) {
      notify(`No digest sent: nobody has open tasks right now.${expiredNote}`);
      return;
    }
    const names = preview.recipientNames;
    const who = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
    notify(`Today's digest sent on WhatsApp to ${who}. Open WhatsApp to read them.${expiredNote}`);
  };

  const handleRunJobsTick = async () => {
    try {
      const res = await runJobsTickApi(state);
      // Cloud mode: the server already saved the tick; the live listener shows the result.
      if (res.storage !== 'cloud') commitState(() => res.state);
      notify(
        `Scheduler tick complete: ${res.releasedTaskCodes.length} task(s) released, ${res.remindersSent} reminder(s) sent, ${res.behindAlertsSent || 0} behind alert(s) sent, ${res.digestsSent} digest(s) sent, ${res.expiredCount} recurring expired.`
      );
    } catch (err: any) {
      notify(err?.message || 'Scheduler tick failed.');
    }
  };

  const handleConfirmScheduledRelease = (taskCode: string) => {
    const nowIso = new Date().toISOString();
    commitState((prev) => {
      const nextTasks = prev.tasks.map((t) =>
        t.taskCode === taskCode && t.release
          ? {
              ...t,
              release: { ...t.release, ownerConfirmed: true },
            }
          : t
      );
      return releaseDueTasks({ ...prev, tasks: nextTasks }, nowIso).nextState;
    });
    const task = state.tasks.find((t) => t.taskCode === taskCode);
    notify(`Confirmed release for "${task?.shortTag || taskCode}".`);
  };

  const handleToggleMicroStepManual = (taskCode: string, stepId: string) => {
    commitState((prev) => toggleTaskMicroStepManual(prev, taskCode, stepId));
  };

  const handleBatchUpdateTasks = (updatedTasks: Task[], auditNote: string) => {
    commitState((prev) => {
      const nowIso = new Date().toISOString();
      let working = prev;
      for (const existing of prev.tasks) {
        const matchingUpdated = updatedTasks.find((u) => u.taskCode === existing.taskCode);
        if (!matchingUpdated) continue;

        const dateOrDurationChanged =
          matchingUpdated.startDate !== existing.startDate ||
          matchingUpdated.dueDate !== existing.dueDate ||
          matchingUpdated.durationDays !== existing.durationDays;

        if (!dateOrDurationChanged) continue;

        working = updateTaskAndNotify(working, matchingUpdated, false, nowIso).nextState;
      }
      return working;
    });
    notify(auditNote);
  };

  const handleUpdateWbsHeads = (heads: WbsHead[]) => {
    commitState((prev) => ({
      ...prev,
      wbs_heads: heads,
    }));
  };

  const handleUpdateTaskAndNotify = (task: Task, pushWhatsapp: boolean, baseTask?: Task) => {
    // Stale form: the task changed in another tab/device (or by the scheduler) after the
    // edit form opened. Refuse instead of silently overwriting the newer change.
    const current = state.tasks.find((t) => t.taskCode === task.taskCode);
    if (baseTask && hasTaskChangedSince(baseTask, current)) {
      notify(describeConflicts([{ collection: 'tasks', id: task.taskCode, knownVersion: null, remoteVersion: null }]));
      return;
    }
    const preview = updateTaskAndNotify(state, task, pushWhatsapp);
    commitState((prev) =>
      prev === state ? preview.nextState : updateTaskAndNotify(prev, task, pushWhatsapp).nextState
    );
    const rName = state.team_members[task.raci.R]?.name || task.raci.R;
    const existing = state.tasks.find((t) => t.taskCode === task.taskCode);
    if (preview.notificationSent) {
      notify(`Updated "${task.shortTag || task.title}" and sent a WhatsApp update to ${rName}.`);
    } else if (pushWhatsapp && !hasTaskBeenSent(existing)) {
      notify(
        `Updated "${task.shortTag || task.title}". Not sent yet, so no WhatsApp update; ${rName} gets the latest version when it is released.`
      );
    } else {
      notify(`Updated "${task.shortTag || task.title}" in workspace.`);
    }
  };

  const handleResolveReview = (
    reviewId: string,
    replyText: string,
    unlockDownstream: boolean
  ) => {
    const rev = state.boss_review_queue.find((r) => r.reviewId === reviewId);
    commitState((prev) => resolveBossReviewItem(prev, reviewId, replyText, unlockDownstream));
    const task = state.tasks.find((t) => t.taskCode === rev?.taskCode);
    notify(
      `Resolved approval on "${task?.shortTag || 'Task'}" and sent WhatsApp decision.${
        unlockDownstream ? ' Downstream task auto-unlocked.' : ''
      }`
    );
  };

  const handleUpsertTeamMember = (member: TeamMember) => {
    commitState((prev) => {
      const existingCount = Object.keys(prev.team_members).length;
      const existingMember = prev.team_members[member.phone];
      const slotId = member.slotId || existingMember?.slotId || `P${existingCount + 1}`;
      return {
        ...prev,
        team_members: {
          ...prev.team_members,
          [member.phone]: {
            ...member,
            slotId,
          },
        },
      };
    });
    notify(`Saved team member ${member.name} (${member.roleTitle}).`);
  };

  const handleDeleteTeamMember = (phone: string) => {
    commitState((prev) => {
      const nextMembers = { ...prev.team_members };
      delete nextMembers[phone];
      // Re-index slotIds cleanly P1, P2, P3...
      const reindexed = Object.fromEntries(
        Object.entries(nextMembers).map(([p, m], idx) => [
          p,
          { ...m, slotId: `P${idx + 1}` },
        ])
      );
      return {
        ...prev,
        team_members: reindexed,
      };
    });
    notify('Removed team member from roster.');
  };

  const handleUpdateBusinessProfile = (profile: BusinessProfileConfig) => {
    commitState((prev) => ({
      ...prev,
      business_profile: profile,
    }));
  };

  const handleUpdateOwnerProfile = (profile: OwnerProfileConfig) => {
    commitState((prev) => ({
      ...prev,
      owner_profile: profile,
    }));
  };

  const handleUpdateTaskSplittingRules = (rules: TaskSplittingConfig) => {
    commitState((prev) => ({
      ...prev,
      task_splitting_rules: rules,
    }));
  };

  const handleUpdateSampleBrainDumps = (samples: SampleBrainDumpItem[]) => {
    commitState((prev) => ({
      ...prev,
      sample_brain_dumps: samples,
    }));
  };

  const handleUpdateModelTuning = (tuning: AiModelTuningConfig) => {
    commitState((prev) => ({
      ...prev,
      model_tuning: tuning,
    }));
  };

  const handleAppendAiLog = (log: AiCallLogEntry) => {
    commitState((prev) => appendAiLogToState(prev, log));
  };

  const handleClearAiLogs = () => {
    commitState((prev) => ({
      ...prev,
      ai_logs: [],
    }));
    notify('Cleared AI telemetry logs.');
  };

  const handleToggleLeave = (phone: string) => {
    commitState((prev) => {
      const existing = prev.team_members[phone];
      if (!existing) return prev;
      return {
        ...prev,
        team_members: {
          ...prev.team_members,
          [phone]: {
            ...existing,
            isOnLeave: !existing.isOnLeave,
          },
        },
      };
    });
  };

  const handleSaveTeamMembersMap = (
    nextMembers: Record<string, TeamMember>,
    notifyMsg?: string
  ) => {
    commitState((prev) => ({
      ...prev,
      team_members: nextMembers,
    }));
    if (notifyMsg) notify(notifyMsg);
  };

  const handleRemoveTeamMember = (
    phone: string,
    plan: RemovePlan,
    sopReplacements: Record<string, SopRoleReplacement> = {}
  ) => {
    commitState((prev) => {
      if (!prev.team_members[phone]) return prev;
      const nowIso = new Date().toISOString();
      const { members, tasks, categorySops } = applyPersonRemovalWithSops(
        phone,
        plan,
        sopReplacements,
        prev.team_members,
        prev.tasks,
        prev.category_sops,
        nowIso
      );
      // Re-index slot IDs cleanly P1, P2, P3... after removal.
      const reindexed = Object.fromEntries(
        Object.entries(members).map(([p, m], idx) => [p, { ...m, slotId: `P${idx + 1}` }])
      );
      return { ...prev, team_members: reindexed, tasks, category_sops: categorySops };
    });
    notify('Removed team member from roster.');
  };

  const importAuditLog = (summary: string) =>
    createAiCallLog({
      tenantId: state.tenantId,
      stage: 'IMPORT',
      model: '—',
      temperature: 0,
      maxOutputTokens: 0,
      latencyMs: 0,
      validationStatus: 'VALID',
      validationNote: cloudUser?.email ? `${summary} (by ${cloudUser.email})` : summary,
    });

  const handleImportTeamSetup = (result: ImportResult) => {
    // result.state already carries the pre-import backup in last_import_backup.
    commitState(() => appendAiLogToState(result.state, importAuditLog(`Team setup import: ${result.summary}`)));
    notify(result.summary);
  };

  const handleUndoImport = () => {
    commitState((prev) => {
      if (!prev.last_import_backup) return prev;
      const restored = restoreImportBackup(prev, prev.last_import_backup);
      return appendAiLogToState(restored, importAuditLog('Undid last team setup import (restored snapshot).'));
    });
    notify('Restored the workspace from before the last import.');
  };

  const handleUpsertSop = (sop: CategorySop) => {
    commitState((prev) => {
      const exists = prev.category_sops.some((c) => c.categoryId === sop.categoryId);
      const nextSops = exists
        ? prev.category_sops.map((c) => (c.categoryId === sop.categoryId ? sop : c))
        : [...prev.category_sops, sop];
      return { ...prev, category_sops: nextSops };
    });
    notify(`Saved Standard Operating Procedure for "${sop.categoryName}".`);
  };

  const handleAddNote = (text: string) => {
    commitState((prev) => addNoteToState(prev, text));
  };

  const handleDeleteNote = (noteId: string) => {
    commitState((prev) => deleteNoteFromState(prev, noteId));
    notify('Removed note from Meditate Notes.');
  };

  const handleAddMemoryRule = (
    category: SystemMemoryCategory,
    fact: string,
    approved: boolean = true
  ) => {
    commitState((prev) => addMemoryRuleToState(prev, { category, fact, approved }));
  };

  const handleApproveMemoryRule = (memoryId: string) => {
    commitState((prev) => approveMemoryRuleInState(prev, memoryId));
    notify('Approved pending rule in System Memory.');
  };

  const handleToggleMemoryRule = (memoryId: string) => {
    commitState((prev) => ({
      ...prev,
      system_memory: prev.system_memory.map((m) =>
        m.memoryId === memoryId && m.approved !== false ? { ...m, active: !m.active } : m
      ),
    }));
  };

  const handleUpdateMemoryFact = (memoryId: string, fact: string) => {
    commitState((prev) => ({
      ...prev,
      system_memory: prev.system_memory.map((m) =>
        m.memoryId === memoryId ? { ...m, fact } : m
      ),
    }));
  };

  const handleDeleteMemoryRule = (memoryId: string) => {
    commitState((prev) => ({
      ...prev,
      system_memory: prev.system_memory.filter((m) => m.memoryId !== memoryId),
    }));
  };

  const handleUpdatePrincipalPrompts = (prompts: PrincipalPrompts) => {
    commitState((prev) => ({
      ...prev,
      principal_prompts: prompts,
    }));
    notify('Updated Principal Master Prompts for Brain Dump & WhatsApp Evaluation.');
  };

  // Simulator Handlers
  const handleEnqueueSimMessage = (
    phone: string,
    msg: Omit<InboundMessageBuffer['messages'][number], 'id' | 'timestamp'>
  ) => {
    let blocked = false;
    commitState((prev) => {
      const res = enqueueInboundSimulatorMessage(prev, phone, msg);
      blocked = res.unknownSenderBlocked;
      return res.nextState;
    });
    if (blocked) {
      notify(`Unknown Sender Guard blocked ${phone} — zero tokens consumed.`);
    }
  };

  /** Batch 4: run a task type's checklist now (or daily) for its default person. */
  const handleRunRoutine = (categoryId: string, daily: boolean) => {
    const sop = state.category_sops.find((c) => c.categoryId === categoryId);
    if (!sop) return;
    const draft = buildRoutineDraft(sop, state, { daily, nowMs: Date.now() });
    if (!draft) {
      notify(`Nobody is free for ${sop.categoryName} right now (on leave or at their limit). Plan it in Meditate instead.`);
      return;
    }
    const result = handleFreezeAndDispatch([draft], {
      title: draft.title,
      rawBrainDump: `Routine: ${sop.categoryName}`,
      quadrant: draft.quadrant,
      majorOrMinor: draft.majorOrMinor,
    });
    notify(result.ok ? result.notice : result.error || 'Could not start the routine.');
  };

  /** The owner's own WhatsApp: decide (1/2/3), get today's brief, or plan a note in Meditate. */
  const handleOwnerWhatsappMessage = (phone: string, text: string) => {
    const nowIso = new Date().toISOString();
    // Work out the outcome from the current state first (the updater may run later).
    const preview = handleOwnerWhatsapp(state, phone, text, nowIso);
    commitState((prev) => handleOwnerWhatsapp(prev, phone, text, nowIso).nextState);
    if (preview.action.kind === 'DECIDE') {
      notify(`Decided ${preview.action.reviewId} from WhatsApp; the team member was told.`);
    } else if (preview.planText) {
      setIsSimulatorOpen(false);
      setActiveTab('MEDITATE_STUDIO');
      setMeditatePrefill({ text: preview.planText, nonce: Date.now(), autoSend: true });
      notify('Your WhatsApp note is being planned in Meditate.');
    }
  };

  const handleDeleteBufferedMessage = (phone: string, msgId: string) => {
    commitState((prev) => {
      const buf = prev.inbound_message_buffer[phone];
      if (!buf) return prev;
      const remaining = buf.messages.filter((m) => m.id !== msgId);
      const nextBuffers = { ...prev.inbound_message_buffer };
      if (remaining.length === 0) {
        delete nextBuffers[phone];
      } else {
        nextBuffers[phone] = { ...buf, messages: remaining };
      }
      return { ...prev, inbound_message_buffer: nextBuffers };
    });
  };

  const handleOversizedVideoGuard = (phone: string, fileName: string, fileSizeMB: number) => {
    commitState((prev) => handleOversizedVideoEscalation(prev, phone, fileName, fileSizeMB));
  };

  const handleApplyProcessedBuffer = (phone: string, aiResult: any) => {
    commitState((prev) => applyProcessedBufferResult(prev, phone, aiResult));
  };

  // Persistence & Demo Sandbox Handlers
  const handleStartDemoEntry = () => {
    setIsFirebaseModalOpen(false);
    setIsSimulatorOpen(false);
    if (typeof window !== 'undefined' && !isDemoUrl()) {
      window.history.pushState({}, '', '/demo');
    }
    const existingLead = loadDemoLead();
    setDemoLead(existingLead);
    setIsDemoMode(true);
    if (existingLead) {
      setDemoApiMode(true);
      setState(loadDemoState());
      setActiveTab('MEDITATE_STUDIO');
    } else {
      setDemoApiMode(false);
    }
  };

  const handleDemoRegistered = (lead: DemoLead) => {
    saveDemoLead(lead);
    setDemoLead(lead);
    setIsDemoMode(true);
    setDemoApiMode(true);
    const fresh = loadDemoState();
    setState(fresh);
    setDemoProgress({});
    setDemoResetNonce((n) => n + 1);
    setActiveTab('MEDITATE_STUDIO');
    if (typeof window !== 'undefined' && !isDemoUrl()) {
      window.history.pushState({}, '', '/demo');
    }
    notify(`Welcome, ${lead.name}. You are exploring ${fresh.business_profile.businessName}.`);
  };

  /** Switch the demo to another sample business; it starts fresh. */
  const handleChooseDemoStory = (story: DemoStoryId) => {
    const fresh = resetToDemoSandboxState(story);
    setDemoStory(story);
    if (demoLead) {
      setState(fresh);
      setDemoProgress({});
      setDemoResetNonce((n) => n + 1);
      setActiveTab('MEDITATE_STUDIO');
      notify(`Switched the demo to ${fresh.business_profile.businessName}.`);
    }
  };

  const handleResetDemoData = () => {
    if (isDemoMode) {
      const fresh = resetToDemoSandboxState(demoStory);
      setState(fresh);
      setDemoProgress({});
      setDemoResetNonce((n) => n + 1);
      setActiveTab('MEDITATE_STUDIO');
      notify(`Reset demo sandbox to the fresh ${fresh.business_profile.businessName} scenario.`);
      return;
    }
    const fresh = resetToDemoSeedState();
    setState(fresh);
    notify('Reset workspace to clean demo operations data.');
  };

  const handleExitDemo = () => {
    setIsFirebaseModalOpen(false);
    setIsSimulatorOpen(false);
    clearDemoSession();
    setDemoApiMode(false);
    setDemoLead(null);
    setIsDemoMode(false);
    setDemoProgress({});
    if (typeof window !== 'undefined' && isDemoUrl()) {
      window.history.pushState({}, '', '/');
    }
    if (!cloudMode) {
      setState(loadLocalState());
      setActiveTab('LIVE_OPS');
    }
  };

  const demoStepActions: Record<string, () => void> = {
    meditate: () => setActiveTab('MEDITATE_STUDIO'),
    team: () => setActiveTab('TEAM_VIEW'),
    liveOps: () => setActiveTab('LIVE_OPS'),
    whatsapp: () => setIsSimulatorOpen(true),
    approvals: () => setActiveTab('BOSS_REVIEW'),
    aiBrain: () => setActiveTab('SOPS_MEMORY'),
  };

  const demoWalkthroughSteps: DemoWalkthroughStep[] = DEMO_STORIES[demoStory].walkthrough.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    done: Boolean(demoProgress[item.id]),
    actionLabel: item.actionLabel,
    onAction: demoStepActions[item.id] || (() => setActiveTab('MEDITATE_STUDIO')),
  }));

  const navItems: Array<{
    id: NavTabId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
    urgent?: boolean;
  }> = [
    {
      id: 'MEDITATE_STUDIO',
      label: 'Meditate & Brain Dump',
      icon: Brain,
    },
    {
      id: 'MY_TASKS',
      label: 'My tasks',
      icon: ListChecks,
      count: myTasks.counts.total,
      urgent: myTasks.counts.decide > 0 || myTasks.followUp.some((f) => f.reasons.includes('OVERDUE')),
    },
    {
      id: 'LIVE_OPS',
      label: 'Live Operations',
      icon: ClipboardList,
      count: activeOpsCount,
    },
    {
      id: 'BOSS_REVIEW',
      label: 'Boss Reviews',
      icon: ShieldAlert,
      count: openReviewCount,
      urgent: openReviewCount > 0,
    },
    {
      id: 'TEAM_VIEW',
      label: 'Team',
      icon: Network,
    },
    {
      id: 'ANALYTICS_ROSTER',
      label: '2x2 Matrix & Team',
      icon: BarChart3,
    },
    {
      id: 'SOPS_MEMORY',
      label: 'AI Brain & Setup',
      icon: BookOpen,
    },
  ];

  if (isDemoMode && !demoLead) {
    return (
      <DemoEntryScreen
        canReturnToSignIn={cloudMode || isDemoUrl()}
        onReturnToSignIn={handleExitDemo}
        onDemoReady={handleDemoRegistered}
        story={DEMO_STORIES[demoStory]}
        onChooseStory={handleChooseDemoStory}
      />
    );
  }

  if (!isDemoMode && cloudMode && cloudPhase !== 'READY') {
    if (cloudPhase === 'SETUP' && cloudUser) {
      return (
        <SetupWizard
          accountEmail={cloudUser.email}
          tenantId={cloudUser.uid}
          onFinished={handleSetupFinished}
          onSignOut={() => void handleCloudSignOut()}
        />
      );
    }
    return (
      <SignInScreen
        busy={cloudPhase === 'CHECKING' || cloudPhase === 'LOADING'}
        error={cloudError}
        unauthorizedDomain={cloudErrorDomain}
        firebaseConsoleUrl={cloudErrorConsoleUrl}
        onSignIn={() => void handleCloudSignIn()}
        onEnterDemo={handleStartDemoEntry}
      />
    );
  }

  return (
    <div className="min-h-screen bg-paper text-ink flex font-sans">
      {/* Desktop Sidebar Navigation */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-r border-hairline bg-surface">
        {/* Brand Header */}
        <div className="flex h-14 items-center justify-between px-5 border-b border-hairline">
          <ReflexionWordmark size="sm" />
        </div>

        {/* Navigation Items */}
        <nav aria-label="Command Navigation" className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors ${
                  isActive
                    ? 'bg-signal-soft text-ink border border-signal-border/70'
                    : 'text-slate border border-transparent hover:bg-paper hover:text-ink'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      item.urgent
                        ? 'text-danger'
                        : isActive
                          ? 'text-signal'
                          : 'text-slate'
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </span>

                {item.count !== undefined && (
                  <span
                    className={`px-1.5 py-0.5 text-[11px] font-semibold tabular-nums rounded-md ${
                      item.urgent
                        ? 'bg-danger-soft text-danger border border-danger-border'
                        : isActive
                          ? 'text-signal-ink'
                          : 'text-slate'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Bottom Database Sync Button */}
        <div className="border-t border-hairline p-3">
          <button
            type="button"
            onClick={() => setIsFirebaseModalOpen(true)}
            className="w-full flex items-center justify-between gap-2 rounded-xl border border-hairline bg-paper px-3 py-2 text-xs font-medium text-ink hover:bg-surface-muted transition-colors"
          >
            <span className="flex items-center gap-2 truncate">
              <Database className="h-3.5 w-3.5 text-ok shrink-0" />
              <span className="truncate">Database Sync</span>
            </span>
            <span className="rounded-md bg-surface border border-hairline px-1.5 py-0.5 text-[10px] font-semibold text-slate shrink-0">
              {isDemoActive ? 'Demo' : cloudMode ? 'Cloud' : 'Local'}
            </span>
          </button>
        </div>
      </aside>

      {/* Mobile Slide-Over Navigation */}
      {isMobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-ink/35 backdrop-blur-xs"
            onClick={() => setIsMobileNavOpen(false)}
          />
          <aside className="relative z-10 flex w-64 flex-col bg-surface border-r border-hairline shadow-[var(--shadow-modal)]">
            <div className="flex h-14 items-center justify-between px-4 border-b border-hairline">
              <ReflexionWordmark size="sm" />
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setIsMobileNavOpen(false)}
                className="rounded-lg p-1.5 text-slate hover:text-ink hover:bg-paper transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setIsMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center justify-between rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors ${
                      isActive
                        ? 'bg-signal-soft text-ink border border-signal-border/70'
                        : 'text-slate border border-transparent hover:bg-paper hover:text-ink'
                    }`}
                  >
                    <span className="flex items-center gap-2.5 truncate">
                      <Icon className={`h-4 w-4 shrink-0 ${item.urgent ? 'text-danger' : isActive ? 'text-signal' : 'text-slate'}`} />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {item.count !== undefined && (
                      <span className={`text-xs font-semibold tabular-nums ${item.urgent ? 'text-danger' : 'text-slate'}`}>
                        {item.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
            <div className="border-t border-hairline p-3">
              <button
                type="button"
                onClick={() => {
                  setIsMobileNavOpen(false);
                  setIsFirebaseModalOpen(true);
                }}
                className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-xs font-semibold text-ink hover:bg-surface-muted transition-colors"
              >
                Workspace ({isDemoActive ? 'Demo' : cloudMode ? 'Cloud' : 'Local'})
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col lg:pl-64 min-w-0">
        {/* Top Header Bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-hairline bg-surface/95 backdrop-blur px-4 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => setIsMobileNavOpen(true)}
              className="lg:hidden rounded-lg border border-hairline p-1.5 text-slate hover:text-ink hover:bg-paper transition-colors"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="hidden sm:inline text-slate font-medium">Workspace</span>
              <span aria-hidden="true" className="hidden sm:inline text-hairline-strong">
                /
              </span>
              <h1 className="font-semibold text-ink truncate">
                {TAB_LABELS[activeTab]}
              </h1>
            </div>
          </div>

          {/* Top Right Action: WhatsApp Simulator Drawer Trigger */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setIsSimulatorOpen((v) => !v)}
              className="inline-flex items-center gap-2 rounded-xl bg-ink px-3.5 py-2 text-xs font-semibold text-white hover:bg-ink-hover transition-colors whitespace-nowrap shrink-0"
            >
              <MessageSquare className="h-3.5 w-3.5 text-signal" />
              <span>WhatsApp Field Chat</span>
              {totalBufferedMessages > 0 && (
                <span className="rounded-md bg-signal-hover text-white px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                  {totalBufferedMessages}
                </span>
              )}
            </button>
          </div>
        </header>

        {/* Action Notification Toast Banner */}
        {toastMessage && (
          <div className="border-b border-ok-border bg-ok-soft px-6 py-2.5 text-xs font-medium text-ok flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-ok shrink-0" />
              <span>{toastMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setToastMessage(null)}
              className="text-ok hover:text-ink font-bold"
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        )}

        {/* Interactive Guest Demo Sandbox Bar */}
        {isDemoActive && demoLead && (
          <DemoSandboxBar
            lead={demoLead}
            story={DEMO_STORIES[demoStory]}
            onSwitchStory={handleChooseDemoStory}
            steps={demoWalkthroughSteps}
            samplePrompts={(state.sample_brain_dumps || []).slice(0, 3).map((s) => ({
              id: s.id,
              label:
                s.splitType === 'QUICK_TASK'
                  ? 'Quick task (one person)'
                  : 'Project (several people)',
              text: s.text,
            }))}
            onTrySamplePrompt={(text) => {
              setActiveTab('MEDITATE_STUDIO');
              setMeditatePrefill({ text, nonce: Date.now() });
            }}
            onResetDemo={handleResetDemoData}
            onExitDemo={handleExitDemo}
            onJumpToTab={(tab) => setActiveTab(tab)}
          />
        )}

        {/* Active Tab Viewport */}
        <main key={demoResetNonce} className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 max-w-[1400px] w-full mx-auto">
          {activeTab === 'MEDITATE_STUDIO' && (
            <MeditateStudioTab
              state={state}
              onFreezeAndDispatch={handleFreezeAndDispatch}
              onSaveMemoryRule={handleAddMemoryRule}
              onAddNote={handleAddNote}
              onDeleteNote={handleDeleteNote}
              onUpdateWbsHeads={handleUpdateWbsHeads}
              onAppendAiLog={handleAppendAiLog}
              onNotify={notify}
              prefillPrompt={meditatePrefill}
              onAiCallTriggered={() => {
                if (isDemoActive) markDemoStep('meditate');
              }}
            />
          )}

          {activeTab === 'LIVE_OPS' && (
            <LiveOpsBoardTab
              state={state}
              onInstantNudge={handleInstantNudge}
              onReassignResponsible={handleReassignResponsible}
              onForceUnlock={handleForceUnlock}
              onCancelTask={handleCancelTask}
              onArchiveTask={handleArchiveTask}
              onTriggerDailyDigest={handleTriggerDailyDigest}
              onRunJobsTick={showDevTools || isDemoActive ? handleRunJobsTick : undefined}
              onConfirmScheduledRelease={handleConfirmScheduledRelease}
              onToggleMicroStepManual={handleToggleMicroStepManual}
              onUpdateTask={handleUpdateTaskAndNotify}
              onBatchUpdateTasks={handleBatchUpdateTasks}
            />
          )}

          {activeTab === 'MY_TASKS' && (
            <MyTasksTab
              state={state}
              summary={myTasks}
              stuckHours={followUpStuckHours}
              onToggleMicroStepManual={handleToggleMicroStepManual}
              onInstantNudge={handleInstantNudge}
              onOpenBossReviews={() => setActiveTab('BOSS_REVIEW')}
              onOpenLiveOps={() => setActiveTab('LIVE_OPS')}
            />
          )}

          {activeTab === 'BOSS_REVIEW' && (
            <BossReviewQueueTab state={state} onResolveReview={handleResolveReview} />
          )}

          {activeTab === 'TEAM_VIEW' && (
            <TeamViewTab
              state={state}
              todayStr={businessTodayIso(state.business_profile?.timezone, new Date(clockTick))}
              nowMs={clockTick}
              onUpsertTeamMember={handleUpsertTeamMember}
              onSaveTeamMembersMap={handleSaveTeamMembersMap}
              onRemoveTeamMember={handleRemoveTeamMember}
              onOpenImport={() => setIsImportOpen(true)}
              onOpenSopEditor={(categoryId) => {
                setSopsJumpRequest({ section: 'SOPS', categoryId, nonce: Date.now() });
                setActiveTab('SOPS_MEMORY');
              }}
              onNotify={notify}
            />
          )}

          {activeTab === 'ANALYTICS_ROSTER' && (
            <AnalyticsRosterTab
              state={state}
              onUpsertTeamMember={handleUpsertTeamMember}
              onDeleteTeamMember={handleDeleteTeamMember}
              onToggleLeave={handleToggleLeave}
              onNotify={notify}
            />
          )}

          {activeTab === 'SOPS_MEMORY' && (
            <SopsMemoryTab
              state={state}
              jumpRequest={sopsJumpRequest}
              onUpsertSop={handleUpsertSop}
              onRunRoutine={handleRunRoutine}
              onAddMemoryRule={handleAddMemoryRule}
              onApproveMemoryRule={handleApproveMemoryRule}
              onToggleMemoryRule={handleToggleMemoryRule}
              onUpdateMemoryFact={handleUpdateMemoryFact}
              onDeleteMemoryRule={handleDeleteMemoryRule}
              onUpdatePrincipalPrompts={handleUpdatePrincipalPrompts}
              onUpdateBusinessProfile={handleUpdateBusinessProfile}
              onUpdateOwnerProfile={handleUpdateOwnerProfile}
              onUpdateTaskSplittingRules={handleUpdateTaskSplittingRules}
              onUpdateSampleBrainDumps={handleUpdateSampleBrainDumps}
              onUpdateModelTuning={handleUpdateModelTuning}
              onClearAiLogs={handleClearAiLogs}
              onOpenImport={() => setIsImportOpen(true)}
              onNotify={notify}
              canViewDemoVisitors={!isDemoActive && cloudMode && cloudPhase === 'READY'}
            />
          )}
        </main>
      </div>

      {/* Persistent WhatsApp Simulator Drawer */}
      <WhatsAppSimulatorDrawer
        isOpen={isSimulatorOpen}
        onClose={() => setIsSimulatorOpen(false)}
        state={state}
        onEnqueueMessage={handleEnqueueSimMessage}
        onDeleteBufferedMessage={handleDeleteBufferedMessage}
        onOversizedVideoGuard={handleOversizedVideoGuard}
        onApplyProcessedBuffer={handleApplyProcessedBuffer}
        onRunJobsTick={showDevTools || isDemoActive ? handleRunJobsTick : undefined}
        onNotify={notify}
        onOwnerMessage={handleOwnerWhatsappMessage}
      />

      {/* Team setup import */}
      {isImportOpen && (
        <TeamImportModal
          state={state}
          accountEmail={isDemoActive ? null : cloudUser?.email ?? null}
          onClose={() => setIsImportOpen(false)}
          onImport={(result) => {
            handleImportTeamSetup(result);
            setIsImportOpen(false);
          }}
          onUndo={state.last_import_backup ? handleUndoImport : undefined}
          lastBackupSummary={state.last_import_backup?.summary ?? null}
          lastBackupSavedAt={state.last_import_backup?.savedAt ?? null}
        />
      )}

      {/* Dual-Mode Persistence Firebase Config Modal */}
      <FirebaseConfigModal
        isOpen={isFirebaseModalOpen}
        onClose={() => setIsFirebaseModalOpen(false)}
        mode={isDemoActive ? 'DEMO' : cloudMode ? 'CLOUD' : 'LOCAL_STORAGE'}
        projectId={cloudProjectId()}
        accountEmail={isDemoActive ? null : cloudUser?.email ?? null}
        demoLead={isDemoActive ? demoLead : null}
        onSignOut={!isDemoActive && cloudMode ? () => void handleCloudSignOut() : undefined}
        onResetDemoData={isDemoActive || !cloudMode ? handleResetDemoData : undefined}
        onExitDemo={isDemoActive ? handleExitDemo : undefined}
      />
    </div>
  );
}
