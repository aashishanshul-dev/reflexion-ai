import type { CategorySop, Task, TeamMember } from '../types/ops.ts';
import { countOpenTasksByPhone } from './promptBuilder.ts';
import { isTaskClosed } from './releaseEngine.ts';
import { isTaskBehind } from './taskTiming.ts';

/** A task counts as "open" for workload when it is frozen, not a draft, and not closed. */
export function isOpenWorkloadTask(t: Task): boolean {
  return Boolean(t?.isFrozen) && !isTaskClosed(t.status) && t.status !== 'STAGING_DRAFT';
}

/** Open tasks currently assigned (Responsible) to a phone. */
export function openTasksForPhone(phone: string, tasks: Task[]): Task[] {
  if (!phone) return [];
  return (tasks || []).filter((t) => t?.raci?.R === phone && isOpenWorkloadTask(t));
}

/** Open, overdue (dueDate before today) task count per phone. */
export function overdueCountByPhone(tasks: Task[], todayStr: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks || []) {
    const r = t?.raci?.R;
    if (!r || !isOpenWorkloadTask(t)) continue;
    if (t.dueDate && t.dueDate < todayStr) counts.set(r, (counts.get(r) || 0) + 1);
  }
  return counts;
}

/** Open tasks per phone that are late by the clock (due time passed) or flagged behind by a reply. */
export function behindCountByPhone(
  tasks: Task[],
  nowMs: number,
  timezone?: string | null
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks || []) {
    const r = t?.raci?.R;
    if (!r || !isOpenWorkloadTask(t)) continue;
    if (isTaskBehind(t, nowMs, timezone)) counts.set(r, (counts.get(r) || 0) + 1);
  }
  return counts;
}

/** Status chip text for a person on the Team chart. */
export function teamStatusLabel(node: Pick<TeamNode, 'isOnLeave' | 'overdue' | 'behind'>): {
  text: string;
  tone: 'leave' | 'danger' | 'ok';
} {
  if (node.isOnLeave) return { text: 'On leave', tone: 'leave' };
  if (node.overdue > 0) return { text: `${node.overdue} overdue`, tone: 'danger' };
  if ((node.behind || 0) > 0) return { text: `${node.behind} behind`, tone: 'danger' };
  return { text: 'On track', tone: 'ok' };
}

export type LoadBand = 'green' | 'amber' | 'red';

/** Colour band for a person's load: green < 70%, amber 70–100%, red > 100%. */
export function loadBand(active: number, limit: number): LoadBand {
  const cap = Math.max(1, limit || 1);
  const ratio = active / cap;
  if (ratio > 1) return 'red';
  if (ratio >= 0.7) return 'amber';
  return 'green';
}

export interface TeamCapacity {
  totalActive: number;
  totalCapacity: number;
  /** Fraction 0..n of capacity in use. */
  utilization: number;
  /** Phones of people at or over their task limit. */
  atLimitPhones: string[];
  /** Open tasks whose Responsible is at/over their limit. */
  waitingCount: number;
  overloaded: boolean;
  /** Plain-language warning, or '' when the team is fine. */
  warning: string;
}

/**
 * Team-wide capacity: total active tasks vs total limits, who is at their cap,
 * how many tasks are waiting on someone at their cap, and whether the team is overloaded.
 * On-leave people contribute 0 capacity (they take no new tasks).
 */
