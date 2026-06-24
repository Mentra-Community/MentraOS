import React, { useState, useEffect, useRef, memo } from 'react';
import { useMentraAuth } from '../lib/localAuth';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { subscribeChatEvents, askByText } from '../lib/chatChannel';
import '../../shared/channels';
import type { DebugTranscript } from '../../shared/types';
import Markdown from 'react-markdown';
// @ts-ignore - SVG import
import ColorMiraLogo from '../../public/figma-parth-assets/icons/color-mira-logo.svg';
import Settings from './Settings';
import { ChromaticBorder } from '../components/ChromaticBorder';
import { fetchUserSettings } from '../api/settings.api';
import { usePageStack } from '../lib/usePageStack';

/** Shared Red Hat Display stack from the Paper mockup (falls back to system). */
const FONT_STACK = "'RedHatDisplay-Regular_Bold','Red_Hat_Display',system-ui,sans-serif";

/**
 * Frosted color gradient backdrop — replicates the Settings page aesthetic
 * inline (same oklab radial-gradient stack as the Paper mockup). Purely
 * decorative and non-interactive, sits behind all content.
 */
const BACKDROP_GRADIENT =
  'radial-gradient(ellipse 80% 50% at 26% 102% in oklab, oklab(69.7% -0.002 -0.158 / 80%) 0%, oklab(69.7% -0.002 -0.158 / 0%) 60%), radial-gradient(ellipse 72% 48% at 82% 98% in oklab, oklab(70.8% 0.198 0.009 / 82%) 0%, oklab(70.8% 0.198 0.009 / 0%) 60%), radial-gradient(ellipse 92% 56% at 52% 114% in oklab, oklab(77.2% 0.094 0.116 / 88%) 0%, oklab(77.2% 0.094 0.116 / 0%) 56%), radial-gradient(ellipse 58% 44% at 60% 86% in oklab, oklab(70.7% 0.096 -0.157 / 48%) 0%, oklab(70.7% 0.096 -0.157 / 0%) 62%)';

/** Subtle bottom vignette overlay (from the Paper mockup). */
const VIGNETTE_GRADIENT =
  'radial-gradient(ellipse 115% 70% at 50% 38% in oklab, oklab(100% 0 0 / 0%) 58%, oklab(15.2% 0.002 -0.008 / 5%) 100%)';

interface MessageAction {
  type: 'open_url';
  kind: 'oauth_connect' | 'link';
  url: string;
}

interface Message {
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
  timestamp: Date;
  image?: string;
  actions?: MessageAction[];
}

/** Friendly label for an action button, derived from its kind/host. */
function actionLabel(action: MessageAction): string {
  if (action.kind === 'oauth_connect') {
    const m = action.url.toLowerCase().match(/(gmail|googlecalendar|calendar|google|slack|github|notion|linear)/);
    if (m) {
      const svc = m[1] === 'googlecalendar' ? 'Google Calendar' : m[1].charAt(0).toUpperCase() + m[1].slice(1);
      return `Connect ${svc}`;
    }
    return 'Connect account';
  }
  try {
    return new URL(action.url).host.replace(/^www\./, '');
  } catch {
    return 'Open link';
  }
}

interface ChatInterfaceProps {
  userId: string;
  recipientId: string;
  onEnableDebugMode?: () => void;
  /** Dev-only: when true, show a text input to ask questions without voice. */
  debugMode?: boolean;
  /** Device top safe-area inset (notch / status bar), in px, from useSafeArea(). */
  safeAreaTop?: number;
  /** Accepted for caller-compat only; light-only app ignores these. */
  isDarkMode?: boolean;
  onToggleDarkMode?: () => void;
}

const THINKING_WORDS = [
  'doodling',
  'vibing',
  'cooking',
  'pondering',
  'brewing',
  'crafting',
  'dreaming',
  'computing',
  'processing',
  'brainstorming',
  'conjuring',
  'imagining',
];

