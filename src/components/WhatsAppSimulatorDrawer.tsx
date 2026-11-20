import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCheck,
  Clock,
  FileVideo,
  Image as ImageIcon,
  Mic,
  MicOff,
  Paperclip,
  Pause,
  Play,
  Send,
  Sparkles,
  Timer,
  Trash2,
  Volume2,
  X,
  Zap,
} from 'lucide-react';
import {
  BufferedMediaType,
  InboundMessageBuffer,
  OpsDatabaseState,
} from '../types/ops';
import { isWithin24HrWindow, validateMediaAttachment } from '../lib/opsEngine';
import { fetchVoiceNoteApi, runBufferBatchProcessorApi } from '../services/dataService';
import { pickDefaultChatPhone } from '../lib/simulatorChat';

interface WhatsAppSimulatorDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  state: OpsDatabaseState;
  onEnqueueMessage: (
    phone: string,
    msg: Omit<InboundMessageBuffer['messages'][number], 'id' | 'timestamp'>
  ) => void;
  onDeleteBufferedMessage: (phone: string, msgId: string) => void;
  onOversizedVideoGuard: (phone: string, fileName: string, fileSizeMB: number) => void;
  onApplyProcessedBuffer: (phone: string, aiResult: any) => void;
  onRunJobsTick?: () => void;
  onNotify: (msg: string) => void;
  /** The owner's own WhatsApp: decisions (1/2/3), "brief", or a note for Meditate. */
  onOwnerMessage?: (phone: string, text: string) => void;
}

const UNREGISTERED_TEST_PHONE = 'UNREGISTERED_SIM_SENDER';

// Tiny 1x1 emerald PNG base64 for photo simulation
const DEMO_PROOF_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface VoicePresetItem {
  label: string;
  text: string;
  duration: number;
}

