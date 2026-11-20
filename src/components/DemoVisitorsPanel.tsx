import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Search, Trash2, Users } from 'lucide-react';
import {
  buildDemoVisitorsCsv,
  computeDemoVisitorMetrics,
  filterDemoVisitors,
  formatVisitorDateTime,
  type DemoVisitorRecord,
} from '../lib/demoLeadsAnalytics';
import { deleteDemoVisitorApi, fetchDemoVisitorsApi } from '../services/dataService';

interface DemoVisitorsPanelProps {
  timezone?: string;
  onNotify?: (msg: string) => void;
}

export const DemoVisitorsPanel: React.FC<DemoVisitorsPanelProps> = ({
  timezone,
  onNotify,
}) => {
  const [visitors, setVisitors] = useState<DemoVisitorRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredDayIso, setHoveredDayIso] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadVisitors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchDemoVisitorsApi();
      setVisitors(list);
    } catch (err: any) {
      setError(err?.message || 'Could not load demo visitors.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVisitors();
  }, [loadVisitors]);

  const metrics = useMemo(
    () => computeDemoVisitorMetrics(visitors, new Date(), timezone),
    [visitors, timezone]
  );

  const filteredVisitors = useMemo(
    () => filterDemoVisitors(metrics.sortedVisitors, searchQuery),
    [metrics.sortedVisitors, searchQuery]
  );

  const maxDailyCount = useMemo(
    () => Math.max(1, ...metrics.dailySeries.map((d) => d.count)),
    [metrics.dailySeries]
  );

  const hoveredDay = useMemo(
    () => metrics.dailySeries.find((d) => d.dateIso === hoveredDayIso) || null,
    [metrics.dailySeries, hoveredDayIso]
  );

  const handleDownloadCsv = () => {
    const csv = buildDemoVisitorsCsv(filteredVisitors, timezone);
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `demo-visitors-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    onNotify?.(`Downloaded CSV (${filteredVisitors.length} visitor row${filteredVisitors.length === 1 ? '' : 's'}).`);
  };

  const handleConfirmDelete = async (leadId: string) => {
    setDeletingId(leadId);
    try {
      await deleteDemoVisitorApi(leadId);
      setVisitors((prev) => prev.filter((v) => v.leadId !== leadId));
      setConfirmDeleteId(null);
      onNotify?.('Deleted visitor entry.');
    } catch (err: any) {
      setError(err?.message || 'Could not delete visitor entry.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-ink font-display">Demo Visitors</h2>
          <p className="text-xs text-slate mt-0.5">
            Registered guests who unlocked the Demo Sandbox, plus count-only AI activity. Visible only to authorized owners.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadVisitors()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-hairline-strong bg-surface px-3.5 py-2 text-xs font-semibold text-ink hover:bg-paper transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadCsv}
            disabled={loading || filteredVisitors.length === 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-signal-hover transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Download CSV</span>
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-danger-border bg-danger-soft px-4 py-3 text-xs text-danger"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void loadVisitors()}
            className="self-start sm:self-auto rounded-lg border border-danger-border bg-surface px-3 py-1 font-semibold text-danger hover:bg-paper whitespace-nowrap"
          >
            Try Again
          </button>
        </div>
      )}

      {/* 4 KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Registered', value: metrics.total },
          { label: 'Today', value: metrics.today },
          { label: 'Last 7 Days', value: metrics.last7Days },
          { label: 'Last 30 Days', value: metrics.last30Days },
        ].map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-2xl border border-hairline bg-surface p-5 space-y-1"
          >
            <p className="text-xs font-medium text-slate">{kpi.label}</p>
            <p className="text-2xl font-bold text-ink font-display tabular-nums">
              {loading ? '—' : kpi.value}
            </p>
          </div>
        ))}
      </div>

      {/* 30-Day Daily Registrations Chart */}
      <div className="rounded-2xl border border-hairline bg-surface p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-ink font-display">
              Registrations Over the Last 30 Days
            </h3>
            <p className="text-xs text-slate">Daily sign-ups across the past 30 calendar days.</p>
          </div>
          <p className="text-xs font-medium text-ink tabular-nums min-h-[1rem]">
            {hoveredDay
              ? `${hoveredDay.label}: ${hoveredDay.count} visitor${hoveredDay.count === 1 ? '' : 's'}`
              : `${metrics.last30Days} in the last 30 days`}
          </p>
        </div>

        <div
          className="flex items-end gap-1 sm:gap-1.5 h-36 pt-4 border-b border-hairline pb-1"
          role="img"
          aria-label="Daily demo visitor registrations over the last 30 days"
        >
          {metrics.dailySeries.map((day) => {
            const pct = day.count === 0 ? 0 : Math.max(8, Math.round((day.count / maxDailyCount) * 100));
            const isHovered = hoveredDayIso === day.dateIso;
            return (
              <div
                key={day.dateIso}
                onMouseEnter={() => setHoveredDayIso(day.dateIso)}
                onMouseLeave={() => setHoveredDayIso(null)}
                title={`${day.label} (${day.dateIso}): ${day.count}`}
                className="flex-1 h-full flex flex-col justify-end items-center group"
              >
                <div
                  className={`w-full rounded-t-sm transition-colors ${
                    day.count === 0
                      ? 'bg-surface-muted h-[3px]'
                      : isHovered
                        ? 'bg-signal-hover'
                        : 'bg-signal'
                  }`}
                  style={day.count > 0 ? { height: `${pct}%` } : undefined}
                />
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate tabular-nums">
          <span>{metrics.dailySeries[0]?.label || ''}</span>
          <span>{metrics.dailySeries[14]?.label || ''}</span>
          <span>{metrics.dailySeries[29]?.label || 'Today'}</span>
        </div>
      </div>

      {/* Searchable Visitor List */}
      <div className="rounded-2xl border border-hairline bg-surface overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-hairline flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-slate tabular-nums">
            <span className="font-semibold text-ink">Visitor Directory</span>
            <span aria-hidden="true">·</span>
            <span>
              {filteredVisitors.length} of {visitors.length}
            </span>
          </div>

          <div className="relative w-full sm:w-80">
            <Search className="h-3.5 w-3.5 text-slate absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, email, or phone..."
              aria-label="Search demo visitors"
              className="w-full rounded-xl border border-hairline-strong bg-paper pl-9 pr-3 py-2 text-xs text-ink placeholder:text-slate/60 focus:border-signal focus:bg-surface focus:outline-none"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-6 space-y-3" aria-busy="true">
            {[1, 2, 3].map((row) => (
              <div key={row} className="h-10 rounded-lg bg-surface-muted animate-pulse" />
            ))}
          </div>
        ) : filteredVisitors.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <Users className="h-6 w-6 text-slate mx-auto" />
            <p className="text-sm font-semibold text-ink">
              {visitors.length === 0 ? 'No demo visitors yet' : 'No matching visitors found'}
            </p>
            <p className="text-xs text-slate max-w-md mx-auto">
              {visitors.length === 0
                ? 'When someone registers through the Demo Sandbox form, their details and count-only AI activity appear here.'
                : 'Try clearing or changing your search filter.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-hairline bg-paper text-[11px] font-semibold text-slate">
                  <th className="py-3 px-4 whitespace-nowrap">Date &amp; Time</th>
                  <th className="py-3 px-4 whitespace-nowrap">Name</th>
                  <th className="py-3 px-4 whitespace-nowrap">Email</th>
                  <th className="py-3 px-4 whitespace-nowrap">Phone</th>
                  <th className="py-3 px-4 whitespace-nowrap">Ran Meditate</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">AI Requests</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {filteredVisitors.map((visitor) => {
                  const isConfirming = confirmDeleteId === visitor.leadId;
                  const isDeleting = deletingId === visitor.leadId;
                  return (
                    <tr key={visitor.leadId} className="hover:bg-paper/60 transition-colors">
                      <td className="py-3 px-4 font-mono tabular-nums text-[11px] text-slate whitespace-nowrap">
                        {formatVisitorDateTime(visitor.registeredAt, timezone)}
                      </td>
                      <td className="py-3 px-4 font-semibold text-ink whitespace-nowrap">
                        {visitor.name}
                      </td>
                      <td className="py-3 px-4 text-ink whitespace-nowrap">
                        {visitor.email}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-[11px] text-ink whitespace-nowrap">
                        {visitor.phone}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`text-xs font-semibold ${
                            visitor.ranMeditate ? 'text-ok' : 'text-slate'
                          }`}
                        >
                          {visitor.ranMeditate ? 'Yes' : 'No'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-ink whitespace-nowrap">
                        {visitor.aiRequestCount}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {isConfirming ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => void handleConfirmDelete(visitor.leadId)}
                              className="rounded-md bg-danger-solid px-2 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                            >
                              {isDeleting ? 'Deleting…' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] font-semibold text-slate hover:text-ink"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(visitor.leadId)}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-slate hover:text-danger hover:bg-danger-soft transition-colors"
                            aria-label={`Remove ${visitor.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Remove</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
