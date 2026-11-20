import type {
  AuthorityLevel,
  CategorySop,
  Classification,
  ImportBackup,
  OpsDatabaseState,
  PreferredLanguage,
  TeamMember,
} from '../types/ops.ts';
import { categoryIdFromName } from './setupWizard.ts';
import { normalizeIndianPhone } from './phoneText.ts';

export const TEAM_SETUP_FORMAT = 'opscommand-team-setup';

export interface ImportPersonInput {
  name: string;
  roleTitle?: string;
  authority?: string;
  language?: string;
  shiftStart?: string;
  shiftEnd?: string;
  maxActiveTasks?: number;
  whatsapp?: string;
  whatTheyHandle?: string;
  strengths?: string[];
  weaknesses?: string[];
  reportsTo?: string | null;
  partnerOf?: string | null;
  worksCloselyWith?: string[];
}

export interface ImportTaskTypeInput {
  name: string;
  usually?: string;
  defaultResponsible?: string | null;
  backup?: string | null;
  approvalBeforeSpending?: boolean;
  steps?: string[];
}

export interface TeamSetupFile {
  format: string;
  version?: number;
  business?: string;
  notes?: string;
  people: ImportPersonInput[];
  taskTypes: ImportTaskTypeInput[];
}

export function parseTeamSetupFile(text: string): { ok: true; data: TeamSetupFile } | { ok: false; error: string } {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!raw || typeof raw !== 'object' || raw.format !== TEAM_SETUP_FORMAT) {
    return { ok: false, error: `Not a team setup file (expected format "${TEAM_SETUP_FORMAT}").` };
  }
  if (!Array.isArray(raw.people) || !Array.isArray(raw.taskTypes)) {
    return { ok: false, error: 'The file must have "people" and "taskTypes" arrays.' };
  }
  return { ok: true, data: raw as TeamSetupFile };
}

/** Lowercase + collapse internal whitespace, for case/space-insensitive name matching. */
export function normalizeName(name: unknown): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function mapAuthority(raw: unknown): AuthorityLevel {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'OWNER' || v === 'BOSS' || v === 'MANAGER' || v === 'SUPERVISOR' || v === 'STAFF') {
    return v === 'BOSS' ? 'OWNER' : (v as AuthorityLevel);
  }
  return 'STAFF';
}

export function mapLanguage(raw: unknown): PreferredLanguage {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v.startsWith('hing')) return 'HINGLISH';
  if (v.startsWith('hin')) return 'HINDI';
  if (v.startsWith('eng')) return 'ENGLISH';
  return 'ENGLISH';
}

export function mapClassification(raw: unknown): Classification {
  return String(raw ?? '').trim().toUpperCase() === 'MAJOR' ? 'MAJOR' : 'MINOR';
}

/** 10-digit Indian mobile -> "91" + digits (shared with every other save path). */
export { normalizeIndianPhone };

export function isValidIndianPhone(raw: string): boolean {
  const d = normalizeIndianPhone(raw);
  return d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2));
}

export type PersonAction = 'create' | 'update';

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface PersonPreviewRow {
  /** Index into the file's people array. */
  index: number;
  name: string;
  action: PersonAction;
  /** Phone of the matched existing member (update), else null. */
  matchedPhone: string | null;
  /** True for new people: a WhatsApp number must be entered (or the person skipped). */
  needsPhone: boolean;
  /** True when this file person maps to the signed-in OWNER account. */
  isOwnerMapping: boolean;
  changes: FieldChange[];
}

export interface TaskTypePreviewRow {
  index: number;
  name: string;
  action: PersonAction;
  categoryId: string;
  changes: FieldChange[];
}

export interface ImportProblem {
  where: string;
  message: string;
}

export interface ImportPreview {
  people: PersonPreviewRow[];
  taskTypes: TaskTypePreviewRow[];
  problems: ImportProblem[];
}

/** Finds the existing OWNER member (the signed-in account), if any. */
export function findOwnerMember(state: OpsDatabaseState): TeamMember | undefined {
  return Object.values(state.team_members || {}).find((m) => m.authorityLevel === 'OWNER');
}