export function computeTeamCapacity(members: TeamMember[], tasks: Task[]): TeamCapacity {
  const openCounts = countOpenTasksByPhone(tasks || []);
  let totalActive = 0;
  let totalCapacity = 0;
  const atLimitPhones: string[] = [];
  let waitingCount = 0;

  for (const m of members || []) {
    const active = openCounts.get(m.phone) || 0;
    const cap = m.isOnLeave ? 0 : Math.max(1, m.maxActiveTasks || 1);
    totalActive += active;
    totalCapacity += cap;
    if (m.isOnLeave) continue;
    if (active >= cap) {
      atLimitPhones.push(m.phone);
      // Tasks beyond the cap are the ones "waiting" on this person.
      waitingCount += Math.max(0, active - cap);
    }
  }

  const utilization = totalCapacity > 0 ? totalActive / totalCapacity : 0;
  const overloaded = totalCapacity > 0 && (totalActive > totalCapacity || (waitingCount > 0 && atLimitPhones.length > 0));

  let warning = '';
  if (totalCapacity === 0) {
    warning = 'No one is available to take tasks right now.';
  } else if (overloaded) {
    warning = `The team is overloaded: ${totalActive} active tasks against ${totalCapacity} slots${
      waitingCount > 0 ? `, with ${waitingCount} waiting on people at their limit` : ''
    }.`;
  } else if (atLimitPhones.length > 0) {
    warning = `${atLimitPhones.length} ${atLimitPhones.length === 1 ? 'person is' : 'people are'} at their task limit.`;
  }

  return { totalActive, totalCapacity, utilization, atLimitPhones, waitingCount, overloaded, warning };
}

export interface TeamNode {
  phone: string;
  name: string;
  roleTitle: string;
  slotId?: string;
  authorityLevel: TeamMember['authorityLevel'];
  active: number;
  limit: number;
  band: LoadBand;
  overdue: number;
  /** Open tasks late by the clock today or flagged behind (includes overdue ones). */
  behind: number;
  topStrengths: string[];
  isOnLeave: boolean;
  reportsToPhone: string | null;
  partnerOfPhone: string | null;
  depth: number;
  /** True when the person has no manager, no partner, no close peers and no backup link. */
  orphan: boolean;
}

export type EdgeKind = 'reports' | 'partner' | 'close' | 'backup';

export interface TeamEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface TeamGraph {
  nodes: TeamNode[];
  edges: TeamEdge[];
  /** Phones at the top of the tree (no manager), in input order. */
  rootPhones: string[];
  orphanPhones: string[];
}

function keyPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Builds the org-chart graph: nodes with load/overdue/strengths, solid "reports" edges,
 * and dashed edges for partner, close peers, and task-type backups. Depth is the
 * reports-to distance from a root (cycles are broken so depth stays finite).
 */
