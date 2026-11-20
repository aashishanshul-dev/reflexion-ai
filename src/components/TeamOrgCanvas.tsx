import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Connection,
  ConnectionMode,
  Controls,
  Edge,
  Handle,
  MarkerType,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowInstance,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowRight, ArrowLeftRight, AlertTriangle, Trash2, X } from 'lucide-react';
import { CategorySop, Task, TeamMember } from '../types/ops';
import {
  autoArrangeOrgPositions,
  checkReportsToChange,
  getSymmetricClosePeerPhones,
  getSymmetricPartnerPhone,
  LoadBand,
  ORG_CARD_HEIGHT,
  ORG_CARD_WIDTH,
  TeamEdge,
  TeamNode,
  teamStatusLabel,
} from '../lib/teamGraph';

export type EditableLinkKind = 'reports' | 'partner' | 'close';

export interface TeamCardNodeData extends Record<string, unknown> {
  teamNode: TeamNode;
  selected: boolean;
  dimmed: boolean;
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

function TeamPersonNodeComponent({ data }: NodeProps<Node<TeamCardNodeData>>) {
  const { teamNode, selected, dimmed } = data;
  const status = teamStatusLabel(teamNode);
  const statusLabel = status.text;
  const statusClass =
    status.tone === 'leave'
      ? 'text-warn bg-warn-soft border-warn-border'
      : status.tone === 'danger'
        ? 'text-danger bg-danger-soft border-danger-border'
        : 'text-ok bg-ok-soft border-ok-border';

  const handleClass =
    '!w-2.5 !h-2.5 !bg-surface !border-2 !border-slate hover:!border-signal hover:!bg-signal-soft transition-colors opacity-40 group-hover:opacity-100';

  return (
    <div
      data-testid={`team-card-${teamNode.phone}`}
      style={{ width: ORG_CARD_WIDTH, height: ORG_CARD_HEIGHT }}
      className={`group relative rounded-xl border bg-surface px-3.5 py-3 shadow-[var(--shadow-card)] transition-opacity flex flex-col justify-between select-none ${
        selected
          ? 'border-signal ring-2 ring-signal/20'
          : 'border-hairline hover:border-hairline-strong'
      } ${dimmed ? 'opacity-30' : 'opacity-100'}`}
    >
      <Handle id="top" type="source" position={Position.Top} className={handleClass} />
      <Handle id="right" type="source" position={Position.Right} className={handleClass} />
      <Handle id="bottom" type="source" position={Position.Bottom} className={handleClass} />
      <Handle id="left" type="source" position={Position.Left} className={handleClass} />

      <div className="min-w-0">
        <div className="truncate text-sm font-bold text-ink leading-tight font-display">
          {teamNode.name || 'Unnamed'}
        </div>
        <div className="mt-0.5 truncate text-xs text-slate">
          {teamNode.roleTitle || 'Team member'}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline">
        <div className="inline-flex items-center gap-1.5 text-xs font-bold tabular-nums">
          <span
            className={`h-2 w-2 rounded-full shrink-0 ${BAND_DOT[teamNode.band]}`}
            aria-hidden="true"
          />
          <span className={BAND_NUM[teamNode.band]}>
            {teamNode.active}/{teamNode.limit}
          </span>
        </div>

        <span
          className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold truncate ${statusClass}`}
        >
          {statusLabel}
        </span>
      </div>
    </div>
  );
}

const NODE_TYPES = {
  teamPerson: TeamPersonNodeComponent,
};

interface CanvasEdgePayload extends Record<string, unknown> {
  edgeKind: TeamEdge['kind'];
  fromPhone: string;
  toPhone: string;
  backupCategories: string[];
}

interface PendingConnectState {
  subordinatePhone: string;
  targetPhone: string;
  kind: EditableLinkKind;
  confirmReplace?: { currentManagerName: string; newManagerName: string };
}

interface ActiveEdgeEditState {
  fromPhone: string;
  toPhone: string;
  originalKind: TeamEdge['kind'];
  nextKind: EditableLinkKind;
  subordinatePhone: string;
  managerPhone: string;
  backupCategories: string[];
  confirmReplace?: { currentManagerName: string; newManagerName: string };
}

export interface TeamOrgCanvasProps {
  nodesData: TeamNode[];
  membersMap: Record<string, TeamMember>;
  categorySops: CategorySop[];
  tasks: Task[];
  todayStr: string;
  selectedPhone: string | null;
  matchingPhones: Set<string>;
  hasSearchQuery: boolean;
  showWorksClosely: boolean;
  showTaskBackups: boolean;
  autoArrangeNonce: number;
  onSelectPerson: (phone: string) => void;
  onSavePositions: (positions: Record<string, { x: number; y: number }>) => void;
  onSaveLink: (params: {
    kind: EditableLinkKind;
    subordinatePhone: string;
    targetPhone: string;
    previousKind?: EditableLinkKind;
    previousFrom?: string;
    previousTo?: string;
  }) => void;
  onDeleteLink: (kind: EditableLinkKind, fromPhone: string, toPhone: string) => void;
  onOpenSopEditor?: (categoryId?: string) => void;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pickPeerHandles(
  aPos: { x: number; y: number } | undefined,
  bPos: { x: number; y: number } | undefined
): { sourceHandle: string; targetHandle: string } {
  if (!aPos || !bPos) return { sourceHandle: 'right', targetHandle: 'left' };
  const dx = bPos.x - aPos.x;
  const dy = bPos.y - aPos.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right', targetHandle: 'left' }
      : { sourceHandle: 'left', targetHandle: 'right' };
  }
  return dy >= 0
    ? { sourceHandle: 'bottom', targetHandle: 'top' }
    : { sourceHandle: 'top', targetHandle: 'bottom' };
}

function InnerTeamOrgCanvas(props: TeamOrgCanvasProps) {
  const {
    nodesData,
    membersMap,
    categorySops,
    tasks,
    todayStr,
    selectedPhone,
    matchingPhones,
    hasSearchQuery,
    showWorksClosely,
    showTaskBackups,
    autoArrangeNonce,
    onSelectPerson,
    onSavePositions,
    onSaveLink,
    onDeleteLink,
    onOpenSopEditor,
  } = props;

  const rfInstanceRef = useRef<ReactFlowInstance<
    Node<TeamCardNodeData>,
    Edge<CanvasEdgePayload>
  > | null>(null);
  const isDraggingRef = useRef(false);
  const lastArrangeNonceRef = useRef(autoArrangeNonce);
  const initialFitDoneRef = useRef(false);

  const [pendingConnect, setPendingConnect] = useState<PendingConnectState | null>(null);
  const [editingEdge, setEditingEdge] = useState<ActiveEdgeEditState | null>(null);

  const autoPositions = useMemo(
    () =>
      autoArrangeOrgPositions(
        Object.values(membersMap),
        categorySops,
        tasks,
        todayStr
      ),
    [membersMap, categorySops, tasks, todayStr]
  );

  const resolvedPositions = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {};
    for (const n of nodesData) {
      const saved = membersMap[n.phone]?.orgChartPosition;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        out[n.phone] = { x: saved.x, y: saved.y };
      } else {
        out[n.phone] = autoPositions[n.phone] || { x: 0, y: 0 };
      }
    }
    return out;
  }, [nodesData, membersMap, autoPositions]);

  const computedRfNodes = useMemo<Node<TeamCardNodeData>[]>(
    () =>
      nodesData.map((n) => {
        const isMatch = !hasSearchQuery || matchingPhones.has(n.phone);
        return {
          id: n.phone,
          type: 'teamPerson',
          position: resolvedPositions[n.phone] || { x: 0, y: 0 },
          draggable: true,
          selectable: true,
          data: {
            teamNode: n,
            selected: selectedPhone === n.phone,
            dimmed: hasSearchQuery && !isMatch,
          },
        };
      }),
    [nodesData, resolvedPositions, hasSearchQuery, matchingPhones, selectedPhone]
  );

  const computedRfEdges = useMemo<Edge<CanvasEdgePayload>[]>(() => {
    const edges: Edge<CanvasEdgePayload>[] = [];
    const members = Object.values(membersMap);

    // 1. Always show "Reports to" links (Manager -> Report)
    for (const m of members) {
      const mgr = m.reportsToPhone;
      if (!mgr || mgr === m.phone || !membersMap[mgr]) continue;
      const bothMatch =
        hasSearchQuery && matchingPhones.has(mgr) && matchingPhones.has(m.phone);
      const anyDimmed =
        hasSearchQuery && (!matchingPhones.has(mgr) || !matchingPhones.has(m.phone));

      edges.push({
        id: `reports:${mgr}->${m.phone}`,
        source: mgr,
        target: m.phone,
        sourceHandle: 'bottom',
        targetHandle: 'top',
        type: 'smoothstep',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: bothMatch ? 'var(--color-signal)' : 'var(--color-ink)',
        },
        style: {
          stroke: bothMatch ? 'var(--color-signal)' : 'var(--color-ink)',
          strokeWidth: bothMatch ? 2.5 : 1.75,
          opacity: anyDimmed ? 0.2 : 1,
        },
        data: {
          edgeKind: 'reports',
          fromPhone: mgr,
          toPhone: m.phone,
          backupCategories: [],
        },
      });
    }

    // 2. Always show symmetric "Partner" links (warm dashed line)
    const seenPartners = new Set<string>();
    for (const m of members) {
      const partnerPhone = getSymmetricPartnerPhone(m.phone, membersMap);
      if (!partnerPhone || !membersMap[partnerPhone]) continue;
      const k = pairKey(m.phone, partnerPhone);
      if (seenPartners.has(k)) continue;
      seenPartners.add(k);

      const bothMatch =
        hasSearchQuery && matchingPhones.has(m.phone) && matchingPhones.has(partnerPhone);
      const anyDimmed =
        hasSearchQuery &&
        (!matchingPhones.has(m.phone) || !matchingPhones.has(partnerPhone));
      const { sourceHandle, targetHandle } = pickPeerHandles(
        resolvedPositions[m.phone],
        resolvedPositions[partnerPhone]
      );

      edges.push({
        id: `partner:${k}`,
        source: m.phone,
        target: partnerPhone,
        sourceHandle,
        targetHandle,
        type: 'smoothstep',
        style: {
          stroke: 'var(--color-signal)',
          strokeWidth: bothMatch ? 2.5 : 1.75,
          strokeDasharray: '6 4',
          opacity: anyDimmed ? 0.2 : 1,
        },
        data: {
          edgeKind: 'partner',
          fromPhone: m.phone,
          toPhone: partnerPhone,
          backupCategories: [],
        },
      });
    }

    // 3. Optional: "Works closely with" links (OFF by default)
    if (showWorksClosely) {
      const seenClose = new Set<string>();
      for (const m of members) {
        for (const peer of getSymmetricClosePeerPhones(m.phone, membersMap)) {
          if (!membersMap[peer]) continue;
          const k = pairKey(m.phone, peer);
          if (seenClose.has(k)) continue;
          seenClose.add(k);

          const bothMatch =
            hasSearchQuery && matchingPhones.has(m.phone) && matchingPhones.has(peer);
          const anyDimmed =
            hasSearchQuery && (!matchingPhones.has(m.phone) || !matchingPhones.has(peer));
          const { sourceHandle, targetHandle } = pickPeerHandles(
            resolvedPositions[m.phone],
            resolvedPositions[peer]
          );

          edges.push({
            id: `close:${k}`,
            source: m.phone,
            target: peer,
            sourceHandle,
            targetHandle,
            type: 'smoothstep',
            style: {
              stroke: bothMatch ? 'var(--color-signal)' : 'var(--color-info)',
              strokeWidth: bothMatch ? 2.25 : 1.5,
              strokeDasharray: '4 4',
              opacity: anyDimmed ? 0.2 : 0.9,
            },
            data: {
              edgeKind: 'close',
              fromPhone: m.phone,
              toPhone: peer,
              backupCategories: [],
            },
          });
        }
      }
    }

    // 4. Optional: Task-type backup links derived from Category SOPs (OFF by default)
    if (showTaskBackups) {
      const pairCats = new Map<string, { a: string; b: string; cats: string[] }>();
      for (const sop of categorySops) {
        const def = sop.defaultResponsiblePhone;
        const bak = sop.backupResponsiblePhone;
        if (!def || !bak || def === bak || !membersMap[def] || !membersMap[bak]) continue;
        const k = pairKey(def, bak);
        const existing = pairCats.get(k);
        if (existing) {
          existing.cats.push(sop.categoryName);
        } else {
          pairCats.set(k, { a: def, b: bak, cats: [sop.categoryName] });
        }
      }
      for (const [k, info] of pairCats.entries()) {
        const bothMatch =
          hasSearchQuery && matchingPhones.has(info.a) && matchingPhones.has(info.b);
        const anyDimmed =
          hasSearchQuery && (!matchingPhones.has(info.a) || !matchingPhones.has(info.b));
        const { sourceHandle, targetHandle } = pickPeerHandles(
          resolvedPositions[info.a],
          resolvedPositions[info.b]
        );

        edges.push({
          id: `backup:${k}`,
          source: info.a,
          target: info.b,
          sourceHandle,
          targetHandle,
          type: 'smoothstep',
          style: {
            stroke: bothMatch ? 'var(--color-signal)' : 'var(--color-warn-solid)',
            strokeWidth: bothMatch ? 2.25 : 1.5,
            strokeDasharray: '2 4',
            opacity: anyDimmed ? 0.2 : 0.9,
          },
          data: {
            edgeKind: 'backup',
            fromPhone: info.a,
            toPhone: info.b,
            backupCategories: info.cats,
          },
        });
      }
    }

    return edges;
  }, [
    membersMap,
    categorySops,
    hasSearchQuery,
    matchingPhones,
    resolvedPositions,
    showWorksClosely,
    showTaskBackups,
  ]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<TeamCardNodeData>>(computedRfNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge<CanvasEdgePayload>>(computedRfEdges);

  useEffect(() => {
    if (!isDraggingRef.current) {
      setRfNodes(computedRfNodes);
    }
  }, [computedRfNodes, setRfNodes]);

  useEffect(() => {
    setRfEdges(computedRfEdges);
  }, [computedRfEdges, setRfEdges]);

  useEffect(() => {
    if (autoArrangeNonce !== lastArrangeNonceRef.current) {
      lastArrangeNonceRef.current = autoArrangeNonce;
      window.requestAnimationFrame(() => {
        rfInstanceRef.current?.fitView({ padding: 0.2, duration: 250 });
      });
    }
  }, [autoArrangeNonce]);

  const handleConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) {
      setPendingConnect({
        subordinatePhone: connection.source,
        targetPhone: connection.target,
        kind: 'reports',
      });
      return;
    }
    // By default dragging from bottom/card A -> top/card B assumes B reports to A if top-down,
    // OR let user see explicit preview and Swap with 1 click!
    setPendingConnect({
      subordinatePhone: connection.target,
      targetPhone: connection.source,
      kind: 'reports',
    });
  };

  const pendingReportsValidation = useMemo(() => {
    if (!pendingConnect || pendingConnect.kind !== 'reports') return null;
    return checkReportsToChange(
      membersMap,
      pendingConnect.subordinatePhone,
      pendingConnect.targetPhone
    );
  }, [pendingConnect, membersMap]);

  const editReportsValidation = useMemo(() => {
    if (!editingEdge || editingEdge.nextKind !== 'reports') return null;
    // Skip REPLACE prompt if this is already the exact same Reports-to link
    const existingMgr = membersMap[editingEdge.subordinatePhone]?.reportsToPhone;
    if (existingMgr === editingEdge.managerPhone) {
      return { ok: true as const, kind: 'DIRECT' as const };
    }
    return checkReportsToChange(
      membersMap,
      editingEdge.subordinatePhone,
      editingEdge.managerPhone
    );
  }, [editingEdge, membersMap]);

  const handleConfirmPendingConnect = () => {
    if (!pendingConnect) return;
    if (pendingConnect.kind === 'reports') {
      if (!pendingReportsValidation?.ok) return;
      if (pendingReportsValidation.kind === 'REPLACE' && !pendingConnect.confirmReplace) {
        setPendingConnect({
          ...pendingConnect,
          confirmReplace: {
            currentManagerName: pendingReportsValidation.currentManagerName,
            newManagerName: membersMap[pendingConnect.targetPhone]?.name || pendingConnect.targetPhone,
          },
        });
        return;
      }
    }
    onSaveLink({
      kind: pendingConnect.kind,
      subordinatePhone: pendingConnect.subordinatePhone,
      targetPhone: pendingConnect.targetPhone,
    });
    setPendingConnect(null);
  };

  const handleConfirmEdgeEdit = () => {
    if (!editingEdge) return;
    if (editingEdge.nextKind === 'reports') {
      if (!editReportsValidation?.ok) return;
      if (editReportsValidation.kind === 'REPLACE' && !editingEdge.confirmReplace) {
        setEditingEdge({
          ...editingEdge,
          confirmReplace: {
            currentManagerName: editReportsValidation.currentManagerName,
            newManagerName: membersMap[editingEdge.managerPhone]?.name || editingEdge.managerPhone,
          },
        });
        return;
      }
    }
    onSaveLink({
      kind: editingEdge.nextKind,
      subordinatePhone: editingEdge.subordinatePhone,
      targetPhone: editingEdge.managerPhone,
      previousKind: editingEdge.originalKind === 'backup' ? undefined : editingEdge.originalKind,
      previousFrom: editingEdge.fromPhone,
      previousTo: editingEdge.toPhone,
    });
    setEditingEdge(null);
  };

  return (
    <div className="relative h-[580px] min-h-[500px] w-full rounded-2xl border border-hairline bg-paper overflow-hidden shadow-[var(--shadow-card)]">
      <ReactFlow<Node<TeamCardNodeData>, Edge<CanvasEdgePayload>>
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        connectionMode={ConnectionMode.Loose}
        onInit={(instance) => {
          rfInstanceRef.current = instance;
          if (!initialFitDoneRef.current) {
            initialFitDoneRef.current = true;
            window.requestAnimationFrame(() => {
              instance.fitView({ padding: 0.22 });
            });
          }
        }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeClick={(_evt, node) => onSelectPerson(node.id)}
        onEdgeClick={(_evt, edge) => {
          const d = edge.data;
          if (!d) return;
          if (d.edgeKind === 'reports') {
            setEditingEdge({
              fromPhone: d.fromPhone,
              toPhone: d.toPhone,
              originalKind: 'reports',
              nextKind: 'reports',
              subordinatePhone: d.toPhone,
              managerPhone: d.fromPhone,
              backupCategories: [],
            });
          } else {
            setEditingEdge({
              fromPhone: d.fromPhone,
              toPhone: d.toPhone,
              originalKind: d.edgeKind,
              nextKind: d.edgeKind === 'backup' ? 'close' : d.edgeKind,
              subordinatePhone: d.toPhone,
              managerPhone: d.fromPhone,
              backupCategories: d.backupCategories || [],
            });
          }
        }}
        onNodeDragStart={() => {
          isDraggingRef.current = true;
        }}
        onNodeDragStop={(_evt, node, allNodes) => {
          isDraggingRef.current = false;
          const posMap: Record<string, { x: number; y: number }> = {};
          for (const item of allNodes) {
            posMap[item.id] = {
              x: Math.round(item.position.x),
              y: Math.round(item.position.y),
            };
          }
          posMap[node.id] = {
            x: Math.round(node.position.x),
            y: Math.round(node.position.y),
          };
          onSavePositions(posMap);
        }}
        fitViewOptions={{ padding: 0.22 }}
        minZoom={0.35}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="var(--color-hairline-strong)" />
        <Controls
          showInteractive={false}
          className="!bg-surface !border !border-hairline !rounded-xl !shadow-[var(--shadow-card)] [&>button]:!border-hairline [&>button]:!bg-surface [&>button]:!text-ink hover:[&>button]:!bg-paper"
        />
      </ReactFlow>

      {/* Connection Creation Modal (from drag onConnect) */}
      {pendingConnect && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Create team connection"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-modal)] space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-ink font-display">Create connection</h3>
                <p className="text-xs text-slate mt-0.5">
                  Choose how these two teammates work together.
                </p>
              </div>
              <button
                type="button"
                aria-label="Cancel connection"
                onClick={() => setPendingConnect(null)}
                className="rounded-lg p-1 text-slate hover:bg-paper hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Connection Type Picker */}
            <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-surface-muted p-1 border border-hairline">
              {(
                [
                  { id: 'reports', label: 'Reports to' },
                  { id: 'partner', label: 'Partner' },
                  { id: 'close', label: 'Works closely' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() =>
                    setPendingConnect({
                      ...pendingConnect,
                      kind: opt.id,
                      confirmReplace: undefined,
                    })
                  }
                  className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${
                    pendingConnect.kind === opt.id
                      ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                      : 'text-slate hover:text-ink'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Direction preview + Swap button */}
            <div className="rounded-xl border border-hairline bg-paper p-3.5 space-y-2.5">
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-ink">
                <span className="truncate">
                  {membersMap[pendingConnect.subordinatePhone]?.name || pendingConnect.subordinatePhone}
                </span>
                <span className="inline-flex items-center gap-1 rounded-md bg-surface border border-hairline px-2 py-0.5 text-[11px] font-bold text-signal shrink-0">
                  {pendingConnect.kind === 'reports' ? (
                    <>
                      reports to <ArrowRight className="h-3 w-3" />
                    </>
                  ) : pendingConnect.kind === 'partner' ? (
                    'two-way partner'
                  ) : (
                    'works closely with'
                  )}
                </span>
                <span className="truncate text-right">
                  {membersMap[pendingConnect.targetPhone]?.name || pendingConnect.targetPhone}
                </span>
              </div>

              {pendingConnect.kind === 'reports' &&
                pendingConnect.subordinatePhone !== pendingConnect.targetPhone && (
                  <button
                    type="button"
                    onClick={() =>
                      setPendingConnect({
                        ...pendingConnect,
                        subordinatePhone: pendingConnect.targetPhone,
                        targetPhone: pendingConnect.subordinatePhone,
                        confirmReplace: undefined,
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-hairline-strong bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-surface-muted transition-colors"
                  >
                    <ArrowLeftRight className="h-3 w-3 text-signal" />
                    Swap direction
                  </button>
                )}
            </div>

            {/* Self-link / Cycle Validation */}
            {pendingConnect.kind === 'reports' &&
              pendingReportsValidation &&
              !pendingReportsValidation.ok && (
                <div className="rounded-xl border border-danger-border bg-danger-soft p-3 text-xs text-danger flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{pendingReportsValidation.message}</span>
                </div>
              )}

            {/* Manager replacement confirmation prompt */}
            {pendingConnect.confirmReplace && (
              <div className="rounded-xl border border-warn-border bg-warn-soft p-3 text-xs text-warn space-y-2">
                <div className="font-semibold text-ink">
                  Replace {pendingConnect.confirmReplace.currentManagerName} with{' '}
                  {pendingConnect.confirmReplace.newManagerName} as{' '}
                  {membersMap[pendingConnect.subordinatePhone]?.name}&apos;s manager?
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPendingConnect(null)}
                    className="rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-paper"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmPendingConnect}
                    className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink-hover"
                  >
                    Confirm replacement
                  </button>
                </div>
              </div>
            )}

            {!pendingConnect.confirmReplace && (
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setPendingConnect(null)}
                  className="rounded-lg border border-hairline-strong bg-surface px-3.5 py-2 text-xs font-semibold text-ink hover:bg-paper"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={
                    pendingConnect.subordinatePhone === pendingConnect.targetPhone ||
                    (pendingConnect.kind === 'reports' && !pendingReportsValidation?.ok)
                  }
                  onClick={handleConfirmPendingConnect}
                  className="rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink-hover disabled:opacity-45"
                >
                  Save link
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Edge Click Edit / Delete Modal */}
      {editingEdge && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit connection"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-modal)] space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-ink font-display">
                  {editingEdge.originalKind === 'backup'
                    ? 'Task-type backup link'
                    : 'Edit connection'}
                </h3>
                <p className="text-xs text-slate mt-0.5">
                  {membersMap[editingEdge.fromPhone]?.name || editingEdge.fromPhone} &harr;{' '}
                  {membersMap[editingEdge.toPhone]?.name || editingEdge.toPhone}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close connection editor"
                onClick={() => setEditingEdge(null)}
                className="rounded-lg p-1 text-slate hover:bg-paper hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {editingEdge.originalKind === 'backup' ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-warn-border bg-warn-soft p-3 text-xs text-ink">
                  This backup connection comes from task types:{' '}
                  <strong>{editingEdge.backupCategories.join(', ')}</strong>. Change default or
                  backup owners inside AI Brain &amp; Setup.
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingEdge(null)}
                    className="rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-paper"
                  >
                    Close
                  </button>
                  {onOpenSopEditor && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingEdge(null);
                        onOpenSopEditor();
                      }}
                      className="rounded-lg bg-ink px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-ink-hover"
                    >
                      Edit in AI Brain &amp; Setup
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-surface-muted p-1 border border-hairline">
                  {(
                    [
                      { id: 'reports', label: 'Reports to' },
                      { id: 'partner', label: 'Partner' },
                      { id: 'close', label: 'Works closely' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() =>
                        setEditingEdge({
                          ...editingEdge,
                          nextKind: opt.id,
                          confirmReplace: undefined,
                        })
                      }
                      className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${
                        editingEdge.nextKind === opt.id
                          ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                          : 'text-slate hover:text-ink'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {editingEdge.nextKind === 'reports' && (
                  <div className="rounded-xl border border-hairline bg-paper p-3.5 space-y-2">
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-ink">
                      <span className="truncate">
                        {membersMap[editingEdge.subordinatePhone]?.name ||
                          editingEdge.subordinatePhone}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-md bg-surface border border-hairline px-2 py-0.5 text-[11px] font-bold text-signal shrink-0">
                        reports to <ArrowRight className="h-3 w-3" />
                      </span>
                      <span className="truncate text-right">
                        {membersMap[editingEdge.managerPhone]?.name || editingEdge.managerPhone}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setEditingEdge({
                          ...editingEdge,
                          subordinatePhone: editingEdge.managerPhone,
                          managerPhone: editingEdge.subordinatePhone,
                          confirmReplace: undefined,
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-hairline-strong bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-surface-muted"
                    >
                      <ArrowLeftRight className="h-3 w-3 text-signal" />
                      Swap direction
                    </button>
                  </div>
                )}

                {editingEdge.nextKind === 'reports' &&
                  editReportsValidation &&
                  !editReportsValidation.ok && (
                    <div className="rounded-xl border border-danger-border bg-danger-soft p-3 text-xs text-danger flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>{editReportsValidation.message}</span>
                    </div>
                  )}

                {editingEdge.confirmReplace && (
                  <div className="rounded-xl border border-warn-border bg-warn-soft p-3 text-xs text-ink space-y-2">
                    <div className="font-semibold">
                      Replace {editingEdge.confirmReplace.currentManagerName} with{' '}
                      {editingEdge.confirmReplace.newManagerName} as{' '}
                      {membersMap[editingEdge.subordinatePhone]?.name}&apos;s manager?
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingEdge(null)}
                        className="rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-paper"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmEdgeEdit}
                        className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink-hover"
                      >
                        Confirm replacement
                      </button>
                    </div>
                  </div>
                )}

                {!editingEdge.confirmReplace && (
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        onDeleteLink(
                          editingEdge.originalKind as EditableLinkKind,
                          editingEdge.fromPhone,
                          editingEdge.toPhone
                        );
                        setEditingEdge(null);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-xs font-semibold text-danger hover:bg-danger-border/30 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete line
                    </button>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingEdge(null)}
                        className="rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-xs font-semibold text-ink hover:bg-paper"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={editingEdge.nextKind === 'reports' && !editReportsValidation?.ok}
                        onClick={handleConfirmEdgeEdit}
                        className="rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink-hover disabled:opacity-45"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function TeamOrgCanvas(props: TeamOrgCanvasProps) {
  return (
    <ReactFlowProvider>
      <InnerTeamOrgCanvas {...props} />
    </ReactFlowProvider>
  );
}