/**
 * Resolves a referenced person name to an existing-or-to-be-created phone.
 * The file's OWNER person (and any reference to that name) maps to the signed-in owner account.
 */
function buildNameResolver(file: TeamSetupFile, state: OpsDatabaseState) {
  const owner = findOwnerMember(state);
  const ownerFilePerson = file.people.find((p) => mapAuthority(p.authority) === 'OWNER');
  const ownerFileNameKey = ownerFilePerson ? normalizeName(ownerFilePerson.name) : null;

  const existingByName = new Map<string, TeamMember>();
  for (const m of Object.values(state.team_members || {})) existingByName.set(normalizeName(m.name), m);

  return function resolve(rawName: unknown, phoneAssignments: Record<number, string>, skipped: Set<number>): string | null {
    const key = normalizeName(rawName);
    if (!key) return null;
    // Any reference to the owner's file-name resolves to the signed-in owner account.
    if (ownerFileNameKey && key === ownerFileNameKey && owner) return owner.phone;
    // Existing member by name.
    const existing = existingByName.get(key);
    if (existing) return existing.phone;
    // A new person being created in this import (by file index), if a phone was entered and not skipped.
    const fileIdx = file.people.findIndex((p) => normalizeName(p.name) === key);
    if (fileIdx >= 0 && !skipped.has(fileIdx)) {
      const assigned = phoneAssignments[fileIdx];
      if (assigned && isValidIndianPhone(assigned)) return normalizeIndianPhone(assigned);
    }
    return null;
  };
}

function diffPerson(existing: TeamMember, incoming: ImportPersonInput): FieldChange[] {
  const changes: FieldChange[] = [];
  const add = (field: string, from: unknown, to: unknown) => {
    const f = Array.isArray(from) ? from.join(', ') : String(from ?? '');
    const t = Array.isArray(to) ? to.join(', ') : String(to ?? '');
    if (f !== t) changes.push({ field, from: f, to: t });
  };
  add('role', existing.roleTitle, incoming.roleTitle);
  add('what they handle', existing.responsibilities, incoming.whatTheyHandle);
  add('strengths', existing.strengths || [], incoming.strengths || []);
  add('weaknesses', existing.weaknesses || [], incoming.weaknesses || []);
  add('language', existing.preferredLanguage, mapLanguage(incoming.language));
  add('shift', `${existing.workShiftStart}-${existing.workShiftEnd}`, `${incoming.shiftStart}-${incoming.shiftEnd}`);
  add('task limit', existing.maxActiveTasks, incoming.maxActiveTasks);
  // Owner authority is never downgraded; others follow the file.
  if (existing.authorityLevel !== 'OWNER') add('authority', existing.authorityLevel, mapAuthority(incoming.authority));
  return changes;
}

/**
 * Builds the preview: which people/task types are created vs updated, the changing fields,
 * which new people need a phone, and any unresolved name references (problems).
 */
