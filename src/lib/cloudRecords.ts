/**
 * Milestone 5A — one Firestore document per record under tenants/{tenantId}/{collection}/{id}.
 *
 * Pure helpers (no Firebase imports) shared by the browser store and the server tick:
 * split the workspace state into records, rebuild it, diff two states, and detect
 * version conflicts so a stale tab cannot overwrite newer changes.
 */
import type { OpsDatabaseState } from '../types/ops.ts';

export type CloudCollection =
  | 'settings'
  | 'members'
  | 'tasks'
  | 'wbsHeads'
  | 'agendas'
  | 'reviews'
  | 'buffers'
  | 'messages'
  | 'notes'
  | 'memory'
  | 'aiLogs';

export const CLOUD_COLLECTIONS: CloudCollection[] = [
  'settings',
  'members',
  'tasks',
  'wbsHeads',
  'agendas',
  'reviews',
  'buffers',
  'messages',
  'notes',
  'memory',
  'aiLogs',
];

/** The single settings document. */
export const SETTINGS_DOC_ID = 'workspace';

/** Fields the store adds to every stored record (never part of the app state). */
export const RECORD_META_FIELDS = ['tenantId', 'version', 'updatedAt', 'updatedBySession'] as const;

export interface CloudRecord {
  collection: CloudCollection;
  /** Firestore-safe document id. */
  id: string;
  /** The record payload (always carries tenantId). */
  data: Record<string, unknown>;
}

export interface RecordChange {
  collection: CloudCollection;
  id: string;
  /** New payload, or null when the record was deleted. */
  data: Record<string, unknown> | null;
  kind: 'create' | 'update' | 'delete';
}

export interface WorkspaceSettings {
  business_profile: OpsDatabaseState['business_profile'];
  owner_profile: OpsDatabaseState['owner_profile'];
  task_splitting_rules: OpsDatabaseState['task_splitting_rules'];
  principal_prompts: OpsDatabaseState['principal_prompts'];
  model_tuning: OpsDatabaseState['model_tuning'];
  category_sops: OpsDatabaseState['category_sops'];
  sample_brain_dumps: OpsDatabaseState['sample_brain_dumps'];
  last_import_backup?: OpsDatabaseState['last_import_backup'];
  setupComplete: boolean;
}

/** Firestore ids cannot contain "/" (and must not be "." or ".."). */
export function toSafeDocId(id: string): string {
  const clean = String(id ?? '').replace(/\//g, '_').trim();
  if (!clean || clean === '.' || clean === '..') return `id_${encodeURIComponent(String(id))}`;
  return clean.slice(0, 1400);
}

/** Removes undefined values (Firestore rejects them) and functions; keeps nulls. */
export function toPlainData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

/** Drops media bytes from buffers; only metadata and text are stored. */
function stripBufferMedia(buffer: OpsDatabaseState['inbound_message_buffer'][string]) {
  return {
    ...buffer,
    messages: (buffer.messages || []).map((m: any) => {
      const { base64Data: _bytes, ...rest } = m || {};
      return rest;
    }),
  };
}

/** Splits the workspace state into one record per item (every record carries tenantId). */
export function stateToRecords(
  state: OpsDatabaseState,
  tenantId: string,
  options: { setupComplete?: boolean } = {}
): CloudRecord[] {
  const rec = (collection: CloudCollection, id: string, payload: object): CloudRecord => ({
    collection,
    id: toSafeDocId(id),
    data: toPlainData({ ...payload, tenantId }) as Record<string, unknown>,
  });
  const settings: WorkspaceSettings = {
    business_profile: state.business_profile,
    owner_profile: state.owner_profile,
    task_splitting_rules: state.task_splitting_rules,
    principal_prompts: state.principal_prompts,
    model_tuning: state.model_tuning,
    category_sops: state.category_sops,
    sample_brain_dumps: state.sample_brain_dumps,
    last_import_backup: state.last_import_backup ?? null,
    setupComplete: options.setupComplete ?? true,
  };
  return [
    rec('settings', SETTINGS_DOC_ID, settings),
    ...Object.values(state.team_members || {}).map((m) => rec('members', m.phone, m)),
    ...(state.tasks || []).map((t) => rec('tasks', t.taskCode, t)),
    ...(state.wbs_heads || []).map((h) => rec('wbsHeads', h.headId, h)),
    ...(state.umbrella_agendas || []).map((a) => rec('agendas', a.agendaId, a)),
    ...(state.boss_review_queue || []).map((r) => rec('reviews', r.reviewId, r)),
    ...Object.entries(state.inbound_message_buffer || {}).map(([phone, b]) =>
      rec('buffers', phone, stripBufferMedia(b))
    ),
    ...(state.whatsapp_messages || []).map((m) => rec('messages', m.id, m)),
    ...(state.notes || []).map((n) => rec('notes', n.noteId, n)),
    ...(state.system_memory || []).map((r) => rec('memory', r.memoryId, r)),
    ...(state.ai_logs || []).map((l) => rec('aiLogs', l.logId, l)),
  ];
}

function stripMeta(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const f of RECORD_META_FIELDS) {
    if (f !== 'tenantId') delete out[f];
  }
  return out;
}

const byTime = (field: string) => (a: any, b: any) => String(a?.[field] || '').localeCompare(String(b?.[field] || ''));

/**
 * Rebuilds the workspace from stored records. Returns `settings: null` when the workspace
 * has no settings yet (a brand-new tenant, which goes through first-run setup).
 */
