import React, { useState, useEffect, useRef, memo } from 'react';
import { useMentraAuth } from '@mentra/react';
import { X, ArrowUp, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { createAuthFetch, withAuthSseUrl } from '../lib/authFetch';
// @ts-ignore - Bun bundler doesn't resolve `export { X as default }` re-exports correctly
import LottieImport from 'lottie-react';
const Lottie: typeof LottieImport = (LottieImport as any)?.default ?? LottieImport;
import Markdown from 'react-markdown';
// @ts-ignore - JSON import
import MentraLogoAnimation from '../../public/figma-parth-assets/anim/Mentralogo2.json';
import { MiraBackgroundAnimation } from '../components/MiraBackgroundAnimation';
// @ts-ignore - SVG import
import ColorMiraLogo from '../../public/figma-parth-assets/icons/color-mira-logo.svg';
import Settings from './Settings';
import Header from '../components/Header';
import BottomHeader from '../components/BottomHeader';
import { ChromaticBorder } from '../components/ChromaticBorder';
import { fetchUserSettings } from '../api/settings.api';

/** A tappable action attached to a message (e.g. an OAuth "Connect" link). */
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
    try {
      // connect.composio.dev/.../gmail?... → "Connect Gmail"
      const m = action.url.toLowerCase().match(/(gmail|googlecalendar|calendar|google|slack|github|notion|linear)/);
      if (m) {
        const svc = m[1] === 'googlecalendar' ? 'Google Calendar' : m[1].charAt(0).toUpperCase() + m[1].slice(1);
        return `Connect ${svc}`;
      }
    } catch {
      /* fall through */
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

/**
 * Memoized message bubble
 */
const ChatBubble = memo(function ChatBubble({
  message,
  isOwnMessage,
  isNew,
}: {
  message: Message;
  isOwnMessage: boolean;
  isNew: boolean;
}) {
  return (
    <motion.div
      key={message.id}
      initial={isNew ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`flex flex-col gap-2 ${isOwnMessage ? 'items-end' : 'items-start'}`}
    >
      {/* Avatar and Name */}
      <div className={`flex items-center gap-2 ${isOwnMessage ? 'flex-row-reverse' : 'flex-row'}`}>
        <div className="ml-[8px]">
          {!isOwnMessage && (
            <img src={ColorMiraLogo} alt="Mentra" className="w-[40px] h-[40px]" />
          )}
        </div>
      </div>

      {/* Message Content */}
      <div className={`flex flex-col ${isOwnMessage ? 'items-end' : 'items-start'}`}>
        {message.image && (
          <div className="mb-2">
            <img
              src={message.image}
              alt="Message context"
              className="rounded-[8px] max-w-xs h-auto cursor-zoom-in hover:opacity-90 transition-opacity"
              style={{ maxWidth: '200px' }}
            />
          </div>
        )}
        <div
          className={`text-[var(--foreground)] leading-relaxed whitespace-pre-line pt-[8px] pb-[8px] pr-[16px] pl-[16px] rounded-[16px] inline-block max-w-[85vw] sm:max-w-lg text-[16px] ${
            isOwnMessage
              ? 'bg-[var(--primary-foreground)] font-medium text-[var(--secondary-foreground)]'
              : 'bg-transparent pl-0 font-medium *:text-[var(--secondary-foreground)]'
          }`}
          style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        >
          {isOwnMessage ? (
            message.content
          ) : (
            <Markdown
              components={{
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                em: ({ children }) => <em className="italic">{children}</em>,
                ul: ({ children }) => <ul className="list-disc pl-4 mb-2">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-4 mb-2">{children}</ol>,
                li: ({ children }) => <li className="mb-1">{children}</li>,
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-');
                  return isBlock ? (
                    <pre className="bg-[var(--primary-foreground)] rounded-lg p-3 my-2 overflow-x-auto">
                      <code className="text-[14px] font-mono">{children}</code>
                    </pre>
                  ) : (
                    <code className="bg-[var(--primary-foreground)] rounded px-1.5 py-0.5 text-[14px] font-mono">
                      {children}
                    </code>
                  );
                },
                h1: ({ children }) => <h1 className="text-xl font-bold mb-2">{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-bold mb-2">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-bold mb-1">{children}</h3>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-gray-400 pl-3 italic my-2">
                    {children}
                  </blockquote>
                ),
              }}
            >
              {message.content}
            </Markdown>
          )}
        </div>
        {/* Action buttons (e.g. an OAuth "Connect Gmail" link from the agent).
            Opened in the system browser via target=_blank — the host webview
            routes external navigations out. */}
        {!isOwnMessage && message.actions && message.actions.length > 0 && (
          <div className="flex flex-col gap-2 mt-2 w-full">
            {message.actions.map((action, i) => (
              <a
                key={`${message.id}-action-${i}`}
                href={action.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-full px-4 py-2 text-[14px] font-semibold bg-[var(--primary)] text-[var(--primary-foreground)] no-underline active:opacity-80 transition-opacity"
              >
                {actionLabel(action)}
              </a>
            ))}
          </div>
        )}
        <div
          className={`text-[12px] ml-[15px] mt-1.5 ${isOwnMessage ? 'text-right' : 'text-left'} w-full text-gray-400`}
        >
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </motion.div>
  );
});

/**
 * ChatInterface component - Beautiful dark-themed chat UI
 */
function ChatInterface({ userId, recipientId, onEnableDebugMode }: ChatInterfaceProps) {
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
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('mentra-dark-mode');
    return saved ? JSON.parse(saved) : false;
  });
  const [chatHistoryEnabled, setChatHistoryEnabled] = useState(false);
  const [sessionActive, setSessionActive] = useState<boolean | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  // Dev-only hook so the Debug overlay's wake-glow button can flip the
  // chromatic ring on without an SSE round-trip. Pure UI preview; does
  // not send anything to the glasses or server. The glow stays in the set
  // state indefinitely — no auto-revert — so it survives toggle taps.
  useEffect(() => {
    const w = window as Window;
    w.__setDevWakeWord = (on: boolean) => setWakeWordActive(on);
    return () => {
      delete w.__setDevWakeWord;
    };
  }, []);
  const [currentPage, setCurrentPage] = useState<'chat' | 'settings'>('chat');
  // Webview chat box — type a message to test the assistant without speaking.
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);
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

  // Send a typed message to the assistant. The user + assistant bubbles render
  // via the SSE stream (the backend broadcasts both), so we don't insert
  // optimistically here — we just fire the request and let the stream update.
  const handleSendMessage = async () => {
    const text = inputText.trim();
    if (!text || isSending) return;
    setInputText('');
    setIsSending(true);
    try {
      const authFetch = createAuthFetch(frontendToken);
      const res = await authFetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        console.error('chat send failed:', res.status, await res.text().catch(() => ''));
      }
    } catch (err) {
      console.error('chat send error:', err);
    } finally {
      setIsSending(false);
    }
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

  // Save dark mode preference
  useEffect(() => {
    localStorage.setItem('mentra-dark-mode', JSON.stringify(isDarkMode));
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

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

  // Set up SSE connection for real-time updates (with auto-reconnect).
  // Wait for the frontend token before connecting; otherwise the stream
  // hits a 401 immediately and triggers the reconnect loop while
  // useMentraAuth() is still resolving.
  useEffect(() => {
    if (!userId || !recipientId || !frontendToken) {
      return;
    }

    let reconnectAttempts = 0;
    const MAX_RECONNECT_DELAY = 30000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const sseUrl = withAuthSseUrl(
        `/api/chat/stream?recipientId=${encodeURIComponent(recipientId)}`,
        frontendToken,
      );
      const eventSource = new EventSource(sseUrl);
      sseRef.current = eventSource;

      eventSource.onopen = () => {
        reconnectAttempts = 0;
        setIsLoadingHistory(true);
        sessionStorage.setItem('mentra-session-connected', 'true');
      };

      eventSource.onmessage = (event) => {
        if (!event.data || event.data.trim() === '') {
          return;
        }

        try {
          const data = JSON.parse(event.data);

          if (data.type === 'message') {
            const isRelevant =
              (data.senderId === userId && data.recipientId === recipientId) ||
              (data.senderId === recipientId && data.recipientId === userId);

            if (isRelevant) {
              if (data.senderId === userId) {
                const randomWord = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
                setThinkingWord(randomWord);
                setIsProcessing(true);
              } else {
                setIsProcessing(false);
              }

              setMessages((prev) => [
                ...prev,
                {
                  id: data.id || Date.now().toString(),
                  senderId: data.senderId,
                  recipientId: data.recipientId,
                  content: data.content,
                  timestamp: new Date(data.timestamp),
                  image: data.image,
                  actions: Array.isArray(data.actions) ? data.actions : undefined,
                },
              ]);
            }
          } else if (data.type === 'wake_word') {
            setWakeWordActive(true);
          } else if (data.type === 'processing') {
            const randomWord = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
            setThinkingWord(randomWord);
            setIsProcessing(true);
          } else if (data.type === 'idle') {
            setIsProcessing(false);
            setWakeWordActive(false);
          } else if (data.type === 'connected') {
            // SSE connected — waiting for history
            setIsLoadingHistory(true);
          } else if (data.type === 'history') {
            // Instant scroll, no animation — mark all IDs as already rendered
            scrollInstantRef.current = true;
            const historyMessages = data.messages.map((msg: any) => ({
              id: msg.id,
              senderId: msg.senderId,
              recipientId: msg.recipientId,
              content: msg.content,
              timestamp: new Date(msg.timestamp),
              image: msg.image,
            }));
            for (const msg of historyMessages) {
              renderedIdsRef.current.add(msg.id);
            }
            setMessages(historyMessages);
            setIsLoadingHistory(false);
          } else if (data.type === 'session_started') {
            setSessionActive(true);
          } else if (data.type === 'session_reconnecting') {
            // Grace period active — keep messages, just show disconnected banner
            setSessionActive(false);
            setIsProcessing(false);
          } else if (data.type === 'session_reconnected') {
            // Reconnected within grace period — messages are intact
            setSessionActive(true);
          } else if (data.type === 'session_ended') {
            // Grace period expired or hard disconnect — full cleanup
            setSessionActive(false);
            setIsProcessing(false);
            setMessages([]);
            renderedIdsRef.current.clear();
          } else if (data.type === 'session_heartbeat') {
            setSessionActive(data.active);
            setIsLoadingHistory(false);
            if (!data.active) {
              setIsProcessing(false);
            }
          }
        } catch (error) {
          console.error('[ChatInterface] Error parsing SSE message:', error);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        setSessionActive(false);
        setIsProcessing(false);
        const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
        reconnectAttempts++;
        console.log(`[ChatInterface] SSE disconnected, reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        if (!sseRef.current || sseRef.current.readyState === EventSource.CLOSED) {
          connect();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    connect();

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      sseRef.current?.close();
    };
  }, [userId, recipientId, frontendToken]);

  // Render Settings page if on settings
  if (currentPage === 'settings') {
    return (
      <Settings
        onBack={() => setCurrentPage('chat')}
        isDarkMode={isDarkMode}
        onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
        onChatHistoryToggle={(enabled) => setChatHistoryEnabled(enabled)}
        onEnableDebugMode={onEnableDebugMode}
      />
    );
  }

  return (
    <div
      className={`h-screen flex overflow-hidden ${isDarkMode ? 'dark' : ''}`}
      style={{ backgroundColor: 'var(--background)' }}
    >
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
            <svg className="w-3.5 h-3.5 text-red-400 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
            </svg>
            <span className="text-red-400 text-xs font-medium">Disconnected — attempting to reconnect</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* RGB Glow Border */}
      <ChromaticBorder state={wakeWordActive ? "active" : "idle"} />

      {/* Main Chat Content */}
      <motion.div
        className="flex-1 flex flex-col relative "
        initial={{ x: 0 }}
        animate={{ x: 0 }}
        style={{ backgroundColor: 'transparent' }}
      >
        {/* Header */}
        <Header
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
          onSettingsClick={() => setCurrentPage('settings')}
        />

        {/* Main Content Area */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto relative"
          style={{
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          {/* Gradient background at bottom */}
          <div
            className="fixed bottom-0 left-0 right-0 pointer-events-none flex justify-center"
            style={{ height: '1000px', transform: 'translateY(660px)' }}
          >
            <MiraBackgroundAnimation />
          </div>

          {/* Empty States: Welcome / Disconnected / Loading */}
          <AnimatePresence mode="wait">
            {isLoadingHistory && messages.length === 0 && (
              <motion.div
                key="loading-screen"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="absolute inset-0 flex flex-col items-center justify-center px-6 z-10"
              >
                <div className="flex flex-col items-center gap-3 -mt-[80px]">
                  <svg className="w-6 h-6 text-[#A3A3A3] animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-25" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                  </svg>
                  <span className="text-[14px] text-[#A3A3A3] font-medium">Loading conversation...</span>
                </div>
              </motion.div>
            )}
            {!isLoadingHistory && messages.length === 0 && sessionActive === false && (
              <motion.div
                key="disconnected-screen"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="absolute inset-0 flex flex-col items-center justify-center px-6 z-10"
              >
                <div className="flex flex-col items-center -mt-[80px]">
                  <Lottie
                    animationData={MentraLogoAnimation}
                    loop={true}
                    autoplay={true}
                    className="w-[150px] h-[150px] mb-[10px]"
                  />
                  <h1 className="text-[20px] font-semibold" style={{ color: 'var(--secondary-foreground)' }}>
                    Waiting for connection...
                  </h1>
                </div>
              </motion.div>
            )}
            {!isLoadingHistory && messages.length === 0 && sessionActive !== false && !hasConnectedBefore && (
              <motion.div
                key="welcome-screen"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5 }}
                className="absolute inset-0 flex flex-col items-center justify-center px-6 z-10"
              >
                <div className="flex flex-col items-center -mt-[80px]">
                  <motion.div
                    initial={{ y: '5vh' }}
                    animate={{ y: 0 }}
                    transition={{
                      duration: 0.7,
                      ease: [0.25, 0.1, 0.25, 1],
                      delay: 0.3,
                    }}
                    className="mb-[10px]"
                  >
                    <Lottie
                      animationData={MentraLogoAnimation}
                      loop={true}
                      autoplay={true}
                      className="w-[150px] h-[150px]"
                    />
                  </motion.div>
                  <h1 className="text-[20px] sm:text-4xl md:text-5xl lg:text-6xl font-semibold flex gap-[4px] justify-center">
                    {['Say', '"Hey', 'Mentra"'].map((word, index) => (
                      <motion.span
                        key={index}
                        initial={{ opacity: 0, filter: 'blur(10px)' }}
                        animate={{ opacity: 1, filter: 'blur(0px)' }}
                        transition={{
                          duration: 0.5,
                          ease: [0.25, 0.1, 0.25, 1],
                          delay: 0.7 + index * 0.15,
                        }}
                        style={{ color: 'var(--secondary-foreground)' }}
                      >
                        {word}
                      </motion.span>
                    ))}
                  </h1>

                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.6,
                      ease: [0.25, 0.1, 0.25, 1],
                      delay: 1.15,
                    }}
                    className="text-[14px] text-[#A3A3A3] mt-[8px]"
                  >
                    Then ask a question.
                  </motion.div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Chat Messages */}
          {(messages.length > 0 || hasConnectedBefore) && (
            <motion.div
              initial={hasConnectedBefore ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: hasConnectedBefore ? 0 : 0.5, ease: 'easeOut' }}
              className="px-[24px] py-6 pb-[150px] relative z-20"
            >
              <div className="max-w-3xl mx-auto space-y-6">
                {messages.map((message) => {
                  const isNew = !renderedIdsRef.current.has(message.id);
                  if (isNew) renderedIdsRef.current.add(message.id);
                  return (
                    <ChatBubble
                      key={message.id}
                      message={message}
                      isOwnMessage={message.senderId === userId}
                      isNew={isNew}
                    />
                  );
                })}

                {/* Processing Indicator */}
                {isProcessing && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-2"
                  >
                    <div className="flex-shrink-0">
                      <img src={ColorMiraLogo} alt="Mentra" className="w-[40px] h-[40px]" />
                    </div>
                    <motion.div
                      className="text-sm text-gray-500 italic"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3 }}
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

                {/* Spacer so the last message clears the fixed input bar. */}
                <div className="h-28 shrink-0" />
                <div ref={messagesEndRef} />
              </div>
            </motion.div>
          )}
        </div>

        {/* Bottom Header */}
        <BottomHeader isDarkMode={isDarkMode} isVisible={messages.length > 0} />

        {/* Chat input bar — type a message to test the assistant without
            speaking. Pinned to the bottom; works with or without glasses. */}
        <div className="fixed bottom-0 left-0 right-0 z-30 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 pointer-events-none">
          <div className="mx-auto flex w-full max-w-[460px] items-center gap-2.5 pointer-events-auto">
            <div className="flex flex-1 items-center rounded-full border border-gray-200 bg-white px-5 py-3 shadow-[0_2px_16px_rgba(0,0,0,0.08)] dark:border-white/10 dark:bg-[#1c1c1e]">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="Ask Mentra…"
                enterKeyHint="send"
                aria-label="Message Mentra"
                className="flex-1 bg-transparent text-[16px] text-gray-900 outline-none placeholder:text-gray-400 dark:text-white"
              />
            </div>
            <button
              type="button"
              onClick={handleSendMessage}
              disabled={!inputText.trim() || isSending}
              aria-label="Send message"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-black text-white shadow-md transition-transform active:scale-95 disabled:opacity-40 dark:bg-white dark:text-black"
            >
              {isSending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" strokeWidth={2.5} />}
            </button>
          </div>
        </div>
      </motion.div>

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
              className="absolute top-4 left-4 w-[40px] h-[40px] bg-[var(--background)] backdrop-blur-sm rounded-full flex justify-center items-center z-10"
              onClick={() => {
                setZoomedImage(null);
                setImageScale(1);
                setImagePosition({ x: 0, y: 0 });
                setIsDragging(false);
              }}
            >
              <X size={20} color="var(--foreground)" />
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

export default ChatInterface;