export function buildTeamGraph(
  members: TeamMember[],
  categorySops: CategorySop[],
  tasks: Task[],
  todayStr: string,
  timing?: { nowMs: number; timezone?: string | null }
): TeamGraph {
  const list = members || [];
  const byPhone = new Map(list.map((m) => [m.phone, m]));
  const openCounts = countOpenTasksByPhone(tasks || []);
  const overdue = overdueCountByPhone(tasks || [], todayStr);
  const behind = timing ? behindCountByPhone(tasks || [], timing.nowMs, timing.timezone) : new Map<string, number>();

  // --- Edges (dedupe dashed pairs across the three dashed sources) ---
  const edges: TeamEdge[] = [];
  const dashedSeen = new Set<string>();
  const addDashed = (a: string, b: string, kind: EdgeKind) => {
    if (!a || !b || a === b || !byPhone.has(a) || !byPhone.has(b)) return;
    const k = keyPair(a, b);
    if (dashedSeen.has(k)) return;
    dashedSeen.add(k);
    edges.push({ from: a, to: b, kind });
  };

  for (const m of list) {
    const mgr = m.reportsToPhone;
    if (mgr && byPhone.has(mgr) && mgr !== m.phone) {
      edges.push({ from: mgr, to: m.phone, kind: 'reports' });
    }
  }
  // Partner first, then close peers, then task-type backups — first kind wins per pair.
  for (const m of list) {
    if (m.partnerOfPhone) addDashed(m.phone, m.partnerOfPhone, 'partner');
  }
  for (const m of list) {
    for (const peer of m.worksCloselyWithPhones || []) addDashed(m.phone, peer, 'close');
  }
  for (const sop of categorySops || []) {
    if (sop.defaultResponsiblePhone && sop.backupResponsiblePhone) {
      addDashed(sop.defaultResponsiblePhone, sop.backupResponsiblePhone, 'backup');
    }
  }

  // --- Depth via BFS over reports-to, roots = people with no (valid) manager ---
  const hasManager = (m: TeamMember) =>
    Boolean(m.reportsToPhone && byPhone.has(m.reportsToPhone) && m.reportsToPhone !== m.phone);
  const childrenOf = new Map<string, string[]>();
  for (const m of list) {
    if (hasManager(m)) {
      const mgr = m.reportsToPhone as string;
      childrenOf.set(mgr, [...(childrenOf.get(mgr) || []), m.phone]);
    }
  }
  const depth = new Map<string, number>();
  const rootPhones = list.filter((m) => !hasManager(m)).map((m) => m.phone);
  const queue: Array<{ phone: string; d: number }> = rootPhones.map((phone) => ({ phone, d: 0 }));
  while (queue.length > 0) {
    const { phone, d } = queue.shift()!;
    if (depth.has(phone)) continue; // cycle guard
    depth.set(phone, d);
    for (const child of childrenOf.get(phone) || []) {
      if (!depth.has(child)) queue.push({ phone: child, d: d + 1 });
    }
  }
  // Any node left (inside a reports-to cycle) gets depth 0 and is treated as a root.
  for (const m of list) {
    if (!depth.has(m.phone)) {
      depth.set(m.phone, 0);
      if (!rootPhones.includes(m.phone)) rootPhones.push(m.phone);
    }
  }

  // --- Orphans: no manager, no reports, no dashed links of any kind ---
  const linkedByDashed = new Set<string>();
  for (const e of edges) {
    if (e.kind !== 'reports') {
      linkedByDashed.add(e.from);
      linkedByDashed.add(e.to);
    }
  }
  const hasReportLink = new Set<string>();
  for (const e of edges) {
    if (e.kind === 'reports') {
      hasReportLink.add(e.from);
      hasReportLink.add(e.to);
    }
  }

  const nodes: TeamNode[] = list.map((m) => {
    const active = openCounts.get(m.phone) || 0;
    const limit = Math.max(1, m.maxActiveTasks || 1);
    const orphan = !hasReportLink.has(m.phone) && !linkedByDashed.has(m.phone);
    return {
      phone: m.phone,
      name: m.name,
      roleTitle: m.roleTitle,
      slotId: m.slotId,
      authorityLevel: m.authorityLevel,
      active,
      limit,
      band: loadBand(active, limit),
      overdue: overdue.get(m.phone) || 0,
      behind: behind.get(m.phone) || 0,
      topStrengths: (m.strengths || []).slice(0, 2),
      isOnLeave: Boolean(m.isOnLeave),
      reportsToPhone: hasManager(m) ? (m.reportsToPhone as string) : null,
      partnerOfPhone: m.partnerOfPhone && byPhone.has(m.partnerOfPhone) ? m.partnerOfPhone : null,
      depth: depth.get(m.phone) ?? 0,
      orphan,
    };
  });

  const orphanPhones = nodes.filter((n) => n.orphan).map((n) => n.phone);
  return { nodes, edges, rootPhones, orphanPhones };
}

export type RemovePlan =
  | { kind: 'DIRECT' }
  | { kind: 'REASSIGN'; targetPhone: string }
  | { kind: 'CANCEL' };

/**
 * Applies a person-removal to a member map + task list, handling their open tasks first.
 * REASSIGN moves every open task to targetPhone; CANCEL cancels them. Returns the next
 * members (slot IDs left as-is for the caller to re-index) and tasks. Also clears the
 * removed phone from others' reportsTo / partnerOf / worksCloselyWith links.
 */
