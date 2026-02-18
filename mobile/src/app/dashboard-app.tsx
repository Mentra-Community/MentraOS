import { useState, useEffect } from 'react';
import { View, ScrollView, NativeModules, Platform } from 'react-native';
import { Screen, Header, Text, Button } from '@/components/ignite';
import { useNavigationHistory } from '@/contexts/NavigationHistoryContext';
import { useAppTheme } from '@/contexts/ThemeContext';
import { Group } from '@/components/ui';
import DashboardManager from '@/services/DashboardManager';

const { MediaButtonHandlerModule } = NativeModules;

export default function DashboardApp() {
  const { goBack } = useNavigationHistory();
  const { theme } = useAppTheme();
  const [currentWidget, setCurrentWidget] = useState('');
  const [displayText, setDisplayText] = useState('');

  useEffect(() => {
    // Enable media button handler when screen opens
    if (Platform.OS === 'ios' && MediaButtonHandlerModule) {
      console.log('[DashboardApp] Enabling media button handler');
      MediaButtonHandlerModule.enable();
    }

    updateWidgetInfo();
    const interval = setInterval(updateWidgetInfo, 10000); // Reduced to 10 seconds
    
    return () => {
      clearInterval(interval);
      // Disable when leaving
      if (Platform.OS === 'ios' && MediaButtonHandlerModule) {
        MediaButtonHandlerModule.disable();
      }
    };
  }, []);

  const updateWidgetInfo = async () => {
    const manager = DashboardManager.getInstance();
    const current = manager.getCurrentWidget();
    setCurrentWidget(current?.name || 'None');
    
    // Disable contextual switching when on Teleprompter
    if (current?.id === 'teleprompter') {
      manager.setContextualSwitching(false);
    } else {
      manager.setContextualSwitching(true);
    }
    
    if (current) {
      try {
        const data = await current.fetchData();
        const formatted = current.formatDisplay(data);
        setDisplayText(formatted);
      } catch (_error) {
        setDisplayText('Error loading widget');
      }
    }
  };

  const handleSwitchWidget = async () => {
    const manager = DashboardManager.getInstance();
    // Re-enable contextual switching and switch to next widget
    manager.setContextualSwitching(true);
    await manager.nextWidget();
    await updateWidgetInfo();
  };

  const handleNext = async () => {
    const manager = DashboardManager.getInstance();
    const current = manager.getCurrentWidget();
    
    // Special handling for Teleprompter - only paginate, don't switch widgets
    if (current?.id === 'teleprompter') {
      const teleprompter = current as any;
      await teleprompter.next();
      await updateWidgetInfo();
      return; // Don't switch widgets
    }
    
    await manager.nextWidget();
    await updateWidgetInfo();
  };

  const handlePrevious = async () => {
    const manager = DashboardManager.getInstance();
    const current = manager.getCurrentWidget();
    
    // Special handling for Teleprompter - only paginate, don't switch widgets
    if (current?.id === 'teleprompter') {
      const teleprompter = current as any;
      await teleprompter.previous();
      await updateWidgetInfo();
      return; // Don't switch widgets
    }
    
    await manager.previousWidget();
    await updateWidgetInfo();
  };

  const handleLoadFile = async () => {
    try {
      const { default: TeleprompterWidget } = await import('../services/widgets/TeleprompterWidget');
      const content = await TeleprompterWidget.loadFromFile();
      if (content) {
        await updateWidgetInfo();
      }
    } catch (error) {
      console.error('[Dashboard] Load file error:', error);
    }
  };

  return (
    <Screen preset="scroll">
      <Header
        title="Dashboard"
        leftIcon="chevron-left"
        onLeftPress={goBack}
      />

      <ScrollView style={{ flex: 1, paddingHorizontal: theme.spacing.s4 }}>
        <Group title="Current Widget">
          <View style={{ padding: theme.spacing.s4 }}>
            <Text style={{ fontSize: 18, marginBottom: 8 }}>{currentWidget}</Text>
            <View style={{ 
              backgroundColor: theme.colors.palette.neutral800, 
              padding: theme.spacing.s4, 
              borderRadius: 8,
              marginTop: 8
            }}>
              <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>
                {displayText || 'Loading...'}
              </Text>
            </View>
          </View>
        </Group>

        <Group title="Navigation">
          <View style={{ padding: theme.spacing.s4, gap: theme.spacing.s4 }}>
            <Button
              text="🔄 Switch Widget"
              onPress={handleSwitchWidget}
              preset="reversed"
              style={{ minHeight: 80, paddingVertical: theme.spacing.s6 }}
              textStyle={{ fontSize: 24 }}
            />
            <Button
              text="⬅️ Previous"
              onPress={handlePrevious}
              preset="default"
              style={{ minHeight: 80, paddingVertical: theme.spacing.s6 }}
              textStyle={{ fontSize: 24 }}
            />
            <Button
              text="Next ➡️"
              onPress={handleNext}
              preset="default"
              style={{ minHeight: 80, paddingVertical: theme.spacing.s6 }}
              textStyle={{ fontSize: 24 }}
            />
            <Button
              text="📄 Load File"
              onPress={handleLoadFile}
              preset="default"
              style={{ minHeight: 80, paddingVertical: theme.spacing.s6 }}
              textStyle={{ fontSize: 24 }}
            />
          </View>
        </Group>

        <Group title="Widgets">
          <View style={{ padding: theme.spacing.s4 }}>
            <Text style={{ marginBottom: 8 }}>📅 Calendar - Today&apos;s events</Text>
            <Text style={{ marginBottom: 8 }}>🌤️ Weather - Columbus, OH</Text>
            <Text style={{ marginBottom: 8 }}>🎤 Teleprompter - Scripts</Text>
          </View>
        </Group>

        <Group title="Contextual Switching">
          <View style={{ padding: theme.spacing.s4 }}>
            <Text style={{ color: theme.colors.textDim }}>
              Dashboard automatically switches based on head position:
              {'\n\n'}
              • Heads Up → Weather (quick glance)
              {'\n'}
              • Heads Down → Calendar (detailed info)
            </Text>
          </View>
        </Group>
      </ScrollView>
    </Screen>
  );
}