export const WhatsAppSimulatorDrawer: React.FC<WhatsAppSimulatorDrawerProps> = ({
  isOpen,
  onClose,
  state,
  onEnqueueMessage,
  onDeleteBufferedMessage,
  onOversizedVideoGuard,
  onApplyProcessedBuffer,
  onRunJobsTick,
  onNotify,
  onOwnerMessage,
}) => {
  const personaOptions = useMemo(() => {
    return Object.values(state.team_members).filter(
      (m) => m.authorityLevel !== 'BOSS' && m.authorityLevel !== 'OWNER'
    );
  }, [state.team_members]);

  const fallbackAllMembers = useMemo(
    () => Object.values(state.team_members),
    [state.team_members]
  );
  const ownerOptions = useMemo(
    () =>
      Object.values(state.team_members).filter(
        (m) => m.authorityLevel === 'BOSS' || m.authorityLevel === 'OWNER'
      ),
    [state.team_members]
  );

  const [selectedPhone, setSelectedPhone] = useState<string>(() =>
    pickDefaultChatPhone(state, personaOptions.map((m) => m.phone))
  );

  // Each time the panel opens, show the chat with waiting (unread) messages first.
  const wasOpenRef = useRef(isOpen);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const next = pickDefaultChatPhone(state, personaOptions.map((m) => m.phone));
      if (next) setSelectedPhone(next);
    }
    wasOpenRef.current = isOpen;
    // Only on open; later state changes must not move the user away from the chat they picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const [messageInput, setMessageInput] = useState('');
  // Voice notes made on demand (Gemini TTS); kept as blob URLs for this session only.
  const voiceUrlsRef = useRef(new Map<string, string>());
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const [voiceBusyId, setVoiceBusyId] = useState<string | null>(null);
  const [voicePlayingId, setVoicePlayingId] = useState<string | null>(null);
  const playVoiceBrief = async (msgId: string, text: string, language: string) => {
    if (voicePlayingId === msgId && voiceAudioRef.current) {
      voiceAudioRef.current.pause();
      setVoicePlayingId(null);
      return;
    }
    try {
      let url = voiceUrlsRef.current.get(msgId);
      if (!url) {
        setVoiceBusyId(msgId);
        const { audioBase64, mimeType } = await fetchVoiceNoteApi({
          text,
          language,
          teamMembers: Object.values(state.team_members),
          ownerProfile: state.owner_profile,
        });
        const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        voiceUrlsRef.current.set(msgId, url);
      }
      voiceAudioRef.current?.pause();
      const audio = new Audio(url);
      voiceAudioRef.current = audio;
      audio.onended = () => setVoicePlayingId(null);
      setVoicePlayingId(msgId);
      await audio.play();
    } catch (err: any) {
      onNotify(err?.message || 'Could not play the voice note.');
      setVoicePlayingId(null);
    } finally {
      setVoiceBusyId(null);
    }
  };
  const [isFlushing, setIsFlushing] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Ensure selectedPhone stays synced if roster updates
  useEffect(() => {
    if (selectedPhone === UNREGISTERED_TEST_PHONE) return;
    if (!state.team_members[selectedPhone]) {
      const nextDefault = personaOptions[0]?.phone || fallbackAllMembers[0]?.phone || '';
      if (nextDefault && nextDefault !== selectedPhone) {
        setSelectedPhone(nextDefault);
      }
    }
  }, [state.team_members, selectedPhone, personaOptions, fallbackAllMembers]);

  // Real voice recording state
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [voiceDuration, setVoiceDuration] = useState(0);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [showVoicePresets, setShowVoicePresets] = useState(false);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const baseVoiceTextRef = useRef<string>('');

  useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isOpen]);

  // Voice recording timer
  useEffect(() => {
    let interval: any;
    if (isRecordingVoice) {
      interval = setInterval(() => {
        setVoiceDuration((d) => d + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecordingVoice]);

  const selectedMember = state.team_members[selectedPhone];
  const isOwnerChat = Boolean(
    onOwnerMessage &&
      selectedMember &&
      (selectedMember.authorityLevel === 'OWNER' || selectedMember.authorityLevel === 'BOSS')
  );
  const activeBuffer = state.inbound_message_buffer[selectedPhone];

  const dynamicVoicePresets = useMemo<VoicePresetItem[]>(() => {
    const memberOpenTask = state.tasks.find(
      (t) =>
        t.raci.R === selectedPhone &&
        t.isFrozen &&
        (t.status === 'IN_PROGRESS' || t.status === 'PENDING' || t.status === 'PARTIALLY_DONE')
    );
    const accountablePhone =
      memberOpenTask?.raci.A || state.owner_profile?.defaultAccountablePhone || '';
    const supervisor = state.team_members[accountablePhone];
    const supervisorRef = supervisor
      ? `${supervisor.roleTitle} (${supervisor.slotId || 'Supervisor'})`
      : 'the assigned supervisor';
    const taskLabel = memberOpenTask?.shortTag || 'assigned task';
    const isEnglish = selectedMember?.preferredLanguage === 'ENGLISH';

    if (isEnglish) {
      return [
        {
          label: `Started Work (${taskLabel})`,
          text: `Voice Note: "Reached the work location and started executing [${taskLabel}]."`,
          duration: 6,
        },
        {
          label: 'Budget Variance Query',
          text: `Voice Note: "Vendor quoted an extra amount on [${taskLabel}] for upgraded material; please confirm approval."`,
          duration: 8,
        },
        {
          label: `Handover to ${supervisor?.slotId || 'Supervisor'}`,
          text: `Voice Note: "Completed my stage for [${taskLabel}] and handed over materials on site to ${supervisorRef}."`,
          duration: 5,
        },
        {
          label: 'Final Verification Pass',
          text: `Voice Note: "All checklist items for [${taskLabel}] are completed and tested successfully."`,
          duration: 7,
        },
      ];
    }

    return [
      {
        label: `Work Started (${taskLabel})`,
        text: `Voice Note: "Sahab location par pahunch gaya hu, [${taskLabel}] ka pehla step complete kar liya hai."`,
        duration: 6,
      },
      {
        label: 'Rate / Budget Approval Query',
        text: `Voice Note: "Sir [${taskLabel}] mein vendor extra rate maang raha hai, approval chahiye."`,
        duration: 8,
      },
      {
        label: `Handover to ${supervisor?.slotId || 'Supervisor'}`,
        text: `Voice Note: "Saara samaan aur site ka kaam ${supervisorRef} ko hand over kar diya hai."`,
        duration: 5,
      },
      {
        label: 'Checklist Test Passed',
        text: `Voice Note: "[${taskLabel}] pura install aur check ho gaya hai, sab theek chal raha hai."`,
        duration: 7,
      },
    ];
  }, [state.tasks, state.team_members, state.owner_profile, selectedPhone, selectedMember]);

  const feedMessages = useMemo(
    () => state.whatsapp_messages.filter((m) => m.employeePhone === selectedPhone),
    [state.whatsapp_messages, selectedPhone]
  );

  useEffect(() => {
    if (isOpen) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [feedMessages.length, activeBuffer?.messages.length, isOpen, selectedPhone]);

  const countdownDisplay = useMemo(() => {
    if (!activeBuffer) {
      return selectedMember?.bufferMode === 'INSTANT_NUDGE_ACTIVE'
        ? 'Instant Nudge Active (2m window)'
        : '15:00 Batching Ready';
    }
    const diffSec = Math.max(
      0,
      Math.floor((new Date(activeBuffer.processAt).getTime() - nowTick) / 1000)
    );
    const mins = String(Math.floor(diffSec / 60)).padStart(2, '0');
    const secs = String(diffSec % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }, [activeBuffer, nowTick, selectedMember]);

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageInput.trim()) return;
    if (isOwnerChat && onOwnerMessage) {
      onOwnerMessage(selectedPhone, messageInput.trim());
      setMessageInput('');
      return;
    }
    onEnqueueMessage(selectedPhone, {
      type: 'text',
      textContent: messageInput.trim(),
    });
    setMessageInput('');
  };

  const startVoiceRecording = async () => {
    const initialText = messageInput.trim();
    baseVoiceTextRef.current = initialText;
    setVoiceTranscript(initialText);
    setVoiceDuration(0);
    setIsRecordingVoice(true);
    setShowVoicePresets(false);

    // Request microphone access via getUserMedia
    let hasMediaStream = false;
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;
        hasMediaStream = true;
      }
    } catch (err: any) {
      console.warn('Microphone permission request error in drawer:', err);
    }

    // Try SpeechRecognition with zero-stutter loop
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRec) {
      try {
        const rec = new SpeechRec();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-IN'; // Indian English & Hinglish accent

        rec.onresult = (event: any) => {
          let finalTranscript = '';
          let interimTranscript = '';
          for (let i = 0; i < event.results.length; i++) {
            const item = event.results[i];
            const piece = item[0]?.transcript || '';
            if (item.isFinal) {
              finalTranscript += piece;
            } else {
              interimTranscript += piece;
            }
          }
          const spoken = `${finalTranscript}${interimTranscript}`.trim();
          if (spoken) {
            const base = baseVoiceTextRef.current.trim();
            const delimiter = base ? ' ' : '';
            setVoiceTranscript(base ? `${base}${delimiter}${spoken}` : spoken);
          }
        };

        rec.onerror = (e: any) => {
          console.warn('SpeechRec error in drawer:', e?.error);
          if (e?.error === 'not-allowed') {
            onNotify('Microphone permission blocked in browser. Using quick voice assistant.');
          }
        };

        rec.start();
        recognitionRef.current = rec;
      } catch (err) {
        console.warn('SpeechRec start failed:', err);
      }
    }

    if (hasMediaStream) {
      onNotify('🎙️ Recording WhatsApp voice note... Speak in Hinglish or English.');
    } else {
      onNotify('🎙️ Recording voice note (voice assistant active)...');
    }
  };

  const stopAndSendVoiceRecording = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setIsRecordingVoice(false);

    const spokenText =
      voiceTranscript.trim() ||
      messageInput.trim() ||
      'Sahab kaam start kar diya hai aur market se saman le liya hai.';

    const finalNoteText = spokenText.startsWith('Voice Note:')
      ? spokenText
      : `Voice Note: "${spokenText}"`;

    const dur = Math.max(2, voiceDuration || 4);

    // The owner's voice note is a brain dump or a reply: handled like typed text.
    if (isOwnerChat && onOwnerMessage) {
      onOwnerMessage(selectedPhone, spokenText.replace(/^Voice Note:\s*"?|"$/g, '').trim());
      setMessageInput('');
      setVoiceTranscript('');
      setVoiceDuration(0);
      setIsRecordingVoice(false);
      return;
    }

    onEnqueueMessage(selectedPhone, {
      type: 'audio',
      fileName: `voice_note_${dur}s.m4a`,
      mimeType: 'audio/mp4',
      fileSizeMB: Math.max(0.1, Number((dur * 0.04).toFixed(2))),
      textContent: finalNoteText,
    });

    setMessageInput('');
    setVoiceTranscript('');
    setVoiceDuration(0);
    onNotify(`Inbound Hinglish voice note (${dur}s) recorded into 15m buffer.`);
  };

  const cancelVoiceRecording = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setIsRecordingVoice(false);
    setVoiceTranscript('');
    setVoiceDuration(0);
    onNotify('Voice note discarded.');
  };

  const handleSelectVoicePreset = (preset: VoicePresetItem) => {
    setShowVoicePresets(false);
    onEnqueueMessage(selectedPhone, {
      type: 'audio',
      fileName: `voice_note_${preset.duration}s.m4a`,
      mimeType: 'audio/mp4',
      fileSizeMB: 0.35,
      textContent: preset.text,
    });
    onNotify(`Selected voice note (${preset.duration}s) queued into 15m buffer.`);
  };

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const sizeMB = file.size / (1024 * 1024);
    const mime = file.type || 'application/octet-stream';
    const check = validateMediaAttachment(sizeMB, mime);

    if (!check.allowedInRam) {
      onOversizedVideoGuard(selectedPhone, file.name, sizeMB);
      onNotify(
        `15MB Video Guard triggered (${sizeMB.toFixed(1)} MB) — routed directly to Boss Review Queue!`
      );
      return;
    }

    let mediaType: BufferedMediaType = 'image';
    if (mime.startsWith('audio/')) mediaType = 'audio';
    else if (mime.startsWith('video/')) mediaType = 'video';

    const reader = new FileReader();
    reader.onload = () => {
      const resultStr = typeof reader.result === 'string' ? reader.result : '';
      const base64Clean = resultStr.includes(',') ? resultStr.split(',')[1] : resultStr;
      onEnqueueMessage(selectedPhone, {
        type: mediaType,
        fileName: file.name,
        mimeType: mime,
        base64Data: base64Clean,
        fileSizeMB: Number(sizeMB.toFixed(2)),
        textContent: messageInput.trim() || `Attached ${mediaType}: ${file.name}`,
      });
      setMessageInput('');
    };
    reader.readAsDataURL(file);
  };

  const handleFlushNow = async () => {
    if (!selectedMember || !activeBuffer || activeBuffer.messages.length === 0) return;
    setIsFlushing(true);
    try {
      const openTasksForMember = state.tasks.filter(
        (t) =>
          t.raci.R === selectedPhone &&
          t.isFrozen &&
          (t.status === 'IN_PROGRESS' || t.status === 'PENDING' || t.status === 'PARTIALLY_DONE')
      );

      const aiRes = await runBufferBatchProcessorApi({
        tenantId: state.tenantId,
        employee: selectedMember,
        teamMembers: fallbackAllMembers,
        buffer: activeBuffer,
        activeTasks: openTasksForMember,
        systemMemory: state.system_memory,
        principalPrompts: state.principal_prompts,
        businessProfile: state.business_profile,
        ownerProfile: state.owner_profile,
        modelTuning: state.model_tuning,
      });

      onApplyProcessedBuffer(selectedPhone, aiRes);
      onNotify(
        aiRes.isNeutralFallback
          ? `Logged ${activeBuffer.messages.length} buffered item(s) -> Update received — needs review.`
          : aiRes.escalateToBossReview
            ? `Processed ${activeBuffer.messages.length} buffered item(s) -> Escalated to Boss Review Queue!`
            : `Processed ${activeBuffer.messages.length} buffered item(s) -> Updated [${aiRes.matchedTaskCode || 'Task'}] (${aiRes.completionPercent}%).`
      );
    } catch (err: any) {
      onNotify(err?.message || 'Failed to process WhatsApp buffer.');
    } finally {
      setIsFlushing(false);
    }
  };

  // Auto-flush WhatsApp buffer when countdown timer reaches 00:00 (processAt <= nowTick)
  useEffect(() => {
    if (!isOpen || isFlushing) return;
    if (activeBuffer && activeBuffer.messages.length > 0) {
      const processAtMs = new Date(activeBuffer.processAt).getTime();
      if (!Number.isNaN(processAtMs) && processAtMs <= nowTick) {
        void handleFlushNow();
      }
    }
  }, [isOpen, isFlushing, activeBuffer, nowTick]);

  if (!isOpen) return null;

  const initials = selectedMember
    ? selectedMember.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '??';

  return (
    <aside
      aria-label="WhatsApp Operations Chat Simulator"
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-hairline bg-surface shadow-[var(--shadow-modal)]"
    >
      {/* WhatsApp / Field Chat Header */}
      <div className="flex items-center justify-between bg-ink px-4 py-3 text-white border-b border-ink-hover">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-signal-hover text-sm font-bold text-white font-display">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold tracking-tight text-white font-display">
                {selectedMember?.name || 'Teammate'}
              </h2>
            </div>
            <p className="truncate text-xs text-white/70 tabular-nums">
              +{selectedPhone} · {selectedMember?.roleTitle || 'Field Team'}
            </p>
          </div>
        </div>

        <button
          type="button"
          aria-label="Close WhatsApp Simulator"
          onClick={onClose}
          className="rounded-full p-1.5 text-white/70 hover:bg-ink-hover hover:text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Switch Teammate Persona Bar */}
      <div className="flex items-center justify-between gap-2 border-b border-hairline bg-paper px-4 py-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-slate font-medium shrink-0">Teammate:</span>
          <select
            aria-label="Select Teammate"
            value={selectedPhone}
            onChange={(e) => setSelectedPhone(e.target.value)}
            className="min-w-0 truncate rounded-md border border-hairline-strong bg-surface px-2 py-1 text-xs font-medium text-ink focus:border-signal focus:outline-none"
          >
            {onOwnerMessage &&
              ownerOptions.map((m) => (
                <option key={m.phone} value={m.phone}>
                  You (owner): {m.name}
                </option>
              ))}
            {personaOptions.map((m) => (
              <option key={m.phone} value={m.phone}>
                {m.name} ({m.roleTitle})
              </option>
            ))}
            <option value={UNREGISTERED_TEST_PHONE}>Unregistered (+91 99999 88888)</option>
          </select>
        </div>

        <div className="flex items-center gap-2 font-medium text-slate shrink-0">
          {selectedMember && (
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${
                isWithin24HrWindow(selectedMember.lastInboundAt)
                  ? 'bg-ok-soft border-ok-border text-ok'
                  : 'bg-warn-soft border-warn-border text-warn'
              }`}
              title="Meta WhatsApp 24-hour customer service window status"
            >
              {isWithin24HrWindow(selectedMember.lastInboundAt) ? '24h Open' : '>24h Template'}
            </span>
          )}
          <span className="flex items-center gap-1 tabular-nums">
            <Timer className="h-3.5 w-3.5 text-signal" />
            <span>{countdownDisplay}</span>
          </span>
          {onRunJobsTick && (
            <button
              type="button"
              onClick={onRunJobsTick}
              className="rounded-md border border-signal-border bg-signal-soft px-2 py-0.5 text-[10px] font-bold text-signal-ink hover:bg-signal-soft/80"
              title="Run scheduled jobs tick"
            >
              Run tick
            </button>
          )}
        </div>
      </div>

      {/* Persona Prompt Hint */}
      {isOwnerChat && (
        <div className="border-b border-signal-border bg-signal-soft px-4 py-2 text-[11px] text-signal-ink leading-relaxed">
          This is your own WhatsApp. Reply <strong>1</strong>, <strong>2</strong> or <strong>3</strong> to a decision,
          send <strong>brief</strong> for today&apos;s summary, or type or speak any note to plan it in Meditate.
        </div>
      )}

      {selectedMember?.personaPrompt && !isOwnerChat && (
        <div className="border-b border-hairline bg-signal-soft/60 px-4 py-1.5 text-[11px] text-ink flex items-center gap-2">
          <span className="font-semibold text-signal-ink shrink-0">Persona Prompt:</span>
          <span className="truncate italic text-slate">{selectedMember.personaPrompt}</span>
        </div>
      )}

      {/* WhatsApp Message Feed (Authentic Wallpaper) */}
      <div className="whatsapp-chat-bg flex-1 overflow-y-auto p-4 space-y-3">
        {feedMessages.length === 0 && !activeBuffer && (
          <div className="my-8 text-center">
            <span className="inline-block rounded-lg bg-surface/95 border border-hairline px-3 py-1.5 text-xs text-slate shadow-[var(--shadow-card)]">
              🔒 Messages are end-to-end encrypted. Operations auto-sync active.
            </span>
          </div>
        )}

        {feedMessages.map((msg) => {
          const isOutbound = msg.direction === 'OUTBOUND';
          const timeStr = new Date(msg.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });

          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isOutbound ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed shadow-[var(--shadow-card)] ${
                  isOutbound
                    ? 'rounded-tr-xs bg-[#D9FDD3] text-ink border border-ok-border'
                    : 'rounded-tl-xs bg-surface text-ink border border-hairline'
                }`}
              >
                {msg.isTemplateMessage && (
                  <div className="mb-1 inline-flex items-center gap-1 rounded bg-warn-soft border border-warn-border px-1.5 py-0.5 text-[10px] font-bold text-warn">
                    📋 24h Template
                  </div>
                )}
                {msg.mediaLabel && (
                  <div className="mb-1 text-xs font-medium text-ok">
                    📎 {msg.mediaLabel}
                  </div>
                )}
                {isOutbound && selectedMember?.prefersVoiceNotes && msg.text && (
                  <button
                    type="button"
                    onClick={() => playVoiceBrief(msg.id, msg.text, selectedMember.preferredLanguage || 'HINDI')}
                    disabled={voiceBusyId === msg.id}
                    className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-ink px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-ink-hover disabled:opacity-60"
                    title="Gemini reads this message aloud as a voice note"
                  >
                    {voicePlayingId === msg.id ? <Pause className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                    {voiceBusyId === msg.id
                      ? 'Making voice note…'
                      : voicePlayingId === msg.id
                        ? 'Pause voice note'
                        : 'Hear as voice note'}
                  </button>
                )}
                {msg.mediaLabel?.includes('Voice') || msg.text?.startsWith('Voice Note:') ? (
                  <div className="space-y-1.5 py-0.5">
                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() =>
                          setPlayingAudioId(playingAudioId === msg.id ? null : msg.id)
                        }
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full shadow-[var(--shadow-card)] transition-colors ${
                          isOutbound
                            ? 'bg-ink text-white hover:bg-ink-hover'
                            : 'bg-signal-hover text-white hover:bg-signal'
                        }`}
                        title={playingAudioId === msg.id ? 'Pause Voice Note' : 'Play Voice Note'}
                      >
                        {playingAudioId === msg.id ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4 fill-current ml-0.5" />
                        )}
                      </button>
                      <div className="flex flex-1 items-center gap-0.5 h-6 px-1">
                        {[12, 18, 8, 22, 14, 20, 10, 16, 24, 12, 18, 14, 8, 16, 20, 10].map(
                          (h, i) => (
                            <div
                              key={i}
                              style={{ height: `${h}px` }}
                              className={`w-1 rounded-full ${
                                playingAudioId === msg.id
                                  ? 'bg-signal animate-pulse'
                                  : isOutbound
                                  ? 'bg-ok-solid/70'
                                  : 'bg-slate/50'
                              }`}
                            />
                          )
                        )}
                      </div>
                      <span className="text-[11px] font-mono font-medium text-slate tabular-nums">
                        {playingAudioId === msg.id ? '0:03' : '0:14'}
                      </span>
                    </div>
                    <div className="text-[12px] italic text-ink pt-1 border-t border-hairline">
                      {msg.text}
                    </div>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap">{msg.text}</div>
                )}
                <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate tabular-nums">
                  <span>{timeStr}</span>
                  {isOutbound && <CheckCheck className="h-3 w-3 text-info" />}
                </div>
              </div>
            </div>
          );
        })}

        {/* Live Inbound Buffer (Staged for 15-min aggregation) */}
        {activeBuffer && activeBuffer.messages.length > 0 && (
          <div className="my-3 rounded-xl border border-warn-border bg-warn-soft p-3 shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between text-xs font-semibold text-warn mb-2">
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-warn" />
                Inbound Buffer ({activeBuffer.messages.length} item{activeBuffer.messages.length > 1 ? 's' : ''})
              </span>
              <span className="font-mono text-[11px] text-warn tabular-nums">
                Flushes in {countdownDisplay}
              </span>
            </div>

            <div className="space-y-1.5">
              {activeBuffer.messages.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-md bg-surface p-2 text-xs text-ink border border-warn-border"
                >
                  <div className="truncate pr-2">
                    {m.type === 'image' && '📷 '}
                    {m.type === 'video' && '🎥 '}
                    {m.type === 'audio' && '🎙️ '}
                    <span className="font-medium text-ink">{m.textContent}</span>
                    {m.fileName && (
                      <span className="text-slate text-[11px]"> ({m.fileName})</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onDeleteBufferedMessage(selectedPhone, m.id)}
                    className="text-slate hover:text-danger"
                    title="Remove item from buffer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={isFlushing}
                onClick={handleFlushNow}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-white shadow-[var(--shadow-card)] hover:bg-ink-hover disabled:opacity-50 transition-colors"
              >
                <Zap className="h-3.5 w-3.5 text-signal" />
                {isFlushing ? 'Inspecting Batch...' : 'Flush & Evaluate Batch Now'}
              </button>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Quick Media Simulation Chips */}
      <div className="border-t border-hairline bg-paper px-3 py-1.5 flex items-center gap-2 overflow-x-auto text-xs text-slate">
        <span className="text-[11px] font-medium text-slate shrink-0">Simulate:</span>
        <button
          type="button"
          onClick={() =>
            onEnqueueMessage(selectedPhone, {
              type: 'image',
              fileName: 'vendor_receipt_proof.png',
              mimeType: 'image/png',
              base64Data: DEMO_PROOF_PNG_BASE64,
              fileSizeMB: 0.12,
              textContent:
                selectedMember?.preferredLanguage === 'ENGLISH'
                  ? 'Uploaded the vendor receipt/invoice photo for verification.'
                  : 'Sir vendor receipt/bill ka clear photo bhej diya hai, check kar lijiye.',
            })
          }
          className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[11px] text-ink border border-hairline hover:bg-surface-muted shrink-0 transition-colors"
        >
          <ImageIcon className="h-3 w-3 text-ok" />
          + Receipt / Bill Photo
        </button>

        <button
          type="button"
          onClick={() =>
            onEnqueueMessage(selectedPhone, {
              type: 'image',
              fileName: 'site_completion_photo.jpg',
              mimeType: 'image/jpeg',
              base64Data: DEMO_PROOF_PNG_BASE64,
              fileSizeMB: 0.28,
              textContent:
                selectedMember?.preferredLanguage === 'ENGLISH'
                  ? 'Work is completed on site; attached completion photo.'
                  : 'Sir kaam pura ho gaya hai, completion photo attach kar di hai.',
            })
          }
          className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[11px] text-ink border border-hairline hover:bg-surface-muted shrink-0 transition-colors"
        >
          <ImageIcon className="h-3 w-3 text-info" />
          + Completion Photo
        </button>

        <button
          type="button"
          onClick={() =>
            onEnqueueMessage(selectedPhone, {
              type: 'text',
              textContent:
                selectedMember?.preferredLanguage === 'ENGLISH'
                  ? 'Vendor is quoting higher than budget; please approve variance or suggest alternate vendor?'
                  : 'Sir vendor extra rate maang raha hai, approve karwa dijiye ya alternate option dekhun?',
            })
          }
          className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[11px] text-ink border border-hairline hover:bg-surface-muted shrink-0 transition-colors"
        >
          ❓ Price Escalation
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setShowVoicePresets((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-md bg-signal-soft px-2 py-0.5 text-[11px] font-medium text-signal-ink border border-signal-border hover:bg-signal-soft/80 shrink-0 transition-colors"
          >
            <Mic className="h-3 w-3 text-signal" />
            🎙️ Voice Presets
          </button>

          {showVoicePresets && (
            <div className="absolute bottom-8 right-0 z-20 w-64 rounded-xl border border-hairline bg-surface p-2 shadow-[var(--shadow-modal)]">
              <div className="mb-1.5 flex items-center justify-between border-b border-hairline pb-1 text-xs font-semibold text-ink">
                <span>Quick Voice Notes ({selectedMember?.slotId || 'Staff'})</span>
                <button
                  type="button"
                  onClick={() => setShowVoicePresets(false)}
                  className="text-slate hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-1">
                {dynamicVoicePresets.map((vp, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSelectVoicePreset(vp)}
                    className="w-full text-left rounded-lg p-1.5 text-xs text-ink hover:bg-signal-soft hover:text-signal-ink transition-colors"
                  >
                    <div className="font-medium text-ink">{vp.label}</div>
                    <div className="text-[10px] text-slate truncate">{vp.text}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* WhatsApp Native Bottom Input Bar or Active Voice Recording Bar */}
      {isRecordingVoice ? (
        <div className="flex items-center justify-between border-t border-danger-border bg-danger-soft px-3 py-2.5 shadow-inner">
          <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
            <span className="flex h-3 w-3 shrink-0 rounded-full bg-danger-solid animate-ping" />
            <span className="font-mono text-xs font-bold text-danger tabular-nums">
              {Math.floor(voiceDuration / 60)}:{(voiceDuration % 60).toString().padStart(2, '0')}
            </span>
            <div className="flex items-center gap-0.5 h-4">
              <div className="w-1 bg-danger-solid animate-bounce rounded-full h-4" />
              <div className="w-1 bg-danger-solid animate-bounce rounded-full h-2 delay-75" />
              <div className="w-1 bg-danger-solid animate-bounce rounded-full h-5 delay-150" />
              <div className="w-1 bg-danger-solid animate-bounce rounded-full h-3 delay-200" />
            </div>
            <p className="truncate text-xs italic text-danger">
              {voiceTranscript || 'Recording voice note... speak in Hinglish/English'}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={cancelVoiceRecording}
              title="Discard Voice Note"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-surface text-slate hover:text-danger border border-hairline transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={stopAndSendVoiceRecording}
              title="Send Voice Note to 15m Buffer"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-white hover:bg-ink-hover shadow-[var(--shadow-card)] transition-colors"
            >
              <Send className="h-4 w-4 text-signal" />
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={handleSendText}
          className="flex items-center gap-2 border-t border-hairline bg-paper px-3 py-2.5"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*"
            className="hidden"
            onChange={handleFileSelected}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Attach photo, video or audio"
            className="rounded-full p-2 text-slate hover:bg-surface-muted hover:text-ink transition-colors"
          >
            <Paperclip className="h-5 w-5" />
          </button>

          <input
            type="text"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            placeholder="Type WhatsApp message in Hinglish / English..."
            className="flex-1 rounded-full border border-hairline-strong bg-surface px-4 py-2 text-sm text-ink placeholder:text-slate/60 focus:border-signal focus:outline-none shadow-[var(--shadow-card)]"
          />

          <button
            type="button"
            onClick={startVoiceRecording}
            title="Record WhatsApp Voice Note"
            className="rounded-full p-2 text-slate hover:bg-surface-muted hover:text-danger transition-colors"
          >
            <Mic className="h-5 w-5" />
          </button>

          <button
            type="submit"
            disabled={!messageInput.trim()}
            title="Send message"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-white shadow-[var(--shadow-card)] hover:bg-ink-hover disabled:opacity-40 transition-colors"
          >
            <Send className="h-4 w-4 text-signal" />
          </button>
        </form>
      )}
    </aside>
  );
};
