import { isTaskClosed } from '../lib/releaseEngine';
import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart2,
  CheckCircle2,
  Clock,
  Edit2,
  Layers,
  MessageSquare,
  Plus,
  Shield,
  Sparkles,
  TrendingUp,
  User,
  UserCheck,
  UserMinus,
  X,
  Zap,
} from 'lucide-react';
import {
  AuthorityLevel,
  OpsDatabaseState,
  PreferredLanguage,
  Quadrant,
  Task,
  TeamMember,
} from '../types/ops';
import { isWithin24HrWindow } from '../lib/opsEngine';
import { normalizeIndianPhone } from '../lib/phoneText';
import { buildTeamScorecard } from '../lib/scorecard';

interface AnalyticsRosterTabProps {
  state: OpsDatabaseState;
  onUpsertTeamMember?: (member: TeamMember) => void;
  onDeleteTeamMember?: (phone: string) => void;
  onToggleLeave?: (phone: string) => void;
  onSelectTask?: (task: Task) => void;
  onNotify?: (msg: string) => void;
}

/** Split a comma- or newline-separated field into trimmed, non-empty phrases. */
function splitPhrases(text: string): string[] {
  return String(text || '')
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export const AnalyticsRosterTab: React.FC<AnalyticsRosterTabProps> = ({
  state,
  onUpsertTeamMember,
  onDeleteTeamMember,
  onToggleLeave,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<'WATERFALL_DOMAIN' | 'TEAM_ROSTER'>('WATERFALL_DOMAIN');

  const membersList = useMemo(() => Object.values(state.team_members), [state.team_members]);
  const liveTasks = useMemo(
    () => state.tasks.filter((t) => t.status !== 'STAGING_DRAFT'),
    [state.tasks]
  );

  // 1. Task Pipeline Waterfall Data (5 stages)
  const waterfallData = useMemo(() => {
    const totalRaised = liveTasks.length;
    const notStarted = liveTasks.filter(
      (t) => t.status === 'PENDING' || t.status === 'LOCKED_BY_DEPENDENCY'
    ).length;
    const inPipeline = liveTasks.filter((t) => t.status === 'IN_PROGRESS').length;
    const nearCompletion = liveTasks.filter(
      (t) => t.status === 'PARTIALLY_DONE' || t.status === 'AWAITING_BOSS_DECISION'
    ).length;
    const completed = liveTasks.filter((t) => t.status === 'COMPLETED').length;

    return [
      {
        stage: 'Total Raised',
        count: totalRaised,
        colorClass: 'bg-ink',
        textColor: 'text-ink',
        description: 'All operational requests catalogued',
      },
      {
        stage: 'Not Started',
        count: notStarted,
        colorClass: 'bg-warn-solid',
        textColor: 'text-warn',
        description: 'Queued or waiting on prior dependencies',
      },
      {
        stage: 'In Pipeline',
        count: inPipeline,
        colorClass: 'bg-info',
        textColor: 'text-info',
        description: 'Actively in field execution',
      },
      {
        stage: 'Near Completion',
        count: nearCompletion,
        colorClass: 'bg-signal',
        textColor: 'text-signal-ink',
        description: 'Partial evidence or Boss review paused',
      },
      {
        stage: 'Completed',
        count: completed,
        colorClass: 'bg-ok-solid',
        textColor: 'text-ok',
        description: 'Full SOP checklist verified & closed',
      },
    ];
  }, [liveTasks]);

  // 2. Domain of Work Breakdown
  const domainData = useMemo(() => {
    const map = new Map<
      string,
      {
        categoryId: string;
        categoryName: string;
        totalTasks: number;
        personDays: number;
        majorTasks: number;
        minorTasks: number;
      }
    >();

    // Seed from category_sops
    for (const sop of state.category_sops) {
      map.set(sop.categoryId, {
        categoryId: sop.categoryId,
        categoryName: sop.categoryName,
        totalTasks: 0,
        personDays: 0,
        majorTasks: 0,
        minorTasks: 0,
      });
    }

    for (const t of liveTasks) {
      let entry = map.get(t.categoryId);
      if (!entry) {
        entry = {
          categoryId: t.categoryId,
          categoryName: t.categoryId,
          totalTasks: 0,
          personDays: 0,
          majorTasks: 0,
          minorTasks: 0,
        };
        map.set(t.categoryId, entry);
      }
      entry.totalTasks += 1;
      entry.personDays += t.durationDays || 1;
      if (t.majorOrMinor === 'MAJOR') {
        entry.majorTasks += 1;
      } else {
        entry.minorTasks += 1;
      }
    }

    return Array.from(map.values()).sort((a, b) => b.personDays - a.personDays);
  }, [liveTasks, state.category_sops]);

  // Overall Velocity & Shift Response
  const velocityMetrics = useMemo(() => {
    const activeTasks = liveTasks.filter(
      (t) =>
        t.status === 'PENDING' ||
        t.status === 'IN_PROGRESS' ||
        t.status === 'PARTIALLY_DONE'
    ).length;
    const completedTasks = liveTasks.filter((t) => t.status === 'COMPLETED').length;
    const pausedTasks = liveTasks.filter((t) => t.status === 'AWAITING_BOSS_DECISION').length;

    let totalMins = 0;
    let totalReplies = 0;
    for (const m of membersList) {
      totalMins += m.stats.totalWorkHoursReplyMins;
      totalReplies += m.stats.replyCount;
    }
    const avgReplyMinutes = totalReplies > 0 ? Math.round(totalMins / totalReplies) : 0;

    return {
      activeTasks,
      completedTasks,
      pausedTasks,
      avgReplyMinutes,
      totalStaff: membersList.length,
    };
  }, [liveTasks, membersList]);

  // Teammate Form State
  const defaultMaxCap = state.task_splitting_rules?.defaultMaxActiveTasksPerPerson ?? 3;
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingPhone, setEditingPhone] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [authorityLevel, setAuthorityLevel] = useState<AuthorityLevel>('STAFF');
  const [skillsText, setSkillsText] = useState('');
  const [maxActiveTasks, setMaxActiveTasks] = useState<number>(defaultMaxCap);
  const [isOnLeaveForm, setIsOnLeaveForm] = useState(false);
  const [prefersVoiceForm, setPrefersVoiceForm] = useState(false);
  const scorecard = useMemo(() => buildTeamScorecard(state, Date.now()), [state]);
  const [preferredLanguage, setPreferredLanguage] = useState<PreferredLanguage>('HINGLISH');
  const [workShiftStart, setWorkShiftStart] = useState('09:00');
  const [workShiftEnd, setWorkShiftEnd] = useState('19:00');
  const [dailyOverviewTime, setDailyOverviewTime] = useState('09:30');
  const [personaPrompt, setPersonaPrompt] = useState('');
  const [addressAs, setAddressAs] = useState('');
  const [responsibilities, setResponsibilities] = useState('');
  const [strengthsText, setStrengthsText] = useState('');
  const [weaknessesText, setWeaknessesText] = useState('');
  const [formError, setFormError] = useState('');

  const openNewMemberModal = () => {
    setEditingPhone(null);
    const nextIdx = membersList.length + 1;
    setPhone(`9198765000${String(nextIdx).padStart(2, '0')}`);
    setName('');
    setRoleTitle('');
    setAuthorityLevel('STAFF');
    setSkillsText('');
    setMaxActiveTasks(defaultMaxCap);
    setIsOnLeaveForm(false);
    setPrefersVoiceForm(false);
    setPreferredLanguage(state.business_profile?.defaultStaffLanguage || 'HINGLISH');
    setWorkShiftStart('09:00');
    setWorkShiftEnd('19:00');
    setDailyOverviewTime('09:30');
    setPersonaPrompt('Respectful and simple. Short lines.');
    setAddressAs('');
    setResponsibilities('');
    setStrengthsText('');
    setWeaknessesText('');
    setFormError('');
    setIsFormOpen(true);
  };

  const openEditMemberModal = (m: TeamMember) => {
    setEditingPhone(m.phone);
    setPhone(m.phone);
    setName(m.name);
    setRoleTitle(m.roleTitle);
    setAuthorityLevel(m.authorityLevel === 'BOSS' ? 'OWNER' : m.authorityLevel);
    setSkillsText(Array.isArray(m.skills) ? m.skills.join(', ') : '');
    setMaxActiveTasks(typeof m.maxActiveTasks === 'number' ? m.maxActiveTasks : defaultMaxCap);
    setIsOnLeaveForm(Boolean(m.isOnLeave));
    setPrefersVoiceForm(Boolean(m.prefersVoiceNotes));
    setPreferredLanguage(m.preferredLanguage);
    setWorkShiftStart(m.workShiftStart);
    setWorkShiftEnd(m.workShiftEnd);
    setDailyOverviewTime(m.dailyOverviewTime);
    setPersonaPrompt(m.personaPrompt || '');
    setAddressAs(m.addressAs || '');
    setResponsibilities(m.responsibilities || '');
    setStrengthsText(Array.isArray(m.strengths) ? m.strengths.join(', ') : '');
    setWeaknessesText(Array.isArray(m.weaknesses) ? m.weaknesses.join(', ') : '');
    setFormError('');
    setIsFormOpen(true);
  };

  const handleSaveMember = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPhone = normalizeIndianPhone(phone);
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      setFormError('Enter a valid WhatsApp phone number with country code (e.g. 919876543210).');
      return;
    }
    if (!name.trim() || !roleTitle.trim()) {
      setFormError('Member Name and Role Title are required.');
      return;
    }

    const existing = state.team_members[cleanPhone];
    const memberIndex = existing
      ? Object.keys(state.team_members).indexOf(cleanPhone)
      : Object.keys(state.team_members).length;
    const assignedSlotId = existing?.slotId || `P${memberIndex + 1}`;
    const parsedSkills = skillsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const memberObj: TeamMember = {
      phone: cleanPhone,
      slotId: assignedSlotId,
      name: name.trim(),
      roleTitle: roleTitle.trim(),
      authorityLevel,
      skills: parsedSkills,
      maxActiveTasks: Math.max(1, Number(maxActiveTasks) || defaultMaxCap),
      preferredLanguage,
      workShiftStart,
      workShiftEnd,
      dailyOverviewTime,
      isOnLeave: isOnLeaveForm,
      prefersVoiceNotes: prefersVoiceForm,
      lastInboundAt: existing ? existing.lastInboundAt : new Date().toISOString(),
      bufferMode: existing ? existing.bufferMode : 'STANDARD_15_MIN',
      personaPrompt: personaPrompt.trim(),
      addressAs: addressAs.trim(),
      responsibilities: responsibilities.trim(),
      strengths: splitPhrases(strengthsText),
      weaknesses: splitPhrases(weaknessesText),
      stats: existing
        ? existing.stats
        : {
            assigned: 0,
            completed: 0,
            partial: 0,
            overdueCount: 0,
            totalWorkHoursReplyMins: 0,
            replyCount: 0,
          },
    };

    onUpsertTeamMember?.(memberObj);
    setIsFormOpen(false);
    onNotify?.(`Saved team member [${assignedSlotId}] ${memberObj.name}.`);
  };

  const maxWaterfallCount = Math.max(1, ...waterfallData.map((w) => w.count));
  const maxDomainDays = Math.max(1, ...domainData.map((d) => d.personDays));

  return (
    <div className="space-y-6">
      {/* Top Header & View Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-hairline pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink font-display">
            Analytics &amp; People Outcome Suite
          </h1>
          <p className="text-xs text-slate mt-0.5">
            Operational pipeline waterfall, domain workload distribution, and WhatsApp team roster with persona prompts.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-hairline bg-surface-muted p-1">
            <button
              type="button"
              onClick={() => setActiveTab('WATERFALL_DOMAIN')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                activeTab === 'WATERFALL_DOMAIN'
                  ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                  : 'text-slate hover:text-ink'
              }`}
            >
              <BarChart2 className="h-3.5 w-3.5" />
              <span>Pipeline &amp; Domain</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('TEAM_ROSTER')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-all tabular-nums ${
                activeTab === 'TEAM_ROSTER'
                  ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                  : 'text-slate hover:text-ink'
              }`}
            >
              <UserCheck className="h-3.5 w-3.5" />
              <span>Team Roster ({membersList.length})</span>
            </button>
          </div>

          {activeTab === 'TEAM_ROSTER' && (
            <button
              type="button"
              onClick={openNewMemberModal}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-bold text-white shadow-[var(--shadow-card)] hover:bg-ink-hover transition-colors"
            >
              <Plus className="h-3.5 w-3.5 text-signal" />
              Add Teammate
            </button>
          )}
        </div>
      </div>

      {/* Summary KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border border-hairline bg-surface p-4 shadow-[var(--shadow-card)]">
          <div className="text-xs font-medium text-slate">Active Live Tasks</div>
          <div className="mt-1 text-2xl font-extrabold text-ink font-display tabular-nums">
            {velocityMetrics.activeTasks}
          </div>
          <div className="mt-0.5 text-[11px] text-slate tabular-nums">
            {velocityMetrics.completedTasks} completed to date
          </div>
        </div>

        <div className="rounded-xl border border-hairline bg-surface p-4 shadow-[var(--shadow-card)]">
          <div className="text-xs font-medium text-slate">Paused in Boss Review</div>
          <div className="mt-1 text-2xl font-extrabold text-warn font-display tabular-nums">
            {velocityMetrics.pausedTasks}
          </div>
          <div className="mt-0.5 text-[11px] text-slate">SLA timers frozen</div>
        </div>

        <div className="rounded-xl border border-hairline bg-surface p-4 shadow-[var(--shadow-card)]">
          <div className="text-xs font-medium text-slate">Avg WhatsApp Reply Speed</div>
          <div className="mt-1 text-2xl font-extrabold text-ok font-display tabular-nums">
            {velocityMetrics.avgReplyMinutes > 0 ? `${velocityMetrics.avgReplyMinutes}m` : 'Fast'}
          </div>
          <div className="mt-0.5 text-[11px] text-slate">Within daily work shifts</div>
        </div>

        <div className="rounded-xl border border-hairline bg-surface p-4 shadow-[var(--shadow-card)]">
          <div className="text-xs font-medium text-slate">Active Field Team</div>
          <div className="mt-1 text-2xl font-extrabold text-ink font-display tabular-nums">
            {velocityMetrics.totalStaff}
          </div>
          <div className="mt-0.5 text-[11px] text-slate">Across shifts &amp; roles</div>
        </div>
      </div>

      {/* Batch 4: per-person scorecard (code arithmetic from tasks and reply stats) */}
      <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-card)] space-y-3">
        <div>
          <h3 className="text-sm font-bold text-ink font-display">Team scorecard</h3>
          <p className="text-xs text-slate mt-0.5">
            On-time rate, reply speed, what is behind now, and who has more due by tomorrow than they can carry.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="text-left text-slate border-b border-hairline">
                <th className="py-2 pr-3 font-semibold">Person</th>
                <th className="py-2 pr-3 font-semibold">On time</th>
                <th className="py-2 pr-3 font-semibold">Avg reply</th>
                <th className="py-2 pr-3 font-semibold">Open now</th>
                <th className="py-2 pr-3 font-semibold">Behind now</th>
                <th className="py-2 pr-3 font-semibold">Due by tomorrow</th>
              </tr>
            </thead>
            <tbody>
              {scorecard.map((row) => (
                <tr key={row.phone} className="border-b border-hairline/60">
                  <td className="py-2 pr-3">
                    <div className="font-semibold text-ink">{row.name}</div>
                    <div className="text-[11px] text-slate">{row.roleTitle}</div>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{row.onTimeRate === null ? '—' : `${row.onTimeRate}%`}</td>
                  <td className="py-2 pr-3 tabular-nums">{row.avgReplyMins === null ? '—' : `${row.avgReplyMins} min`}</td>
                  <td className="py-2 pr-3 tabular-nums">{row.openNow}</td>
                  <td className={`py-2 pr-3 tabular-nums ${row.behindNow > 0 ? 'font-bold text-danger' : ''}`}>{row.behindNow}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    <span className={row.overloadedTomorrow ? 'font-bold text-danger' : ''}>
                      {row.dueByTomorrow} / {row.limit}
                    </span>
                    {row.overloadedTomorrow && <span className="ml-1 text-[11px] text-danger">overloaded</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {activeTab === 'WATERFALL_DOMAIN' ? (
        <div className="space-y-6">
          {/* 1. VISUAL TASK PIPELINE WATERFALL CHART */}
          <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-hairline pb-3">
              <div>
                <h3 className="text-sm font-bold text-ink font-display">
                  Task Pipeline Waterfall Flow
                </h3>
                <p className="text-xs text-slate mt-0.5">
                  5-stage progression from initial brain-dump to verified completion.
                </p>
              </div>
              <span className="text-xs font-bold text-ink bg-paper border border-hairline px-2.5 py-1 rounded-md tabular-nums">
                {liveTasks.length} Total Initiatives
              </span>
            </div>

            {/* Waterfall Stepped Bars */}
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 pt-2">
              {waterfallData.map((item, idx) => {
                const heightPct = Math.max(15, Math.round((item.count / maxWaterfallCount) * 100));

                return (
                  <div
                    key={item.stage}
                    className="rounded-xl border border-hairline bg-paper/75 p-4 flex flex-col justify-between h-56 space-y-2 hover:bg-surface hover:border-hairline-strong transition-all"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-slate font-mono">0{idx + 1}</span>
                        <span className={`text-xs font-extrabold tabular-nums ${item.textColor}`}>
                          {item.count} Tasks
                        </span>
                      </div>
                      <h4 className="text-xs font-bold text-ink font-display mt-1">{item.stage}</h4>
                      <p className="text-[10px] text-slate mt-0.5 line-clamp-2">
                        {item.description}
                      </p>
                    </div>

                    {/* Stepped Vertical Bar */}
                    <div className="h-24 w-full bg-surface-muted rounded-lg flex items-end overflow-hidden p-1 border border-hairline">
                      <div
                        style={{ height: `${heightPct}%` }}
                        className={`w-full ${item.colorClass} rounded-md transition-all duration-500 flex items-center justify-center`}
                      >
                        <span className="text-[10px] font-bold text-white tabular-nums">
                          {item.count}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2. DOMAIN OF WORK BREAKDOWN (HORIZONTAL BARS) */}
          <div className="rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-card)] space-y-4">
            <div className="border-b border-hairline pb-3">
              <h3 className="text-sm font-bold text-ink font-display">
                Domain of Work &amp; Effort Distribution
              </h3>
              <p className="text-xs text-slate mt-0.5">
                Workload person-days and Major vs Minor scope split across functional operational domains.
              </p>
            </div>

            <div className="space-y-4 pt-1">
              {domainData.map((dom) => {
                const barWidth = Math.max(8, Math.round((dom.personDays / maxDomainDays) * 100));

                return (
                  <div key={dom.categoryId} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-ink">{dom.categoryName}</span>
                        <span className="rounded-md bg-paper border border-hairline text-slate px-2 py-0.5 text-[10px] font-semibold tabular-nums">
                          {dom.totalTasks} task{dom.totalTasks !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-slate">
                        <span className="text-[11px] tabular-nums">
                          Major: <strong className="text-signal-ink">{dom.majorTasks}</strong> · Minor: <strong className="text-info">{dom.minorTasks}</strong>
                        </span>
                        <span className="font-bold text-ink tabular-nums">
                          {dom.personDays} Person-Days
                        </span>
                      </div>
                    </div>

                    <div className="h-3 w-full rounded-full bg-surface-muted overflow-hidden border border-hairline flex">
                      <div
                        style={{ width: `${barWidth}%` }}
                        className="h-full bg-gradient-to-r from-ink to-signal rounded-full transition-all duration-300"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Team Roster View with Slot IDs, Skills, Capacity & Persona Prompts */
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {membersList.map((m, idx) => {
              const slotId = m.slotId || `P${idx + 1}`;
              const displayAuthority = m.authorityLevel === 'BOSS' ? 'OWNER' : m.authorityLevel;
              const memberCap =
                typeof m.maxActiveTasks === 'number' ? m.maxActiveTasks : defaultMaxCap;
              const activeMemberTaskCount = liveTasks.filter(
                (t) =>
                  t.raci?.R === m.phone &&
                  !isTaskClosed(t.status)
              ).length;
              const windowOpen = isWithin24HrWindow(m.lastInboundAt);
              const initials = m.name
                .split(' ')
                .map((n) => n[0])
                .join('')
                .slice(0, 2)
                .toUpperCase();

              return (
                <div
                  key={m.phone}
                  className="rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-card)] space-y-3.5 hover:border-hairline-strong transition-all"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl bg-ink text-white font-bold text-xs shadow-[var(--shadow-card)]">
                        <span className="text-[10px] text-signal leading-none font-mono">{slotId}</span>
                        <span className="leading-tight font-display">{initials}</span>
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-signal-soft border border-signal-border px-1.5 py-0.5 font-mono text-[10px] font-extrabold text-signal-ink">
                            {slotId}
                          </span>
                          <h4 className="text-sm font-bold text-ink font-display">{m.name}</h4>
                          <span className="rounded-md bg-paper border border-hairline px-2 py-0.5 text-[10px] font-semibold text-slate">
                            {displayAuthority}
                          </span>
                        </div>
                        <p className="text-xs text-slate font-medium">{m.roleTitle}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openEditMemberModal(m)}
                        className="rounded-lg border border-hairline p-1.5 text-slate hover:bg-paper hover:text-ink transition-colors"
                        title="Edit profile, skills, capacity & persona prompt"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onToggleLeave?.(m.phone);
                          onNotify?.(`${m.name} marked ${m.isOnLeave ? 'Active' : 'On Leave'}.`);
                        }}
                        className={`rounded-lg border px-2 py-1 text-xs font-semibold transition-colors ${
                          m.isOnLeave
                            ? 'border-warn-border bg-warn-soft text-warn'
                            : 'border-hairline bg-surface text-slate hover:bg-paper hover:text-ink'
                        }`}
                      >
                        {m.isOnLeave ? 'On Leave' : 'Mark Leave'}
                      </button>
                      {onDeleteTeamMember && membersList.length > 1 && (
                        <button
                          type="button"
                          onClick={() => onDeleteTeamMember(m.phone)}
                          className="rounded-lg border border-hairline p-1.5 text-danger hover:bg-danger-soft transition-colors"
                          title="Remove from roster"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Skills / Departments Tags */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {Array.isArray(m.skills) && m.skills.length > 0 ? (
                      m.skills.map((skill) => (
                        <span
                          key={skill}
                          className="rounded-md bg-info-soft border border-info-border px-2 py-0.5 text-[10px] font-semibold text-info"
                        >
                          {skill}
                        </span>
                      ))
                    ) : (
                      <span className="text-[11px] text-slate italic">
                        No department tags set — click Edit to add skills
                      </span>
                    )}
                  </div>

                  {/* What they handle */}
                  {m.responsibilities ? (
                    <div className="rounded-xl border border-hairline bg-paper/50 p-3 space-y-1">
                      <div className="text-[10px] font-bold text-slate uppercase tracking-wider">
                        What they handle
                      </div>
                      <p className="text-[11px] text-ink leading-relaxed whitespace-pre-line">
                        {m.responsibilities}
                      </p>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate italic">
                      No &quot;What they handle&quot; yet — click Edit to add it
                    </p>
                  )}

                  {/* Strengths & Weaknesses */}
                  {(Array.isArray(m.strengths) && m.strengths.length > 0) ||
                  (Array.isArray(m.weaknesses) && m.weaknesses.length > 0) ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {Array.isArray(m.strengths) && m.strengths.length > 0 && (
                        <div className="rounded-xl border border-ok-border bg-ok-soft p-2.5 space-y-1">
                          <div className="text-[10px] font-bold text-ok uppercase tracking-wider">
                            Strengths
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {m.strengths.map((x) => (
                              <span key={x} className="rounded-md bg-surface border border-ok-border px-1.5 py-0.5 text-[10px] font-semibold text-ok">
                                {x}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {Array.isArray(m.weaknesses) && m.weaknesses.length > 0 && (
                        <div className="rounded-xl border border-warn-border bg-warn-soft p-2.5 space-y-1">
                          <div className="flex items-center gap-1 text-[10px] font-bold text-warn uppercase tracking-wider">
                            Weaknesses · private
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {m.weaknesses.map((x) => (
                              <span key={x} className="rounded-md bg-surface border border-warn-border px-1.5 py-0.5 text-[10px] font-semibold text-warn">
                                {x}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}

                  {/* Persona Prompt Card */}
                  <div className="rounded-xl border border-hairline bg-paper p-3 space-y-1">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate uppercase tracking-wider">
                      <Sparkles className="h-3 w-3 text-signal" />
                      Personal AI WhatsApp Tone Directive
                    </div>
                    <p className="text-xs text-ink font-medium leading-relaxed italic">
                      "{m.personaPrompt || 'Standard respectful communication.'}"
                    </p>
                  </div>

                  {/* Contact, Capacity & Shift Info */}
                  <div className="grid grid-cols-2 gap-2 text-xs text-slate pt-1 border-t border-hairline">
                    <div>
                      <span>Shift Hours: </span>
                      <strong className="text-ink tabular-nums">
                        {m.workShiftStart}–{m.workShiftEnd}
                      </strong>
                    </div>
                    <div>
                      <span>Max Capacity: </span>
                      <strong
                        className={`tabular-nums ${
                          activeMemberTaskCount >= memberCap
                            ? 'text-danger'
                            : 'text-ok'
                        }`}
                      >
                        {activeMemberTaskCount} / {memberCap} Active Tasks
                      </strong>
                    </div>
                    <div>
                      <span>Language: </span>
                      <strong className="text-ink">{m.preferredLanguage}</strong>
                    </div>
                    <div>
                      <span>WhatsApp Window: </span>
                      <strong className={windowOpen ? 'text-ok' : 'text-warn'}>
                        {windowOpen ? 'Open (<24h)' : 'Template Req.'}
                      </strong>
                    </div>
                  </div>

                  {/* Performance Statistics */}
                  <div className="grid grid-cols-3 gap-2 rounded-xl bg-paper border border-hairline p-2.5 text-center text-xs">
                    <div>
                      <div className="text-[10px] text-slate font-medium">Assigned</div>
                      <div className="font-bold text-ink tabular-nums">{m.stats.assigned}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate font-medium">Completed</div>
                      <div className="font-bold text-ok tabular-nums">{m.stats.completed}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate font-medium">Overdue</div>
                      <div className="font-bold text-danger tabular-nums">{m.stats.overdueCount}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Teammate Profile Edit Modal */}
      {isFormOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-lg rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-modal)] space-y-4 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-hairline pb-3">
              <h3 className="text-base font-bold text-ink font-display">
                {editingPhone ? 'Edit Teammate Profile & Capacity' : 'Add New Teammate'}
              </h3>
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
                className="text-slate hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {formError && (
              <div className="rounded-lg bg-danger-soft border border-danger-border p-2.5 text-xs text-danger">
                {formError}
              </div>
            )}

            <form onSubmit={handleSaveMember} className="space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Aman Verma"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    WhatsApp Phone (with Country Code)
                  </label>
                  <input
                    type="text"
                    value={phone}
                    disabled={!!editingPhone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="e.g. 919000000001"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none disabled:bg-surface-muted"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Role Title
                  </label>
                  <input
                    type="text"
                    value={roleTitle}
                    onChange={(e) => setRoleTitle(e.target.value)}
                    placeholder="e.g. Site Electrician"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Role / Authority Level
                  </label>
                  <select
                    value={authorityLevel}
                    onChange={(e) => setAuthorityLevel(e.target.value as AuthorityLevel)}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                  >
                    <option value="OWNER">OWNER (Founder / Director)</option>
                    <option value="MANAGER">MANAGER (Department / Accounts)</option>
                    <option value="SUPERVISOR">SUPERVISOR (Handover Sign-Off)</option>
                    <option value="STAFF">STAFF (Ground Execution)</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="member-responsibilities" className="block text-xs font-semibold text-ink mb-1">
                  What they handle (optional)
                </label>
                <textarea
                  id="member-responsibilities"
                  rows={3}
                  value={responsibilities}
                  onChange={(e) => setResponsibilities(e.target.value)}
                  placeholder="A few sentences on the work this person usually looks after. The AI uses this to choose who does a task."
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none leading-relaxed"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="member-strengths" className="block text-xs font-semibold text-ink mb-1">
                    Strengths (comma-separated)
                  </label>
                  <input
                    id="member-strengths"
                    type="text"
                    value={strengthsText}
                    onChange={(e) => setStrengthsText(e.target.value)}
                    placeholder="e.g. vendor relations, calm under pressure"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="member-weaknesses" className="block text-xs font-semibold text-ink mb-1">
                    Weaknesses <span className="font-bold text-warn">(private)</span>
                  </label>
                  <input
                    id="member-weaknesses"
                    type="text"
                    value={weaknessesText}
                    onChange={(e) => setWeaknessesText(e.target.value)}
                    placeholder="e.g. slow at paperwork"
                    className="w-full rounded-lg border border-warn-border bg-warn-soft px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                  />
                  <p className="mt-1 text-[10px] text-warn">
                    Only you and the AI see these. They never appear in any WhatsApp message or staff view.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Skills / Departments (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={skillsText}
                    onChange={(e) => setSkillsText(e.target.value)}
                    placeholder="e.g. Electrical, Procurement, Plumbing"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Max Active Tasks
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={25}
                    value={maxActiveTasks}
                    onChange={(e) => setMaxActiveTasks(Math.max(1, Number(e.target.value) || 3))}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-bold text-ink tabular-nums focus:border-signal focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Shift Start
                  </label>
                  <input
                    type="time"
                    value={workShiftStart}
                    onChange={(e) => setWorkShiftStart(e.target.value)}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-2 py-1.5 text-xs text-ink"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Shift End
                  </label>
                  <input
                    type="time"
                    value={workShiftEnd}
                    onChange={(e) => setWorkShiftEnd(e.target.value)}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-2 py-1.5 text-xs text-ink"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">
                    Language
                  </label>
                  <select
                    value={preferredLanguage}
                    onChange={(e) => setPreferredLanguage(e.target.value as PreferredLanguage)}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-2 py-1.5 text-xs text-ink"
                  >
                    <option value="HINGLISH">HINGLISH (Roman Hindi)</option>
                    <option value="HINDI">HINDI</option>
                    <option value="ENGLISH">ENGLISH</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-hairline bg-paper px-3.5 py-2.5">
                <div>
                  <div className="text-xs font-bold text-ink">On Leave Status</div>
                  <div className="text-[11px] text-slate">
                    When enabled, the AI will not assign new tasks to this person.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={isOnLeaveForm}
                  onChange={(e) => setIsOnLeaveForm(e.target.checked)}
                  className="h-4 w-4 rounded border-hairline-strong text-signal focus:ring-signal"
                />
              </div>

              <label className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2 cursor-pointer">
                <span>
                  <span className="block text-xs font-bold text-ink">Send tasks as voice notes</span>
                  <span className="block text-[11px] text-slate">
                    For people who listen more than they read. The text is kept too.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={prefersVoiceForm}
                  onChange={(e) => setPrefersVoiceForm(e.target.checked)}
                  className="h-4 w-4 rounded border-hairline-strong text-signal focus:ring-signal"
                />
              </label>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Address as (in messages)
                </label>
                <input
                  type="text"
                  value={addressAs}
                  onChange={(e) => setAddressAs(e.target.value)}
                  placeholder="First name and how the team greets them, e.g. ji or bhai"
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  How to talk to them (tone only)
                </label>
                <textarea
                  rows={2}
                  value={personaPrompt}
                  onChange={(e) => setPersonaPrompt(e.target.value)}
                  placeholder="Simple, friendly Hinglish. Short lines."
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline">
                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="rounded-lg border border-hairline-strong px-3.5 py-1.5 text-xs font-semibold text-ink hover:bg-paper"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-ink px-4 py-1.5 text-xs font-bold text-white hover:bg-ink-hover"
                >
                  Save Teammate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
