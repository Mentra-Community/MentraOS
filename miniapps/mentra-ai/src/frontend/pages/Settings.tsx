import React, { useRef, useState, useEffect } from 'react';
import { useMentraAuth } from '@mentra/react';
import { motion } from 'framer-motion';
import Header from '../components/Header';
import SettingItem from '../ui/setting-item';
import ToggleSwitch from '../ui/toggle-switch';
import SimpleToggle from '../ui/simple-toggle';
import { updateTheme, updateChatHistoryEnabled, fetchUserSettings } from '../api/settings.api';

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
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);

  // Hidden 10-tap debug mode activation
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

  // Fetch user settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await fetchUserSettings(frontendToken);
        setChatHistoryEnabled(settings.chatHistoryEnabled ?? false);
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
      onClick={handleSettingsTap}
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
          isLastItem={true}
          settingItemName={settingItems.darkMode.settingName}
          description={settingItems.darkMode.description}
          customContent={
            <ToggleSwitch isOn={isDarkMode} onToggle={handleThemeToggle} label="Theme" />
          }
        />

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

        {/* Version Info */}
        <div className="pt-8 text-center">
          <p className="text-[12px] text-gray-500">Mentra AI v1.0.0</p>
        </div>
      </motion.div>
    </div>
  );
}

export default Settings;