export function buildImportPreview(
  file: TeamSetupFile,
  state: OpsDatabaseState,
  phoneAssignments: Record<number, string> = {},
  skipped: Set<number> = new Set()
): ImportPreview {
  const owner = findOwnerMember(state);
  const existingByName = new Map<string, TeamMember>();
  for (const m of Object.values(state.team_members || {})) existingByName.set(normalizeName(m.name), m);

  const people: PersonPreviewRow[] = file.people.map((p, index) => {
    const key = normalizeName(p.name);
    const isOwnerMapping = mapAuthority(p.authority) === 'OWNER' && !!owner;
    const matched = isOwnerMapping ? owner : existingByName.get(key);
    if (matched) {
      return {
        index,
        name: p.name,
        action: 'update',
        matchedPhone: matched.phone,
        needsPhone: false,
        isOwnerMapping,
        changes: diffPerson(matched, p),
      };
    }
    return {
      index,
      name: p.name,
      action: 'create',
      matchedPhone: null,
      needsPhone: !skipped.has(index),
      isOwnerMapping: false,
      changes: [],
    };
  });

  const existingSopByName = new Map<string, CategorySop>();
  for (const c of state.category_sops || []) existingSopByName.set(normalizeName(c.categoryName), c);

  const taskTypes: TaskTypePreviewRow[] = file.taskTypes.map((t, index) => {
    const existing = existingSopByName.get(normalizeName(t.name));
    const changes: FieldChange[] = [];
    if (existing) {
      if (existing.defaultClassification !== mapClassification(t.usually))
        changes.push({ field: 'usually', from: existing.defaultClassification, to: mapClassification(t.usually) });
      if ((existing.defaultMicroSteps || []).join(' | ') !== (t.steps || []).join(' | '))
        changes.push({ field: 'steps', from: `${(existing.defaultMicroSteps || []).length} steps`, to: `${(t.steps || []).length} steps` });
      if (Boolean(existing.spendApprovalRequired) !== Boolean(t.approvalBeforeSpending))
        changes.push({ field: 'approval before spending', from: String(Boolean(existing.spendApprovalRequired)), to: String(Boolean(t.approvalBeforeSpending)) });
      changes.push({ field: 'default / backup', from: 'current', to: 'from file (by name)' });
    }
    return {
      index,
      name: t.name,
      action: existing ? 'update' : 'create',
      categoryId: existing ? existing.categoryId : '(new)',
      changes,
    };
  });

  // --- Problems: a referenced name that matches NOBODY (not in the file, not in your team).
  //     A new person who simply has no number yet is not a problem — they resolve once added.
  const ownerFilePerson = file.people.find((p) => mapAuthority(p.authority) === 'OWNER');
  const ownerFileNameKey = ownerFilePerson ? normalizeName(ownerFilePerson.name) : null;
  const knownNames = new Set<string>();
  for (const m of Object.values(state.team_members || {})) knownNames.add(normalizeName(m.name));
  for (const p of file.people) knownNames.add(normalizeName(p.name));
  if (ownerFileNameKey && owner) knownNames.add(ownerFileNameKey);
  const isKnownName = (rawName: unknown) => knownNames.has(normalizeName(rawName));

  const problems: ImportProblem[] = [];
  const check = (rawName: unknown, where: string) => {
    if (rawName === null || rawName === undefined || String(rawName).trim() === '') return;
    if (!isKnownName(rawName)) {
      problems.push({ where, message: `"${String(rawName)}" does not match anyone in the file or your team.` });
    }
  };
  for (const p of file.people) {
    check(p.reportsTo, `${p.name} → reports to`);
    check(p.partnerOf, `${p.name} → partner of`);
    for (const w of p.worksCloselyWith || []) check(w, `${p.name} → works closely with`);
  }
  for (const t of file.taskTypes) {
    check(t.defaultResponsible, `${t.name} → default responsible`);
    check(t.backup, `${t.name} → backup`);
  }

  return { people, taskTypes, problems };
}

/** Confirm is allowed only when every new, non-skipped person has a valid phone number. */
export function canConfirmImport(
  preview: ImportPreview,
  phoneAssignments: Record<number, string>,
  skipped: Set<number>
): boolean {
  for (const row of preview.people) {
    if (row.action !== 'create') continue;
    if (skipped.has(row.index)) continue;
    if (!isValidIndianPhone(phoneAssignments[row.index] || '')) return false;
  }
  return true;
}

/** A full restore point of the parts the import can change. */
export function makeImportBackup(state: OpsDatabaseState, summary: string): ImportBackup {
  return {
    savedAt: new Date().toISOString(),
    summary,
    team_members: JSON.parse(JSON.stringify(state.team_members || {})),
    category_sops: JSON.parse(JSON.stringify(state.category_sops || [])),
    tasks: JSON.parse(JSON.stringify(state.tasks || [])),
  };
}

/** Next free slot IDs (P1, P2, ...) that existing members do not already use. */
function nextFreeSlot(used: Set<string>): string {
  let n = 1;
  while (used.has(`P${n}`)) n++;
  const slot = `P${n}`;
  used.add(slot);
  return slot;
}

export interface ImportResult {
  state: OpsDatabaseState;
  summary: string;
  counts: { peopleCreated: number; peopleUpdated: number; peopleSkipped: number; typesCreated: number; typesUpdated: number };
  backup: ImportBackup;
}

