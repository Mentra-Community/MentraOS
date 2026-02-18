/**
 * Offline Apps Screen
 * Shows only offline apps that work without backend
 */

import {View, ScrollView, TouchableOpacity, Image} from 'react-native'
import {Screen, Header, Text} from '@/components/ignite'
import {useNavigationHistory} from '@/contexts/NavigationHistoryContext'
import {useApplets, useStartApplet, useStopApplet} from '@/stores/applets'

export default function OfflineAppsScreen() {
  const {goBack} = useNavigationHistory()
  const apps = useApplets()
  const startApplet = useStartApplet()
  const stopApplet = useStopApplet()

  // Filter to only offline apps
  const offlineApps = apps.filter(app => app.offline && app.packageName !== 'com.mentra.store')

  const toggleApp = (app: any) => {
    if (app.running) {
      stopApplet(app.packageName)
    } else {
      startApplet(app.packageName)
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <Header
        title="My Apps"
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        style={{height: 44}}
      />

      <ScrollView className="flex-1 p-4">
        {offlineApps.map((app) => (
          <TouchableOpacity
            key={app.packageName}
            onPress={() => toggleApp(app)}
            className="bg-card border border-border rounded-lg p-4 mb-3 flex-row items-center"
          >
            <Image
              source={app.logoUrl}
              className="w-12 h-12 rounded-lg mr-4"
            />
            <View className="flex-1">
              <Text className="text-foreground font-semibold text-base">
                {app.name}
              </Text>
              <Text className="text-muted-foreground text-sm">
                {app.running ? 'Running' : 'Stopped'}
              </Text>
            </View>
            <View
              className={`w-12 h-6 rounded-full ${
                app.running ? 'bg-primary' : 'bg-muted'
              } justify-center px-1`}
            >
              <View
                className={`w-4 h-4 rounded-full bg-white ${
                  app.running ? 'self-end' : 'self-start'
                }`}
              />
            </View>
          </TouchableOpacity>
        ))}

        {offlineApps.length === 0 && (
          <View className="items-center justify-center py-20">
            <Text className="text-muted-foreground text-center">
              No offline apps available
            </Text>
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}
