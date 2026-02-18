/**
 * Dashboard Control Screen
 * Manual navigation controls for MP Dashboard widgets
 */

import { View, TouchableOpacity, TextInput, Modal } from 'react-native';
import { Screen, Header, Text } from '@/components/ignite';
import { useNavigationHistory } from '@/contexts/NavigationHistoryContext';
import { dashboardManager } from '@/services/DashboardManager';
import { TeleprompterWidget } from '@/services/widgets/TeleprompterWidget';
import { useState, useEffect } from 'react';
import { useSettingsStore, SETTINGS } from '@/stores/settings';

export default function DashboardControlScreen() {
  const { goBack } = useNavigationHistory();
  const mpCliRunning = useSettingsStore((state) => state.mp_cli_running);
  const [currentWidget, setCurrentWidget] = useState<string>('');
  const [widgets, setWidgets] = useState<any[]>([]);
  const [displayText, setDisplayText] = useState<string>('');
  const [showScriptEditor, setShowScriptEditor] = useState(false);
  const [scriptText, setScriptText] = useState('');

  useEffect(() => {
    updateWidgetInfo();
    // Poll for updates every 2 seconds
    const interval = setInterval(updateWidgetInfo, 2000);
    return () => clearInterval(interval);
  }, [mpCliRunning]);

  const updateWidgetInfo = async () => {
    if (!dashboardManager) return;
    
    const current = dashboardManager.getCurrentWidget();
    setCurrentWidget(current?.name || 'None');
    setWidgets(dashboardManager.getAllWidgets());
    
    // Fetch and display current widget data
    if (current) {
      try {
        const data = await current.fetchData();
        const formatted = current.formatDisplay(data);
        setDisplayText(formatted);
      } catch (error) {
        setDisplayText('Error loading widget');
      }
    }
  };

  const handleNext = async () => {
    if (!dashboardManager) return;
    await dashboardManager.next();
    updateWidgetInfo();
  };

  const handlePrevious = async () => {
    if (!dashboardManager) return;
    await dashboardManager.previous();
    updateWidgetInfo();
  };

  const handleRefresh = async () => {
    if (!dashboardManager) return;
    await dashboardManager.refresh();
  };

  const toggleWidget = (widgetId: string, enabled: boolean) => {
    if (!dashboardManager) return;
    dashboardManager.setWidgetEnabled(widgetId, enabled);
    setWidgets([...dashboardManager.getAllWidgets()]);
  };

  const openScriptEditor = async () => {
    const saved = await TeleprompterWidget.loadScript();
    setScriptText(saved || '');
    setShowScriptEditor(true);
  };

  const saveScript = async () => {
    await TeleprompterWidget.saveScript(scriptText);
    setShowScriptEditor(false);
    updateWidgetInfo();
  };

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <Header
        title="Dashboard"
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        style={{ height: 44 }}
      />

      <View className="flex-1 p-4">
        {/* Current Widget Display */}
        <View className="bg-card border border-border rounded-lg p-4 mb-4">
          <Text className="text-muted-foreground text-sm mb-1">
            Current Widget
          </Text>
          <Text className="text-foreground font-semibold text-xl mb-3">
            {currentWidget}
          </Text>
          {displayText && (
            <View className="bg-muted rounded p-3 mt-2">
              <Text className="text-foreground font-mono text-sm" style={{ lineHeight: 20 }}>
                {displayText}
              </Text>
            </View>
          )}
        </View>

        {/* Navigation Controls */}
        <View className="flex-row gap-3 mb-6">
          <TouchableOpacity
            onPress={handlePrevious}
            className="flex-1 bg-primary rounded-lg p-4 items-center"
          >
            <Text className="text-primary-foreground font-semibold">
              ← Previous
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleRefresh}
            className="bg-primary rounded-lg p-4 items-center px-6"
          >
            <Text className="text-primary-foreground font-semibold">
              ↻ Refresh
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleNext}
            className="flex-1 bg-primary rounded-lg p-4 items-center"
          >
            <Text className="text-primary-foreground font-semibold">
              Next →
            </Text>
          </TouchableOpacity>
        </View>

        {/* Widget List */}
        <Text className="text-foreground font-semibold text-lg mb-3">
          Widgets
        </Text>

        {widgets.map((widget) => (
          <View key={widget.id}>
            <TouchableOpacity
              onPress={() => toggleWidget(widget.id, !widget.enabled)}
              className="bg-card border border-border rounded-lg p-4 mb-3 flex-row items-center"
            >
              <View className="flex-1">
                <Text className="text-foreground font-semibold text-base">
                  {widget.name}
                </Text>
                <Text className="text-muted-foreground text-sm">
                  Refresh: {widget.refreshInterval}s
                </Text>
              </View>
              <View
                className={`w-12 h-6 rounded-full ${
                  widget.enabled ? 'bg-primary' : 'bg-muted'
                } justify-center px-1`}
              >
                <View
                  className={`w-4 h-4 rounded-full bg-white ${
                    widget.enabled ? 'self-end' : 'self-start'
                  }`}
                />
              </View>
            </TouchableOpacity>
            
            {/* Show script editor button for teleprompter */}
            {widget.id === 'teleprompter' && (
              <TouchableOpacity
                onPress={openScriptEditor}
                className="bg-secondary rounded-lg p-3 mb-3 items-center"
              >
                <Text className="text-secondary-foreground font-semibold">
                  ✏️ Edit Script
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </View>

      {/* Script Editor Modal */}
      <Modal
        visible={showScriptEditor}
        animationType="slide"
        transparent={false}
      >
        <Screen preset="fixed" safeAreaEdges={[]}>
          <Header
            title="Edit Script"
            titleMode="center"
            leftIcon="x"
            onLeftPress={() => setShowScriptEditor(false)}
            rightIcon="check"
            onRightPress={saveScript}
            style={{ height: 44 }}
          />
          <View className="flex-1 p-4">
            <TextInput
              value={scriptText}
              onChangeText={setScriptText}
              multiline
              placeholder="Enter your teleprompter script here..."
              className="flex-1 bg-card border border-border rounded-lg p-4 text-foreground"
              style={{ textAlignVertical: 'top' }}
            />
            <Text className="text-muted-foreground text-sm mt-2">
              Use Next/Previous buttons to scroll through your script on the glasses.
            </Text>
          </View>
        </Screen>
      </Modal>
    </Screen>
  );
}