/**
 * Applies the import to a copy of the state and returns the next state, a summary, and a backup.
 * Pure: it never mutates the input. Existing tasks are never touched. Existing people keep their
 * slot IDs; new people get the next free slots. Nothing is deleted.
 */
export function applyImport(
  file: TeamSetupFile,
  state: OpsDatabaseState,
  phoneAssignments: Record<number, string>,
  skipped: Set<number>,
  actor: { email?: string } = {}
): ImportResult {
  const owner = findOwnerMember(state);
  const nowIso = new Date().toISOString();

  // Snapshot for undo (taken from the untouched input state).
  const preliminarySummary = 'Team setup import';
  const backup = makeImportBackup(state, preliminarySummary);

  const nextMembers: Record<string, TeamMember> = JSON.parse(JSON.stringify(state.team_members || {}));
  const existingByName = new Map<string, TeamMember>();
  for (const m of Object.values(nextMembers)) existingByName.set(normalizeName(m.name), m);
  const usedSlots = new Set<string>(Object.values(nextMembers).map((m) => m.slotId).filter(Boolean) as string[]);

  const resolve = buildNameResolver(file, state);

  let peopleCreated = 0;
  let peopleUpdated = 0;
  let peopleSkipped = 0;

  const defaultMaxCap = state.task_splitting_rules?.defaultMaxActiveTasksPerPerson ?? 3;

  // Pass 1: create/update people (so links can resolve to their phones in pass 2).
  file.people.forEach((p, index) => {
    const isOwnerMapping = mapAuthority(p.authority) === 'OWNER' && !!owner;
    const matched = isOwnerMapping ? owner : existingByName.get(normalizeName(p.name));

    if (!matched) {
      if (skipped.has(index) || !isValidIndianPhone(phoneAssignments[index] || '')) {
        peopleSkipped++;
        return;
      }
      const phone = normalizeIndianPhone(phoneAssignments[index]);
      if (nextMembers[phone]) {
        // Phone collided with an existing member: treat as update of that member instead of duplicating.
        peopleSkipped++;
        return;
      }
      const member: TeamMember = {
        phone,
        slotId: nextFreeSlot(usedSlots),
        name: p.name.trim(),
        roleTitle: (p.roleTitle || '').trim() || 'Team member',
        authorityLevel: mapAuthority(p.authority),
        skills: [],
        strengths: p.strengths || [],
        weaknesses: p.weaknesses || [],
        responsibilities: (p.whatTheyHandle || '').trim(),
        maxActiveTasks: typeof p.maxActiveTasks === 'number' ? p.maxActiveTasks : defaultMaxCap,
        preferredLanguage: mapLanguage(p.language),
        workShiftStart: p.shiftStart || '09:00',
        workShiftEnd: p.shiftEnd || '19:00',
        dailyOverviewTime: p.shiftStart || '09:30',
        isOnLeave: false,
        reportsToPhone: null,
        partnerOfPhone: null,
        worksCloselyWithPhones: [],
        lastInboundAt: nowIso,
        bufferMode: 'STANDARD_15_MIN',
        personaPrompt: '',
        stats: { assigned: 0, completed: 0, partial: 0, overdueCount: 0, totalWorkHoursReplyMins: 0, replyCount: 0 },
      };
      nextMembers[phone] = member;
      existingByName.set(normalizeName(member.name), member);
      peopleCreated++;
      return;
    }

    // Update: keep phone, slotId, name; never downgrade the owner's authority.
    const target = nextMembers[matched.phone];
    target.roleTitle = (p.roleTitle || '').trim() || target.roleTitle;
    target.responsibilities = (p.whatTheyHandle || '').trim();
    target.strengths = p.strengths || [];
    target.weaknesses = p.weaknesses || [];
    target.preferredLanguage = mapLanguage(p.language);
    target.workShiftStart = p.shiftStart || target.workShiftStart;
    target.workShiftEnd = p.shiftEnd || target.workShiftEnd;
    if (typeof p.maxActiveTasks === 'number') target.maxActiveTasks = p.maxActiveTasks;
    if (target.authorityLevel !== 'OWNER') target.authorityLevel = mapAuthority(p.authority);
    peopleUpdated++;
  });

  // Pass 2: resolve relationship links by name -> phone.
  file.people.forEach((p) => {
    const selfPhone = resolve(p.name, phoneAssignments, skipped);
    if (!selfPhone || !nextMembers[selfPhone]) return;
    const target = nextMembers[selfPhone];
    const reportsTo = resolve(p.reportsTo, phoneAssignments, skipped);
    const partnerOf = resolve(p.partnerOf, phoneAssignments, skipped);
    const close = (p.worksCloselyWith || [])
      .map((w) => resolve(w, phoneAssignments, skipped))
      .filter((x): x is string => Boolean(x) && x !== selfPhone);
    target.reportsToPhone = reportsTo && reportsTo !== selfPhone ? reportsTo : null;
    target.partnerOfPhone = partnerOf && partnerOf !== selfPhone ? partnerOf : null;
    target.worksCloselyWithPhones = Array.from(new Set(close));
  });

  // Task types: update by name, create missing; never delete.
  const nextSops: CategorySop[] = JSON.parse(JSON.stringify(state.category_sops || []));
  const sopIndexByName = new Map<string, number>();
  nextSops.forEach((c, i) => sopIndexByName.set(normalizeName(c.categoryName), i));
  const takenIds = new Set<string>(nextSops.map((c) => c.categoryId));
  let typesCreated = 0;
  let typesUpdated = 0;

  for (const t of file.taskTypes) {
    const defPhone = resolve(t.defaultResponsible, phoneAssignments, skipped);
    const backupPhone = resolve(t.backup, phoneAssignments, skipped);
    const idx = sopIndexByName.get(normalizeName(t.name));
    if (idx !== undefined) {
      const sop = nextSops[idx];
      sop.categoryName = t.name.trim();
      sop.defaultClassification = mapClassification(t.usually);
      sop.defaultMicroSteps = (t.steps || []).map((s) => s.trim()).filter(Boolean);
      sop.defaultResponsiblePhone = defPhone;
      sop.backupResponsiblePhone = backupPhone && backupPhone !== defPhone ? backupPhone : null;
      sop.spendApprovalRequired = Boolean(t.approvalBeforeSpending);
      typesUpdated++;
    } else {
      const categoryId = categoryIdFromName(t.name, takenIds);
      nextSops.push({
        tenantId: state.tenantId,
        categoryId,
        categoryName: t.name.trim(),
        defaultClassification: mapClassification(t.usually),
        sopSystemPrompt: '',
        defaultMicroSteps: (t.steps || []).map((s) => s.trim()).filter(Boolean),
        defaultResponsiblePhone: defPhone,
        backupResponsiblePhone: backupPhone && backupPhone !== defPhone ? backupPhone : null,
        spendApprovalRequired: Boolean(t.approvalBeforeSpending),
      });
      typesCreated++;
    }
  }

  const summary = `Created ${peopleCreated} ${peopleCreated === 1 ? 'person' : 'people'}, updated ${peopleUpdated}, created ${typesCreated} task type${typesCreated === 1 ? '' : 's'}, updated ${typesUpdated}${
    peopleSkipped > 0 ? ` (${peopleSkipped} skipped)` : ''
  }.`;
  backup.summary = summary;

  const nextState: OpsDatabaseState = {
    ...state,
    team_members: nextMembers,
    category_sops: nextSops,
    tasks: state.tasks, // existing tasks are never changed by an import
    last_import_backup: backup,
  };

  return {
    state: nextState,
    summary,
    counts: { peopleCreated, peopleUpdated, peopleSkipped, typesCreated, typesUpdated },
    backup,
  };
}

/** Restores the people, task types and tasks captured in a backup (for "Undo last import"). */
export function restoreImportBackup(state: OpsDatabaseState, backup: ImportBackup): OpsDatabaseState {
  return {
    ...state,
    team_members: JSON.parse(JSON.stringify(backup.team_members || {})),
    category_sops: JSON.parse(JSON.stringify(backup.category_sops || [])),
    tasks: JSON.parse(JSON.stringify(backup.tasks || [])),
    last_import_backup: null,
  };
}
