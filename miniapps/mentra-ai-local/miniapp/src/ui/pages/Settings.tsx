import React, { useRef, useState, useEffect } from 'react';
import { useMentraAuth } from '../lib/localAuth';
import { motion } from 'framer-motion';
import { updateModel, fetchUserSettings } from '../api/settings.api';
import { MODEL_OPTIONS, DEFAULT_MODEL_ID } from '../../shared/types';
import OptionSheet, { type SheetOption } from '../ui/option-sheet';
import { providerIcon } from '../ui/provider-icons';
import SettingsBackground from '../components/SettingsBackground';
// @ts-ignore - JSON import typed as unknown by env.d.ts
import miniappManifest from '../../../miniapp.json';

/** Real app version from the miniapp manifest (single source of truth). */
const APP_VERSION = (miniappManifest as { version?: string })?.version ?? '0.0.0';
/** Taps on the version line needed to toggle debug mode. */
const DEBUG_TAP_THRESHOLD = 10;

/** Shared Red Hat Display stack from the Paper mockup (falls back to system). */
const FONT_STACK = "'RedHatDisplay-Regular_Bold','Red_Hat_Display',system-ui,sans-serif";

/**
 * Entry motion for each settings section — a quick, refined lift + fade.
 * Sections cascade via the container's staggerChildren for a premium feel
 * (short distance, snappy custom-bezier, no slow whole-page slide).
 */
const SECTION_VARIANTS = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const },
  },
};

interface SettingsProps {
  onBack: () => void;
  onEnableDebugMode?: () => void;
  /** Accepted for compatibility with the caller; these rows are not shown. */
  isDarkMode?: boolean;
  onToggleDarkMode?: () => void;
  onChatHistoryToggle?: (enabled: boolean) => void;
}

// ── Inline icons (matched to the Paper mockup exactly) ─────────────────────

/** Pink four-point star — leading icon for Model and Wake word rows. */
function StarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <path d="M12 2.5 L13.5 9 L20 11 L13.5 13 L12 19.5 L10.5 13 L4 11 L10.5 9 Z" fill="#FF5FA2" />
    </svg>
  );
}

/** Globe — leading icon for the Voice & language row. */
function GlobeIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" fill="none" stroke="#0B0B0F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 12h20" fill="none" stroke="#0B0B0F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" fill="none" stroke="#0B0B0F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Info circle — leading icon for the About row. */
function InfoIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" fill="none" stroke="#0B0B0F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 16v-4" fill="none" stroke="#0B0B0F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 8h.01" fill="none" stroke="#0B0B0F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Trailing chevron (disclosure indicator). */
function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <path d="m9 18 6-6-6-6" fill="none" stroke="rgb(11 11 15 / 28%)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Back chevron in the header. */
function BackIcon() {
  return (
    <svg width="23" height="23" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <path d="m15 18-6-6 6-6" fill="none" stroke="#0B0B0F" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Layout primitives (match the mockup's frosted card + rows) ─────────────

/** Frosted-glass card wrapper (one rounded panel per section). */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-[20px] overflow-clip [backdrop-filter:blur(20px)] [box-shadow:#0B0B0F12_0px_8px_24px] bg-[rgb(255_255_255/72%)] border border-solid border-[rgb(255_255_255/65%)]">
      {children}
    </div>
  );
}

/** Thin divider between rows, inset to clear the icon column. */
function RowDivider() {
  return <div className="h-px ml-15 shrink-0 bg-[#0B0B0F12]" />;
}

/** Square tinted tile holding a row's leading icon. */
function IconTile({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center w-8.5 h-8.5 shrink-0 rounded-[9px] bg-[#0B0B0F0D]">
      {children}
    </div>
  );
}

/** Section header label ("ASSISTANT" / "ABOUT"). */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pl-1.5">
      <div
        className="inline-block tracking-[0.14em] font-semibold text-[#0B0B0F73] text-[11px]/3.5"
        style={{ fontFamily: FONT_STACK }}
      >
        {children}
      </div>
    </div>
  );
}

/** The bold black title of a row (e.g. "Model"). */
function RowTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grow basis-0 font-semibold text-[#0B0B0F] text-[15px]/4.5"
      style={{ fontFamily: FONT_STACK }}
    >
      {children}
    </div>
  );
}