/** Pink star glyph used as the Mentra label mark on assistant replies. */
function MentraStar({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <path
        d="M12 1.6 L13.9 8.2 C14.2 9.1 14.9 9.8 15.8 10.1 L22.4 12 L15.8 13.9 C14.9 14.2 14.2 14.9 13.9 15.8 L12 22.4 L10.1 15.8 C9.8 14.9 9.1 14.2 8.2 13.9 L1.6 12 L8.2 10.1 C9.1 9.8 9.8 9.1 10.1 8.2 Z"
        fill="#FF5FA2"
      />
    </svg>
  );
}

const formatTime = (ts: Date) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * "Hey Mentra" activation view — a fade-in OVERLAY shown while the wake word is
 * active. Rendered on top of the (still-mounted) chat so nothing unmounts/
 * re-renders when listening starts or ends. Big live-transcript preview up top,
 * a glowing pulsing mic orb, and a "Listening… tap to stop" pill at the bottom.
 * `transcript` is the in-progress recognition text (interim + final).
 */
function ActivationView({ transcript, onStop }: { transcript: string; onStop: () => void }) {
  const heard = transcript.trim();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      className="absolute left-0 right-0 bottom-0 top-11 z-40 flex flex-col bg-white/85 [backdrop-filter:blur(8px)]"
    >
      {/* Live transcript preview */}
      <div className="flex flex-col items-start justify-center py-2.5 gap-1.5 grow basis-0">
        <div
          className="tracking-[-0.01em] font-medium text-[#0B0B0F57] text-[25px]/8.25"
          style={{ fontFamily: FONT_STACK }}
        >
          Hey Mentra —
        </div>
        <div
          className="tracking-[-0.01em] font-medium text-[#0B0B0FE0] text-[25px]/8.25"
          style={{ fontFamily: FONT_STACK, overflowWrap: 'anywhere' }}
        >
          {heard || (
            <span className="text-[#0B0B0F3D]">listening…</span>
          )}
        </div>
      </div>

      {/* Glowing mic orb (pulsing rings + gradient core) */}
      <div className="flex flex-col items-center grow justify-start pt-8.5">
        <div className="relative shrink-0 size-56">
          {/* soft colored glow */}
          <motion.div
            className="top-4.25 left-4.25 w-47.5 h-47.5 rounded-[999px] absolute filter-[blur(26px)]"
            style={{
              backgroundImage:
                'radial-gradient(circle farthest-corner at 50% 50% in oklab, oklab(63.6% 0.067 -0.198 / 45%) 0%, oklab(73.1% 0.183 -0.004 / 35%) 55%, oklab(79% 0.095 0.083 / 0%) 75%)',
            }}
            animate={{ scale: [1, 1.08, 1], opacity: [0.85, 1, 0.85] }}
            transition={{ duration: 2.4, ease: 'easeInOut', repeat: Infinity }}
          />
          {/* outer ring */}
          <motion.div
            className="top-1.5 left-1.5 w-53 h-53 rounded-[999px] absolute border border-solid border-[#8B6CFF2E]"
            animate={{ scale: [1, 1.04, 1], opacity: [0.6, 1, 0.6] }}
            transition={{ duration: 2.4, ease: 'easeInOut', repeat: Infinity }}
          />
          {/* mid ring */}
          <motion.div
            className="top-10 left-10 rounded-[999px] absolute border border-solid border-[#8B6CFF4D] size-36"
            animate={{ scale: [1, 1.06, 1], opacity: [0.7, 1, 0.7] }}
            transition={{ duration: 2.4, ease: 'easeInOut', repeat: Infinity, delay: 0.15 }}
          />
          {/* gradient core with mic */}
          <motion.div
            className="top-16.5 left-16.5 w-23 h-23 flex items-center justify-center rounded-[999px] absolute [box-shadow:#8B6CFF73_0px_16px_40px]"
            style={{
              backgroundImage:
                'linear-gradient(in oklab 140deg, oklab(63.6% 0.067 -0.198) 0%, oklab(73.1% 0.183 -0.004) 100%)',
            }}
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 2.4, ease: 'easeInOut', repeat: Infinity }}
          >
            <svg width="34" height="34" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" fill="none" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 19v3" fill="none" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </motion.div>
        </div>
      </div>

      {/* "Listening… tap to stop" pill. Tap only dismisses this overlay; the
          background keeps listening until its own timeout/idle (no stop RPC). */}
      <div className="flex flex-col items-center gap-3 w-full">
        <div className="flex items-center w-full rounded-[999px] pr-1.75 pl-5.25 gap-2 py-2.5 [backdrop-filter:blur(22px)] [box-shadow:#0B0B0F1A_0px_10px_28px] bg-[rgb(255_255_255/72%)] border border-solid border-[rgb(255_255_255/65%)]">
          <span className="grow font-medium text-[#0B0B0F] text-[15px]/4.5" style={{ fontFamily: FONT_STACK }}>
            Listening… tap to stop
          </span>
          <button
            type="button"
            aria-label="Stop listening"
            onClick={onStop}
            className="flex items-center justify-center shrink-0 rounded-[999px] [box-shadow:#0B0B0F38_0px_6px_16px] bg-[#0B0B0F] size-12 transition-transform active:scale-95"
          >
            <svg viewBox="0 0 24 24" style={{ width: '20px', height: '20px', flexShrink: 0 }}>
              <rect x="6" y="6" width="12" height="12" rx="3" fill="#FFFFFF" />
            </svg>
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/** Markdown render config shared by assistant replies. */
const MD_COMPONENTS = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-4 mb-2">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal pl-4 mb-2">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="mb-1">{children}</li>,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes('language-');
    return isBlock ? (
      <pre className="bg-[#0B0B0F0D] rounded-lg p-3 my-2 overflow-x-auto">
        <code className="text-[14px] font-mono">{children}</code>
      </pre>
    ) : (
      <code className="bg-[#0B0B0F0D] rounded px-1.5 py-0.5 text-[14px] font-mono">{children}</code>
    );
  },
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-xl font-bold mb-2">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-lg font-bold mb-2">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-base font-bold mb-1">{children}</h3>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-[#0B0B0F26] pl-3 italic my-2">{children}</blockquote>
  ),
};