export function applyPersonRemoval(
  phone: string,
  plan: RemovePlan,
  members: Record<string, TeamMember>,
  tasks: Task[],
  nowIso: string
): { members: Record<string, TeamMember>; tasks: Task[] } {
  const open = openTasksForPhone(phone, tasks);

  const nextTasks = (tasks || []).map((t) => {
    if (t?.raci?.R !== phone || !isOpenWorkloadTask(t)) return t;
    if (plan.kind === 'REASSIGN' && plan.targetPhone) {
      return { ...t, raci: { ...t.raci, R: plan.targetPhone } };
    }
    if (plan.kind === 'CANCEL') {
      return { ...t, status: 'CANCELLED' as Task['status'], cancelledAt: nowIso };
    }
    return t;
  });

  const nextMembers: Record<string, TeamMember> = {};
  for (const [p, m] of Object.entries(members)) {
    if (p === phone) continue;
    nextMembers[p] = {
      ...m,
      reportsToPhone: m.reportsToPhone === phone ? null : m.reportsToPhone,
      partnerOfPhone: m.partnerOfPhone === phone ? null : m.partnerOfPhone,
      worksCloselyWithPhones: (m.worksCloselyWithPhones || []).filter((x) => x !== phone),
    };
  }

  // Note: `open` is returned implicitly via the task changes; callers check it beforehand.
  void open;
  return { members: nextMembers, tasks: nextTasks };
}

/** Generic case-insensitive match across name, role, and "What they handle". */
export function matchesMemberSearch(
  member: Pick<TeamMember, 'name' | 'roleTitle' | 'responsibilities'>,
  query: string
): boolean {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  const haystack = `${member.name || ''} ${member.roleTitle || ''} ${member.responsibilities || ''}`.toLowerCase();
  return tokens.every((tok) => haystack.includes(tok));
}

export type ReportsToValidation =
  | { ok: true; kind: 'DIRECT' }
  | { ok: true; kind: 'REPLACE'; currentManagerPhone: string; currentManagerName: string }
  | { ok: false; reason: 'SELF' | 'CYCLE'; message: string };

/**
 * Validates setting `personPhone`'s `reportsToPhone` to `newManagerPhone` (or null).
 * - Blocks self-links (`personPhone === newManagerPhone`).
 * - Blocks reporting loops (cycles through `reportsToPhone`).
 * - Flags manager replacement when `personPhone` already reports to a different valid manager.
 */
export function checkReportsToChange(
  members: Record<string, TeamMember> | TeamMember[],
  personPhone: string,
  newManagerPhone: string | null | undefined
): ReportsToValidation {
  const byPhone = Array.isArray(members)
    ? new Map(members.map((m) => [m.phone, m]))
    : new Map(Object.entries(members || {}));
  const person = byPhone.get(personPhone);
  const target = newManagerPhone ? newManagerPhone.trim() : '';
  if (!target) return { ok: true, kind: 'DIRECT' };

  if (target === personPhone) {
    return {
      ok: false,
      reason: 'SELF',
      message: `${person?.name || 'A person'} cannot report to themselves.`,
    };
  }

  // Walk upward from newManagerPhone to see if personPhone is an ancestor (would form a loop).
  const visited = new Set<string>([personPhone]);
  let cursor: string | null | undefined = target;
  const trailNames: string[] = [byPhone.get(target)?.name || target];
  while (cursor) {
    if (visited.has(cursor)) {
      const personName = person?.name || personPhone;
      return {
        ok: false,
        reason: 'CYCLE',
        message: `Cannot set this reporting link — it would create a reporting loop (${personName} → ${trailNames.join(' → ')}).`,
      };
    }
    visited.add(cursor);
    const mgrPhone: string | null = byPhone.get(cursor)?.reportsToPhone || null;
    if (!mgrPhone || !byPhone.has(mgrPhone)) break;
    cursor = mgrPhone;
    trailNames.push(byPhone.get(mgrPhone)?.name || mgrPhone);
  }

  const currentMgr = person?.reportsToPhone && byPhone.has(person.reportsToPhone) ? person.reportsToPhone : null;
  if (currentMgr && currentMgr !== target) {
    return {
      ok: true,
      kind: 'REPLACE',
      currentManagerPhone: currentMgr,
      currentManagerName: byPhone.get(currentMgr)?.name || currentMgr,
    };
  }

  return { ok: true, kind: 'DIRECT' };
}

