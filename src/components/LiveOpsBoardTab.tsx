import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Clock,
  Columns,
  Edit3,
  FileText,
  Grid,
  Layers,
  LayoutGrid,
  List,
  Lock,
  Archive,
  Ban,
  Plus,
  Search,
  Send,
  Sun,
  Trash2,
  Unlock,
  User,
  Users,
  X,
  Zap,
} from 'lucide-react';
import {
  Classification,
  MicroStep,
  OpsDatabaseState,
  Quadrant,
  Task,
  TaskStatus,
} from '../types/ops';
import { cascadeTaskSchedule, computeDueDate } from '../lib/opsEngine';
import { findRelatedOpenItems } from '../lib/behindAlerts';
import { formatStepCount } from '../lib/stepChecks';
import {
  describeTaskTiming,
  formatDueLabel,
  isTaskBehind,
  normalizeDueTime,
  timingLabel,
} from '../lib/taskTiming';
import {
  describePlannedSendTime,
  isTaskClosed,
  isTaskOnActiveBoard,
  isTaskReleasedStatus,
} from '../lib/releaseEngine';
import { BrandEmptyState } from './BrandLogo';

interface LiveOpsBoardTabProps {
  state: OpsDatabaseState;
  onInstantNudge: (taskCode: string) => void;
  onReassignResponsible: (taskCode: string, newPhone: string) => void;
  onForceUnlock: (taskCode: string) => void;
  onTriggerDailyDigest: () => void;
  onRunJobsTick?: () => void;
  onConfirmScheduledRelease?: (taskCode: string) => void;
  onToggleMicroStepManual: (taskCode: string, stepId: string) => void;
  /** `baseTask`: the task as it was when the edit form opened (stale-form check). */
  onUpdateTask?: (task: Task, pushWhatsapp: boolean, baseTask?: Task) => void;
  onBatchUpdateTasks: (updatedTasks: Task[], auditNote: string) => void;
  onSelectTask?: (task: Task | null) => void;
  onCancelTask?: (taskCode: string) => void;
  onArchiveTask?: (taskCode: string) => void;
}

type OpsWorkspaceView = 'LIST' | 'MATRIX_2X2' | 'GANTT' | 'SPLIT_ALL';

const QUADRANT_CONFIG: Record<
  Quadrant,
  { label: string; badgeClass: string; dotClass: string; bgTint: string }
> = {
  Q1_DO_FIRST: {
    label: 'Do First',
    badgeClass: 'bg-danger-soft text-danger border-danger-border',
    dotClass: 'bg-danger-solid',
    bgTint: 'bg-danger-soft/45',
  },
  Q2_SCHEDULE: {
    label: 'Schedule',
    badgeClass: 'bg-info-soft text-info border-info-border',
    dotClass: 'bg-info',
    bgTint: 'bg-info-soft/45',
  },
  Q3_DELEGATE: {
    label: 'Delegate',
    badgeClass: 'bg-warn-soft text-warn border-warn-border',
    dotClass: 'bg-warn-solid',
    bgTint: 'bg-warn-soft/45',
  },
  Q4_LOW: {
    label: 'Routine',
    badgeClass: 'bg-surface-muted text-slate border-hairline-strong',
    dotClass: 'bg-slate',
    bgTint: 'bg-paper/80',
  },
};

const STATUS_CONFIG: Record<
  TaskStatus,
  { label: string; badgeClass: string }
> = {
  STAGING_DRAFT: {
    label: 'Draft',
    badgeClass: 'bg-surface-muted text-slate border-hairline-strong',
  },
  LOCKED_BY_DEPENDENCY: {
    label: 'Waiting on Dependency',
    badgeClass: 'bg-warn-soft text-warn border-warn-border',
  },
  SCHEDULED: {
    label: 'Scheduled',
    badgeClass: 'bg-info-soft text-info border-info-border',
  },
  PENDING: {
    label: 'Queued',
    badgeClass: 'bg-info-soft text-info border-info-border',
  },
  IN_PROGRESS: {
    label: 'In Progress',
    badgeClass: 'bg-ok-soft text-ok border-ok-border',
  },
  PARTIALLY_DONE: {
    label: 'Partially Done',
    badgeClass: 'bg-ok-soft text-ok border-ok-border',
  },
  AWAITING_BOSS_DECISION: {
    label: 'Boss Review',
    badgeClass: 'bg-danger-soft text-danger border-danger-border',
  },
  COMPLETED: {
    label: 'Completed',
    badgeClass: 'bg-ok-soft text-ok border-ok-border',
  },
  EXPIRED_MISSED: {
    label: 'Missed',
    badgeClass: 'bg-danger-soft text-danger border-danger-border',
  },
  CANCELLED: {
    label: 'Cancelled',
    badgeClass: 'bg-surface-muted text-slate border-hairline-strong line-through',
  },
};

