import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { useMentraAuth } from '@mentra/react';
import { motion, AnimatePresence } from 'framer-motion';
import ChatInterface from './pages/ChatInterface';
import { DebugOverlay } from './components/DebugOverlay';
import { createAuthFetch } from './lib/authFetch';

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

  // Sync theme with backend when user authenticates
  useEffect(() => {
    if (isAuthenticated && userId) {
      const authFetch = createAuthFetch(frontendToken);
      authFetch('/api/settings')
        .then((res) => res.json())
        .then((data) => {
          if (data.theme === 'dark' || data.theme === 'light') {
            setTheme(data.theme);
            localStorage.setItem('theme', data.theme);
          }
        })
        .catch(() => {});
    }
  }, [isAuthenticated, userId, frontendToken]);

  // Save theme to backend on change
  useEffect(() => {
    if (isAuthenticated && userId) {
      const authFetch = createAuthFetch(frontendToken);
      authFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      }).catch(() => {});
    }
  }, [theme, isAuthenticated, userId, frontendToken]);

  // Debug mode state with localStorage persistence.
  // In development the overlay auto-opens so the Buttons tab (TTS test,
  // etc.) is always available without the hidden 10-tap gesture.
  //
  // NOTE: use process.env.NODE_ENV, not import.meta.env.DEV — Bun only
  // defines import.meta.env in its dev server, so a production build
  // (`bun src/index.ts`) would throw on `.DEV` and white-screen the app.
  const [debugMode, setDebugMode] = useState(() => {
    if (process.env.NODE_ENV === 'development') return true;
    return localStorage.getItem('mentra-debug-mode') === 'true';
  });
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
          <h2 className="text-destructive text-lg font-semibold mb-2">Authentication Error</h2>
          <p className="text-destructive/80 text-sm mb-4">{error}</p>
          <p className="text-muted-foreground text-xs">
            Please ensure you are opening this page from the MentraOS app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ThemeContext.Provider value={{ theme, isDarkMode: theme === 'dark', toggleTheme }}>
      <div className="font-sans bg-background text-foreground min-h-screen">
        <ChatInterface userId={userId || ''} recipientId="mentra-ai" onEnableDebugMode={enableDebugMode} />

        {/* Debug overlay — rendered outside ChatInterface so it appears on all pages */}
        {debugMode && userId && (
          <DebugOverlay onClose={disableDebugMode} />
        )}

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