export function recordsToState(
  records: CloudRecord[],
  tenantId: string
): { state: OpsDatabaseState | null; setupComplete: boolean } {
  const by = (c: CloudCollection) => records.filter((r) => r.collection === c).map((r) => stripMeta(r.data));
  const settingsRaw = by('settings')[0] as unknown as WorkspaceSettings | undefined;
  if (!settingsRaw) return { state: null, setupComplete: false };

  const state: OpsDatabaseState = {
    tenantId,
    business_profile: settingsRaw.business_profile,
    owner_profile: settingsRaw.owner_profile,
    task_splitting_rules: settingsRaw.task_splitting_rules,
    principal_prompts: settingsRaw.principal_prompts,
    model_tuning: settingsRaw.model_tuning,
    category_sops: settingsRaw.category_sops || [],
    sample_brain_dumps: settingsRaw.sample_brain_dumps || [],
    last_import_backup: settingsRaw.last_import_backup ?? null,
    team_members: Object.fromEntries(by('members').map((m: any) => [m.phone, m])),
    tasks: by('tasks') as any,
    wbs_heads: by('wbsHeads') as any,
    umbrella_agendas: by('agendas').sort(byTime('createdAt')) as any,
    boss_review_queue: by('reviews').sort(byTime('createdAt')) as any,
    inbound_message_buffer: Object.fromEntries(by('buffers').map((b: any) => [b.employeePhone, b])),
    whatsapp_messages: by('messages').sort(byTime('timestamp')) as any,
    notes: by('notes').sort(byTime('createdAt')) as any,
    system_memory: by('memory') as any,
    ai_logs: by('aiLogs').sort(byTime('timestamp')) as any,
  };
  return { state, setupComplete: Boolean(settingsRaw.setupComplete) };
}

const keyOf = (r: { collection: CloudCollection; id: string }) => `${r.collection}/${r.id}`;

/** Only the records that were created, changed or deleted between two states. */
export function diffRecords(
  prev: OpsDatabaseState | null,
  next: OpsDatabaseState,
  tenantId: string,
  options: { setupComplete?: boolean } = {}
): RecordChange[] {
  const before = new Map((prev ? stateToRecords(prev, tenantId, options) : []).map((r) => [keyOf(r), r]));
  const after = new Map(stateToRecords(next, tenantId, options).map((r) => [keyOf(r), r]));
  const changes: RecordChange[] = [];
  for (const [key, rec] of after) {
    const old = before.get(key);
    if (!old) changes.push({ collection: rec.collection, id: rec.id, data: rec.data, kind: 'create' });
    else if (JSON.stringify(old.data) !== JSON.stringify(rec.data)) {
      changes.push({ collection: rec.collection, id: rec.id, data: rec.data, kind: 'update' });
    }
  }
  for (const [key, rec] of before) {
    if (!after.has(key)) changes.push({ collection: rec.collection, id: rec.id, data: null, kind: 'delete' });
  }
  return changes;
}

export interface VersionConflict {
  collection: CloudCollection;
  id: string;
  knownVersion: number | null;
  remoteVersion: number | null;
}

/**
 * A change conflicts when the stored record's version differs from the version this tab
 * last saw (someone else saved in between), or when it was created/deleted meanwhile.
 * `knownVersions`/`remoteVersions` are keyed "collection/id"; missing = record absent.
 */
export function checkVersions(
  changes: RecordChange[],
  knownVersions: Record<string, number>,
  remoteVersions: Record<string, number>
): VersionConflict[] {
  const conflicts: VersionConflict[] = [];
  for (const c of changes) {
    const key = keyOf(c);
    const known = key in knownVersions ? knownVersions[key] : null;
    const remote = key in remoteVersions ? remoteVersions[key] : null;
    if (known !== remote) {
      conflicts.push({ collection: c.collection, id: c.id, knownVersion: known, remoteVersion: remote });
    }
  }
  return conflicts;
}

/** Plain-language message for the owner when a save was refused because of other tabs. */
export function describeConflicts(conflicts: VersionConflict[]): string {
  if (conflicts.length === 0) return '';
  const labels = conflicts.slice(0, 3).map((c) => (c.collection === 'settings' ? 'settings' : c.id));
  const more = conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : '';
  return `This was changed in another tab or device — your change to ${labels.join(', ')}${more} was not saved. The latest version is now shown; please try again.`;
}

export function recordKey(collection: CloudCollection, id: string): string {
  return `${collection}/${id}`;
}

/**
 * Stale-form check: true when the task changed (in another tab/device, or by the scheduler)
 * since the owner opened it for editing. Ignores fields the engine refreshes on its own
 * (hold reasons, reminder bookkeeping, AI summary) so routine updates do not block edits.
 */
export function hasTaskChangedSince(
  base: Record<string, any> | null | undefined,
  current: Record<string, any> | null | undefined
): boolean {
  if (!base || !current) return Boolean(base) !== Boolean(current);
  const strip = (t: Record<string, any>) => {
    const { reminderConfig: _r, lastOutboundAt: _o, latestAiSummary: _s, release, ...rest } = t;
    const { holdReason: _h, nextEligibleAt: _n, batchedForDigest: _b, ...releaseRest } = release || {};
    return { ...rest, release: releaseRest };
  };
  return JSON.stringify(toPlainData(strip(base))) !== JSON.stringify(toPlainData(strip(current)));
}
