import {useState, useEffect} from 'react'
import {View, ScrollView, ActivityIndicator, RefreshControl} from 'react-native'

import {Screen, Header, Text, Button} from '@/components/ignite'
import {useNavigationHistory} from '@/contexts/NavigationHistoryContext'
import {mpCliBridge} from '@/services/MpCliBridge'
import miniComms from '@/services/MiniComms'
import DisplayFormatter from '@/services/DisplayFormatter'
import GlobalEventEmitter from '@/utils/GlobalEventEmitter'
import {SETTINGS, useSettingsStore} from '@/stores/settings'

export default function MpCliDashboard() {
  const {goBack} = useNavigationHistory()
  
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<any>(null)
  const [formattedText, setFormattedText] = useState<string>('')
  const [lastUpdated, setLastUpdated] = useState<string>('')
  const [debugLog, setDebugLog] = useState<string[]>([])

  // Load dashboard data
  const loadDashboard = async () => {
    console.log('[MP-CLI Dashboard] loadDashboard called')
    setLoading(true)
    setError(null)

    try {
      // Configure bridge (in production, this would come from settings)
      mpCliBridge.configure(
        'http://192.168.0.91:8421/api/v1',
        '3l2LMHhjg5BH-XJfon0VmqIkhA1ZA9Dv1FWVnsxcbXU'
      )

      console.log('[MP-CLI Dashboard] Executing mp next command')
      // Execute mp next
      const response = await mpCliBridge.executeCommand('next')
      console.log('[MP-CLI Dashboard] Response:', response)

      if (response.success) {
        console.log('[MP-CLI Dashboard] Success! Data:', response.data)
        setData(response.data)
        
        // Format for G1 display
        const formatted = DisplayFormatter.formatNext(response.data)
        console.log('[MP-CLI Dashboard] Formatted text:', formatted)
        setFormattedText(formatted)
        
        setLastUpdated(new Date().toLocaleTimeString())
      } else {
        console.log('[MP-CLI Dashboard] Error:', response.error)
        setError(response.error || 'Failed to load dashboard')
      }
    } catch (err) {
      console.log('[MP-CLI Dashboard] Exception:', err)
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
      console.log('[MP-CLI Dashboard] Loading complete')
    }
  }

  // Load on mount
  useEffect(() => {
    console.log('[MP-CLI Dashboard] Component mounted')
    loadDashboard()
  }, [])

  // Disable default button action while dashboard is active
  // useEffect(() => {
  //   // Disable immediately (synchronous)
  //   useSettingsStore.getState().setSetting(SETTINGS.default_button_action_enabled.key, false)
  //   console.log('[MP-CLI Dashboard] Disabled default button action')

  //   // Store previous value for restoration
  //   let previousSetting: boolean | null = null
  //   useSettingsStore.getState().getSetting(SETTINGS.default_button_action_enabled.key).then(val => {
  //     previousSetting = val
  //   })

  //   return () => {
  //     // Restore on unmount
  //     if (previousSetting !== null) {
  //       useSettingsStore.getState().setSetting(SETTINGS.default_button_action_enabled.key, previousSetting)
  //       console.log('[MP-CLI Dashboard] Restored default button action')
  //     }
  //   }
  // }, [])

  // Listen for G1 button presses
  useEffect(() => {
    let lastTapTime = 0
    const DEBOUNCE_MS = 500

    const onButtonPress = (event: {buttonId: string; pressType: string; timestamp: number}) => {
      const now = Date.now()
      if (now - lastTapTime < DEBOUNCE_MS) {
        console.log('[MP-CLI Dashboard] Ignoring duplicate tap')
        return
      }
      lastTapTime = now

      console.log('[MP-CLI Dashboard] Button press:', event)

      // Left touchpad = Refresh
      if (event.buttonId === 'left' || event.buttonId === 'button_left') {
        console.log('[MP-CLI Dashboard] Left button - refreshing')
        loadDashboard()
        return // Prevent ButtonActions from handling this
      }

      // Right touchpad = Send to G1
      if (event.buttonId === 'right' || event.buttonId === 'button_right') {
        console.log('[MP-CLI Dashboard] Right button - sending to G1')
        handleSendToG1()
        return // Prevent ButtonActions from handling this
      }
    }

    // Register listener with high priority (first in the chain)
    GlobalEventEmitter.on('BUTTON_PRESS', onButtonPress)
    return () => {
      GlobalEventEmitter.removeListener('BUTTON_PRESS', onButtonPress)
    }
  }, [formattedText]) // Re-subscribe when formattedText changes

  // Send to G1
  const handleSendToG1 = () => {
    if (!formattedText) {
      console.log('[MP-CLI Dashboard] No data to send')
      return
    }

    try {
      miniComms.sendToGlasses(formattedText)
      console.log('[MP-CLI Dashboard] Sent to G1 successfully')
    } catch (error) {
      console.error('[MP-CLI Dashboard] Error sending to G1:', error)
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <Header
        title="MP-CLI Dashboard"
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        style={{height: 44}}
      />

      <ScrollView
        className="flex-1"
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadDashboard} />
        }
      >
        {/* Status Bar */}
        <View className="bg-card p-4 border-b border-border">
          <View className="flex-row justify-between items-center">
            <Text className="text-foreground text-sm">
              {lastUpdated ? `Updated: ${lastUpdated}` : 'Not loaded'}
            </Text>
            <Button
              text="Refresh"
              onPress={loadDashboard}
              disabled={loading}
              preset="default"
              style={{paddingHorizontal: 16, paddingVertical: 8}}
            />
          </View>
        </View>

        {/* Loading State */}
        {loading && !data && (
          <View className="items-center justify-center py-20">
            <ActivityIndicator size="large" />
            <Text className="text-foreground mt-4">Loading dashboard...</Text>
          </View>
        )}

        {/* Error State */}
        {error && (
          <View className="p-4">
            <View className="bg-destructive/10 border border-destructive rounded-lg p-4">
              <Text className="text-destructive font-semibold mb-2">Error</Text>
              <Text className="text-destructive text-sm">{error}</Text>
              <Button
                text="Retry"
                onPress={loadDashboard}
                className="mt-4"
              />
            </View>
          </View>
        )}

        {/* Dashboard Content */}
        {data && !loading && (
          <View className="p-4">
            {/* G1 Preview */}
            <View className="mb-6">
              <Text className="text-foreground font-semibold mb-2">
                G1 Display Preview
              </Text>
              <View className="bg-black rounded-lg p-4 border-2 border-primary">
                <Text className="text-green-400 font-mono text-sm leading-6">
                  {formattedText}
                </Text>
              </View>
              <Button
                text="Send to G1"
                onPress={handleSendToG1}
                className="mt-2"
              />
            </View>

            {/* Raw Data (collapsible) */}
            <View className="mb-6">
              <Text className="text-foreground font-semibold mb-2">
                Raw Data
              </Text>
              <ScrollView 
                className="bg-card border border-border rounded-lg p-3 max-h-60"
                nestedScrollEnabled
              >
                <Text className="text-foreground text-xs font-mono">
                  {JSON.stringify(data, null, 2)}
                </Text>
              </ScrollView>
            </View>
          </View>
        )}

        {/* Empty State */}
        {!data && !loading && !error && (
          <View className="items-center justify-center py-20">
            <Text className="text-muted-foreground text-center mb-4">
              Pull down to refresh
            </Text>
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}
