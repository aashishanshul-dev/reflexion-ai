import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  MessageSquare,
  Network,
  ShieldCheck,
} from 'lucide-react';
import { HourglassXMark, ReflexionWordmark } from './BrandLogo';
import type { DemoLead } from '../lib/demoData';
import { DEMO_STORIES, DEMO_STORY_IDS, type DemoStoryCopy, type DemoStoryId } from '../lib/demoStories';
import { registerDemoLeadApi } from '../services/dataService';

interface DemoEntryScreenProps {
  canReturnToSignIn: boolean;
  onReturnToSignIn: () => void;
  onDemoReady: (lead: DemoLead) => void;
  /** The sample business to show. */
  story: DemoStoryCopy;
  onChooseStory: (id: DemoStoryId) => void;
}

export const DemoEntryScreen: React.FC<DemoEntryScreenProps> = ({
  canReturnToSignIn,
  onReturnToSignIn,
  onDemoReady,
  story,
  onChooseStory,
}) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const lead = await registerDemoLeadApi({ name, email, phone });
      onDemoReady(lead);
    } catch (err: any) {
      setError(err?.message || 'Please check your name, email, and phone number.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-paper text-ink flex items-center justify-center p-4 sm:p-6 lg:p-10 font-sans">
      <div className="w-full max-w-5xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl border border-hairline bg-surface flex items-center justify-center shadow-[var(--shadow-card)]">
              <HourglassXMark variant="orange" className="h-6 w-6" />
            </div>
            <ReflexionWordmark size="md" />
          </div>

          {canReturnToSignIn && (
            <button
              type="button"
              onClick={onReturnToSignIn}
              className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-xs font-semibold text-ink hover:bg-surface-muted transition-colors whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Back to Sign In</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* Left Column: Business Story & How It Works */}
          <section className="lg:col-span-7 rounded-2xl border border-hairline bg-surface p-6 sm:p-8 shadow-[var(--shadow-card)] flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="text-xs font-medium text-slate flex flex-wrap items-center gap-2">
                <span className="font-semibold text-signal-ink">Interactive Product Walkthrough</span>
                <span aria-hidden="true">·</span>
                <span>{story.kindLine}</span>
              </div>

              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Choose a sample business">
                {DEMO_STORY_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={story.id === id}
                    onClick={() => onChooseStory(id)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      story.id === id
                        ? 'border-signal-border bg-signal-soft text-signal-ink'
                        : 'border-hairline bg-paper text-slate hover:text-ink hover:bg-surface-muted'
                    }`}
                  >
                    {DEMO_STORIES[id].switchLabel}
                  </button>
                ))}
              </div>

              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink font-display">
                {story.businessName}
              </h1>

              <p className="text-sm text-slate leading-relaxed">{story.tagline}</p>

              <div className="rounded-xl border border-hairline bg-paper p-4 space-y-2">
                <p className="text-xs font-semibold text-ink">
                  What is already happening right now
                </p>
                <p className="text-xs text-slate leading-relaxed">{story.happeningNow}</p>
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t border-hairline">
              <p className="text-xs font-semibold text-ink">Try the full app in 3 simple steps</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-hairline bg-paper p-3.5 space-y-1.5">
                  <Brain className="h-4 w-4 text-signal" />
                  <p className="text-xs font-semibold text-ink">1. Type in Meditate</p>
                  <p className="text-[11px] text-slate leading-relaxed">
                    Say or type any plain instruction, in English or Hinglish, and watch it become tasks for the right people.
                  </p>
                </div>
                <div className="rounded-xl border border-hairline bg-paper p-3.5 space-y-1.5">
                  <Network className="h-4 w-4 text-signal" />
                  <p className="text-xs font-semibold text-ink">2. Check Team &amp; Live Ops</p>
                  <p className="text-[11px] text-slate leading-relaxed">
                    See the team chart, tasks waiting on earlier steps, and what is due when.
                  </p>
                </div>
                <div className="rounded-xl border border-hairline bg-paper p-3.5 space-y-1.5">
                  <MessageSquare className="h-4 w-4 text-signal" />
                  <p className="text-xs font-semibold text-ink">3. WhatsApp &amp; AI Settings</p>
                  <p className="text-[11px] text-slate leading-relaxed">
                    Read staff replies, approve spending in Boss Reviews, and tune Gemini model settings.
                  </p>
                </div>
              </div>

              <div className="pt-2 flex flex-wrap items-center gap-2 text-xs text-slate tabular-nums">
                {story.counts.map((c, i) => (
                  <React.Fragment key={c}>
                    {i > 0 && <span aria-hidden="true">·</span>}
                    <span>{c}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </section>

          {/* Right Column: Guest Access Registration */}
          <section className="lg:col-span-5 rounded-2xl border border-hairline bg-surface p-6 sm:p-8 shadow-[var(--shadow-card)] flex flex-col justify-between">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-1.5">
                <h2 className="text-lg font-bold text-ink font-display">
                  Enter the live demo workspace
                </h2>
                <p className="text-xs text-slate leading-relaxed">
                  Share your contact details below to launch the sandbox. Everything stays isolated on sample {story.businessName} data.
                </p>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-xl border border-danger-border bg-danger-soft px-3.5 py-2.5 text-xs font-medium text-danger"
                >
                  {error}
                </p>
              )}

              <div className="space-y-4">
                <div>
                  <label htmlFor="demo-guest-name" className="block text-xs font-semibold text-ink mb-1.5">
                    Full Name
                  </label>
                  <input
                    id="demo-guest-name"
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Riya Verma"
                    className="w-full rounded-xl border border-hairline-strong bg-paper px-3.5 py-2.5 text-sm text-ink placeholder:text-slate/60 focus:border-signal focus:bg-surface focus:outline-none transition-colors"
                  />
                </div>

                <div>
                  <label htmlFor="demo-guest-email" className="block text-xs font-semibold text-ink mb-1.5">
                    Email Address
                  </label>
                  <input
                    id="demo-guest-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="e.g. riya@company.com"
                    className="w-full rounded-xl border border-hairline-strong bg-paper px-3.5 py-2.5 text-sm text-ink placeholder:text-slate/60 focus:border-signal focus:bg-surface focus:outline-none transition-colors"
                  />
                </div>

                <div>
                  <label htmlFor="demo-guest-phone" className="block text-xs font-semibold text-ink mb-1.5">
                    Phone Number
                  </label>
                  <input
                    id="demo-guest-phone"
                    type="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="e.g. +91 98201 55443"
                    className="w-full rounded-xl border border-hairline-strong bg-paper px-3.5 py-2.5 text-sm text-ink placeholder:text-slate/60 focus:border-signal focus:bg-surface focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <p className="text-[11px] text-slate leading-relaxed">
                We&apos;ll use these details only to follow up about OpsCommand AI. We never share them.
              </p>

              <button
                type="submit"
                disabled={submitting}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-signal px-4 py-3 text-sm font-semibold text-white hover:bg-signal-hover transition-colors disabled:opacity-60 whitespace-nowrap"
              >
                <span>{submitting ? 'Preparing Sandbox…' : 'Enter Live Demo Workspace'}</span>
                <ArrowRight className="h-4 w-4 shrink-0" />
              </button>
            </form>

            <div className="pt-5 mt-5 border-t border-hairline flex items-start gap-2.5 text-[11px] text-slate leading-relaxed">
              <ShieldCheck className="h-4 w-4 text-ok shrink-0 mt-0.5" />
              <span>
                Sandbox edits live only in your browser session with a 1-click Reset button and never touch live customer workspaces.
              </span>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
};
