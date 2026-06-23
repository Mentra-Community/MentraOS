import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { useSafeArea } from '@mentra/miniapp/ui';
import { useMentraAuth } from './lib/localAuth';
import { motion, AnimatePresence } from 'framer-motion';
import ChatInterface from './pages/ChatInterface';
import { DebugOverlay } from './components/DebugOverlay';
import { fetchUserSettings, updateTheme } from './api/settings.api';

// Theme Context
interface ThemeContextValue {
  theme: 'light' | 'dark';
  isDarkMode: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  isDarkMode: false,
  toggleTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export default function App() {
  const { userId, frontendToken, isLoading, error, isAuthenticated } = useMentraAuth();
  // Device safe-area insets (notch / status bar / home indicator) from the host.
  const { insets } = useSafeArea();

  // Theme state with localStorage persistence
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme');
      if (saved === 'dark' || saved === 'light') return saved;
    }
    return 'light';
  });

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', next);
      return next;
    });
  }, []);

  // Apply dark class to document root
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // Load persisted theme from the background (channel RPC) on mount.
  useEffect(() => {
    if (isAuthenticated && userId) {
      fetchUserSettings(frontendToken)
        .then((data) => {
          if (data.theme === 'dark' || data.theme === 'light') {
            setTheme(data.theme);
            localStorage.setItem('theme', data.theme);
          }
        })
        .catch(() => {});
    }
  }, [isAuthenticated, userId, frontendToken]);

  // Persist theme to the background (channel RPC) on change.
  useEffect(() => {
    if (isAuthenticated && userId) {
      updateTheme(frontendToken, theme).catch(() => {});
    }
  }, [theme, isAuthenticated, userId, frontendToken]);

  // Keyboard shortcut: Cmd+Shift+D to toggle theme
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'd' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        toggleTheme();
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [toggleTheme]);

  // Debug overlay — opened by the hidden 10-tap on the settings header,
  // persisted in localStorage so it survives a reload.
  const [debugMode, setDebugMode] = useState(
    () => localStorage.getItem('mentra-debug-mode') === 'true',
  );
  const [debugToast, setDebugToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showDebugToast = useCallback((message: string) => {
    setDebugToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setDebugToast(null), 2000);
  }, []);

  const enableDebugMode = useCallback(() => {
    if (debugMode) return;
    localStorage.setItem('mentra-debug-mode', 'true');
    setDebugMode(true);
    showDebugToast('Debug mode enabled');
  }, [debugMode, showDebugToast]);

  const disableDebugMode = useCallback(() => {
    localStorage.removeItem('mentra-debug-mode');
    setDebugMode(false);
    showDebugToast('Debug mode disabled');
  }, [showDebugToast]);

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-foreground" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center p-8 max-w-md">
          <h2 className="text-destructive text-lg font-semibold mb-2">Something went wrong</h2>
          <p className="text-destructive/80 text-sm mb-4">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <ThemeContext.Provider value={{ theme, isDarkMode: theme === 'dark', toggleTheme }}>
      <div
        className="font-sans bg-background text-foreground min-h-screen"
        style={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        <ChatInterface
          userId={userId || ''}
          recipientId="mentra-ai"
          onEnableDebugMode={enableDebugMode}
          debugMode={debugMode}
          safeAreaTop={insets.top}
        />

        {/* Debug overlay — rendered outside ChatInterface so it appears on all pages */}
        {debugMode && <DebugOverlay onClose={disableDebugMode} />}

        {/* Debug toast */}
        <AnimatePresence>
          {debugToast && (
            <motion.div
              key="debug-toast"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.2 }}
              className="fixed bottom-[160px] left-0 right-0 z-[70] flex justify-center pointer-events-none"
            >
              <span className="px-4 py-2 rounded-full bg-black/80 text-white text-xs font-medium backdrop-blur-md">
                {debugToast}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ThemeContext.Provider>
  );
}