/** Reads partner symmetrically (even if only stored on one side in legacy data). */
export function getSymmetricPartnerPhone(
  phone: string,
  members: Record<string, TeamMember>
): string | null {
  const m = members[phone];
  if (m?.partnerOfPhone && m.partnerOfPhone !== phone && members[m.partnerOfPhone]) {
    return m.partnerOfPhone;
  }
  const reverse = Object.values(members).find(
    (other) => other.phone !== phone && other.partnerOfPhone === phone
  );
  return reverse ? reverse.phone : null;
}

/** Reads works-closely-with peers symmetrically (union of outgoing + incoming links). */
export function getSymmetricClosePeerPhones(
  phone: string,
  members: Record<string, TeamMember>
): string[] {
  const m = members[phone];
  const set = new Set<string>();
  for (const p of m?.worksCloselyWithPhones || []) {
    if (p && p !== phone && members[p]) set.add(p);
  }
  for (const other of Object.values(members)) {
    if (other.phone !== phone && (other.worksCloselyWithPhones || []).includes(phone)) {
      set.add(other.phone);
    }
  }
  return Array.from(set);
}

/**
 * Sets or clears a symmetric two-way Partner link between `aPhone` and `bPhoneOrNull`.
 * Cleans up any previous partner back-pointers so pairs stay strictly 1-to-1.
 */
export function syncPartnerLink(
  members: Record<string, TeamMember>,
  aPhone: string,
  bPhoneOrNull: string | null
): Record<string, TeamMember> {
  const a = members[aPhone];
  if (!a) return members;
  const targetPhone = bPhoneOrNull && bPhoneOrNull !== aPhone && members[bPhoneOrNull] ? bPhoneOrNull : null;

  const next: Record<string, TeamMember> = { ...members };
  // Clear stale partner pointers referencing aPhone or targetPhone from anyone else.
  for (const [p, m] of Object.entries(next)) {
    if (p === aPhone || (targetPhone && p === targetPhone)) continue;
    if (m.partnerOfPhone === aPhone || (targetPhone && m.partnerOfPhone === targetPhone)) {
      next[p] = { ...m, partnerOfPhone: null };
    }
  }
  // If A had a prior partner and we are clearing or changing, clear that old partner's pointer.
  if (a.partnerOfPhone && a.partnerOfPhone !== targetPhone && next[a.partnerOfPhone]) {
    next[a.partnerOfPhone] = { ...next[a.partnerOfPhone], partnerOfPhone: null };
  }
  if (targetPhone && next[targetPhone]) {
    const oldTargetPartner = next[targetPhone].partnerOfPhone;
    if (oldTargetPartner && oldTargetPartner !== aPhone && next[oldTargetPartner]) {
      next[oldTargetPartner] = { ...next[oldTargetPartner], partnerOfPhone: null };
    }
  }

  next[aPhone] = { ...next[aPhone], partnerOfPhone: targetPhone };
  if (targetPhone && next[targetPhone]) {
    next[targetPhone] = { ...next[targetPhone], partnerOfPhone: aPhone };
  }
  return next;
}

/**
 * Adds or removes a symmetric two-way "Works closely with" peer link between `aPhone` and `bPhone`.
 */
export function syncWorksCloselyLink(
  members: Record<string, TeamMember>,
  aPhone: string,
  bPhone: string,
  connected: boolean
): Record<string, TeamMember> {
  if (!aPhone || !bPhone || aPhone === bPhone || !members[aPhone] || !members[bPhone]) {
    return members;
  }
  const addPeer = (list: string[] | undefined, peer: string) =>
    Array.from(new Set([...(list || []).filter((x) => x !== peer && members[x]), peer]));
  const dropPeer = (list: string[] | undefined, peer: string) =>
    (list || []).filter((x) => x !== peer && members[x]);

  return {
    ...members,
    [aPhone]: {
      ...members[aPhone],
      worksCloselyWithPhones: connected
        ? addPeer(members[aPhone].worksCloselyWithPhones, bPhone)
        : dropPeer(members[aPhone].worksCloselyWithPhones, bPhone),
    },
    [bPhone]: {
      ...members[bPhone],
      worksCloselyWithPhones: connected
        ? addPeer(members[bPhone].worksCloselyWithPhones, aPhone)
        : dropPeer(members[bPhone].worksCloselyWithPhones, aPhone),
    },
  };
}

