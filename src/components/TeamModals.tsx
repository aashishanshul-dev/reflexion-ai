import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Lock,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import {
  AuthorityLevel,
  CategorySop,
  PreferredLanguage,
  Task,
  TeamMember,
} from '../types/ops';
import {
  checkReportsToChange,
  getPersonSopAssignments,
  getSymmetricClosePeerPhones,
  getSymmetricPartnerPhone,
  openTasksForPhone,
  RemovePlan,
  SopRoleReplacement,
} from '../lib/teamGraph';
import { normalizeIndianPhone } from '../lib/phoneText';
import { authorityLabel, languageLabel } from '../lib/plainLabels';

const AUTHORITY_OPTIONS: AuthorityLevel[] = [
  'OWNER',
  'BOSS',
  'MANAGER',
  'SUPERVISOR',
  'STAFF',
];
const LANGUAGE_OPTIONS: PreferredLanguage[] = ['HINGLISH', 'HINDI', 'ENGLISH'];

function splitPhrases(text: string): string[] {
  return String(text || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* Person Side Panel                                                          */
/* -------------------------------------------------------------------------- */

export interface PersonSidePanelProps {
  member: TeamMember;
  allMembers: TeamMember[];
  membersMap: Record<string, TeamMember>;
  categorySops: CategorySop[];
  tasks: Task[];
  onClose: () => void;
  onSaveProfile: (updated: TeamMember) => void;
  onRequestRemove: (member: TeamMember) => void;
  onOpenSopEditor?: (categoryId?: string) => void;
}

export const PersonSidePanel: React.FC<PersonSidePanelProps> = ({
  member,
  allMembers,
  membersMap,
  categorySops,
  tasks,
  onClose,
  onSaveProfile,
  onRequestRemove,
  onOpenSopEditor,
}) => {
  const [name, setName] = useState(member.name);
  const [roleTitle, setRoleTitle] = useState(member.roleTitle);
  const [authorityLevel, setAuthorityLevel] = useState<AuthorityLevel>(
    member.authorityLevel
  );
  const [preferredLanguage, setPreferredLanguage] = useState<PreferredLanguage>(
    member.preferredLanguage
  );
  const [workShiftStart, setWorkShiftStart] = useState(member.workShiftStart);
  const [workShiftEnd, setWorkShiftEnd] = useState(member.workShiftEnd);
  const [maxActiveTasks, setMaxActiveTasks] = useState<number>(
    member.maxActiveTasks ?? 3
  );
  const [isOnLeave, setIsOnLeave] = useState(Boolean(member.isOnLeave));
  const [responsibilities, setResponsibilities] = useState(member.responsibilities || '');
  const [strengthsText, setStrengthsText] = useState((member.strengths || []).join(', '));
  const [weaknessesText, setWeaknessesText] = useState(
    (member.weaknesses || []).join(', ')
  );
  const [reportsToPhone, setReportsToPhone] = useState<string>(
    member.reportsToPhone || ''
  );
  const [partnerOfPhone, setPartnerOfPhone] = useState<string>(() =>
    getSymmetricPartnerPhone(member.phone, membersMap) || ''
  );
  const [worksCloselyWithPhones, setWorksCloselyWithPhones] = useState<string[]>(() =>
    getSymmetricClosePeerPhones(member.phone, membersMap)
  );

  // Manager change confirmation state when replacing an existing manager
  const [pendingManagerConfirm, setPendingManagerConfirm] = useState<{
    newPhone: string;
    currentManagerName: string;
    newManagerName: string;
  } | null>(null);
  const [managerError, setManagerError] = useState('');

  // Re-sync draft form whenever selected member changes or external graph link updates occur
  useEffect(() => {
    setName(member.name);
    setRoleTitle(member.roleTitle);
    setAuthorityLevel(member.authorityLevel);
    setPreferredLanguage(member.preferredLanguage);
    setWorkShiftStart(member.workShiftStart);
    setWorkShiftEnd(member.workShiftEnd);
    setMaxActiveTasks(member.maxActiveTasks ?? 3);
    setIsOnLeave(Boolean(member.isOnLeave));
    setResponsibilities(member.responsibilities || '');
    setStrengthsText((member.strengths || []).join(', '));
    setWeaknessesText((member.weaknesses || []).join(', '));
    setReportsToPhone(member.reportsToPhone || '');
    setPartnerOfPhone(getSymmetricPartnerPhone(member.phone, membersMap) || '');
    setWorksCloselyWithPhones(getSymmetricClosePeerPhones(member.phone, membersMap));
    setPendingManagerConfirm(null);
    setManagerError('');
  }, [member, membersMap]);

  const others = useMemo(
    () => allMembers.filter((m) => m.phone !== member.phone),
    [allMembers, member.phone]
  );

  const openTaskCount = useMemo(
    () => openTasksForPhone(member.phone, tasks).length,
    [member.phone, tasks]
  );

  const sopAssignments = useMemo(
    () => getPersonSopAssignments(member.phone, categorySops),
    [member.phone, categorySops]
  );

  const handleManagerDropdownChange = (nextMgr: string) => {
    setManagerError('');
    setPendingManagerConfirm(null);
    if (!nextMgr) {
      setReportsToPhone('');
      return;
    }
    const validation = checkReportsToChange(membersMap, member.phone, nextMgr);
    if (!validation.ok) {
      setManagerError(validation.message);
      return;
    }
    if (validation.kind === 'REPLACE' && nextMgr !== (member.reportsToPhone || '')) {
      setPendingManagerConfirm({
        newPhone: nextMgr,
        currentManagerName: validation.currentManagerName,
        newManagerName: membersMap[nextMgr]?.name || nextMgr,
      });
      return;
    }
    setReportsToPhone(nextMgr);
  };

  const toggleClosePeer = (peerPhone: string) => {
    setWorksCloselyWithPhones((prev) =>
      prev.includes(peerPhone)
        ? prev.filter((p) => p !== peerPhone)
        : [...prev, peerPhone]
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (reportsToPhone) {
      const check = checkReportsToChange(membersMap, member.phone, reportsToPhone);
      if (!check.ok) {
        setManagerError(check.message);
        return;
      }
    }
    onSaveProfile({
      ...member,
      name: name.trim(),
      roleTitle: roleTitle.trim() || 'Team member',
      authorityLevel,
      preferredLanguage,
      workShiftStart: workShiftStart || '09:00',
      workShiftEnd: workShiftEnd || '18:00',
      maxActiveTasks: Math.max(1, Math.min(25, Number(maxActiveTasks) || 3)),
      isOnLeave,
      responsibilities: responsibilities.trim(),
      strengths: splitPhrases(strengthsText),
      weaknesses: splitPhrases(weaknessesText),
      reportsToPhone: reportsToPhone || null,
      partnerOfPhone: partnerOfPhone || null,
      worksCloselyWithPhones,
    });
  };

  return (
    <aside
      aria-label={`Edit ${member.name}`}
      className="flex flex-col rounded-2xl border border-hairline bg-surface shadow-[var(--shadow-card)] overflow-hidden h-full max-h-[82vh] md:max-h-[760px]"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-hairline bg-paper/60 px-4 py-3.5 shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-bold text-ink font-display">
              {member.name}
            </h2>
          </div>
          <p className="mt-0.5 truncate text-xs text-slate">
            +{member.phone} &middot; {openTaskCount} active task{openTaskCount === 1 ? '' : 's'}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close side panel"
          onClick={onClose}
          className="rounded-lg p-1 text-slate hover:bg-surface hover:text-ink transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable Editor Form */}
      <form
        onSubmit={handleSubmit}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-xs"
      >
        {/* Status / On leave quick switch */}
        <label className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-paper px-3 py-2.5 cursor-pointer">
          <div>
            <div className="font-semibold text-ink">On leave today</div>
            <div className="text-[11px] text-slate">
              Pauses automatic new task assignments
            </div>
          </div>
          <input
            type="checkbox"
            checked={isOnLeave}
            onChange={(e) => setIsOnLeave(e.target.checked)}
            className="h-4 w-4 accent-signal rounded"
          />
        </label>

        {/* Identity */}
        <div className="grid grid-cols-1 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Full name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Role
            </label>
            <input
              type="text"
              required
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Authority
            </label>
            <select
              value={authorityLevel}
              onChange={(e) => setAuthorityLevel(e.target.value as AuthorityLevel)}
              className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
            >
              {AUTHORITY_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {authorityLabel(a)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Language
            </label>
            <select
              value={preferredLanguage}
              onChange={(e) => setPreferredLanguage(e.target.value as PreferredLanguage)}
              className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink focus:border-signal focus:outline-none"
            >
              {LANGUAGE_OPTIONS.map((l) => (
                <option key={l} value={l}>
                  {languageLabel(l)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Shift start
            </label>
            <input
              type="time"
              value={workShiftStart}
              onChange={(e) => setWorkShiftStart(e.target.value)}
              className="w-full rounded-lg border border-hairline-strong bg-paper px-2 py-1.5 text-xs text-ink tabular-nums"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Shift end
            </label>
            <input
              type="time"
              value={workShiftEnd}
              onChange={(e) => setWorkShiftEnd(e.target.value)}
              className="w-full rounded-lg border border-hairline-strong bg-paper px-2 py-1.5 text-xs text-ink tabular-nums"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Task limit
            </label>
            <input
              type="number"
              min={1}
              max={25}
              value={maxActiveTasks}
              onChange={(e) => setMaxActiveTasks(Math.max(1, Number(e.target.value) || 1))}
              className="w-full rounded-lg border border-hairline-strong bg-paper px-2.5 py-1.5 text-xs font-semibold text-ink tabular-nums"
            />
          </div>
        </div>

        {/* Reporting & Peer Connections */}
        <div className="space-y-3 pt-1 border-t border-hairline">
          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Who they report to
            </label>
            <select
              value={reportsToPhone}
              onChange={(e) => handleManagerDropdownChange(e.target.value)}
              className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
            >
              <option value="">No one (top level)</option>
              {others.map((o) => (
                <option key={o.phone} value={o.phone}>
                  {o.name} — {o.roleTitle}
                </option>
              ))}
            </select>

            {managerError && (
              <div className="mt-1.5 rounded-lg border border-danger-border bg-danger-soft px-2.5 py-1.5 text-[11px] text-danger flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{managerError}</span>
              </div>
            )}

            {pendingManagerConfirm && (
              <div className="mt-2 rounded-xl border border-warn-border bg-warn-soft p-2.5 text-[11px] text-ink space-y-2">
                <div className="font-semibold">
                  Replace {pendingManagerConfirm.currentManagerName} with{' '}
                  {pendingManagerConfirm.newManagerName} as {name || member.name}&apos;s
                  manager?
                </div>
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPendingManagerConfirm(null)}
                    className="rounded-md border border-hairline-strong bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-paper"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReportsToPhone(pendingManagerConfirm.newPhone);
                      setPendingManagerConfirm(null);
                    }}
                    className="rounded-md bg-ink px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-ink-hover"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Partner (two-way)
            </label>
            <select
              value={partnerOfPhone}
              onChange={(e) => setPartnerOfPhone(e.target.value)}
              className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
            >
              <option value="">None</option>
              {others.map((o) => (
                <option key={o.phone} value={o.phone}>
                  {o.name} — {o.roleTitle}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-ink mb-1">
              Works closely with (two-way)
            </div>
            {others.length === 0 ? (
              <p className="text-[11px] text-slate">Add another person first.</p>
            ) : (
              <div className="max-h-28 overflow-y-auto rounded-xl border border-hairline bg-paper p-2 space-y-1">
                {others.map((o) => (
                  <label
                    key={o.phone}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={worksCloselyWithPhones.includes(o.phone)}
                      onChange={() => toggleClosePeer(o.phone)}
                      className="h-3.5 w-3.5 accent-signal rounded"
                    />
                    <span className="truncate text-ink font-medium">{o.name}</span>
                    <span className="truncate text-[11px] text-slate">{o.roleTitle}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Capabilities & Private Weaknesses */}
        <div className="space-y-3 pt-1 border-t border-hairline">
          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              What they handle
            </label>
            <textarea
              rows={2}
              value={responsibilities}
              onChange={(e) => setResponsibilities(e.target.value)}
              placeholder="e.g. Vendor coordination, daily floor checks, urgent dispatches"
              className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Strengths
            </label>
            <input
              type="text"
              value={strengthsText}
              onChange={(e) => setStrengthsText(e.target.value)}
              placeholder="Comma separated skills or strengths"
              className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
            />
          </div>

          <div className="rounded-xl border border-warn-border bg-warn-soft/50 p-3 space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-warn">
              <Lock className="h-3 w-3 shrink-0" />
              Weaknesses / caution areas (private)
            </label>
            <p className="text-[11px] text-slate">
              Shown only in this side panel &amp; used by AI routing. Never displayed on team cards.
            </p>
            <input
              type="text"
              value={weaknessesText}
              onChange={(e) => setWeaknessesText(e.target.value)}
              placeholder="e.g. Needs reminders on paperwork deadlines"
              className="w-full rounded-lg border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink focus:border-signal focus:outline-none"
            />
          </div>
        </div>

        {/* Task-Type SOP Ownership */}
        <div className="pt-2 border-t border-hairline space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-ink">Task-type ownership</span>
            {onOpenSopEditor && (
              <button
                type="button"
                onClick={() => onOpenSopEditor(sopAssignments[0]?.categoryId)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-signal hover:text-signal-hover"
              >
                <BookOpen className="h-3 w-3" />
                Edit in AI Brain &amp; Setup
              </button>
            )}
          </div>
          {sopAssignments.length === 0 ? (
            <p className="text-[11px] text-slate">
              Not assigned as default owner or backup on any task type.
            </p>
          ) : (
            <div className="space-y-1.5">
              {sopAssignments.map((a) => (
                <div
                  key={`${a.categoryId}-${a.role}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-paper px-2.5 py-1.5"
                >
                  <span className="truncate font-medium text-ink">{a.categoryName}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold border ${
                        a.role === 'DEFAULT'
                          ? 'bg-ok-soft text-ok border-ok-border'
                          : 'bg-warn-soft text-warn border-warn-border'
                      }`}
                    >
                      {a.role === 'DEFAULT' ? 'Default owner' : 'Backup'}
                    </span>
                    {onOpenSopEditor && (
                      <button
                        type="button"
                        onClick={() => onOpenSopEditor(a.categoryId)}
                        className="text-[11px] font-semibold text-signal hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 pt-3 border-t border-hairline">
          <button
            type="button"
            onClick={() => onRequestRemove(member)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-xs font-semibold text-danger hover:bg-danger-border/30 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove person
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink-hover disabled:opacity-45 transition-colors"
          >
            Save changes
          </button>
        </div>
      </form>
    </aside>
  );
};

/* -------------------------------------------------------------------------- */
/* + Add Person Modal                                                         */
/* -------------------------------------------------------------------------- */

export interface AddPersonModalProps {
  existingMembers: TeamMember[];
  existingPhones: Set<string>;
  defaultLimit: number;
  onClose: () => void;
  onCreate: (member: TeamMember) => void;
}

export const AddPersonModal: React.FC<AddPersonModalProps> = ({
  existingMembers,
  existingPhones,
  defaultLimit,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [preferredLanguage, setPreferredLanguage] =
    useState<PreferredLanguage>('HINGLISH');
  const [workShiftStart, setWorkShiftStart] = useState('09:00');
  const [workShiftEnd, setWorkShiftEnd] = useState('19:00');
  const [maxActiveTasks, setMaxActiveTasks] = useState(defaultLimit || 3);
  const [authorityLevel, setAuthorityLevel] = useState<AuthorityLevel>('STAFF');
  const [reportsToPhone, setReportsToPhone] = useState('');
  const [responsibilities, setResponsibilities] = useState('');
  const [strengthsText, setStrengthsText] = useState('');
  const [weaknessesText, setWeaknessesText] = useState('');
  const [error, setError] = useState('');

  const normalizedPreview = normalizeIndianPhone(phoneInput);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPhone = normalizeIndianPhone(phoneInput);
    if (!name.trim()) {
      setError('Enter a full name.');
      return;
    }
    if (!roleTitle.trim()) {
      setError('Enter a role title.');
      return;
    }
    if (!cleanPhone || cleanPhone.length < 10) {
      setError('Enter a valid 10-digit WhatsApp mobile number.');
      return;
    }
    if (existingPhones.has(cleanPhone)) {
      setError(`Someone with WhatsApp number +${cleanPhone} is already on the team.`);
      return;
    }

    const member: TeamMember = {
      phone: cleanPhone,
      slotId: '',
      name: name.trim(),
      roleTitle: roleTitle.trim(),
      authorityLevel,
      skills: [],
      responsibilities: responsibilities.trim(),
      strengths: splitPhrases(strengthsText),
      weaknesses: splitPhrases(weaknessesText),
      reportsToPhone: reportsToPhone || null,
      partnerOfPhone: null,
      worksCloselyWithPhones: [],
      maxActiveTasks: Math.max(1, Math.min(25, Number(maxActiveTasks) || 3)),
      preferredLanguage,
      workShiftStart: workShiftStart || '09:00',
      workShiftEnd: workShiftEnd || '19:00',
      dailyOverviewTime: '09:00',
      isOnLeave: false,
      lastInboundAt: new Date().toISOString(),
      bufferMode: 'STANDARD_15_MIN',
      stats: {
        assigned: 0,
        completed: 0,
        partial: 0,
        overdueCount: 0,
        totalWorkHoursReplyMins: 0,
        replyCount: 0,
      },
    };
    onCreate(member);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add person to team"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
    >
      <div className="w-full max-w-lg rounded-2xl border border-hairline bg-surface shadow-[var(--shadow-modal)] overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-signal" />
            <h2 className="text-base font-bold text-ink font-display">Add person</h2>
          </div>
          <button
            type="button"
            aria-label="Close add person modal"
            onClick={onClose}
            className="rounded-lg p-1 text-slate hover:bg-paper hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto p-5 space-y-3.5 text-xs">
          {error && (
            <div className="rounded-xl border border-danger-border bg-danger-soft p-3 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Name *
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Priya Nair"
                className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Role *
              </label>
              <input
                type="text"
                required
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                placeholder="e.g. Procurement Lead"
                className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                WhatsApp number *
              </label>
              <input
                type="tel"
                required
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="10-digit mobile or 91XXXXXXXXXX"
                className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none tabular-nums"
              />
              {phoneInput.trim().length > 0 && (
                <div className="mt-1 text-[10px] text-slate tabular-nums">
                  Stored as: +{normalizedPreview || '—'}
                </div>
              )}
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Who they report to
              </label>
              <select
                value={reportsToPhone}
                onChange={(e) => setReportsToPhone(e.target.value)}
                className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink focus:border-signal focus:outline-none"
              >
                <option value="">No one (top level)</option>
                {existingMembers.map((m) => (
                  <option key={m.phone} value={m.phone}>
                    {m.name} — {m.roleTitle}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            <div className="col-span-1 sm:col-span-1">
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Language
              </label>
              <select
                value={preferredLanguage}
                onChange={(e) =>
                  setPreferredLanguage(e.target.value as PreferredLanguage)
                }
                className="w-full rounded-lg border border-hairline-strong bg-surface px-2 py-2 text-xs text-ink"
              >
                {LANGUAGE_OPTIONS.map((l) => (
                  <option key={l} value={l}>
                    {languageLabel(l)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Shift start
              </label>
              <input
                type="time"
                value={workShiftStart}
                onChange={(e) => setWorkShiftStart(e.target.value)}
                className="w-full rounded-lg border border-hairline-strong bg-paper px-2 py-2 text-xs text-ink tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Shift end
              </label>
              <input
                type="time"
                value={workShiftEnd}
                onChange={(e) => setWorkShiftEnd(e.target.value)}
                className="w-full rounded-lg border border-hairline-strong bg-paper px-2 py-2 text-xs text-ink tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Task limit
              </label>
              <input
                type="number"
                min={1}
                max={25}
                value={maxActiveTasks}
                onChange={(e) => setMaxActiveTasks(Math.max(1, Number(e.target.value) || 3))}
                className="w-full rounded-lg border border-hairline-strong bg-paper px-2.5 py-2 text-xs text-ink tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Authority
              </label>
              <select
                value={authorityLevel}
                onChange={(e) => setAuthorityLevel(e.target.value as AuthorityLevel)}
                className="w-full rounded-lg border border-hairline-strong bg-surface px-2 py-2 text-xs text-ink"
              >
                {AUTHORITY_OPTIONS.map((a) => (
                  <option key={a} value={a}>
                    {authorityLabel(a)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              What they handle
            </label>
            <textarea
              rows={2}
              value={responsibilities}
              onChange={(e) => setResponsibilities(e.target.value)}
              placeholder="e.g. Vendor quotes, spare parts ordering, daily shift checklists"
              className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Strengths
              </label>
              <input
                type="text"
                value={strengthsText}
                onChange={(e) => setStrengthsText(e.target.value)}
                placeholder="Comma separated"
                className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink mb-1">
                Weaknesses (private)
              </label>
              <input
                type="text"
                value={weaknessesText}
                onChange={(e) => setWeaknessesText(e.target.value)}
                placeholder="Shown only to you & AI"
                className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-xs text-ink focus:border-signal focus:bg-surface focus:outline-none"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-hairline">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-hairline-strong bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-paper"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink-hover"
            >
              Add person
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Remove Person Modal (Open Tasks + Explicit SOP Replacements)               */
/* -------------------------------------------------------------------------- */

export interface RemovePersonModalProps {
  member: TeamMember;
  allMembers: TeamMember[];
  tasks: Task[];
  categorySops: CategorySop[];
  onClose: () => void;
  onConfirmRemove: (
    phone: string,
    plan: RemovePlan,
    sopReplacements: Record<string, SopRoleReplacement>
  ) => void;
}

export const RemovePersonModal: React.FC<RemovePersonModalProps> = ({
  member,
  allMembers,
  tasks,
  categorySops,
  onClose,
  onConfirmRemove,
}) => {
  const remainingMembers = useMemo(
    () => allMembers.filter((m) => m.phone !== member.phone),
    [allMembers, member.phone]
  );
  const openTasks = useMemo(
    () => openTasksForPhone(member.phone, tasks),
    [member.phone, tasks]
  );
  const sopAssignments = useMemo(
    () => getPersonSopAssignments(member.phone, categorySops),
    [member.phone, categorySops]
  );

  // Open task decision: default undefined if open tasks exist so boss makes explicit choice
  const [taskMode, setTaskMode] = useState<'REASSIGN' | 'CANCEL' | ''>(() =>
    openTasks.length === 0 ? '' : remainingMembers.length > 0 ? 'REASSIGN' : 'CANCEL'
  );
  const [reassignTarget, setReassignTarget] = useState<string>(
    remainingMembers[0]?.phone || ''
  );

  // Explicit per-SOP replacement map keyed by `${categoryId}:${role}` -> undefined (unpicked) | '' (no owner) | phone
  const [sopChoices, setSopChoices] = useState<Record<string, string | undefined>>({});

  const allSopsChosen = sopAssignments.every(
    (a) => sopChoices[`${a.categoryId}:${a.role}`] !== undefined
  );
  const tasksChosen =
    openTasks.length === 0 ||
    taskMode === 'CANCEL' ||
    (taskMode === 'REASSIGN' && Boolean(reassignTarget));

  const canConfirm = tasksChosen && allSopsChosen;

  const handleConfirm = () => {
    if (!canConfirm) return;
    const plan: RemovePlan =
      openTasks.length === 0
        ? { kind: 'DIRECT' }
        : taskMode === 'CANCEL'
          ? { kind: 'CANCEL' }
          : { kind: 'REASSIGN', targetPhone: reassignTarget };

    const sopReplacements: Record<string, SopRoleReplacement> = {};
    for (const a of sopAssignments) {
      const picked = sopChoices[`${a.categoryId}:${a.role}`] ?? '';
      const entry = sopReplacements[a.categoryId] || {};
      if (a.role === 'DEFAULT') {
        entry.defaultResponsiblePhone = picked || null;
      } else {
        entry.backupResponsiblePhone = picked || null;
      }
      sopReplacements[a.categoryId] = entry;
    }
    onConfirmRemove(member.phone, plan, sopReplacements);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Remove ${member.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
    >
      <div className="w-full max-w-lg rounded-2xl border border-hairline bg-surface shadow-[var(--shadow-modal)] overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-ink font-display">
              Remove {member.name}?
            </h2>
            <p className="text-xs text-slate mt-0.5">
              Handle active work and task-type ownership cleanly before removing from the
              roster.
            </p>
          </div>
          <button
            type="button"
            aria-label="Cancel removal"
            onClick={onClose}
            className="rounded-lg p-1 text-slate hover:bg-paper hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-5 text-xs">
          {/* Step 1: Open Tasks */}
          <div className="space-y-2.5">
            <div className="font-bold text-ink">1. Open tasks ({openTasks.length})</div>
            {openTasks.length === 0 ? (
              <div className="rounded-xl border border-hairline bg-paper px-3 py-2.5 text-slate">
                {member.name} has no open tasks right now.
              </div>
            ) : (
              <div className="rounded-xl border border-hairline bg-paper p-3 space-y-2.5">
                {remainingMembers.length > 0 && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="remove-task-mode"
                      checked={taskMode === 'REASSIGN'}
                      onChange={() => setTaskMode('REASSIGN')}
                      className="accent-signal"
                    />
                    <span className="font-medium text-ink">
                      Reassign all {openTasks.length} open task(s) to
                    </span>
                  </label>
                )}
                {taskMode === 'REASSIGN' && remainingMembers.length > 0 && (
                  <select
                    aria-label="Reassign open tasks to"
                    value={reassignTarget}
                    onChange={(e) => setReassignTarget(e.target.value)}
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink"
                  >
                    {remainingMembers.map((m) => (
                      <option key={m.phone} value={m.phone}>
                        {m.name} — {m.roleTitle}
                      </option>
                    ))}
                  </select>
                )}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="remove-task-mode"
                    checked={taskMode === 'CANCEL'}
                    onChange={() => setTaskMode('CANCEL')}
                    className="accent-signal"
                  />
                  <span className="font-medium text-ink">
                    Cancel all {openTasks.length} open task(s)
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* Step 2: Task-type SOP ownership / backups */}
          <div className="space-y-2.5">
            <div className="font-bold text-ink">
              2. Task-type ownership &amp; backups ({sopAssignments.length})
            </div>
            {sopAssignments.length === 0 ? (
              <div className="rounded-xl border border-hairline bg-paper px-3 py-2.5 text-slate">
                Not listed as default owner or backup on any task type.
              </div>
            ) : (
              <div className="space-y-2">
                {sopAssignments.map((a) => {
                  const key = `${a.categoryId}:${a.role}`;
                  const val = sopChoices[key];
                  return (
                    <div
                      key={key}
                      className="rounded-xl border border-hairline bg-paper p-3 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-ink">{a.categoryName}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold border ${
                            a.role === 'DEFAULT'
                              ? 'bg-ok-soft text-ok border-ok-border'
                              : 'bg-warn-soft text-warn border-warn-border'
                          }`}
                        >
                          {a.role === 'DEFAULT' ? 'Default owner' : 'Backup'}
                        </span>
                      </div>
                      <select
                        aria-label={`Replacement for ${a.categoryName} ${a.role.toLowerCase()}`}
                        value={val ?? '__UNPICKED__'}
                        onChange={(e) => {
                          const v = e.target.value;
                          setSopChoices((prev) => ({
                            ...prev,
                            [key]: v === '__UNPICKED__' ? undefined : v,
                          }));
                        }}
                        className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs text-ink"
                      >
                        <option value="__UNPICKED__">Choose replacement...</option>
                        <option value="">
                          No {a.role === 'DEFAULT' ? 'owner' : 'backup'} (leave unassigned)
                        </option>
                        {remainingMembers.map((m) => (
                          <option key={m.phone} value={m.phone}>
                            {m.name} — {m.roleTitle}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-hairline-strong bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-paper"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={handleConfirm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-danger-solid px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove {member.name}
          </button>
        </div>
      </div>
    </div>
  );
};
