import React, { useMemo, useState } from 'react';
import {
  LayoutGrid,
  Search,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import { OpsDatabaseState, TeamMember } from '../types/ops';
import {
  applyMemberProfileUpdate,
  autoArrangeOrgPositions,
  buildTeamGraph,
  teamStatusLabel,
  computeTeamCapacity,
  LoadBand,
  matchesMemberSearch,
  ORG_CARD_HEIGHT,
  ORG_CARD_WIDTH,
  RemovePlan,
  SopRoleReplacement,
  syncPartnerLink,
  syncWorksCloselyLink,
  TeamNode,
} from '../lib/teamGraph';
import { BrandEmptyState } from './BrandLogo';
import { SECTION_EXPLAINERS } from '../lib/plainLabels';
import { EditableLinkKind, TeamOrgCanvas } from './TeamOrgCanvas';
import {
  AddPersonModal,
  PersonSidePanel,
  RemovePersonModal,
} from './TeamModals';

export interface TeamViewTabProps {
  state: OpsDatabaseState;
  todayStr: string;
  /** Current time (ms) for "behind" checks; the app passes its minute clock. */
  nowMs?: number;
  onUpsertTeamMember?: (member: TeamMember) => void;
  onSaveTeamMembersMap?: (nextMembers: Record<string, TeamMember>, notifyMsg?: string) => void;
  onRemoveTeamMember?: (
    phone: string,
    plan: RemovePlan,
    sopReplacements?: Record<string, SopRoleReplacement>
  ) => void;
  onOpenImport?: () => void;
  onOpenSopEditor?: (categoryId?: string) => void;
  onNotify?: (msg: string) => void;
}

const BAND_DOT: Record<LoadBand, string> = {
  green: 'bg-ok-solid',
  amber: 'bg-warn-solid',
  red: 'bg-danger-solid',
};

const BAND_NUM: Record<LoadBand, string> = {
  green: 'text-ok',
  amber: 'text-warn',
  red: 'text-danger',
};

const BAND_BAR: Record<LoadBand, string> = {
  green: 'bg-ok-solid',
  amber: 'bg-warn-solid',
  red: 'bg-danger-solid',
};

function orderNodesDepthFirst(nodes: TeamNode[]): TeamNode[] {
  const byPhone = new Map(nodes.map((n) => [n.phone, n]));
  const children = new Map<string, TeamNode[]>();
  const roots: TeamNode[] = [];
  for (const n of nodes) {
    if (n.reportsToPhone && byPhone.has(n.reportsToPhone)) {
      children.set(n.reportsToPhone, [
        ...(children.get(n.reportsToPhone) || []),
        n,
      ]);
    } else {
      roots.push(n);
    }
  }
  const ordered: TeamNode[] = [];
  const seen = new Set<string>();
  const visit = (n: TeamNode) => {
    if (seen.has(n.phone)) return;
    seen.add(n.phone);
    ordered.push(n);
    for (const c of children.get(n.phone) || []) visit(c);
  };
  for (const r of roots) visit(r);
  for (const n of nodes) visit(n);
  return ordered;
}

export const TeamViewTab: React.FC<TeamViewTabProps> = ({
  state,
  todayStr,
  nowMs,
  onUpsertTeamMember,
  onSaveTeamMembersMap,
  onRemoveTeamMember,
  onOpenImport,
  onOpenSopEditor,
  onNotify,
}) => {
  const membersMap = state.team_members || {};
  const membersList = useMemo(() => Object.values(membersMap), [membersMap]);

  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showWorksClosely, setShowWorksClosely] = useState(false);
  const [showTaskBackups, setShowTaskBackups] = useState(false);
  const [autoArrangeNonce, setAutoArrangeNonce] = useState(0);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [removeTargetPhone, setRemoveTargetPhone] = useState<string | null>(null);

  const capacity = useMemo(
    () => computeTeamCapacity(membersList, state.tasks),
    [membersList, state.tasks]
  );

  const graph = useMemo(
    () =>
      buildTeamGraph(membersList, state.category_sops, state.tasks, todayStr, {
        nowMs: nowMs ?? Date.now(),
        timezone: state.business_profile?.timezone,
      }),
    [membersList, state.category_sops, state.tasks, todayStr, nowMs, state.business_profile?.timezone]
  );

  const mobileOrderedNodes = useMemo(
    () => orderNodesDepthFirst(graph.nodes),
    [graph.nodes]
  );

  const hasSearchQuery = searchQuery.trim().length > 0;
  const matchingPhones = useMemo(() => {
    const matches = new Set<string>();
    for (const m of membersList) {
      if (matchesMemberSearch(m, searchQuery)) matches.add(m.phone);
    }
    return matches;
  }, [membersList, searchQuery]);

  const selectedMember = selectedPhone ? membersMap[selectedPhone] || null : null;
  const removeMember = removeTargetPhone ? membersMap[removeTargetPhone] || null : null;

  const commitMembers = (
    nextMembers: Record<string, TeamMember>,
    notifyMsg?: string
  ) => {
    if (onSaveTeamMembersMap) {
      onSaveTeamMembersMap(nextMembers, notifyMsg);
      return;
    }
    for (const m of Object.values(nextMembers)) {
      onUpsertTeamMember?.(m);
    }
    if (notifyMsg) onNotify?.(notifyMsg);
  };

  const handleSavePositions = (positions: Record<string, { x: number; y: number }>) => {
    const next: Record<string, TeamMember> = { ...membersMap };
    let changed = false;
    for (const [phone, pos] of Object.entries(positions)) {
      const m = next[phone];
      if (!m) continue;
      if (
        m.orgChartPosition?.x !== pos.x ||
        m.orgChartPosition?.y !== pos.y
      ) {
        next[phone] = { ...m, orgChartPosition: { x: pos.x, y: pos.y } };
        changed = true;
      }
    }
    if (changed) {
      // Save drag positions cleanly without audit/AI logs or toast banners.
      commitMembers(next);
    }
  };

  const handleAutoArrange = () => {
    const arranged = autoArrangeOrgPositions(
      membersList,
      state.category_sops,
      state.tasks,
      todayStr
    );
    const next: Record<string, TeamMember> = {};
    for (const [phone, m] of Object.entries(membersMap)) {
      next[phone] = {
        ...m,
        orgChartPosition: arranged[phone] || m.orgChartPosition || { x: 0, y: 0 },
      };
    }
    commitMembers(next, 'Auto-arranged team layout.');
    setAutoArrangeNonce((n) => n + 1);
  };

  const handleSaveLink = ({
    kind,
    subordinatePhone,
    targetPhone,
    previousKind,
    previousFrom,
    previousTo,
  }: {
    kind: EditableLinkKind;
    subordinatePhone: string;
    targetPhone: string;
    previousKind?: EditableLinkKind;
    previousFrom?: string;
    previousTo?: string;
  }) => {
    let next: Record<string, TeamMember> = { ...membersMap };

    // Remove previous link first if editing/converting an existing connection
    if (previousKind && previousFrom && previousTo) {
      if (previousKind === 'reports' && next[previousTo]) {
        next[previousTo] = { ...next[previousTo], reportsToPhone: null };
      } else if (previousKind === 'partner') {
        next = syncPartnerLink(next, previousFrom, null);
      } else if (previousKind === 'close') {
        next = syncWorksCloselyLink(next, previousFrom, previousTo, false);
      }
    }

    if (kind === 'reports' && next[subordinatePhone]) {
      next[subordinatePhone] = {
        ...next[subordinatePhone],
        reportsToPhone: targetPhone,
      };
    } else if (kind === 'partner') {
      next = syncPartnerLink(next, subordinatePhone, targetPhone);
    } else if (kind === 'close') {
      next = syncWorksCloselyLink(next, subordinatePhone, targetPhone, true);
      setShowWorksClosely(true);
    }

    const subName = next[subordinatePhone]?.name || subordinatePhone;
    const tgtName = next[targetPhone]?.name || targetPhone;
    const msg =
      kind === 'reports'
        ? `${subName} now reports to ${tgtName}.`
        : kind === 'partner'
          ? `${subName} and ${tgtName} are now linked as Partners.`
          : `${subName} and ${tgtName} are now linked as Works closely with.`;

    commitMembers(next, msg);
  };

  const handleDeleteLink = (
    kind: EditableLinkKind,
    fromPhone: string,
    toPhone: string
  ) => {
    let next: Record<string, TeamMember> = { ...membersMap };
    if (kind === 'reports' && next[toPhone]) {
      next[toPhone] = { ...next[toPhone], reportsToPhone: null };
    } else if (kind === 'partner') {
      next = syncPartnerLink(next, fromPhone, null);
    } else if (kind === 'close') {
      next = syncWorksCloselyLink(next, fromPhone, toPhone, false);
    }
    commitMembers(next, 'Removed connection.');
  };

  const handleSaveProfile = (updated: TeamMember) => {
    const next = applyMemberProfileUpdate(membersMap, updated);
    if (updated.worksCloselyWithPhones && updated.worksCloselyWithPhones.length > 0) {
      // Leave toggle state as user prefers, don't force if already editing from side panel
    }
    commitMembers(next, `Saved ${updated.name}.`);
  };

  const handleCreatePerson = (created: TeamMember) => {
    const count = Object.keys(membersMap).length;
    const usedSlots = new Set(Object.values(membersMap).map((m) => m.slotId));
    let n = count + 1;
    while (usedSlots.has(`P${n}`)) n++;
    const nextSlot = `P${n}`;

    // Compute clean initial position without colliding with existing nodes
    const tempMembers = [...membersList, created];
    const autoMap = autoArrangeOrgPositions(
      tempMembers,
      state.category_sops,
      state.tasks,
      todayStr
    );
    let initialPos = autoMap[created.phone] || { x: 0, y: 0 };

    // Avoid landing on top of manually dragged cards
    const existingPositions = membersList
      .map((m) => m.orgChartPosition)
      .filter((p): p is { x: number; y: number } => Boolean(p));
    while (
      existingPositions.some(
        (p) =>
          Math.abs(p.x - initialPos.x) < ORG_CARD_WIDTH &&
          Math.abs(p.y - initialPos.y) < ORG_CARD_HEIGHT
      )
    ) {
      initialPos = { x: initialPos.x + ORG_CARD_WIDTH + 40, y: initialPos.y };
    }

    const withMeta: TeamMember = {
      ...created,
      slotId: nextSlot,
      orgChartPosition: initialPos,
    };

    const next = { ...membersMap, [withMeta.phone]: withMeta };
    commitMembers(next, `Added ${withMeta.name} (${withMeta.roleTitle}).`);
    setIsAddOpen(false);
    setSelectedPhone(withMeta.phone);
  };

  const capBand: LoadBand = capacity.overloaded
    ? 'red'
    : capacity.atLimitPhones.length > 0 || capacity.utilization >= 0.7
      ? 'amber'
      : 'green';
  const capPct = Math.min(100, Math.round(capacity.utilization * 100));

  return (
    <div className="space-y-4 overflow-x-hidden">
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink font-display">
            Team
          </h1>
          <p className="text-xs text-slate mt-0.5">
            {SECTION_EXPLAINERS.team}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {membersList.length > 0 && (
            <button
              type="button"
              onClick={handleAutoArrange}
              className="inline-flex items-center gap-1.5 rounded-xl border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink hover:bg-paper transition-colors"
            >
              <LayoutGrid className="h-3.5 w-3.5 text-slate" />
              Auto-arrange
            </button>
          )}
          {onOpenImport && (
            <button
              type="button"
              onClick={onOpenImport}
              className="inline-flex items-center gap-1.5 rounded-xl border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink hover:bg-paper transition-colors"
            >
              <Upload className="h-3.5 w-3.5 text-signal" />
              Import team setup
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsAddOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-xs font-semibold text-white hover:bg-ink-hover transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5 text-signal" />
            + Add person
          </button>
        </div>
      </div>

      {/* Empty State */}
      {membersList.length === 0 ? (
        <BrandEmptyState
          title="No teammates yet"
          description="Add people manually or import your existing team setup to map out reporting lines."
          action={
            <button
              type="button"
              onClick={() => setIsAddOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink-hover"
            >
              <UserPlus className="h-3.5 w-3.5 text-signal" />
              + Add your first person
            </button>
          }
        />
      ) : (
        <>
          {/* Slim Capacity Strip */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-hairline bg-surface px-4 py-2.5 shadow-[var(--shadow-card)]">
            <div className="flex items-center gap-3 min-w-0">
              <span className={`h-2 w-2 rounded-full shrink-0 ${BAND_DOT[capBand]}`} />
              <span className="text-xs font-semibold text-ink tabular-nums">
                {capacity.totalActive} / {capacity.totalCapacity} slots active
              </span>
              <div className="hidden sm:block w-28 h-1.5 rounded-full bg-surface-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${BAND_BAR[capBand]}`}
                  style={{ width: `${capPct}%` }}
                />
              </div>
            </div>
            <div
              className={`text-xs truncate ${
                capacity.overloaded
                  ? 'font-semibold text-danger'
                  : capacity.warning
                    ? 'font-semibold text-warn'
                    : 'text-slate'
              }`}
            >
              {capacity.warning || `${membersList.filter((m) => !m.isOnLeave).length} available today`}
            </div>
          </div>

          {/* Search Box, Layer Toggles & Line Legend */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 rounded-xl border border-hairline bg-surface px-3.5 py-2.5 shadow-[var(--shadow-card)]">
            {/* Search Box + Toggles */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate" />
                <input
                  type="text"
                  aria-label="Search team"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search name, role, what they handle"
                  className="w-full rounded-lg border border-hairline-strong bg-paper pl-8 pr-7 py-1.5 text-xs text-ink placeholder:text-slate focus:border-signal focus:bg-surface focus:outline-none"
                />
                {searchQuery.length > 0 && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate hover:bg-surface-muted hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-ink cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showWorksClosely}
                  onChange={(e) => setShowWorksClosely(e.target.checked)}
                  className="h-3.5 w-3.5 accent-signal rounded"
                />
                Show works-closely links
              </label>

              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-ink cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showTaskBackups}
                  onChange={(e) => setShowTaskBackups(e.target.checked)}
                  className="h-3.5 w-3.5 accent-signal rounded"
                />
                Show task-type backups
              </label>
            </div>

            {/* Compact Line Legend */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate shrink-0">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-5 h-0.5 bg-ink" />
                Reports to
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-5 border-t-2 border-dashed border-signal" />
                Partner
              </span>
              {showWorksClosely && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-5 border-t-2 border-dashed border-info" />
                  Works closely
                </span>
              )}
              {showTaskBackups && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-5 border-t-2 border-dotted border-warn-solid" />
                  Task-type backup
                </span>
              )}
            </div>
          </div>

          {hasSearchQuery && matchingPhones.size === 0 && (
            <div className="rounded-xl border border-hairline bg-surface px-4 py-2 text-xs text-slate">
              No teammates match &ldquo;{searchQuery.trim()}&rdquo;. Clear search to restore full
              opacity.
            </div>
          )}

          {/* Desktop Split View: Canvas + Docked Right Side Panel */}
          <div className="hidden md:flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <TeamOrgCanvas
                nodesData={graph.nodes}
                membersMap={membersMap}
                categorySops={state.category_sops}
                tasks={state.tasks}
                todayStr={todayStr}
                selectedPhone={selectedPhone}
                matchingPhones={matchingPhones}
                hasSearchQuery={hasSearchQuery}
                showWorksClosely={showWorksClosely}
                showTaskBackups={showTaskBackups}
                autoArrangeNonce={autoArrangeNonce}
                onSelectPerson={(phone) => setSelectedPhone(phone)}
                onSavePositions={handleSavePositions}
                onSaveLink={handleSaveLink}
                onDeleteLink={handleDeleteLink}
                onOpenSopEditor={onOpenSopEditor}
              />
            </div>

            {selectedMember && (
              <div className="w-[360px] lg:w-[390px] shrink-0">
                <PersonSidePanel
                  member={selectedMember}
                  allMembers={membersList}
                  membersMap={membersMap}
                  categorySops={state.category_sops}
                  tasks={state.tasks}
                  onClose={() => setSelectedPhone(null)}
                  onSaveProfile={handleSaveProfile}
                  onRequestRemove={(m) => setRemoveTargetPhone(m.phone)}
                  onOpenSopEditor={onOpenSopEditor}
                />
              </div>
            )}
          </div>

          {/* Mobile Indented List Fallback (< md) */}
          <div className="md:hidden space-y-2">
            {mobileOrderedNodes.map((n) => {
              const dimmed = hasSearchQuery && !matchingPhones.has(n.phone);
              const isSelected = selectedPhone === n.phone;
              const status = teamStatusLabel(n);
              const statusText = status.text;
              return (
                <div
                  key={n.phone}
                  style={{ marginLeft: `${Math.min(n.depth, 4) * 14}px` }}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedPhone(n.phone)}
                    className={`w-full rounded-xl border bg-surface px-3.5 py-2.5 text-left shadow-[var(--shadow-card)] transition-opacity flex items-center justify-between gap-3 ${
                      isSelected
                        ? 'border-signal ring-2 ring-signal/20'
                        : 'border-hairline hover:border-hairline-strong'
                    } ${dimmed ? 'opacity-30' : 'opacity-100'}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-ink font-display">
                        {n.depth > 0 && (
                          <span className="mr-1.5 text-slate font-normal">↳</span>
                        )}
                        {n.name}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-slate">
                        {n.roleTitle}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <div className="inline-flex items-center gap-1.5 text-xs font-bold tabular-nums">
                        <span
                          className={`h-2 w-2 rounded-full ${BAND_DOT[n.band]}`}
                          aria-hidden="true"
                        />
                        <span className={BAND_NUM[n.band]}>
                          {n.active}/{n.limit}
                        </span>
                      </div>
                      <span
                        className={`text-[10px] font-semibold ${
                          status.tone === 'leave'
                            ? 'text-warn'
                            : status.tone === 'danger'
                              ? 'text-danger'
                              : 'text-ok'
                        }`}
                      >
                        {statusText}
                      </span>
                    </div>
                  </button>
                </div>
              );
            })}

            {/* Mobile Sheet Side Panel */}
            {selectedMember && (
              <div
                role="dialog"
                aria-modal="true"
                aria-label={`Edit ${selectedMember.name}`}
                className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/40 p-2 sm:p-4"
              >
                <div className="w-full max-w-md">
                  <PersonSidePanel
                    member={selectedMember}
                    allMembers={membersList}
                    membersMap={membersMap}
                    categorySops={state.category_sops}
                    tasks={state.tasks}
                    onClose={() => setSelectedPhone(null)}
                    onSaveProfile={handleSaveProfile}
                    onRequestRemove={(m) => setRemoveTargetPhone(m.phone)}
                    onOpenSopEditor={onOpenSopEditor}
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* + Add Person Modal */}
      {isAddOpen && (
        <AddPersonModal
          existingMembers={membersList}
          existingPhones={new Set(membersList.map((m) => m.phone))}
          defaultLimit={state.task_splitting_rules?.defaultMaxActiveTasksPerPerson || 3}
          onClose={() => setIsAddOpen(false)}
          onCreate={handleCreatePerson}
        />
      )}

      {/* Remove Person Modal */}
      {removeMember && (
        <RemovePersonModal
          member={removeMember}
          allMembers={membersList}
          tasks={state.tasks}
          categorySops={state.category_sops}
          onClose={() => setRemoveTargetPhone(null)}
          onConfirmRemove={(phone, plan, sopReplacements) => {
            onRemoveTeamMember?.(phone, plan, sopReplacements);
            setRemoveTargetPhone(null);
            if (selectedPhone === phone) setSelectedPhone(null);
          }}
        />
      )}
    </div>
  );
};
