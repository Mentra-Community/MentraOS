import React, { useRef, useState, useEffect } from 'react';
import { useMentraAuth } from '@mentra/react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Mic, Globe, Info, Check, ChevronDown } from 'lucide-react';
import Header from '../components/Header';
import ToggleSwitch from '../ui/toggle-switch';
import { updateTheme, updateUserSettings, fetchUserSettings } from '../api/settings.api';

interface SettingsProps {
  onBack: () => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  onChatHistoryToggle?: (enabled: boolean) => void;
  onEnableDebugMode?: () => void;
}

/**
 * User-selectable models. Mirrors MODEL_OPTIONS on the server (display copy
 * only — the server owns the actual model strings). `key` is what we persist.
 */
const MODEL_OPTIONS: { key: string; label: string; description: string; accent: string }[] = [
  { key: 'flash', label: 'Gemini Flash', description: 'Fast · best for quick answers', accent: '#F0A88B' },
  { key: 'pro', label: 'Gemini Pro', description: 'Most capable · detailed replies', accent: '#A89BF5' },
  { key: 'flashLite', label: 'Gemini Flash-Lite', description: 'Fastest · lightweight replies', accent: '#86CFAC' },
];
const DEFAULT_MODEL_KEY = 'flashLite';

/** Uppercase section label above a card group. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-6 px-1 text-[12px] font-semibold uppercase tracking-wider text-gray-400">
      {children}
    </div>
  );
}

/** A rounded icon chip tinted with the given accent. */
function IconChip({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]"
      style={{ backgroundColor: `${accent}22`, color: accent }}
    >
      {children}
    </div>
  );
}

/**
 * Settings page — Figma V2 layout (Assistant / Appearance / About).
 */