/**
 * Applies a teammate's profile edits atomically and keeps two-way `partnerOfPhone`
 * and `worksCloselyWithPhones` synchronized across all affected peers.
 */
export function applyMemberProfileUpdate(
  members: Record<string, TeamMember>,
  updated: TeamMember
): Record<string, TeamMember> {
  const prevClose = getSymmetricClosePeerPhones(updated.phone, members);
  const desiredClose = Array.from(
    new Set((updated.worksCloselyWithPhones || []).filter((p) => p !== updated.phone && members[p]))
  );
  const desiredPartner =
    updated.partnerOfPhone && updated.partnerOfPhone !== updated.phone && members[updated.partnerOfPhone]
      ? updated.partnerOfPhone
      : null;

  let next: Record<string, TeamMember> = {
    ...members,
    [updated.phone]: {
      ...updated,
      partnerOfPhone: desiredPartner,
      worksCloselyWithPhones: desiredClose,
    },
  };

  next = syncPartnerLink(next, updated.phone, desiredPartner);

  const desiredSet = new Set(desiredClose);
  for (const peer of prevClose) {
    if (!desiredSet.has(peer)) next = syncWorksCloselyLink(next, updated.phone, peer, false);
  }
  for (const peer of desiredClose) {
    next = syncWorksCloselyLink(next, updated.phone, peer, true);
  }
  return next;
}

export const ORG_CARD_WIDTH = 224;
export const ORG_CARD_HEIGHT = 112;
const ORG_GAP_X = 48;
const ORG_PAIR_GAP_X = 28;
const ORG_TIER_GAP_Y = 176;

/**
 * Computes zero-overlap top-down hierarchical node coordinates (`{ x, y }`).
 * - Owners/roots sit at y = 0; partners are paired horizontally side-by-side.
 * - Subtrees allocate exclusive horizontal widths so siblings never overlap.
 * - Unlinked teammates (`orphan`) are arranged in a clean row below the main tree.
 */
