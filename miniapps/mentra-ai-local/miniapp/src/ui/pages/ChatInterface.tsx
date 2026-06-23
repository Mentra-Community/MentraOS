import React, { useState, useEffect, useRef, memo } from 'react';
import { useMentraAuth } from '../lib/localAuth';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { subscribeChatEvents, askByText } from '../lib/chatChannel';
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

interface Message {
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
  timestamp: Date;
  image?: string;
}

interface ChatInterfaceProps {
  userId: string;
  recipientId: string;
  onEnableDebugMode?: () => void;
  /** Dev-only: when true, show a text input to ask questions without voice. */
  debugMode?: boolean;
  /** Device top safe-area inset (notch / status bar), in px, from useSafeArea(). */
  safeAreaTop?: number;
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
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('mentra-dark-mode');
    return saved ? JSON.parse(saved) : false;
  });
  const [chatHistoryEnabled, setChatHistoryEnabled] = useState(false);
  const [sessionActive, setSessionActive] = useState<boolean | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  // Dev-only text input (shown when debugMode is on).
  const [devInput, setDevInput] = useState('');
  const [devSending, setDevSending] = useState(false);

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

  const [currentPage, setCurrentPage] = useState<'chat' | 'settings'>('chat');
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

  // Real-time updates over the background channel bus (local replacement for
  // the cloud SSE stream). There's no server/session here — the assistant is
  // always "connected" — so there's no reconnect loop, auth gating, or
  // session_* lifecycle. subscribeChatEvents() also hydrates history on mount.
  useEffect(() => {
    setSessionActive(true);

    const unsubscribe = subscribeChatEvents((data) => {
      if (data.type === 'message') {
        if (data.senderId === userId) {
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
            },
          ];
        });
      } else if (data.type === 'wake_word') {
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

                <div ref={messagesEndRef} />
              </div>
            </motion.div>
          )}
        </div>

        {/* Bottom Header */}
        <BottomHeader isDarkMode={isDarkMode} isVisible={messages.length > 0} />
      </motion.div>

      {/* Dev-only text input — pinned to the TOP, above everything (header,
          overlays, modals), below the device safe-area inset (notch/status bar
          from useSafeArea). Type a question without the wake word. */}
      {debugMode && (
        <div
          className="fixed left-0 right-0 z-[100] px-4 pt-3 pb-3 bg-gradient-to-b from-[var(--background)] via-[var(--background)] to-transparent"
          style={{ top: safeAreaTop }}
        >
          <div className="max-w-3xl mx-auto flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 select-none">
              dev
            </span>
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
              placeholder="Ask Mentra by text…"
              disabled={devSending}
              className="flex-1 rounded-full px-4 py-2.5 text-[15px] bg-[var(--primary-foreground)] text-[var(--foreground)] placeholder:text-gray-400 outline-none border border-transparent focus:border-gray-400/40 disabled:opacity-50 shadow-lg"
            />
            <button
              onClick={() => void sendDevQuery()}
              disabled={devSending || !devInput.trim()}
              className="rounded-full px-4 py-2.5 text-[14px] font-medium bg-[var(--secondary-foreground)] text-[var(--background)] disabled:opacity-40 shadow-lg"
            >
              {devSending ? '…' : 'Send'}
            </button>
          </div>
        </div>
      )}

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