function Settings({ onBack, isDarkMode, onToggleDarkMode, onChatHistoryToggle, onEnableDebugMode }: SettingsProps) {
  const { frontendToken } = useMentraAuth();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [modelKey, setModelKey] = useState<string>(DEFAULT_MODEL_KEY);
  const [modelOpen, setModelOpen] = useState(false);

  // Hidden 10-tap debug mode activation (taps anywhere on the page).
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSettingsTap = () => {
    tapCountRef.current++;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => { tapCountRef.current = 0; }, 3000);
    if (tapCountRef.current >= 10) {
      tapCountRef.current = 0;
      onEnableDebugMode?.();
    }
  };

  // Load settings on mount.
  useEffect(() => {
    (async () => {
      try {
        const settings = await fetchUserSettings(frontendToken);
        if (settings.model) setModelKey(settings.model);
        onChatHistoryToggle?.(settings.chatHistoryEnabled ?? false);
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    })();
  }, [frontendToken]);

  const handleSelectModel = async (key: string) => {
    setModelKey(key);
    setModelOpen(false);
    try {
      await updateUserSettings(frontendToken, { model: key });
    } catch (error) {
      console.error('Failed to update model:', error);
    }
  };

  const handleThemeToggle = async () => {
    const newTheme = isDarkMode ? 'light' : 'dark';
    onToggleDarkMode();
    try {
      await updateTheme(frontendToken, newTheme);
    } catch (error) {
      console.error('Failed to update theme:', error);
      onToggleDarkMode(); // revert on failure
    }
  };

  const selectedModel = MODEL_OPTIONS.find((m) => m.key === modelKey) ?? MODEL_OPTIONS[2];

  return (
    <div
      onClick={handleSettingsTap}
      className={`relative h-screen overflow-hidden ${isDarkMode ? 'dark' : ''}`}
      style={{ backgroundColor: 'var(--background)', overscrollBehavior: 'none', touchAction: 'pan-y' }}
    >
      {/* Soft gradient glow at the bottom (matches the other screens). */}
      <div
        className="pointer-events-none absolute bottom-0 left-0 right-0 h-[420px]"
        style={{
          background:
            'radial-gradient(120% 80% at 70% 100%, rgba(244,114,182,0.22), rgba(168,139,250,0.18) 40%, rgba(96,165,250,0.10) 65%, transparent 80%)',
        }}
      />

      <div className="relative z-10 flex h-full flex-col">
        <Header isDarkMode={isDarkMode} onToggleDarkMode={onToggleDarkMode} onSettingsClick={onBack} showBackArrow title="Settings" />

        <motion.div
          ref={scrollAreaRef}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex-1 overflow-y-auto px-[20px] pb-16"
          style={{ overscrollBehavior: 'none', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
        >
          {/* ── Assistant ──────────────────────────────────────────── */}
          <SectionLabel>Assistant</SectionLabel>
          <div className="overflow-hidden rounded-[18px] bg-[var(--primary-foreground)] shadow-sm">
            {/* Model (expandable) */}
            <button
              onClick={() => setModelOpen((o) => !o)}
              className="flex h-[58px] w-full items-center gap-3 px-4 text-left"
            >
              <IconChip accent={selectedModel.accent}><Sparkles className="h-[18px] w-[18px]" /></IconChip>
              <span className="flex-1 text-[15px] font-semibold" style={{ color: 'var(--secondary-foreground)' }}>Model</span>
              <span className="text-[14px]" style={{ color: modelOpen ? selectedModel.accent : '#9ca3af' }}>{selectedModel.label}</span>
              <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence initial={false}>
              {modelOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  {MODEL_OPTIONS.map((opt) => {
                    const active = opt.key === modelKey;
                    return (
                      <button
                        key={opt.key}
                        onClick={() => handleSelectModel(opt.key)}
                        className="flex w-full items-center gap-3 border-t border-black/[0.04] px-4 py-3 text-left dark:border-white/[0.06]"
                        style={active ? { backgroundColor: `${opt.accent}14` } : undefined}
                      >
                        <IconChip accent={opt.accent}><Sparkles className="h-[18px] w-[18px]" /></IconChip>
                        <span className="flex-1">
                          <span className="block text-[15px] font-semibold" style={{ color: 'var(--secondary-foreground)' }}>{opt.label}</span>
                          <span className="block text-[13px] text-gray-400">{opt.description}</span>
                        </span>
                        {active && <Check className="h-5 w-5" style={{ color: opt.accent }} strokeWidth={2.5} />}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Wake word (display) */}
            <div className="flex h-[58px] items-center gap-3 border-t border-black/[0.04] px-4 dark:border-white/[0.06]">
              <IconChip accent="#F472B6"><Mic className="h-[18px] w-[18px]" /></IconChip>
              <span className="flex-1 text-[15px] font-semibold" style={{ color: 'var(--secondary-foreground)' }}>Wake word</span>
              <span className="text-[14px] text-gray-400">“Hey Mentra”</span>
            </div>

            {/* Voice & language (display) */}
            <div className="flex h-[58px] items-center gap-3 border-t border-black/[0.04] px-4 dark:border-white/[0.06]">
              <IconChip accent="#60A5FA"><Globe className="h-[18px] w-[18px]" /></IconChip>
              <span className="flex-1 text-[15px] font-semibold" style={{ color: 'var(--secondary-foreground)' }}>Voice &amp; language</span>
              <span className="text-[14px] text-gray-400">English (US)</span>
            </div>
          </div>

          {/* ── Appearance ─────────────────────────────────────────── */}
          <SectionLabel>Appearance</SectionLabel>
          <div className="overflow-hidden rounded-[18px] bg-[var(--primary-foreground)] shadow-sm">
            <div className="flex h-[58px] items-center gap-3 px-4">
              <span className="flex-1 text-[15px] font-semibold" style={{ color: 'var(--secondary-foreground)' }}>Dark mode</span>
              <ToggleSwitch isOn={isDarkMode} onToggle={handleThemeToggle} label="Dark mode" />
            </div>
          </div>

          {/* ── About ──────────────────────────────────────────────── */}
          <SectionLabel>About</SectionLabel>
          <div className="overflow-hidden rounded-[18px] bg-[var(--primary-foreground)] shadow-sm">
            <div className="flex h-[58px] items-center gap-3 px-4">
              <IconChip accent="#6B7280"><Info className="h-[18px] w-[18px]" /></IconChip>
              <span className="flex-1 text-[15px] font-semibold" style={{ color: 'var(--secondary-foreground)' }}>About Mentra AI</span>
              <span className="text-[14px] text-gray-400">v2.0</span>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

export default Settings;