export function autoArrangeOrgPositions(
  members: TeamMember[],
  categorySops: CategorySop[],
  tasks: Task[],
  todayStr: string
): Record<string, { x: number; y: number }> {
  const graph = buildTeamGraph(members, categorySops, tasks, todayStr);
  const byPhone = new Map(graph.nodes.map((n) => [n.phone, n]));
  const nonOrphans = graph.nodes.filter((n) => !n.orphan);
  const orphans = graph.nodes.filter((n) => n.orphan);

  // Build valid children list per phone
  const childrenMap = new Map<string, string[]>();
  for (const n of nonOrphans) {
    if (n.reportsToPhone && byPhone.has(n.reportsToPhone) && !byPhone.get(n.reportsToPhone)!.orphan) {
      childrenMap.set(n.reportsToPhone, [...(childrenMap.get(n.reportsToPhone) || []), n.phone]);
    }
  }

  // Group mutual/direct partners on the same root/manager parent into visual horizontal units
  const pairedPartnerOf = new Map<string, string>();
  const secondaryPartners = new Set<string>();
  const sortedNodes = [...nonOrphans].sort((a, b) => a.depth - b.depth);
  for (const n of sortedNodes) {
    if (pairedPartnerOf.has(n.phone) || secondaryPartners.has(n.phone)) continue;
    const pPhone = n.partnerOfPhone;
    if (!pPhone || !byPhone.has(pPhone) || byPhone.get(pPhone)!.orphan) continue;
    const partnerNode = byPhone.get(pPhone)!;
    // Pair side-by-side if they sit at the same tier and partner hasn't been claimed as a primary unit yet
    if (partnerNode.depth === n.depth && !pairedPartnerOf.has(pPhone) && !secondaryPartners.has(pPhone)) {
      pairedPartnerOf.set(n.phone, pPhone);
      secondaryPartners.add(pPhone);
    }
  }

  const unitMembers = (primaryPhone: string): string[] => {
    const p = pairedPartnerOf.get(primaryPhone);
    return p ? [primaryPhone, p] : [primaryPhone];
  };

  // Recursive subtree width and placement (guarding against any edge cycles)
  const visitedWidth = new Set<string>();
  const unitChildren = (primaryPhone: string): string[] => {
    const team = unitMembers(primaryPhone);
    const out: string[] = [];
    for (const ph of team) {
      for (const ch of childrenMap.get(ph) || []) {
        if (!secondaryPartners.has(ch) && !out.includes(ch)) out.push(ch);
      }
    }
    return out;
  };

  const widthCache = new Map<string, number>();
  const measureWidth = (primaryPhone: string): number => {
    if (widthCache.has(primaryPhone)) return widthCache.get(primaryPhone)!;
    if (visitedWidth.has(primaryPhone)) return ORG_CARD_WIDTH;
    visitedWidth.add(primaryPhone);

    const team = unitMembers(primaryPhone);
    const selfWidth =
      team.length === 2 ? ORG_CARD_WIDTH * 2 + ORG_PAIR_GAP_X : ORG_CARD_WIDTH;
    const children = unitChildren(primaryPhone);
    const childrenWidth =
      children.length === 0
        ? 0
        : children.reduce((acc, c) => acc + measureWidth(c), 0) +
          ORG_GAP_X * Math.max(0, children.length - 1);
    const total = Math.max(selfWidth, childrenWidth);
    widthCache.set(primaryPhone, total);
    return total;
  };

  const positions: Record<string, { x: number; y: number }> = {};
  const placed = new Set<string>();

  const placeSubtree = (primaryPhone: string, leftX: number, depth: number) => {
    if (placed.has(primaryPhone)) return;
    const totalW = measureWidth(primaryPhone);
    const team = unitMembers(primaryPhone);
    const selfWidth =
      team.length === 2 ? ORG_CARD_WIDTH * 2 + ORG_PAIR_GAP_X : ORG_CARD_WIDTH;
    const y = depth * ORG_TIER_GAP_Y;

    if (team.length === 2) {
      const startX = Math.round(leftX + (totalW - selfWidth) / 2);
      positions[team[0]] = { x: startX, y };
      positions[team[1]] = { x: startX + ORG_CARD_WIDTH + ORG_PAIR_GAP_X, y };
      placed.add(team[0]);
      placed.add(team[1]);
    } else {
      positions[team[0]] = { x: Math.round(leftX + (totalW - ORG_CARD_WIDTH) / 2), y };
      placed.add(team[0]);
    }

    const children = unitChildren(primaryPhone);
    if (children.length > 0) {
      const childrenTotalW =
        children.reduce((acc, c) => acc + measureWidth(c), 0) +
        ORG_GAP_X * Math.max(0, children.length - 1);
      let cursorX = leftX + Math.max(0, (totalW - childrenTotalW) / 2);
      for (const child of children) {
        const cw = measureWidth(child);
        placeSubtree(child, cursorX, depth + 1);
        cursorX += cw + ORG_GAP_X;
      }
    }
  };

  const rootPrimaries = graph.rootPhones.filter(
    (p) => byPhone.has(p) && !byPhone.get(p)!.orphan && !secondaryPartners.has(p)
  );
  // Fallback in case a secondary partner's primary wasn't in rootPhones
  for (const n of nonOrphans) {
    if (n.depth === 0 && !secondaryPartners.has(n.phone) && !rootPrimaries.includes(n.phone)) {
      rootPrimaries.push(n.phone);
    }
  }

  let cursorX = 0;
  for (const r of rootPrimaries) {
    const rw = measureWidth(r);
    placeSubtree(r, cursorX, 0);
    cursorX += rw + ORG_GAP_X;
  }

  // Place any unplaced non-orphans (e.g. a secondary partner whose primary was non-root) safely
  let extraY =
    Object.values(positions).reduce((m, p) => Math.max(m, p.y), 0) +
    (Object.keys(positions).length > 0 ? ORG_TIER_GAP_Y : 0);
  let extraX = 0;
  for (const n of nonOrphans) {
    if (!positions[n.phone]) {
      positions[n.phone] = { x: extraX, y: extraY };
      extraX += ORG_CARD_WIDTH + ORG_GAP_X;
    }
  }

  // Place orphans in a neat row underneath the tree (max 4 per row)
  if (orphans.length > 0) {
    const orphanStartY =
      Object.values(positions).reduce((m, p) => Math.max(m, p.y), -ORG_TIER_GAP_Y) +
      ORG_TIER_GAP_Y;
    orphans.forEach((o, idx) => {
      const col = idx % 4;
      const row = Math.floor(idx / 4);
      positions[o.phone] = {
        x: col * (ORG_CARD_WIDTH + ORG_GAP_X),
        y: orphanStartY + row * ORG_TIER_GAP_Y,
      };
    });
  }

  return positions;
}