/** The grey trailing value of a row (e.g. "Gemini Flash"). */
function RowValue({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-medium text-[#6B6B72] text-sm/4.5 max-w-[150px] truncate text-right"
      style={{ fontFamily: FONT_STACK }}
    >
      {children}
    </div>
  );
}

/**
 * Settings page component — frosted-card design (ASSISTANT / ABOUT sections),
 * pixel-matched to the Paper mockup. Light-only (no theme toggle). Model is the
 * one live control; Wake word and Voice & language are display-only for now;
 * the About row is the hidden debug-mode tap target.
 */
function Settings({ onBack, onEnableDebugMode }: SettingsProps) {
  const { frontendToken } = useMentraAuth();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [, setChatHistoryEnabled] = useState(false);
  const [model, setModel] = useState<string>(DEFAULT_MODEL_ID);
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);

  // Hidden debug-mode toggle: tap the version row DEBUG_TAP_THRESHOLD times.
  const [tapCount, setTapCount] = useState(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleVersionTap = () => {
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    setTapCount((prev) => {
      const next = prev + 1;
      if (next >= DEBUG_TAP_THRESHOLD) {
        onEnableDebugMode?.();
        return 0; // reset after triggering
      }
      // Reset the streak if the user pauses between taps.
      tapTimerRef.current = setTimeout(() => setTapCount(0), 3000);
      return next;
    });
  };

  // Fetch user settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await fetchUserSettings(frontendToken);
        setChatHistoryEnabled(settings.chatHistoryEnabled ?? false);
        setModel(settings.model ?? DEFAULT_MODEL_ID);
      } catch (error) {
        console.error('Failed to load settings:', error);
      } finally {
        setIsLoadingSettings(false);
      }
    };
    loadSettings();
  }, [frontendToken]);

  // Handle AI model change — optimistic, reverts on failure.
  const handleModelChange = async (newModel: string) => {
    const prev = model;
    setModel(newModel);
    try {
      await updateModel(frontendToken, newModel);
      console.log('AI model synced:', newModel);
    } catch (error) {
      console.error('Failed to update AI model:', error);
      setModel(prev);
    }
  };

  const selectedModel = MODEL_OPTIONS.find((m) => m.id === model);

  // Map the model catalog into the generic sheet's option shape, with each
  // provider's brand logo as the leading icon.
  const modelSheetOptions: SheetOption<string>[] = MODEL_OPTIONS.map((m) => ({
    value: m.id,
    label: m.label,
    description: m.visionCapable ? m.provider : `${m.provider} · text only`,
    leading: providerIcon(m.provider, 'w-[18px] h-[18px]'),
  }));

  return (
    <div
      className="flex-1 min-h-0 flex flex-col overflow-clip relative bg-white antialiased text-[#0B0B0F] [font-synthesis:none]"
      style={{ fontFamily: FONT_STACK }}
    >
      {/* Colorful blurred gradient backdrop — subtly animated (from the Paper
          mockup; the blobs now slowly drift for a living-glow feel). */}
      <SettingsBackground />

      {/* Header: back chevron + title */}
      <div className="flex items-center h-11 px-5 pt-5 pb-4.5 gap-3.5 shrink-0 relative z-10">
        <button
          onClick={onBack}
          aria-label="Back"
          className="flex items-center justify-center w-9.5 h-9.5 shrink-0 -ml-2 rounded-full transition-opacity active:opacity-60"
        >
          <BackIcon />
        </button>
        <div
          className="grow tracking-[-0.02em] font-bold text-[#0B0B0F] text-2xl/7.5"
          style={{ fontFamily: FONT_STACK }}
        >
          Settings
        </div>
      </div>

      {/* Scrollable content */}
      <motion.div
        ref={scrollAreaRef}
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.06, delayChildren: 0.02 } },
        }}
        className="flex-1 px-5 pb-5.5 flex flex-col gap-5.5 overflow-y-auto relative z-10"
        style={{ overscrollBehavior: 'none', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
      >
        {/* ── ASSISTANT ─────────────────────────────────────────── */}
        <motion.section
          variants={SECTION_VARIANTS}
          style={{ willChange: 'transform, opacity' }}
          className="flex flex-col gap-2.25"
        >
          <SectionLabel>ASSISTANT</SectionLabel>
          <Card>
            {/* Model — opens the reusable OptionSheet listing every AI option. */}
            <button
              type="button"
              disabled={isLoadingSettings}
              onClick={() => setModelSheetOpen(true)}
              aria-label="AI Model"
              className="flex items-center py-3.25 px-3.5 gap-3 text-left active:bg-[#0B0B0F08] disabled:opacity-60 transition-colors"
            >
              <IconTile>
                {selectedModel ? providerIcon(selectedModel.provider, 'w-[18px] h-[18px]') ?? <StarIcon /> : <StarIcon />}
              </IconTile>
              <RowTitle>Model</RowTitle>
              <RowValue>{selectedModel?.label ?? 'Model'}</RowValue>
              <ChevronIcon />
            </button>

            <RowDivider />

            {/* Wake word — display-only ("Hey Mentra" is hard-coded today). */}
            <div className="flex items-center py-3.25 px-3.5 gap-3">
              <IconTile>
                <StarIcon />
              </IconTile>
              <RowTitle>Wake word</RowTitle>
              <RowValue>&ldquo;Hey Mentra&rdquo;</RowValue>
              <ChevronIcon />
            </div>

            <RowDivider />

            {/* Voice & language — display-only (recognition stays auto-detect). */}
            <div className="flex items-center py-3.25 px-3.5 gap-3">
              <IconTile>
                <GlobeIcon />
              </IconTile>
              <RowTitle>Voice &amp; language</RowTitle>
              <RowValue>English (US)</RowValue>
              <ChevronIcon />
            </div>
          </Card>

          {/* Warn when the selected model can't analyze photos. */}
          {selectedModel?.visionCapable === false && (
            <p className="pl-1.5 text-[12px] text-[#6B6B72]" style={{ fontFamily: FONT_STACK }}>
              This model can&apos;t analyze photos from the camera.
            </p>
          )}
        </motion.section>

        {/* ── ABOUT ─────────────────────────────────────────────── */}
        <motion.section
          variants={SECTION_VARIANTS}
          style={{ willChange: 'transform, opacity' }}
          className="flex flex-col gap-2.25"
        >
          <SectionLabel>ABOUT</SectionLabel>
          <Card>
            {/* About row — value is the version, and it's the hidden debug tap target. */}
            <button
              onClick={handleVersionTap}
              className="flex items-center py-3.25 px-3.5 gap-3 text-left select-none transition-opacity duration-150 active:opacity-70"
              style={{ opacity: tapCount === 0 ? 1 : Math.max(0.4, 1 - tapCount / DEBUG_TAP_THRESHOLD) }}
            >
              <IconTile>
                <InfoIcon />
              </IconTile>
              <RowTitle>About Mentra AI</RowTitle>
              <RowValue>v{APP_VERSION}</RowValue>
              <ChevronIcon />
            </button>
          </Card>
        </motion.section>
      </motion.div>

      {/* Model picker — reusable bottom sheet listing all AI options. */}
      <OptionSheet
        open={modelSheetOpen}
        title="Model"
        options={modelSheetOptions}
        value={model}
        onSelect={(v) => void handleModelChange(v)}
        onClose={() => setModelSheetOpen(false)}
      />
    </div>
  );
}

export default Settings;