/**
 * Memoized message row — matches the Paper conversation design.
 *
 * User (input): a frosted white bubble pinned right (special tail corner),
 * with the timestamp below it.
 * Assistant (output): no bubble — a "✦ Mentra · time" header, the reply text,
 * then a row of action icons (copy + thumbs up/down).
 */
const ChatBubble = memo(function ChatBubble({
  message,
  isOwnMessage,
  isNew,
  onCopy,
}: {
  message: Message;
  isOwnMessage: boolean;
  isNew: boolean;
  onCopy: (text: string) => void;
}) {
  // ── User (input) bubble ───────────────────────────────────────────
  if (isOwnMessage) {
    return (
      <motion.div
        initial={isNew ? { opacity: 0, y: 10 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-col items-end gap-1.25 self-stretch"
      >
        {message.image && (
          <img
            src={message.image}
            alt="Message context"
            className="mb-1 rounded-[16px] max-w-[200px] h-auto cursor-zoom-in hover:opacity-90 transition-opacity"
          />
        )}
        <div
          className="max-w-[82%] rounded-tl-[20px] rounded-tr-[20px] rounded-br-md rounded-bl-[20px] py-2.75 px-4 [box-shadow:#0B0B0F0D_0px_4px_14px] bg-[#FFFFFFE6] border border-solid border-[#FFFFFFB3]"
        >
          <div
            className="font-medium text-[#0B0B0F] text-[15px]/4.5 whitespace-pre-line"
            style={{ fontFamily: FONT_STACK, overflowWrap: 'anywhere', wordBreak: 'break-word' }}
          >
            {message.content}
          </div>
        </div>
        <div className="pr-1 font-medium text-[#0B0B0F66] text-[11px]/3.5" style={{ fontFamily: FONT_STACK }}>
          {formatTime(message.timestamp)}
        </div>
      </motion.div>
    );
  }

  // ── Assistant (output) message ────────────────────────────────────
  return (
    <motion.div
      initial={isNew ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col items-start gap-2.25 self-stretch"
    >
      {/* Header: ✦ Mentra · time */}
      <div className="flex items-center gap-1.75">
        <MentraStar />
        <span className="font-semibold text-[#0B0B0F] text-[13px]/4" style={{ fontFamily: FONT_STACK }}>
          Mentra
        </span>
        <span className="font-medium text-[#0B0B0F66] text-[11px]/3.5" style={{ fontFamily: FONT_STACK }}>
          {formatTime(message.timestamp)}
        </span>
      </div>

      {/* Reply text */}
      <div
        className="pl-0.5 text-[#0B0B0F] text-[15px]/5.5"
        style={{ fontFamily: FONT_STACK, overflowWrap: 'anywhere', wordBreak: 'break-word' }}
      >
        <Markdown components={MD_COMPONENTS}>{message.content}</Markdown>
      </div>

      {/* Agent action buttons (e.g. an OAuth "Connect Gmail" link). Opens in the
          system browser via the background's session.system.openUrl. */}
      {message.actions && message.actions.length > 0 && (
        <div className="flex flex-col gap-2 pl-0.5 pt-1">
          {message.actions.map((action, i) => (
            <button
              key={`${message.id}-action-${i}`}
              type="button"
              onClick={() => {
                void mentra.request('system:open-url', { url: action.url });
              }}
              className="inline-flex items-center justify-center self-start rounded-full bg-[#0B0B0F] px-4 py-2 text-[14px] font-semibold text-white transition-opacity active:opacity-80"
            >
              {actionLabel(action)}
            </button>
          ))}
        </div>
      )}

      {/* Action row: copy + thumbs up/down */}
      <div className="flex items-center pl-0.5 gap-3.5">
        <button
          type="button"
          aria-label="Copy"
          onClick={() => onCopy(message.content)}
          className="transition-opacity active:opacity-50"
        >
          {/* copy icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
            <rect width="14" height="14" x="8" y="8" rx="2" fill="none" stroke="#0B0B0F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" fill="none" stroke="#0B0B0F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" aria-label="Good response" className="transition-opacity active:opacity-50">
          {/* thumbs up */}
          <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
            <path d="M7 10v12" fill="none" stroke="rgb(11 11 15 / 50%)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z" fill="none" stroke="rgb(11 11 15 / 50%)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" aria-label="Bad response" className="transition-opacity active:opacity-50">
          {/* thumbs down */}
          <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
            <path d="M17 14V2" fill="none" stroke="rgb(11 11 15 / 50%)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z" fill="none" stroke="rgb(11 11 15 / 50%)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </motion.div>
  );
});

/**
 * ChatInterface component — light frosted "Paper" design.
 */
function ChatInterface({ userId, recipientId, onEnableDebugMode, debugMode, safeAreaTop = 0 }: ChatInterfaceProps) {
  const { frontendToken } = useMentraAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasConnectedBefore] = useState(() => {
    return sessionStorage.getItem('mentra-session-connected') === 'true';
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [wakeWordActive, setWakeWordActive] = useState(false);
  const [thinkingWord, setThinkingWord] = useState(() =>
    THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)]
  );
  // Track which message IDs have been rendered to avoid re-animating old messages
  const renderedIdsRef = useRef<Set<string>>(new Set());
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [imageScale, setImageScale] = useState(1);
  const [imagePosition, setImagePosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  // Light-only app: theme toggle was removed, so dark mode is hard-off. Keeping
  // the setter as a no-op so the few callers still referencing it compile.
  const isDarkMode = false;
  const setIsDarkMode = (_: boolean) => {};
  const [chatHistoryEnabled, setChatHistoryEnabled] = useState(false);
  const [sessionActive, setSessionActive] = useState<boolean | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  // Dev-only text input (shown when debugMode is on).
  const [devInput, setDevInput] = useState('');
  const [devSending, setDevSending] = useState(false);
  // "Copied to clipboard" toast shown when an assistant reply is copied.
  const [copiedToast, setCopiedToast] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live transcript preview shown in the "Hey Mentra" activation view while
  // listening (fed by the background's debug:transcript broadcast).
  const [liveTranscript, setLiveTranscript] = useState('');

  const handleCopy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedToast(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedToast(false), 1800);
  };

  // No real display name is available locally — auth userId is the literal
  // "local-user", not a person's name. This is where a real display name would
  // be wired in (e.g. from a profile fetch); for now it stays empty → "Hi there".
  const userName = '';

  const sendDevQuery = async () => {
    const query = devInput.trim();
    if (!query || devSending) return;
    setDevSending(true);
    setDevInput('');
    try {
      await askByText(query);
    } catch (error) {
      console.error('[ChatInterface] dev ask failed:', error);
    } finally {
      setDevSending(false);
    }
  };

  // Dev-only hook so the Debug overlay's wake-glow button can flip the
  // chromatic ring on without a wake-word round-trip. Pure UI preview.
  useEffect(() => {
    window.__setDevWakeWord = (on: boolean) => setWakeWordActive(on);
    return () => {
      delete window.__setDevWakeWord;
    };
  }, []);

  // Clear the copy-toast timer on unmount.
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  // Live transcript feed (interim + final) for the activation view's preview.
  // The background broadcasts this on every recognition update while listening.
  useEffect(() => {
    const off = mentra.on('debug:transcript', (data: DebugTranscript) => {
      setLiveTranscript(data.text ?? '');
    });
    return off;
  }, []);

  // History-backed page stack so the OS back gesture (iOS swipe / Android back)
  // pops settings → chat, and exits the app only from chat. See usePageStack.
  const { page: currentPage, push: pushPage, back: popPage } = usePageStack<'chat' | 'settings'>('chat');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Track whether next scroll should be instant (history load) vs smooth (live message)
  const scrollInstantRef = useRef(false);

  // Scroll to bottom of messages
  const scrollToBottom = (instant?: boolean) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
    });
  };

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom(scrollInstantRef.current);
      scrollInstantRef.current = false;
    }
  }, [messages]);

  useEffect(() => {
    if (currentPage === 'chat' && messages.length > 0) {
      scrollToBottom(true);
    }
  }, [currentPage]);

  // Light-only app: keep the root in light mode regardless of any stale state.
  useEffect(() => {
    document.documentElement.classList.remove('dark');
  }, []);

  // Load user settings on mount
  useEffect(() => {
    if (userId) {
      fetchUserSettings(frontendToken)
        .then((settings) => {
          setChatHistoryEnabled(settings.chatHistoryEnabled ?? false);
        })
        .catch((error) => {
          console.error('[ChatInterface] Failed to fetch user settings:', error);
        });
    }
  }, [userId, frontendToken]);

  // Real-time updates over the background channel bus (local replacement for
  // the cloud SSE stream). There's no server/session here — the assistant is
  // always "connected" — so there's no reconnect loop, auth gating, or
  // session_* lifecycle. subscribeChatEvents() also hydrates history on mount.
  useEffect(() => {
    setSessionActive(true);

    const unsubscribe = subscribeChatEvents((data) => {
      if (data.type === 'message') {
        if (data.senderId === userId) {
          // The finalized user query landed — leave the listening view.
          setWakeWordActive(false);
          setLiveTranscript('');
          const randomWord = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
          setThinkingWord(randomWord);
          setIsProcessing(true);
        } else {
          setIsProcessing(false);
        }

        setMessages((prev) => {
          if (prev.some((m) => m.id === data.id)) return prev;
          return [
            ...prev,
            {
              id: data.id || Date.now().toString(),
              senderId: data.senderId,
              recipientId: data.recipientId,
              content: data.content,
              timestamp: new Date(data.timestamp),
              image: data.image,
              actions: data.actions,
            },
          ];
        });
      } else if (data.type === 'wake_word') {
        setLiveTranscript('');
        setWakeWordActive(true);
      } else if (data.type === 'processing') {
        const randomWord = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
        setThinkingWord(randomWord);
        setIsProcessing(true);
      } else if (data.type === 'idle') {
        setIsProcessing(false);
        setWakeWordActive(false);
      } else if (data.type === 'history') {
        // Instant scroll, no animation — mark all IDs as already rendered.
        scrollInstantRef.current = true;
        const historyMessages = data.messages.map((msg) => ({
          id: msg.id,
          senderId: msg.senderId,
          recipientId: msg.recipientId,
          content: msg.content,
          timestamp: new Date(msg.timestamp),
          image: msg.image,
          actions: msg.actions,
        }));
        for (const msg of historyMessages) {
          renderedIdsRef.current.add(msg.id);
        }
        setMessages(historyMessages);
        setIsLoadingHistory(false);
      }
    });

    return unsubscribe;
  }, [userId, recipientId]);

  // Render Settings page if on settings
  if (currentPage === 'settings') {
    return (
      <Settings
        onBack={popPage}
        isDarkMode={isDarkMode}
        onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
        onChatHistoryToggle={(enabled) => setChatHistoryEnabled(enabled)}
        onEnableDebugMode={onEnableDebugMode}
      />
    );
  }

  const hasMessages = messages.length > 0;

  return (
    <div
      className="[font-synthesis:none] flex overflow-hidden flex-1 min-h-0 relative flex-col bg-white antialiased text-[#0B0B0F]"
      style={{ fontFamily: FONT_STACK }}
    >
      {/* Frosted color gradient backdrop — same aesthetic as Settings. */}
      <div
        aria-hidden="true"
        className="absolute filter-[blur(34px)_saturate(105%)] bg-white inset-0 pointer-events-none"
        style={{ backgroundImage: BACKDROP_GRADIENT }}
      />

      {/* Session disconnected banner — fixed on top of everything */}
      <AnimatePresence>
        {sessionActive === false && (
          <motion.div
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -40, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2 bg-red-500/15 backdrop-blur-sm border-b border-red-500/20"
          >
            <svg className="w-3.5 h-3.5 text-red-500 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
            </svg>
            <span className="text-red-500 text-xs font-medium">Disconnected — attempting to reconnect</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* RGB Glow Border (active on wake word) */}
      <ChromaticBorder state={wakeWordActive ? 'active' : 'idle'} />

      {/* Main column */}
      <div className="flex flex-col grow basis-0 relative z-10 px-5 pt-4.5 pb-5.5">
        {/* HEADER: settings gear (left) + "Mentra AI" title */}
        <div className="flex items-center justify-between h-11 shrink-0">
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => pushPage('settings')}
              aria-label="Settings"
              className="flex items-center justify-center w-9.5 h-9.5 shrink-0 -ml-2 rounded-full transition-opacity active:opacity-60"
            >
              <svg width="23" height="23" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="3" fill="none" stroke="#0B0B0F" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" fill="none" stroke="#0B0B0F" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="flex items-center gap-2 py-2">
              <img src={ColorMiraLogo} alt="" aria-hidden="true" className="w-[26px] h-[26px]" />
              <div className="font-semibold text-[#0B0B0F] text-[17px]/5.5" style={{ fontFamily: FONT_STACK }}>
                Mentra AI
              </div>
            </div>
          </div>
        </div>

        {/* "Hey Mentra" activation overlay — fades in over the chat (which stays
            mounted) while listening, and fades out when it ends. */}
        <AnimatePresence>
          {wakeWordActive && (
            <ActivationView
              transcript={liveTranscript}
              onStop={() => setWakeWordActive(false)}
            />
          )}
        </AnimatePresence>

        {/* MIDDLE AREA: welcome (empty) OR scrolling message list. Stays mounted
            even while listening — the activation view is an overlay (above). */}
        <div className="grow basis-0 relative min-h-0">
          <div
            ref={scrollContainerRef}
            className="absolute inset-0 overflow-y-auto"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {/* Empty States: Loading / Disconnected / Welcome */}
            <AnimatePresence mode="wait">
              {isLoadingHistory && !hasMessages && (
                <motion.div
                  key="loading-screen"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="absolute inset-0 flex flex-col items-center justify-center px-6"
                >
                  <div className="flex flex-col items-center gap-3">
                    <svg className="w-6 h-6 text-[#0B0B0F59] animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-25" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                    </svg>
                    <span className="text-[14px] text-[#0B0B0F8C] font-medium" style={{ fontFamily: FONT_STACK }}>
                      Loading conversation…
                    </span>
                  </div>
                </motion.div>
              )}

              {!isLoadingHistory && !hasMessages && sessionActive === false && (
                <motion.div
                  key="disconnected-screen"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="absolute inset-0 flex flex-col items-center justify-center px-6"
                >
                  <div className="flex flex-col items-center gap-3">
                    <img src={ColorMiraLogo} alt="Mentra" className="w-[96px] h-[96px]" />
                    <h1 className="text-[18px] font-semibold text-[#0B0B0F]" style={{ fontFamily: FONT_STACK }}>
                      Waiting for connection…
                    </h1>
                  </div>
                </motion.div>
              )}

              {!isLoadingHistory && !hasMessages && sessionActive !== false && (
                <motion.div
                  key="welcome-screen"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5 }}
                  className="absolute inset-0 flex flex-col items-center justify-center py-2.5 gap-5 px-6"
                >
                  <img src={ColorMiraLogo} alt="Mentra" className="w-[104px] h-[102px]" />
                  <div className="flex flex-col items-center gap-2">
                    <div className="font-medium text-[#0B0B0F80] text-[15px]/4.5" style={{ fontFamily: FONT_STACK }}>
                      Hi{userName ? `, ${userName}` : ' there'}
                    </div>
                    <div
                      className="[letter-spacing:-0.025em] text-center font-bold text-[#0B0B0F] text-3xl/8.5"
                      style={{ fontFamily: FONT_STACK }}
                    >
                      Say &ldquo;Hey Mentra&rdquo;
                    </div>
                    <div className="text-center font-medium text-[#0B0B0F8C] text-sm/4.5" style={{ fontFamily: FONT_STACK }}>
                      Then ask a question — or type below.
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Chat Messages */}
            {(hasMessages || hasConnectedBefore) && (
              <motion.div
                initial={hasConnectedBefore ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: hasConnectedBefore ? 0 : 0.5, ease: 'easeOut' }}
                className="pt-4.5 pb-4 relative"
              >
                <div className="max-w-3xl mx-auto flex flex-col gap-4">
                  {messages.map((message) => {
                    const isNew = !renderedIdsRef.current.has(message.id);
                    if (isNew) renderedIdsRef.current.add(message.id);
                    return (
                      <ChatBubble
                        key={message.id}
                        message={message}
                        isOwnMessage={message.senderId === userId}
                        isNew={isNew}
                        onCopy={handleCopy}
                      />
                    );
                  })}

                  {/* Processing Indicator — matches the assistant header style. */}
                  {isProcessing && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center gap-1.75 self-start"
                    >
                      <MentraStar />
                      <motion.div
                        className="text-[13px]/4 text-[#0B0B0F8C] italic"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.3 }}
                        style={{ fontFamily: FONT_STACK }}
                      >
                        {`${thinkingWord}...`.split('').map((char, index) => (
                          <motion.span
                            key={index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: index * 0.05 }}
                          >
                            {char}
                          </motion.span>
                        ))}
                      </motion.div>
                    </motion.div>
                  )}

                  <div ref={messagesEndRef} />
                </div>
              </motion.div>
            )}
          </div>
        </div>

        {/* BOTTOM PILL INPUT BAR — always visible over welcome + message list.
            relative z-30 keeps it ABOVE the bottom vignette overlay (z-20), so
            the dark send button isn't dimmed/"behind" the gradient. While
            listening it's replaced by the "Listening… tap to stop" pill. */}
        <div className="relative z-30 flex flex-col items-center gap-3 shrink-0">
          {/* "Copied to clipboard" toast (shown briefly after copying a reply). */}
          <AnimatePresence>
            {copiedToast && (
              <motion.div
                key="copied-toast"
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="flex items-center rounded-[999px] py-2.25 px-3.5 gap-1.75 [box-shadow:#0B0B0F42_0px_8px_22px] bg-[#0B0B0F]"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                  <path d="M20 6 9 17l-5-5" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="font-medium text-white text-[13px]/4" style={{ fontFamily: FONT_STACK }}>
                  Copied to clipboard
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Hint chip — "Say Hey Mentra or type below". */}
          <div className="flex items-center rounded-[999px] py-1.75 px-3.5 gap-1.75 [backdrop-filter:blur(16px)] [box-shadow:#0B0B0F0F_0px_4px_14px] bg-[#FFFFFF9E] border border-solid border-[#FFFFFFB3]">
            <svg width="14" height="14" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" fill="none" stroke="rgb(11 11 15 / 70%)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="rgb(11 11 15 / 70%)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 19v3" fill="none" stroke="rgb(11 11 15 / 70%)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="font-medium text-[#0B0B0F9E] text-[12.5px]/4" style={{ fontFamily: FONT_STACK }}>
              Say &quot;Hey Mentra&quot; or type below
            </span>
          </div>

          <div className="flex items-center w-full rounded-[999px] pr-1.5 pl-5 gap-1.5 py-1.5 [backdrop-filter:blur(22px)] [box-shadow:#0B0B0F1A_0px_10px_28px] bg-[#FFFFFFE0] border border-solid border-[rgb(255_255_255/65%)]">
            <input
              type="text"
              value={devInput}
              onChange={(e) => setDevInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendDevQuery();
                }
              }}
              placeholder="Ask Mentra…"
              disabled={devSending}
              className="grow min-w-0 bg-transparent outline-none text-[#0B0B0F] placeholder:text-[#9A9AA2] text-[15px]/4.5 disabled:opacity-60"
              style={{ fontFamily: FONT_STACK }}
            />

            {/* Mic button — display-only for now (no wiring yet). */}
            <button
              type="button"
              aria-label="Voice input (coming soon)"
              className="flex items-center justify-center shrink-0 rounded-[999px] size-11"
            >
              <svg viewBox="0 0 24 24" style={{ width: '23px', height: '23px', flexShrink: 0 }}>
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" fill="none" stroke="#0B0B0F" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="#0B0B0F" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 19v3" fill="none" stroke="#0B0B0F" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* SEND button — always-solid dark circle (matches the mockup).
                Empty/sending is a no-op via sendDevQuery's own guard rather than
                a disabled+dimmed state, so the arrow never looks greyed out. */}
            <button
              onClick={() => void sendDevQuery()}
              aria-label="Send"
              className="flex items-center justify-center shrink-0 rounded-[999px] [box-shadow:#0B0B0F38_0px_6px_16px] bg-[#0B0B0F] size-12 transition-transform active:scale-95"
            >
              <svg viewBox="0 0 24 24" style={{ width: '24px', height: '24px', flexShrink: 0 }}>
                <path d="M12 19V5" fill="none" stroke="#FFFFFF" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                <path d="m5 12 7-7 7 7" fill="none" stroke="#FFFFFF" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Subtle bottom vignette overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-20"
        style={{ backgroundImage: VIGNETTE_GRADIENT }}
      />

      {/* Image Zoom Modal */}
      {zoomedImage && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/95 z-50 flex items-center justify-center overflow-hidden"
        >
          <div className="relative w-full h-full flex items-center justify-center">
            <motion.img
              initial={{ scale: 0.9 }}
              animate={{
                scale: imageScale,
                x: imagePosition.x,
                y: imagePosition.y,
              }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              src={zoomedImage}
              alt="Zoomed view"
              className="max-w-full max-h-full object-contain rounded-lg select-none"
              style={{
                touchAction: 'none',
                cursor: isDragging ? 'grabbing' : 'grab',
              }}
              onWheel={(e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                setImageScale((prev) => Math.min(Math.max(0.5, prev + delta), 5));
              }}
              onMouseDown={(e) => {
                setIsDragging(true);
                setDragStart({
                  x: e.clientX - imagePosition.x,
                  y: e.clientY - imagePosition.y,
                });
              }}
              onMouseMove={(e) => {
                if (isDragging) {
                  setImagePosition({
                    x: e.clientX - dragStart.x,
                    y: e.clientY - dragStart.y,
                  });
                }
              }}
              onMouseUp={() => setIsDragging(false)}
              onMouseLeave={() => setIsDragging(false)}
            />
            {/* Close button */}
            <button
              className="absolute top-4 left-4 w-[40px] h-[40px] bg-white backdrop-blur-sm rounded-full flex justify-center items-center z-10"
              onClick={() => {
                setZoomedImage(null);
                setImageScale(1);
                setImagePosition({ x: 0, y: 0 });
                setIsDragging(false);
              }}
            >
              <X size={20} color="#0B0B0F" />
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

export default ChatInterface;