export interface PersonSopAssignment {
  categoryId: string;
  categoryName: string;
  role: 'DEFAULT' | 'BACKUP';
}

/** Lists every Category SOP where `phone` is Default Owner or Backup. */
export function getPersonSopAssignments(
  phone: string,
  categorySops: CategorySop[]
): PersonSopAssignment[] {
  const out: PersonSopAssignment[] = [];
  for (const sop of categorySops || []) {
    if (sop.defaultResponsiblePhone === phone) {
      out.push({ categoryId: sop.categoryId, categoryName: sop.categoryName, role: 'DEFAULT' });
    }
    if (sop.backupResponsiblePhone === phone) {
      out.push({ categoryId: sop.categoryId, categoryName: sop.categoryName, role: 'BACKUP' });
    }
  }
  return out;
}

export interface SopRoleReplacement {
  defaultResponsiblePhone?: string | null;
  backupResponsiblePhone?: string | null;
}

/**
 * Removes a member cleanly: handles open tasks, cleans up roster links, and applies
 * explicit owner/backup replacements for every Category SOP they held.
 */
export function applyPersonRemovalWithSops(
  phone: string,
  plan: RemovePlan,
  sopReplacements: Record<string, SopRoleReplacement>,
  members: Record<string, TeamMember>,
  tasks: Task[],
  categorySops: CategorySop[],
  nowIso: string
): { members: Record<string, TeamMember>; tasks: Task[]; categorySops: CategorySop[] } {
  const base = applyPersonRemoval(phone, plan, members, tasks, nowIso);

  const nextSops = (categorySops || []).map((sop) => {
    const rep = sopReplacements[sop.categoryId];
    let nextDefault = sop.defaultResponsiblePhone ?? null;
    let nextBackup = sop.backupResponsiblePhone ?? null;

    if (nextDefault === phone) {
      if (rep && rep.defaultResponsiblePhone !== undefined) {
        nextDefault = rep.defaultResponsiblePhone || null;
      } else {
        nextDefault = null;
      }
    }
    if (nextBackup === phone) {
      if (rep && rep.backupResponsiblePhone !== undefined) {
        nextBackup = rep.backupResponsiblePhone || null;
      } else {
        nextBackup = null;
      }
    }

    if (nextDefault && !base.members[nextDefault]) nextDefault = null;
    if (nextBackup && !base.members[nextBackup]) nextBackup = null;
    if (nextDefault && nextBackup && nextDefault === nextBackup) nextBackup = null;

    return {
      ...sop,
      defaultResponsiblePhone: nextDefault,
      backupResponsiblePhone: nextBackup,
    };
  });

  return { ...base, categorySops: nextSops };
}