export const LiveOpsBoardTab: React.FC<LiveOpsBoardTabProps> = ({
  state,
  onInstantNudge,
  onReassignResponsible,
  onForceUnlock,
  onTriggerDailyDigest,
  onRunJobsTick,
  onConfirmScheduledRelease,
  onToggleMicroStepManual,
  onUpdateTask,
  onBatchUpdateTasks,
  onCancelTask,
  onArchiveTask,
}) => {
  // Inline two-step confirm for Cancel / Archive on a task card.
  const [pendingCloseAction, setPendingCloseAction] = useState<{
    taskCode: string;
    kind: 'CANCEL' | 'ARCHIVE';
  } | null>(null);
  // Top View Switcher State
  const [currentView, setCurrentView] = useState<OpsWorkspaceView>('LIST');

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [quadrantFilter, setQuadrantFilter] = useState<string>('ALL');
  const [classFilter, setClassFilter] = useState<Classification | 'ALL'>('ALL');
  const [ownerFilter, setOwnerFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Gantt chart config
  const [ganttHorizon, setGanttHorizon] = useState<'WEEK' | 'MONTH'>('WEEK');
  const [ganttGroupBy, setGanttGroupBy] = useState<'TEAM_MEMBER' | 'WBS_HEAD'>('TEAM_MEMBER');

  // Drawers & Modals
  const [auditDrawerTask, setAuditDrawerTask] = useState<Task | null>(null);
  const [editDrawerTask, setEditDrawerTask] = useState<Task | null>(null);

  // Quadrant Move Modal (Prompt on drag/drop in 2x2 Matrix)
  const [quadrantMoveModal, setQuadrantMoveModal] = useState<{
    task: Task;
    targetQuadrant: Quadrant;
    tentativeDueDate: string;
    durationDays: number;
  } | null>(null);

  // Cascade Confirmation Modal (When resizing or shifting task dates in Gantt)
  const [cascadeModal, setCascadeModal] = useState<{
    task: Task;
    newStartDate: string;
    newDuration: number;
    cascadedCount: number;
    conflict: boolean;
    conflictMessage?: string;
    updatedTasks: Task[];
  } | null>(null);

  // Deep task edit state
  const [editTitle, setEditTitle] = useState('');
  const [editShortTag, setEditShortTag] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editQuadrant, setEditQuadrant] = useState<Quadrant>('Q1_DO_FIRST');
  const [editClassification, setEditClassification] = useState<Classification>('MAJOR');
  const [editStartDate, setEditStartDate] = useState('');
  const [editDurationDays, setEditDurationDays] = useState(1);
  const [editDueDate, setEditDueDate] = useState('');
  const [editDueTime, setEditDueTime] = useState('');
  const [editIsForcedDeadline, setEditIsForcedDeadline] = useState(false);
  const [editForcedDeadlineDate, setEditForcedDeadlineDate] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');
  const [editR, setEditR] = useState('');
  const [editA, setEditA] = useState('');
  const [editC, setEditC] = useState('');
  const [editI, setEditI] = useState('');
  const [editMicroSteps, setEditMicroSteps] = useState<MicroStep[]>([]);
  const [newStepText, setNewStepText] = useState('');

  // Active board: everything except drafts and archived/cancelled tasks.
  const liveTasks = useMemo(() => state.tasks.filter((t) => isTaskOnActiveBoard(t)), [state.tasks]);
  const archivedTasks = useMemo(
    () => state.tasks.filter((t) => t.status !== 'STAGING_DRAFT' && Boolean(t.archivedAt)),
    [state.tasks]
  );

  const kpis = useMemo(() => {
    const active = liveTasks.filter(
      (t) =>
        t.status === 'PENDING' ||
        t.status === 'IN_PROGRESS' ||
        t.status === 'PARTIALLY_DONE'
    ).length;
    const scheduled = liveTasks.filter((t) => t.status === 'SCHEDULED').length;
    const locked = liveTasks.filter((t) => t.status === 'LOCKED_BY_DEPENDENCY').length;
    const awaitingBoss = liveTasks.filter((t) => t.status === 'AWAITING_BOSS_DECISION').length;
    const completed = liveTasks.filter((t) => t.status === 'COMPLETED').length;
    return { active, scheduled, locked, awaitingBoss, completed };
  }, [liveTasks]);

  // Scheduled lane: tasks held by schedule/shift/cap/confirmation AND tasks waiting on another task.
  const scheduledTasks = useMemo(
    () =>
      liveTasks.filter((t) => t.status === 'SCHEDULED' || t.status === 'LOCKED_BY_DEPENDENCY'),
    [liveTasks]
  );

  const filteredTasks = useMemo(() => {
    const showArchived = statusFilter === 'ARCHIVED';
    return (showArchived ? archivedTasks : liveTasks).filter((t) => {
      if (quadrantFilter !== 'ALL' && t.quadrant !== quadrantFilter) return false;
      if (classFilter !== 'ALL' && t.majorOrMinor !== classFilter) return false;
      if (ownerFilter !== 'ALL' && t.raci.R !== ownerFilter) return false;
      if (!showArchived && statusFilter !== 'ALL' && t.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const rName = state.team_members[t.raci.R]?.name?.toLowerCase() || '';
        const tag = (t.shortTag || '').toLowerCase();
        const title = t.title.toLowerCase();
        return tag.includes(q) || title.includes(q) || rName.includes(q);
      }
      return true;
    });
  }, [
    liveTasks,
    archivedTasks,
    quadrantFilter,
    classFilter,
    ownerFilter,
    statusFilter,
    searchQuery,
    state.team_members,
  ]);

  const membersList = useMemo(() => Object.values(state.team_members), [state.team_members]);

  const openEditDrawer = (task: Task) => {
    setEditDrawerTask(task);
    setEditTitle(task.title);
    setEditShortTag(task.shortTag || '');
    setEditDescription(task.latestAiSummary || '');
    setEditQuadrant(task.quadrant);
    setEditClassification(task.majorOrMinor);
    setEditStartDate(task.startDate || new Date().toISOString().slice(0, 10));
    setEditDurationDays(task.durationDays || 1);
    setEditDueDate(task.dueDate || '');
    setEditDueTime(normalizeDueTime(task.dueTime) || '');
    setEditIsForcedDeadline(!!task.isForcedDeadline);
    setEditForcedDeadlineDate(task.forcedDeadlineDate || '');
    setEditCategoryId(task.categoryId);
    setEditR(task.raci.R);
    setEditA(task.raci.A || '');
    setEditC(task.raci.C?.join(', ') || '');
    setEditI(task.raci.I?.join(', ') || '');
    setEditMicroSteps([...task.microSteps]);
    setNewStepText('');
  };

  const handleAddEditStep = () => {
    if (!newStepText.trim()) return;
    const newStep: MicroStep = {
      id: `step-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      label: newStepText.trim(),
      status: 'PENDING',
    };
    setEditMicroSteps([...editMicroSteps, newStep]);
    setNewStepText('');
  };

  const handleToggleEditStep = (stepId: string) => {
    setEditMicroSteps(
      editMicroSteps.map((s) =>
        s.id === stepId
          ? { ...s, status: s.status === 'DONE' ? 'PENDING' : 'DONE' }
          : s
      )
    );
  };

  const handleRemoveEditStep = (stepId: string) => {
    setEditMicroSteps(editMicroSteps.filter((s) => s.id !== stepId));
  };

  const handleSaveTask = (pushWhatsapp: boolean) => {
    if (!editDrawerTask || !onUpdateTask) return;
    const computedDue =
      editDueDate || computeDueDate(editStartDate || new Date().toISOString().slice(0, 10), editDurationDays);

    const updated: Task = {
      ...editDrawerTask,
      title: editTitle.trim() || editDrawerTask.title,
      shortTag: editShortTag.trim() || editDrawerTask.shortTag || 'Task',
      latestAiSummary: editDescription,
      quadrant: editQuadrant,
      majorOrMinor: editClassification,
      startDate: editStartDate || editDrawerTask.startDate,
      durationDays: editDurationDays,
      dueDate: computedDue,
      dueTime: normalizeDueTime(editDueTime),
      isForcedDeadline: editIsForcedDeadline,
      forcedDeadlineDate: editIsForcedDeadline ? (editForcedDeadlineDate || computedDue) : null,
      categoryId: editCategoryId,
      raci: {
        R: editR,
        A: editA || editR,
        C: editC ? editC.split(',').map((s) => s.trim()).filter(Boolean) : [],
        I: editI ? editI.split(',').map((s) => s.trim()).filter(Boolean) : [],
      },
      microSteps: editMicroSteps,
    };
    onUpdateTask(updated, pushWhatsapp, editDrawerTask);
    setEditDrawerTask(null);
  };

  // Drag and drop quadrant change handler
  const handleQuadrantDrop = (task: Task, targetQuadrant: Quadrant) => {
    if (task.quadrant === targetQuadrant) return;
    // Open confirmation modal to confirm tentative date/duration change
    setQuadrantMoveModal({
      task,
      targetQuadrant,
      tentativeDueDate: task.dueDate || new Date().toISOString().slice(0, 10),
      durationDays: task.durationDays || 1,
    });
  };

  const handleConfirmQuadrantMove = () => {
    if (!quadrantMoveModal) return;
    const { task, targetQuadrant, tentativeDueDate, durationDays } = quadrantMoveModal;
    const computedStart = task.startDate || new Date().toISOString().slice(0, 10);
    const cascadeRes = cascadeTaskSchedule(state.tasks, task.taskCode, computedStart, durationDays);

    if (cascadeRes.cascadedCount > 0 && onBatchUpdateTasks) {
      const mergedTasks = cascadeRes.updatedTasks.map((t) =>
        t.taskCode === task.taskCode
          ? { ...t, quadrant: targetQuadrant, dueDate: tentativeDueDate, durationDays }
          : t
      );
      onBatchUpdateTasks(
        mergedTasks,
        `Moved [${task.shortTag || 'Task'}] to ${QUADRANT_CONFIG[targetQuadrant].label} and cascaded dependent dates.`
      );
    } else if (onUpdateTask) {
      const updated: Task = {
        ...task,
        quadrant: targetQuadrant,
        dueDate: tentativeDueDate,
        durationDays,
      };
      onUpdateTask(updated, true);
    }
    setQuadrantMoveModal(null);
  };

  // Macro Gantt date timeline calculation
  const ganttDaysCount = ganttHorizon === 'WEEK' ? 14 : 30;
  const ganttBaseDate = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const timelineDays = useMemo(() => {
    const list: Array<{ dateStr: string; label: string; isToday: boolean }> = [];
    const todayStr = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < ganttDaysCount; i++) {
      const d = new Date(ganttBaseDate);
      d.setDate(d.getDate() + i);
      const str = d.toISOString().slice(0, 10);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      const dayNum = d.getDate();
      list.push({
        dateStr: str,
        label: `${dayName} ${dayNum}`,
        isToday: str === todayStr,
      });
    }
    return list;
  }, [ganttBaseDate, ganttDaysCount]);

  // Grouped Gantt rows according to selected grouping
  const ganttGroupedRows = useMemo(() => {
    if (ganttGroupBy === 'TEAM_MEMBER') {
      const groupsMap = new Map<
        string,
        { key: string; title: string; subtitle: string; totalScheduledDays: number; tasks: Task[] }
      >();
      for (const t of liveTasks) {
        const phone = t.raci.R;
        const member = state.team_members[phone];
        if (!groupsMap.has(phone)) {
          groupsMap.set(phone, {
            key: phone,
            title: member?.name || phone,
            subtitle: member?.roleTitle || 'Field Team',
            totalScheduledDays: 0,
            tasks: [],
          });
        }
        const grp = groupsMap.get(phone)!;
        grp.tasks.push(t);
        if (t.status !== 'COMPLETED' && t.status !== 'EXPIRED_MISSED') {
          grp.totalScheduledDays += t.durationDays || 1;
        }
      }
      return Array.from(groupsMap.values());
    } else {
      const groupsMap = new Map<
        string,
        { key: string; title: string; subtitle: string; totalScheduledDays: number; tasks: Task[] }
      >();
      for (const t of liveTasks) {
        const headId = t.wbsHeadId || 'ADHOC_STANDALONE';
        const head = t.wbsHeadId ? state.wbs_heads?.find((h) => h.headId === t.wbsHeadId) : undefined;
        if (!groupsMap.has(headId)) {
          groupsMap.set(headId, {
            key: headId,
            title: head?.title || (t.wbsHeadId ? t.wbsHeadId : 'Ad-Hoc / Standalone Tasks'),
            subtitle: head
              ? `${head.domainCategory} · ${head.tentativeDurationDays}d timeline`
              : 'Ad-Hoc / Standalone Tasks',
            totalScheduledDays: 0,
            tasks: [],
          });
        }
        const grp = groupsMap.get(headId)!;
        grp.tasks.push(t);
        if (t.status !== 'COMPLETED' && t.status !== 'EXPIRED_MISSED') {
          grp.totalScheduledDays += t.durationDays || 1;
        }
      }
      return Array.from(groupsMap.values());
    }
  }, [liveTasks, ganttGroupBy, state.team_members, state.wbs_heads]);

  // Handle bar shift/resize on Gantt
  const handleShiftGanttTask = (task: Task, deltaDays: number) => {
    if (!onUpdateTask && !onBatchUpdateTasks) return;
    const startParts = (task.startDate || new Date().toISOString().slice(0, 10))
      .split('-')
      .map((p) => Number.parseInt(p, 10));
    const d = new Date(startParts[0], startParts[1] - 1, startParts[2]);
    d.setDate(d.getDate() + deltaDays);
    const newStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;

    const cascadeRes = cascadeTaskSchedule(
      state.tasks,
      task.taskCode,
      newStart,
      task.durationDays || 1
    );

    if (cascadeRes.cascadedCount > 0 || cascadeRes.conflict) {
      setCascadeModal({
        task,
        newStartDate: newStart,
        newDuration: task.durationDays || 1,
        cascadedCount: cascadeRes.cascadedCount,
        conflict: cascadeRes.conflict,
        conflictMessage: cascadeRes.conflictMessage,
        updatedTasks: cascadeRes.updatedTasks,
      });
    } else {
      const updated = cascadeRes.updatedTasks.find((t) => t.taskCode === task.taskCode)!;
      onUpdateTask?.(updated, false);
    }
  };

  const handleApplyCascade = () => {
    if (!cascadeModal) return;
    if (onBatchUpdateTasks) {
      onBatchUpdateTasks(
        cascadeModal.updatedTasks,
        `Cascaded schedule from [${cascadeModal.task.shortTag || 'Task'}] starting ${cascadeModal.newStartDate} across ${cascadeModal.cascadedCount} task(s).`
      );
    } else if (onUpdateTask) {
      for (const t of cascadeModal.updatedTasks) {
        onUpdateTask(t, false);
      }
    }
    setCascadeModal(null);
  };

  // Chronological Audit Drawer sync
  const currentAuditTask = useMemo(
    () =>
      auditDrawerTask
        ? state.tasks.find((t) => t.taskCode === auditDrawerTask.taskCode) || null
        : null,
    [auditDrawerTask, state.tasks]
  );

  return (
    <div className="space-y-6">
      {/* Top Banner, Trigger Overview & View Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-hairline pb-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink font-display">
            Operations Workspace
          </h2>
          <p className="mt-1 text-xs text-slate">
            Every task, who has it, when it is due, and where it stands.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* View Switcher Pills */}
          <div className="inline-flex rounded-xl border border-hairline bg-surface-muted p-1">
            <button
              type="button"
              onClick={() => setCurrentView('LIST')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                currentView === 'LIST'
                  ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                  : 'text-slate hover:text-ink'
              }`}
            >
              <List className="h-3.5 w-3.5" />
              <span>Task List</span>
            </button>
            <button
              type="button"
              onClick={() => setCurrentView('MATRIX_2X2')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                currentView === 'MATRIX_2X2'
                  ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                  : 'text-slate hover:text-ink'
              }`}
            >
              <Grid className="h-3.5 w-3.5" />
              <span>2x2 Matrix</span>
            </button>
            <button
              type="button"
              onClick={() => setCurrentView('GANTT')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                currentView === 'GANTT'
                  ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                  : 'text-slate hover:text-ink'
              }`}
            >
              <Calendar className="h-3.5 w-3.5" />
              <span>Macro Gantt</span>
            </button>
            <button
              type="button"
              onClick={() => setCurrentView('SPLIT_ALL')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                currentView === 'SPLIT_ALL'
                  ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                  : 'text-slate hover:text-ink'
              }`}
            >
              <Columns className="h-3.5 w-3.5" />
              <span>Split All-in-One</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onTriggerDailyDigest}
            className="inline-flex items-center gap-2 rounded-xl border border-warn-border bg-warn-soft px-3.5 py-1.5 text-xs font-semibold text-warn hover:bg-warn-border/40 transition-colors"
          >
            <Sun className="h-3.5 w-3.5 text-warn" />
            <span>Send today's digest</span>
          </button>

          {onRunJobsTick && (
            <button
              type="button"
              onClick={onRunJobsTick}
              className="inline-flex items-center gap-2 rounded-xl border border-info-border bg-info-soft px-3.5 py-1.5 text-xs font-semibold text-info hover:bg-info-border/40 transition-colors"
              title="Run releaseDueTasks and daily digest checks for current time"
            >
              <Clock className="h-3.5 w-3.5 text-info" />
              <span>Run tick</span>
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <button
          type="button"
          onClick={() => setStatusFilter(statusFilter === 'IN_PROGRESS' ? 'ALL' : 'IN_PROGRESS')}
          className={`rounded-2xl border bg-surface p-4 text-left transition-all shadow-[var(--shadow-card)] ${
            statusFilter === 'IN_PROGRESS'
              ? 'border-ok ring-1 ring-ok'
              : 'border-hairline hover:border-ok-border'
          }`}
        >
          <div className="text-xs font-medium text-slate">Active Execution</div>
          <div className="mt-1 text-2xl font-bold text-ok font-display tabular-nums">
            {kpis.active}
          </div>
          <div className="mt-0.5 text-[11px] text-slate/80">Tasks in field progress</div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter(statusFilter === 'SCHEDULED' ? 'ALL' : 'SCHEDULED')}
          className={`rounded-2xl border bg-surface p-4 text-left transition-all shadow-[var(--shadow-card)] ${
            statusFilter === 'SCHEDULED'
              ? 'border-info ring-1 ring-info'
              : 'border-hairline hover:border-info-border'
          }`}
        >
          <div className="text-xs font-medium text-slate">Scheduled / Held</div>
          <div className="mt-1 text-2xl font-bold text-info font-display tabular-nums">
            {kpis.scheduled}
          </div>
          <div className="mt-0.5 text-[11px] text-slate/80">Waiting on shift, time or cap</div>
        </button>

        <button
          type="button"
          onClick={() =>
            setStatusFilter(
              statusFilter === 'LOCKED_BY_DEPENDENCY' ? 'ALL' : 'LOCKED_BY_DEPENDENCY'
            )
          }
          className={`rounded-2xl border bg-surface p-4 text-left transition-all shadow-[var(--shadow-card)] ${
            statusFilter === 'LOCKED_BY_DEPENDENCY'
              ? 'border-warn ring-1 ring-warn'
              : 'border-hairline hover:border-warn-border'
          }`}
        >
          <div className="text-xs font-medium text-slate">Waiting on Dependency</div>
          <div className="mt-1 text-2xl font-bold text-warn font-display tabular-nums">
            {kpis.locked}
          </div>
          <div className="mt-0.5 text-[11px] text-slate/80">Awaiting prior handover</div>
        </button>

        <button
          type="button"
          onClick={() =>
            setStatusFilter(
              statusFilter === 'AWAITING_BOSS_DECISION' ? 'ALL' : 'AWAITING_BOSS_DECISION'
            )
          }
          className={`rounded-2xl border bg-surface p-4 text-left transition-all shadow-[var(--shadow-card)] ${
            statusFilter === 'AWAITING_BOSS_DECISION'
              ? 'border-danger ring-1 ring-danger'
              : 'border-hairline hover:border-danger-border'
          }`}
        >
          <div className="text-xs font-medium text-slate">Boss Review</div>
          <div className="mt-1 text-2xl font-bold text-danger font-display tabular-nums">
            {kpis.awaitingBoss}
          </div>
          <div className="mt-0.5 text-[11px] text-slate/80">SLA reminders paused</div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter(statusFilter === 'COMPLETED' ? 'ALL' : 'COMPLETED')}
          className={`rounded-2xl border bg-surface p-4 text-left transition-all shadow-[var(--shadow-card)] ${
            statusFilter === 'COMPLETED'
              ? 'border-ink ring-1 ring-ink'
              : 'border-hairline hover:border-hairline-strong'
          }`}
        >
          <div className="text-xs font-medium text-slate">Completed</div>
          <div className="mt-1 text-2xl font-bold text-ink font-display tabular-nums">
            {kpis.completed}
          </div>
          <div className="mt-0.5 text-[11px] text-slate/80">Verified &amp; closed</div>
        </button>
      </div>

      {/* Filter Bar (Active in List & Split views) */}
      {(currentView === 'LIST' || currentView === 'SPLIT_ALL') && (
        <div className="grid grid-cols-1 gap-3 rounded-2xl border border-hairline bg-surface p-3.5 sm:grid-cols-2 lg:grid-cols-5 shadow-[var(--shadow-card)]">
          <div className="relative lg:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-slate" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by tag, title, or teammate..."
              className="w-full rounded-lg border border-hairline bg-paper pl-9 pr-3 py-1.5 text-xs text-ink placeholder:text-slate/70 focus:border-signal focus:bg-surface focus:outline-none transition-colors"
            />
          </div>

          <select
            value={quadrantFilter}
            onChange={(e) => setQuadrantFilter(e.target.value)}
            className="rounded-lg border border-hairline bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
          >
            <option value="ALL">All Priorities</option>
            <option value="Q1_DO_FIRST">Do First (Urgent &amp; Important)</option>
            <option value="Q2_SCHEDULE">Schedule (Important)</option>
            <option value="Q3_DELEGATE">Delegate (Urgent)</option>
            <option value="Q4_LOW">Routine (Low)</option>
          </select>

          <select
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            className="rounded-lg border border-hairline bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
          >
            <option value="ALL">All Teammates</option>
            {membersList.map((m) => (
              <option key={m.phone} value={m.phone}>
                {m.name} ({m.roleTitle})
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-hairline bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
          >
            <option value="ALL">All Statuses</option>
            <option value="SCHEDULED">Scheduled (Held)</option>
            <option value="IN_PROGRESS">In Progress</option>
            <option value="LOCKED_BY_DEPENDENCY">Waiting on Dependency</option>
            <option value="AWAITING_BOSS_DECISION">Boss Review</option>
            <option value="COMPLETED">Completed</option>
            <option value="PENDING">Queued</option>
            <option value="ARCHIVED">Archived ({archivedTasks.length})</option>
          </select>
        </div>
      )}

      {/* SCHEDULED RELEASE LANE */}
      {scheduledTasks.length > 0 && (currentView === 'LIST' || currentView === 'SPLIT_ALL') && (
        <div className="rounded-2xl border border-info-border bg-info-soft/50 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-info" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-info font-display">
                Scheduled Release Lane (<span className="tabular-nums">{scheduledTasks.length}</span>)
              </h3>
            </div>
            <span className="text-[11px] text-info">
              Not sent yet: held by schedule, shift, cap, confirmation, or waiting on another task
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {scheduledTasks.map((st) => {
              const assignee = state.team_members[st.raci.R];
              const needsConfirm = Boolean(
                st.release?.requireOwnerConfirm && !st.release?.ownerConfirmed
              );
              const isWaitingOnTask = st.status === 'LOCKED_BY_DEPENDENCY';
              const plannedSend = describePlannedSendTime(st, state);
              const holdReason =
                st.release?.holdReason ||
                (isWaitingOnTask
                  ? `Waiting on ${st.release?.afterTaskCode || st.dependency?.dependsOnTaskCode || 'another task'}`
                  : 'Awaiting release evaluation');
              return (
                <div
                  key={st.taskCode}
                  className="rounded-xl border border-info-border bg-surface p-3 flex flex-col justify-between gap-2 shadow-[var(--shadow-card)]"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-ink truncate">
                        [{st.shortTag || st.taskCode}] {st.title}
                      </span>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-bold shrink-0 border ${
                          isWaitingOnTask
                            ? 'bg-warn-soft text-warn border-warn-border'
                            : 'bg-info-soft text-info border-info-border'
                        }`}
                      >
                        {isWaitingOnTask ? 'WAITING ON TASK' : st.release?.mode || 'NOW'}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate">
                      Assignee: <strong className="text-ink">{assignee?.name || st.raci.R}</strong> ·{' '}
                      <span className="tabular-nums">Due {st.dueDate}</span>
                    </div>
                    <div className="text-[11px] font-semibold text-ink flex items-center gap-1">
                      <Clock className="h-3 w-3 text-info shrink-0" />
                      Planned send: <span className="font-bold tabular-nums">{plannedSend}</span>
                    </div>
                    <div className="text-[11px] font-medium text-info bg-info-soft rounded-lg px-2 py-1">
                      Hold reason: {holdReason}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    {needsConfirm && onConfirmScheduledRelease && (
                      <button
                        type="button"
                        onClick={() => onConfirmScheduledRelease(st.taskCode)}
                        className="rounded-lg bg-ok-solid px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-ok transition-colors"
                      >
                        Confirm Release
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onForceUnlock(st.taskCode)}
                      className="rounded-lg border border-hairline-strong bg-paper px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-surface-muted transition-colors"
                    >
                      Release Now
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* VIEW 1: SCROLLABLE TASK LIST */}
      {(currentView === 'LIST' || currentView === 'SPLIT_ALL') && (
        <div className="space-y-3">
          {filteredTasks.length === 0 ? (
            <BrandEmptyState
              compact
              title="No operational tasks match the selected filters"
              description="Stage new assignments via Meditate & Task Studio, or reset the filters above."
            />
          ) : (
            filteredTasks.map((task) => {
              const responsible = state.team_members[task.raci.R];
              const accountable = state.team_members[task.raci.A];
              const qCfg = QUADRANT_CONFIG[task.quadrant];
              const sCfg = STATUS_CONFIG[task.status];
              const doneCount = task.microSteps.filter((s) => s.status === 'DONE').length;
              const totalSteps = task.microSteps.length;
              const progress = totalSteps > 0 ? Math.round((doneCount / totalSteps) * 100) : 0;
              const isLocked = task.status === 'LOCKED_BY_DEPENDENCY';
              const isArchived = Boolean(task.archivedAt);
              const isClosed = isTaskClosed(task.status);
              const assigneeName = state.team_members[task.raci.R]?.name || task.raci.R;
              const wasSent =
                task.isFrozen && (isTaskReleasedStatus(task.status) || Boolean(task.release?.releasedAt));
              const pending =
                pendingCloseAction?.taskCode === task.taskCode ? pendingCloseAction : null;

              return (
                <article
                  key={task.taskCode}
                  className="group rounded-2xl border border-hairline bg-surface p-4.5 hover:border-hairline-strong shadow-[var(--shadow-card)] transition-all"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Human-Readable Short Tag Pill */}
                      <span className="inline-flex items-center rounded-md bg-ink px-2.5 py-0.5 text-xs font-mono font-semibold text-white">
                        {task.shortTag || task.title}
                      </span>

                      {/* Priority badge */}
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${qCfg.badgeClass}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${qCfg.dotClass}`} />
                        {qCfg.label}
                      </span>

                      {/* Status badge */}
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${sCfg.badgeClass}`}
                      >
                        {sCfg.label}
                      </span>

                      {/* Hard Deadline Badge */}
                      {task.isForcedDeadline && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-danger-soft border border-danger-border px-2 py-0.5 text-[11px] font-bold text-danger tabular-nums">
                          <Clock className="h-3 w-3" /> Hard Cutoff: {formatDueLabel(task)}
                        </span>
                      )}

                      {/* Behind: late by the clock, or a reply said it will finish late (code-checked) */}
                      {isTaskBehind(task, Date.now(), state.business_profile?.timezone) && (
                        <span
                          className="inline-flex items-center gap-1 rounded-md bg-danger-soft border border-danger-border px-2 py-0.5 text-[11px] font-bold text-danger tabular-nums"
                          title={task.scheduleRisk?.reason || undefined}
                        >
                          <Clock className="h-3 w-3" />
                          {(() => {
                            const timing = describeTaskTiming(task, Date.now(), state.business_profile?.timezone);
                            return timing.state === 'LATE' ? timingLabel(timing) : 'Behind';
                          })()}
                        </span>
                      )}
                    </div>

                    {/* Quick Action Buttons */}
                    {pending ? (
                      <div
                        role="alertdialog"
                        aria-label={pending.kind === 'CANCEL' ? 'Confirm cancel' : 'Confirm archive'}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-danger-border bg-danger-soft px-2.5 py-1.5"
                      >
                        <span className="text-xs font-medium text-danger">
                          {pending.kind === 'ARCHIVE' && isClosed
                            ? 'Archive this task? No message is sent.'
                            : wasSent
                              ? `Cancel this task and tell ${assigneeName} to stop?`
                              : 'Cancel this task? It was not sent yet, so no message is sent.'}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setPendingCloseAction(null);
                            if (pending.kind === 'CANCEL') onCancelTask?.(task.taskCode);
                            else onArchiveTask?.(task.taskCode);
                          }}
                          className="rounded-md bg-danger-solid px-2.5 py-1 text-xs font-semibold text-white hover:bg-danger transition-colors"
                        >
                          {pending.kind === 'CANCEL' ? 'Yes, cancel' : 'Yes, archive'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingCloseAction(null)}
                          className="rounded-md border border-hairline-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper"
                        >
                          Keep
                        </button>
                      </div>
                    ) : isArchived ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-md bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-slate">
                        <Archive className="h-3 w-3" /> Archived
                      </span>
                      <button
                        type="button"
                        onClick={() => setAuditDrawerTask(task)}
                        className="inline-flex items-center gap-1 rounded-lg border border-hairline bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper transition-colors"
                        title="View WhatsApp trail"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        <span>WhatsApp Trail</span>
                      </button>
                    </div>
                    ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {!isClosed && onCancelTask && (
                        <button
                          type="button"
                          onClick={() => setPendingCloseAction({ taskCode: task.taskCode, kind: 'CANCEL' })}
                          className="inline-flex items-center gap-1 rounded-lg border border-danger-border bg-surface px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-soft transition-colors"
                          title="Cancel this task"
                        >
                          <Ban className="h-3.5 w-3.5" />
                          <span>Cancel</span>
                        </button>
                      )}
                      {onArchiveTask && (
                        <button
                          type="button"
                          onClick={() => setPendingCloseAction({ taskCode: task.taskCode, kind: 'ARCHIVE' })}
                          className="inline-flex items-center gap-1 rounded-lg border border-hairline bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper transition-colors"
                          title={isClosed ? 'Move to Archived' : 'Cancel and move to Archived'}
                        >
                          <Archive className="h-3.5 w-3.5" />
                          <span>Archive</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openEditDrawer(task)}
                        className="inline-flex items-center gap-1 rounded-lg border border-hairline bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper transition-colors"
                        title="Edit task & micro-steps"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        <span>Edit</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setAuditDrawerTask(task)}
                        className="inline-flex items-center gap-1 rounded-lg border border-hairline bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper transition-colors"
                        title="View WhatsApp trail"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        <span>WhatsApp Trail</span>
                      </button>

                      {isLocked ? (
                        <button
                          type="button"
                          onClick={() => onForceUnlock(task.taskCode)}
                          className="inline-flex items-center gap-1 rounded-lg bg-warn-solid px-2.5 py-1 text-xs font-semibold text-white hover:bg-warn transition-colors"
                        >
                          <Unlock className="h-3.5 w-3.5" />
                          <span>Unlock Now</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onInstantNudge(task.taskCode)}
                          className="inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1 text-xs font-semibold text-white hover:bg-ink-hover transition-colors"
                          title="Push immediate WhatsApp reminder"
                        >
                          <Zap className="h-3.5 w-3.5 text-signal" />
                          <span>Nudge</span>
                        </button>
                      )}
                    </div>
                    )}
                  </div>

                  {/* Title and Summary */}
                  <div className="mt-2.5 space-y-1">
                    <h3 className="text-sm font-bold text-ink font-display">{task.title}</h3>
                    {task.latestAiSummary && (
                      <p className="text-xs text-slate leading-relaxed">
                        {task.latestAiSummary}
                      </p>
                    )}
                    {task.scheduleRisk && isTaskBehind(task, Date.now(), state.business_profile?.timezone) && (
                      <div className="space-y-1">
                        <p className="text-xs font-semibold text-danger leading-relaxed">
                          Behind: {task.scheduleRisk.reason}
                        </p>
                        {task.scheduleRisk.suggestedFix && (
                          <p className="text-xs text-ink leading-relaxed">
                            <span className="font-semibold">Suggested fix:</span> {task.scheduleRisk.suggestedFix}
                          </p>
                        )}
                        {findRelatedOpenItems(state, task).map((r) => (
                          <p key={r.reviewId} className="text-xs text-warn leading-relaxed">
                            Linked approval waiting: {r.personName} — [{r.tag}] ({r.reviewId}) in Boss Reviews
                          </p>
                        ))}
                        {task.scheduleRisk.alertedAt && (
                          <p className="text-[11px] text-slate">
                            {state.team_members[task.raci.A]?.name || 'Accountable'} was told on WhatsApp.
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Micro-Steps Checkbox Strip */}
                  <div className="mt-3 rounded-xl border border-hairline bg-paper/75 p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-ink tabular-nums">
                        Operational Checklist ({doneCount}/{totalSteps})
                      </span>
                      <span className="font-bold text-ink tabular-nums">{progress}%</span>
                    </div>

                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className="h-full bg-ok-solid transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>

                    <div className="space-y-1 pt-1">
                      {task.microSteps.map((step) => (
                        <label
                          key={step.id}
                          className="flex items-start gap-2 text-xs text-ink cursor-pointer hover:text-ink"
                        >
                          <input
                            type="checkbox"
                            checked={step.status === 'DONE'}
                            onChange={() => onToggleMicroStepManual(task.taskCode, step.id)}
                            className="mt-0.5 rounded border-hairline-strong accent-signal"
                          />
                          <span
                            className={
                              step.status === 'DONE' ? 'line-through text-slate' : 'font-medium'
                            }
                          >
                            {step.label}
                          </span>
                          {step.targetCount ? (
                            <span className="ml-auto shrink-0 rounded-md border border-info-border bg-info-soft px-1.5 py-0.5 text-[10px] font-bold text-info tabular-nums">
                              {formatStepCount(step)}
                            </span>
                          ) : null}
                          {step.photoMustShow ? (
                            <span
                              className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${
                                step.photoVerified
                                  ? 'border-ok-border bg-ok-soft text-ok'
                                  : 'border-hairline bg-paper text-slate'
                              }`}
                              title={step.evidenceNote || `Needs a photo showing ${step.photoMustShow}`}
                            >
                              {step.photoVerified ? 'Photo checked' : 'Photo needed'}
                            </span>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Footer Bar: RACI & Due Date */}
                  <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 text-xs text-slate border-t border-hairline pt-3">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1 font-medium text-ink">
                        <User className="h-3.5 w-3.5 text-slate" />
                        <span>Responsible:</span>
                        <strong className="text-ink">{responsible?.name || task.raci.R}</strong>
                      </span>
                      {accountable && (
                        <span className="hidden sm:inline text-slate">
                          (Acc: {accountable.name})
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 tabular-nums">
                      <span>Start: <strong className="text-ink">{task.startDate || 'Today'}</strong></span>
                      <span>Duration: <strong className="text-ink">{task.durationDays || 1}d</strong></span>
                      <span className="text-ink font-semibold">Due: {formatDueLabel(task)}</span>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      )}

      {/* VIEW 2: DRAG-AND-DROP 2x2 EISENHOWER MATRIX */}
      {(currentView === 'MATRIX_2X2' || currentView === 'SPLIT_ALL') && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-ink font-display">
              Interactive 2x2 Eisenhower Prioritization Matrix
            </h3>
            <p className="text-xs text-slate">
              Drag cards between quadrants to re-prioritize. A duration &amp; deadline prompt will confirm your update.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(['Q1_DO_FIRST', 'Q2_SCHEDULE', 'Q3_DELEGATE', 'Q4_LOW'] as Quadrant[]).map(
              (quadKey) => {
                const qCfg = QUADRANT_CONFIG[quadKey];
                const quadTasks = liveTasks.filter((t) => t.quadrant === quadKey);

                return (
                  <div
                    key={quadKey}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const taskCode = e.dataTransfer.getData('text/plain');
                      const task = liveTasks.find((t) => t.taskCode === taskCode);
                      if (task) handleQuadrantDrop(task, quadKey);
                    }}
                    className={`rounded-2xl border border-hairline p-4 min-h-[300px] flex flex-col ${qCfg.bgTint}`}
                  >
                    <div className="flex items-center justify-between border-b border-hairline pb-2.5 mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${qCfg.dotClass}`} />
                        <h4 className="text-xs font-bold text-ink font-display">{qCfg.label}</h4>
                      </div>
                      <span className="rounded-md bg-surface px-2 py-0.5 text-[11px] font-bold text-ink border border-hairline tabular-nums">
                        {quadTasks.length} Task{quadTasks.length !== 1 ? 's' : ''}
                      </span>
                    </div>

                    <div className="flex-1 space-y-2.5 overflow-y-auto">
                      {quadTasks.length === 0 ? (
                        <div className="flex items-center justify-center h-32 text-xs text-slate border border-dashed border-hairline-strong rounded-xl bg-surface/50">
                          Drop tasks here
                        </div>
                      ) : (
                        quadTasks.map((t) => (
                          <div
                            key={t.taskCode}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/plain', t.taskCode);
                            }}
                            className="cursor-grab active:cursor-grabbing rounded-xl border border-hairline bg-surface p-3 shadow-[var(--shadow-card)] hover:border-hairline-strong transition-all space-y-1.5"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="rounded-md bg-ink text-white px-2 py-0.5 text-[10px] font-mono font-bold">
                                {t.shortTag || 'Task'}
                              </span>
                              <span className="text-[10px] text-slate font-medium tabular-nums">
                                Due {t.dueDate}
                              </span>
                            </div>
                            <h5 className="text-xs font-semibold text-ink leading-tight">
                              {t.title}
                            </h5>
                            <div className="flex items-center justify-between text-[10px] text-slate pt-1">
                              <span>@{state.team_members[t.raci.R]?.name || t.raci.R}</span>
                              <span className="font-semibold text-ok tabular-nums">
                                {t.completionPercent}%
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              }
            )}
          </div>
        </div>
      )}

      {/* VIEW 3: MACRO WEEK / MONTH GANTT CHART */}
      {(currentView === 'GANTT' || currentView === 'SPLIT_ALL') && (
        <div className="rounded-2xl border border-hairline bg-surface shadow-[var(--shadow-card)] p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-hairline pb-3">
            <div>
              <h3 className="text-sm font-bold text-ink font-display">
                Macro Operations Gantt Chart
              </h3>
              <p className="text-xs text-slate mt-0.5">
                Clean macro boundaries without step clutter. Drag arrows to shift forward cascade.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-lg border border-hairline bg-surface-muted p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setGanttHorizon('WEEK')}
                  className={`rounded-md px-2.5 py-1 font-semibold ${
                    ganttHorizon === 'WEEK' ? 'bg-surface text-ink shadow-[var(--shadow-card)]' : 'text-slate'
                  }`}
                >
                  14-Day Horizon
                </button>
                <button
                  type="button"
                  onClick={() => setGanttHorizon('MONTH')}
                  className={`rounded-md px-2.5 py-1 font-semibold ${
                    ganttHorizon === 'MONTH' ? 'bg-surface text-ink shadow-[var(--shadow-card)]' : 'text-slate'
                  }`}
                >
                  30-Day Month
                </button>
              </div>

              <select
                value={ganttGroupBy}
                onChange={(e) => setGanttGroupBy(e.target.value as any)}
                className="rounded-lg border border-hairline bg-paper px-2.5 py-1 text-xs text-ink focus:border-signal focus:outline-none"
              >
                <option value="TEAM_MEMBER">Group by Team Member</option>
                <option value="WBS_HEAD">Group by project</option>
              </select>
            </div>
          </div>

          {/* Timeline Grid Table */}
          <div className="overflow-x-auto">
            <div className="min-w-[850px] space-y-3">
              {/* Header Days Row */}
              <div className="grid grid-cols-12 gap-2 text-[10px] font-bold text-slate border-b border-hairline pb-2">
                <div className="col-span-3 text-xs text-ink">
                  {ganttGroupBy === 'TEAM_MEMBER' ? 'Person / Task' : 'Project / Task'}
                </div>
                <div className="col-span-9 grid grid-flow-col auto-cols-fr gap-1 text-center tabular-nums">
                  {timelineDays.map((day) => (
                    <div
                      key={day.dateStr}
                      className={`py-1 rounded ${
                        day.isToday
                          ? 'bg-signal-hover text-white font-bold'
                          : 'bg-paper text-slate'
                      }`}
                    >
                      {day.label}
                    </div>
                  ))}
                </div>
              </div>

              {/* Rows Grouped */}
              <div className="space-y-4">
                {ganttGroupedRows.length === 0 ? (
                  <div className="text-center py-8 text-xs text-slate">
                    No active tasks match the current filter.
                  </div>
                ) : (
                  ganttGroupedRows.map((group) => (
                    <div key={group.key} className="space-y-1">
                      {/* Group Header Row */}
                      <div className="bg-surface-muted px-3 py-1.5 rounded-lg flex items-center justify-between text-xs font-bold text-ink border border-hairline">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-ink">{group.title}</span>
                          <span className="text-[10px] font-normal text-slate">
                            ({group.subtitle})
                          </span>
                        </div>
                        <div className="flex items-center gap-2 tabular-nums">
                          <span className="rounded bg-signal-soft px-2 py-0.5 text-[10px] font-bold text-signal-ink border border-signal-border">
                            {group.totalScheduledDays}d scheduled
                          </span>
                          <span className="rounded bg-surface px-2 py-0.5 text-[10px] font-bold text-ink border border-hairline">
                            {group.tasks.length} task{group.tasks.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </div>

                      {/* Group Task Rows */}
                      <div className="divide-y divide-hairline pl-1">
                        {group.tasks.map((task) => {
                          const rMember = state.team_members[task.raci.R];

                          const startParts = (task.startDate || new Date().toISOString().slice(0, 10))
                            .split('-')
                            .map((p) => Number.parseInt(p, 10));
                          const taskStart = new Date(startParts[0], startParts[1] - 1, startParts[2]);
                          const diffDays = Math.round(
                            (taskStart.getTime() - ganttBaseDate.getTime()) / (1000 * 60 * 60 * 24)
                          );
                          const duration = Math.max(1, Math.ceil(task.durationDays || 1));

                          const clampedStart = Math.max(0, Math.min(ganttDaysCount - 1, diffDays));
                          const clampedWidth = Math.max(
                            1,
                            Math.min(ganttDaysCount - clampedStart, duration)
                          );

                          return (
                            <div key={task.taskCode} className="grid grid-cols-12 gap-2 py-2.5 items-center">
                              <div className="col-span-3 pr-2 space-y-0.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="rounded-md bg-ink text-white px-2 py-0.5 text-[10px] font-mono font-bold">
                                    {task.shortTag || 'Task'}
                                  </span>
                                  {task.isForcedDeadline && (
                                    <span className="text-[10px] font-bold text-danger">★ Cutoff</span>
                                  )}
                                </div>
                                <p className="text-xs font-semibold text-ink truncate">
                                  {task.title}
                                </p>
                                <p className="text-[10px] text-slate tabular-nums">
                                  @{rMember?.name || task.raci.R} · {task.durationDays || 1}d
                                </p>
                              </div>

                              {/* Bar Track Container */}
                              <div className="col-span-9 relative h-9 bg-paper rounded-lg flex items-center px-1">
                                <div
                                  style={{
                                    marginLeft: `${(clampedStart / ganttDaysCount) * 100}%`,
                                    width: `${(clampedWidth / ganttDaysCount) * 100}%`,
                                  }}
                                  className={`h-7 rounded-lg border text-white text-[10px] font-bold flex items-center justify-between px-2 shadow-[var(--shadow-card)] transition-all ${
                                    task.status === 'COMPLETED'
                                      ? 'bg-ok-solid border-ok'
                                      : task.isForcedDeadline
                                        ? 'bg-danger-solid border-danger'
                                        : 'bg-ink border-ink'
                                  }`}
                                >
                                  {/* Shift Back Button */}
                                  <button
                                    type="button"
                                    onClick={() => handleShiftGanttTask(task, -1)}
                                    className="text-white/75 hover:text-white"
                                    title="Shift -1 day"
                                  >
                                    ◀
                                  </button>

                                  <span className="truncate px-1 tabular-nums">
                                    {task.shortTag || task.title} ({task.completionPercent}%)
                                  </span>

                                  {/* Shift Forward Button (Auto Cascades) */}
                                  <button
                                    type="button"
                                    onClick={() => handleShiftGanttTask(task, 1)}
                                    className="text-white/75 hover:text-white"
                                    title="Shift +1 day (Cascades forward)"
                                  >
                                    ▶
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* QUADRANT MOVE PROMPT MODAL */}
      {quadrantMoveModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-modal)] space-y-4">
            <h3 className="text-base font-bold text-ink font-display">
              Move to {QUADRANT_CONFIG[quadrantMoveModal.targetQuadrant].label}
            </h3>
            <p className="text-xs text-slate">
              Adjust duration and target deadline for [
              <strong className="text-ink">{quadrantMoveModal.task.shortTag || 'Task'}</strong>] to reflect its new priority.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Duration (Days)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="14"
                  value={quadrantMoveModal.durationDays}
                  onChange={(e) =>
                    setQuadrantMoveModal({
                      ...quadrantMoveModal,
                      durationDays: Number.parseFloat(e.target.value) || 1,
                    })
                  }
                  className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Target Due Date
                </label>
                <input
                  type="date"
                  value={quadrantMoveModal.tentativeDueDate}
                  onChange={(e) =>
                    setQuadrantMoveModal({
                      ...quadrantMoveModal,
                      tentativeDueDate: e.target.value,
                    })
                  }
                  className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setQuadrantMoveModal(null)}
                className="rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-paper"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmQuadrantMove}
                className="rounded-lg bg-ink px-4 py-1.5 text-xs font-bold text-white hover:bg-ink-hover transition-colors"
              >
                Confirm Move &amp; Notify
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DEPENDENCY CASCADE CONFIRMATION MODAL */}
      {cascadeModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-lg rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-modal)] space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle
                className={`h-5 w-5 ${
                  cascadeModal.conflict ? 'text-danger' : 'text-warn'
                }`}
              />
              <h3 className="text-base font-bold text-ink font-display">
                {cascadeModal.conflict
                  ? 'Forced Deadline Conflict Warning'
                  : 'Dependency Auto-Cascade Notification'}
              </h3>
            </div>

            <p className="text-xs text-slate">
              Shifting [<strong className="text-ink">{cascadeModal.task.shortTag || 'Task'}</strong>] to start on{' '}
              <strong className="text-ink tabular-nums">{cascadeModal.newStartDate}</strong> cascades down{' '}
              <strong className="text-ink tabular-nums">{cascadeModal.cascadedCount}</strong> downstream task(s).
            </p>

            {cascadeModal.conflict && (
              <div className="rounded-xl border border-danger-border bg-danger-soft p-3 text-xs text-danger font-medium">
                {cascadeModal.conflictMessage}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCascadeModal(null)}
                className="rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-paper"
              >
                Cancel Shift
              </button>
              <button
                type="button"
                onClick={handleApplyCascade}
                className={`rounded-lg px-4 py-1.5 text-xs font-bold text-white transition-colors ${
                  cascadeModal.conflict
                    ? 'bg-danger-solid hover:bg-danger'
                    : 'bg-ink hover:bg-ink-hover'
                }`}
              >
                Apply Cascade Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deep Task Editor Drawer */}
      {editDrawerTask && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex justify-end bg-ink/35 backdrop-blur-xs"
        >
          <div className="flex h-full w-full max-w-xl flex-col border-l border-hairline bg-surface p-6 shadow-[var(--shadow-modal)] overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b border-hairline pb-4">
              <div>
                <span className="inline-flex items-center rounded-md bg-ink px-2.5 py-0.5 text-xs font-mono font-semibold text-white">
                  {editShortTag || 'Task'}
                </span>
                <h3 className="mt-1 text-base font-bold text-ink font-display">
                  Edit Task Details &amp; SOP
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditDrawerTask(null)}
                className="rounded-lg border border-hairline p-1.5 text-slate hover:bg-paper hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-bold text-ink mb-1">Task Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Human Tag</label>
                  <input
                    type="text"
                    value={editShortTag}
                    onChange={(e) => setEditShortTag(e.target.value)}
                    className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-ink mb-1">Priority</label>
                  <select
                    value={editQuadrant}
                    onChange={(e) => setEditQuadrant(e.target.value as Quadrant)}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink focus:border-signal focus:outline-none"
                  >
                    <option value="Q1_DO_FIRST">Q1 Do First</option>
                    <option value="Q2_SCHEDULE">Q2 Schedule</option>
                    <option value="Q3_DELEGATE">Q3 Delegate</option>
                    <option value="Q4_LOW">Q4 Routine</option>
                  </select>
                </div>
              </div>

              {/* Timing & Forced Deadline Configuration */}
              <div className="rounded-xl border border-hairline bg-paper p-3.5 space-y-3">
                <div className="text-xs font-bold text-ink">Timing &amp; Deadlines</div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate mb-1">
                      Start Date
                    </label>
                    <input
                      type="date"
                      value={editStartDate}
                      onChange={(e) => setEditStartDate(e.target.value)}
                      className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate mb-1">
                      Duration (Days)
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      min="0.5"
                      value={editDurationDays}
                      onChange={(e) => setEditDurationDays(Number.parseFloat(e.target.value) || 1)}
                      className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate mb-1">
                      Due Date
                    </label>
                    <input
                      type="date"
                      value={editDueDate}
                      onChange={(e) => setEditDueDate(e.target.value)}
                      className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink"
                    />
                    <label className="block text-[11px] font-semibold text-slate mt-1.5 mb-1">
                      Due by (time, optional)
                    </label>
                    <input
                      type="time"
                      value={editDueTime}
                      onChange={(e) => setEditDueTime(e.target.value)}
                      className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink tabular-nums"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs font-semibold text-ink cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={editIsForcedDeadline}
                    onChange={(e) => setEditIsForcedDeadline(e.target.checked)}
                    className="rounded border-hairline-strong accent-signal"
                  />
                  <span>Hard Forced Deadline (Cannot be deferred)</span>
                </label>
              </div>

              {/* RACI Selection */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">
                    Responsible (R)
                  </label>
                  <select
                    value={editR}
                    onChange={(e) => setEditR(e.target.value)}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink"
                  >
                    {membersList.map((m) => (
                      <option key={m.phone} value={m.phone}>
                        {m.name} ({m.roleTitle})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink mb-1">
                    Accountable (A)
                  </label>
                  <select
                    value={editA}
                    onChange={(e) => setEditA(e.target.value)}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink"
                  >
                    {membersList.map((m) => (
                      <option key={m.phone} value={m.phone}>
                        {m.name} ({m.authorityLevel})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Micro-Steps Editor */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-ink tabular-nums">
                  Micro-Steps Checklist ({editMicroSteps.length})
                </label>
                <div className="space-y-1.5">
                  {editMicroSteps.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-paper p-2 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => handleToggleEditStep(s.id)}
                        className={`text-left flex-1 font-medium ${
                          s.status === 'DONE' ? 'line-through text-slate' : 'text-ink'
                        }`}
                      >
                        {s.label}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveEditStep(s.id)}
                        className="text-slate hover:text-danger p-1"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2 pt-1">
                  <input
                    type="text"
                    value={newStepText}
                    onChange={(e) => setNewStepText(e.target.value)}
                    placeholder="Add a new checklist step..."
                    className="flex-1 rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleAddEditStep}
                    className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink-hover transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-end gap-3 border-t border-hairline pt-4">
              <button
                type="button"
                onClick={() => setEditDrawerTask(null)}
                className="w-full sm:w-auto rounded-lg border border-hairline-strong bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-paper"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={() => handleSaveTask(false)}
                className="w-full sm:w-auto rounded-lg border border-hairline-strong bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-paper shadow-[var(--shadow-card)]"
              >
                Save Changes Only
              </button>

              <button
                type="button"
                onClick={() => handleSaveTask(true)}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-ink px-4.5 py-2 text-xs font-semibold text-white hover:bg-ink-hover shadow-[var(--shadow-card)] transition-colors"
              >
                <Send className="h-3.5 w-3.5 text-signal" />
                Save &amp; Push WhatsApp
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chronological Audit Drawer */}
      {currentAuditTask && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex justify-end bg-ink/35 backdrop-blur-xs"
        >
          <div className="flex h-full w-full max-w-xl flex-col border-l border-hairline bg-surface p-6 shadow-[var(--shadow-modal)] overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b border-hairline pb-4">
              <div>
                <span className="inline-flex items-center rounded-md bg-ink px-2.5 py-0.5 text-xs font-mono font-semibold text-white">
                  {currentAuditTask.shortTag || currentAuditTask.title}
                </span>
                <h3 className="mt-1 text-base font-bold text-ink font-display">
                  {currentAuditTask.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setAuditDrawerTask(null)}
                className="rounded-lg border border-hairline p-1.5 text-slate hover:bg-paper hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-2">
              <div className="text-xs font-semibold text-ink">
                Outbound WhatsApp Message (Dispatched in Hinglish)
              </div>
              <pre className="whitespace-pre-wrap rounded-xl border border-hairline bg-paper p-3.5 font-sans text-xs text-ink leading-relaxed">
                {currentAuditTask.outboundWhatsappPreview}
              </pre>
            </div>

            <div className="mt-6 space-y-3">
              <div className="text-xs font-semibold text-ink tabular-nums">
                Chronological Audit &amp; Inspection Trail ({currentAuditTask.auditLogs.length})
              </div>
              <div className="divide-y divide-hairline rounded-xl border border-hairline bg-surface shadow-[var(--shadow-card)]">
                {currentAuditTask.auditLogs.map((log, i) => (
                  <div key={`${log.timestamp}-${i}`} className="p-3.5 space-y-1 text-xs">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate">
                      <span className="text-ink font-semibold">{log.sender}</span>
                      <span className="tabular-nums">{new Date(log.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="text-ink leading-relaxed">{log.rawInputSummary}</p>
                    {log.mediaInspected && (
                      <p className="text-warn bg-warn-soft border border-warn-border rounded px-2 py-1 text-[11px] font-medium inline-block">
                        Media Inspection: {log.mediaInspected}
                      </p>
                    )}
                    <p className="text-ok font-medium text-[11px]">
                      Outcome: {log.aiDecision}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
