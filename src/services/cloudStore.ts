/**
 * Milestone 5A — the signed-in owner's workspace in Firestore, one document per record under
 * tenants/{uid}/{collection}/{id}. Saves write only changed records in a transaction and are
 * refused when another tab/device changed those records first (version check).
 */
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  Unsubscribe,
} from 'firebase/firestore';
import { OpsDatabaseState } from '../types/ops';
import {
  checkVersions,
  CLOUD_COLLECTIONS,
  CloudCollection,
  CloudRecord,
  diffRecords,
  recordKey,
  recordsToState,
  VersionConflict,
} from '../lib/cloudRecords';
import { stripEphemeralMediaFromState } from '../lib/opsEngine';
import { getCloudDb } from './firebaseClient';

/** Version of each record as this tab last saw it ("collection/id" -> version). */
let knownVersions: Record<string, number> = {};
const SESSION_ID = `tab-${Math.random().toString(36).slice(2, 10)}`;

export interface LoadedWorkspace {
  state: OpsDatabaseState | null;
  setupComplete: boolean;
}

function noteRecord(collectionName: CloudCollection, id: string, data: Record<string, unknown> | undefined) {
  const key = recordKey(collectionName, id);
  if (data) knownVersions[key] = Number(data.version) || 0;
  else delete knownVersions[key];
}

export async function loadWorkspace(uid: string): Promise<LoadedWorkspace> {
  const db = getCloudDb();
  const records: CloudRecord[] = [];
  const fresh: Record<string, number> = {};
  const snaps = await Promise.all(CLOUD_COLLECTIONS.map((c) => getDocs(collection(db, 'tenants', uid, c))));
  snaps.forEach((snap, i) => {
    const c = CLOUD_COLLECTIONS[i];
    snap.forEach((d) => {
      const data = d.data() as Record<string, unknown>;
      records.push({ collection: c, id: d.id, data });
      fresh[recordKey(c, d.id)] = Number(data.version) || 0;
    });
  });
  knownVersions = fresh;
  return recordsToState(records, uid);
}

/**
 * Live updates (other tabs/devices and the server tick). Calls back with the rebuilt
 * workspace after every confirmed change, once all collections have loaded.
 */
export function subscribeWorkspace(uid: string, onChange: (loaded: LoadedWorkspace) => void): Unsubscribe {
  const db = getCloudDb();
  const byCollection = new Map<CloudCollection, Map<string, Record<string, unknown>>>();
  const ready = new Set<CloudCollection>();
  const emit = () => {
    if (ready.size < CLOUD_COLLECTIONS.length) return;
    const records: CloudRecord[] = [];
    for (const [c, docs] of byCollection) for (const [id, data] of docs) records.push({ collection: c, id, data });
    onChange(recordsToState(records, uid));
  };
  const unsubs = CLOUD_COLLECTIONS.map((c) =>
    onSnapshot(collection(db, 'tenants', uid, c), (snap) => {
      const docs = byCollection.get(c) || new Map<string, Record<string, unknown>>();
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') {
          docs.delete(change.doc.id);
          if (!snap.metadata.hasPendingWrites) noteRecord(c, change.doc.id, undefined);
        } else {
          const data = change.doc.data() as Record<string, unknown>;
          docs.set(change.doc.id, data);
          if (!change.doc.metadata.hasPendingWrites) noteRecord(c, change.doc.id, data);
        }
      });
      byCollection.set(c, docs);
      ready.add(c);
      if (!snap.metadata.hasPendingWrites) emit();
    })
  );
  return () => unsubs.forEach((u) => u());
}

export interface SaveResult {
  conflicts: VersionConflict[];
  written: number;
}

const MAX_WRITES_PER_TRANSACTION = 450;

/** Writes only what changed between `prev` and `next` (prev null = brand-new workspace). */
export async function saveChanges(
  uid: string,
  prev: OpsDatabaseState | null,
  next: OpsDatabaseState,
  options: { setupComplete?: boolean } = {}
): Promise<SaveResult> {
  const db = getCloudDb();
  const changes = diffRecords(
    prev ? stripEphemeralMediaFromState(prev) : null,
    stripEphemeralMediaFromState(next),
    uid,
    options
  );
  let written = 0;
  for (let i = 0; i < changes.length; i += MAX_WRITES_PER_TRANSACTION) {
    const chunk = changes.slice(i, i + MAX_WRITES_PER_TRANSACTION);
    const result = await runTransaction(db, async (tx) => {
      const refs = chunk.map((c) => doc(db, 'tenants', uid, c.collection, c.id));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      const remote: Record<string, number> = {};
      snaps.forEach((s, idx) => {
        if (s.exists()) remote[recordKey(chunk[idx].collection, chunk[idx].id)] = Number(s.data()?.version) || 0;
      });
      const conflicts = checkVersions(chunk, knownVersions, remote);
      if (conflicts.length > 0) return { conflicts, newVersions: {} as Record<string, number | null> };
      const newVersions: Record<string, number | null> = {};
      chunk.forEach((c, idx) => {
        const key = recordKey(c.collection, c.id);
        if (c.kind === 'delete' || !c.data) {
          tx.delete(refs[idx]);
          newVersions[key] = null;
          return;
        }
        const version = (remote[key] ?? 0) + 1;
        tx.set(refs[idx], {
          ...c.data,
          tenantId: uid,
          version,
          updatedAt: serverTimestamp(),
          updatedBySession: SESSION_ID,
        });
        newVersions[key] = version;
      });
      return { conflicts: [] as VersionConflict[], newVersions };
    });
    if (result.conflicts.length > 0) return { conflicts: result.conflicts, written };
    for (const [key, v] of Object.entries(result.newVersions)) {
      if (v === null) delete knownVersions[key];
      else knownVersions[key] = v;
    }
    written += chunk.length;
  }
  return { conflicts: [], written };
}
