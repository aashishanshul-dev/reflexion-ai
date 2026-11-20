import React, { useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Compass,
  LogOut,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import type { DemoLead } from '../lib/demoData';
import { DEMO_STORIES, DEMO_STORY_IDS, type DemoStoryCopy, type DemoStoryId } from '../lib/demoStories';

export type DemoTabTarget =
  | 'MEDITATE_STUDIO'
  | 'MY_TASKS'
  | 'LIVE_OPS'
  | 'BOSS_REVIEW'
  | 'TEAM_VIEW'
  | 'ANALYTICS_ROSTER'
  | 'SOPS_MEMORY';

export interface DemoWalkthroughStep {
  id: string;
  title: string;
  summary: string;
  done: boolean;
  actionLabel: string;
  onAction: () => void;
}

interface DemoSandboxBarProps {
  lead: DemoLead;
  steps: DemoWalkthroughStep[];
  samplePrompts: Array<{ id: string; label: string; text: string }>;
  onTrySamplePrompt: (text: string) => void;
  onResetDemo: () => void;
  onExitDemo: () => void;
  onJumpToTab: (tab: DemoTabTarget) => void;
  /** The sample business shown and its words. */
  story: DemoStoryCopy;
  /** Switch to the other sample business (starts it fresh). */
  onSwitchStory: (id: DemoStoryId) => void;
}

export const DemoSandboxBar: React.FC<DemoSandboxBarProps> = ({
  lead,
  steps,
  samplePrompts,
  onTrySamplePrompt,
  onResetDemo,
  onExitDemo,
  onJumpToTab,
  story,
  onSwitchStory,
}) => {
  const [openPanel, setOpenPanel] = useState<'NONE' | 'STORY' | 'TOUR'>('NONE');
  const completedCount = steps.filter((s) => s.done).length;

  return (
    <div className="border-b border-hairline bg-paper">
      {/* Slim Top Sandbox Strip (non-sticky so mobile sticky chrome remains minimal) */}
      <div className="px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs min-w-0">
          <span className="font-semibold text-signal-ink whitespace-nowrap">Demo Sandbox</span>
          <span aria-hidden="true" className="text-hairline-strong">·</span>
          <label className="sr-only" htmlFor="demo-story-switch">Sample business</label>
          <select
            id="demo-story-switch"
            value={story.id}
            onChange={(e) => onSwitchStory(e.target.value as DemoStoryId)}
            className="max-w-[16rem] truncate rounded-lg border border-hairline bg-surface px-2 py-1 text-xs font-medium text-ink focus:border-signal focus:outline-none"
            title="Switch the sample business (starts it fresh)"
          >
            {DEMO_STORY_IDS.map((id) => (
              <option key={id} value={id}>
                {DEMO_STORIES[id].businessName} — {DEMO_STORIES[id].switchLabel}
              </option>
            ))}
          </select>
          <span aria-hidden="true" className="hidden sm:inline text-hairline-strong">·</span>
          <span className="hidden sm:inline text-slate truncate">
            Guest: {lead.name}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setOpenPanel((p) => (p === 'STORY' ? 'NONE' : 'STORY'))}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              openPanel === 'STORY'
                ? 'border-signal-border bg-signal-soft text-signal-ink'
                : 'border-hairline bg-surface text-ink hover:bg-surface-muted'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5 text-signal" />
            <span>Business Story</span>
            {openPanel === 'STORY' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>

          <button
            type="button"
            onClick={() => setOpenPanel((p) => (p === 'TOUR' ? 'NONE' : 'TOUR'))}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 tabular-nums ${
              openPanel === 'TOUR'
                ? 'border-signal-border bg-signal-soft text-signal-ink'
                : 'border-hairline bg-surface text-ink hover:bg-surface-muted'
            }`}
          >
            <Compass className="h-3.5 w-3.5 text-signal" />
            <span>Walkthrough {completedCount}/{steps.length}</span>
            {openPanel === 'TOUR' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>

          <button
            type="button"
            onClick={onResetDemo}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-surface-muted transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5 text-slate" />
            <span>Reset Demo</span>
          </button>

          <button
            type="button"
            onClick={onExitDemo}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs font-semibold text-slate hover:text-ink hover:bg-surface-muted transition-colors whitespace-nowrap shrink-0"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Exit Demo</span>
          </button>
        </div>
      </div>

      {/* Collapsible Business Story + Quick-Try Prompts Panel */}
      {openPanel === 'STORY' && (
        <div className="border-t border-hairline bg-surface px-4 sm:px-6 py-4 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            <div className="lg:col-span-6 space-y-2.5">
              <h2 className="text-sm font-bold text-ink font-display">
                {story.businessName} — Quick Story
              </h2>
              <ul className="space-y-1.5 text-xs text-slate leading-relaxed list-disc pl-4">
                {story.storyBullets.map((b) => (
                  <li key={b.label}>
                    <strong>{b.label}:</strong> {b.text}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOpenPanel('NONE');
                    onJumpToTab('TEAM_VIEW');
                  }}
                  className="rounded-lg border border-hairline bg-paper px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-muted transition-colors whitespace-nowrap"
                >
                  {story.teamButtonLabel}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenPanel('NONE');
                    onJumpToTab('SOPS_MEMORY');
                  }}
                  className="rounded-lg border border-hairline bg-paper px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-muted transition-colors whitespace-nowrap"
                >
                  Adjust Temperature &amp; Prompts
                </button>
              </div>
            </div>

            <div className="lg:col-span-6 space-y-2">
              <p className="text-xs font-semibold text-ink">
                Try sending a sample request in Meditate (pre-fills the input box)
              </p>
              <div className="space-y-2">
                {samplePrompts.map((sample) => (
                  <div
                    key={sample.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-hairline bg-paper px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold text-ink">{sample.label}</p>
                      <p className="text-xs text-slate truncate">{sample.text}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenPanel('NONE');
                        onTrySamplePrompt(sample.text);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg bg-signal px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-signal-hover transition-colors whitespace-nowrap shrink-0"
                    >
                      <Sparkles className="h-3 w-3" />
                      <span>Load in Meditate</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Collapsible 6-Step Interactive Walkthrough */}
      {openPanel === 'TOUR' && (
        <div className="border-t border-hairline bg-surface px-4 sm:px-6 py-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {steps.map((step, index) => (
              <div
                key={step.id}
                className={`rounded-xl border p-3.5 flex flex-col justify-between gap-3 ${
                  step.done ? 'border-ok-border bg-ok-soft/40' : 'border-hairline bg-paper'
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate tabular-nums">
                      Step {index + 1} of {steps.length}
                    </span>
                    {step.done && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-ok">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Explored
                      </span>
                    )}
                  </div>
                  <h3 className="text-xs font-bold text-ink">{step.title}</h3>
                  <p className="text-[11px] text-slate leading-relaxed">{step.summary}</p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setOpenPanel('NONE');
                    step.onAction();
                  }}
                  className="self-start rounded-lg border border-hairline-strong bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:bg-signal-soft hover:border-signal-border hover:text-signal-ink transition-colors whitespace-nowrap"
                >
                  {step.actionLabel}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
