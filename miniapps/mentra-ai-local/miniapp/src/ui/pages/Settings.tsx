import React, { useRef, useState, useEffect } from 'react';
import { useMentraAuth } from '../lib/localAuth';
import { motion } from 'framer-motion';
import Header from '../components/Header';
import SettingItem from '../ui/setting-item';
import ToggleSwitch from '../ui/toggle-switch';
import SimpleToggle from '../ui/simple-toggle';
import { updateTheme, updateChatHistoryEnabled, updateModel, fetchUserSettings } from '../api/settings.api';
import { MODEL_OPTIONS, DEFAULT_MODEL_ID } from '../../shared/types';
// @ts-ignore - JSON import typed as unknown by env.d.ts
import miniappManifest from '../../../miniapp.json';

/** Real app version from the miniapp manifest (single source of truth). */
const APP_VERSION = (miniappManifest as { version?: string })?.version ?? '0.0.0';
/** Taps on the version line needed to toggle debug mode. */
const DEBUG_TAP_THRESHOLD = 10;

interface SettingsProps {
  onBack: () => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  onChatHistoryToggle?: (enabled: boolean) => void;
  onEnableDebugMode?: () => void;
}

interface SettingItemInfo {
  settingName: string;
  description?: string;
}

const settingItems: Record<string, SettingItemInfo> = {
  darkMode: {
    settingName: 'Theme',
    description: '',
  },
  chatHistory: {
    settingName: 'Chat History',
    description: 'Save conversations to view later',
  },
  model: {
    settingName: 'AI Model',
    description: 'Model that powers Mentra AI',
  },
};

/**
 * Settings page component
 */
function Settings({
  onBack,
  isDarkMode,
  onToggleDarkMode,
  onChatHistoryToggle,
  onEnableDebugMode,
}: SettingsProps) {
  const { frontendToken } = useMentraAuth();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [chatHistoryEnabled, setChatHistoryEnabled] = useState(false);
  const [model, setModel] = useState<string>(DEFAULT_MODEL_ID);
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);

  // Hidden debug-mode toggle: tap the version line DEBUG_TAP_THRESHOLD times.
  // tapCount is state (not a ref) so the version line can grey out as feedback.
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

  // Handle chat history toggle
  const handleChatHistoryToggle = async () => {
    const newValue = !chatHistoryEnabled;
    setChatHistoryEnabled(newValue);

    try {
      await updateChatHistoryEnabled(frontendToken, newValue);
      console.log('Chat history setting synced:', newValue);
      onChatHistoryToggle?.(newValue);
    } catch (error) {
      console.error('Failed to update chat history setting:', error);
      setChatHistoryEnabled(!newValue);
    }
  };

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

  // Handle theme toggle
  const handleThemeToggle = async () => {
    const newTheme = isDarkMode ? 'light' : 'dark';
    onToggleDarkMode();

    try {
      await updateTheme(frontendToken, newTheme);
      console.log('Theme synced:', newTheme);
    } catch (error) {
      console.error('Failed to update theme:', error);
      onToggleDarkMode();
    }
  };

  return (
    <div
      className={`h-screen flex flex-col ${isDarkMode ? 'dark' : ''}`}
      style={{
        backgroundColor: 'var(--background)',
        overscrollBehavior: 'none',
        touchAction: 'pan-y',
      }}
    >
      {/* Header */}
      <Header
        isDarkMode={isDarkMode}
        onToggleDarkMode={onToggleDarkMode}
        onSettingsClick={onBack}
        showBackArrow={true}
      />

      {/* Settings Content */}
      <motion.div
        ref={scrollAreaRef}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex-1 px-[24px] pt-[24px] space-y-3 overflow-y-auto"
        style={{
          overscrollBehavior: 'none',
          WebkitOverflowScrolling: 'touch',
          touchAction: 'pan-y',
        }}
      >
        {/* Theme Setting */}
        <SettingItem
          isFirstItem={true}
          isLastItem={false}
          settingItemName={settingItems.darkMode.settingName}
          description={settingItems.darkMode.description}
          customContent={
            <ToggleSwitch isOn={isDarkMode} onToggle={handleThemeToggle} label="Theme" />
          }
        />

        {/* AI Model Setting — picks which OpenRouter model powers the agent.
            Vision-capable models do Mentra Live photo analysis; text-only ones
            (e.g. DeepSeek) are flagged and can't see photos. */}
        <SettingItem
          isFirstItem={false}
          isLastItem={true}
          settingItemName={settingItems.model.settingName}
          description={settingItems.model.description}
          customContent={
            <select
              value={model}
              disabled={isLoadingSettings}
              onChange={(e) => handleModelChange(e.target.value)}
              aria-label="AI Model"
              className="text-[14px] font-medium bg-transparent text-right outline-none cursor-pointer disabled:opacity-50"
              style={{ color: 'var(--secondary-foreground)' }}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.provider}){m.visionCapable ? '' : ' — text only'}
                </option>
              ))}
            </select>
          }
        />

        {/* Warn when the selected model can't analyze photos. */}
        {MODEL_OPTIONS.find((m) => m.id === model)?.visionCapable === false && (
          <p className="px-[16px] text-[12px]" style={{ color: 'var(--secondary-foreground)' }}>
            This model can&apos;t analyze photos from the camera.
          </p>
        )}

        {/* Chat History Setting — disabled until persistence is implemented
        <SettingItem
          isFirstItem={false}
          isLastItem={true}
          settingItemName={settingItems.chatHistory.settingName}
          description={settingItems.chatHistory.description}
          customContent={
            <SimpleToggle
              isOn={chatHistoryEnabled}
              onToggle={handleChatHistoryToggle}
              label="Chat History"
            />
          }
        />
        */}

        {/* Version Info — also the hidden debug toggle. Tapping greys it out
            progressively as feedback; DEBUG_TAP_THRESHOLD taps enables dev mode. */}
        <div className="pt-8 text-center">
          <p
            onClick={handleVersionTap}
            className="text-[12px] text-gray-500 select-none cursor-pointer transition-opacity duration-150"
            style={{
              // Grey out progressively as taps accumulate — visual feedback that
              // each tap registered. Resting (tapCount 0) keeps full opacity.
              opacity: tapCount === 0 ? 1 : Math.max(0.3, 1 - tapCount / DEBUG_TAP_THRESHOLD),
            }}
          >
            Mentra AI v{APP_VERSION}
          </p>
        </div>
      </motion.div>
    </div>
  );
}

export default Settings;
