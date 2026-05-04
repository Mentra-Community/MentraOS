import React, { useState } from 'react';
import { View, StyleSheet, StatusBar } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { TabBar, TabKey } from './components/TabBar';
import { DeviceScreen } from './screens/DeviceScreen';
import { CameraScreen } from './screens/CameraScreen';
import { StreamScreen } from './screens/StreamScreen';
import { SystemScreen } from './screens/SystemScreen';
import { ConsoleScreen } from './screens/ConsoleScreen';
import { useMentraSdk } from './useMentraSdk';

export default function App() {
  const [tab, setTab] = useState<TabKey>('device');
  const sdk = useMentraSdk();

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.screen}>
          {tab === 'device' && <DeviceScreen sdk={sdk} />}
          {tab === 'camera' && <CameraScreen sdk={sdk} />}
          {tab === 'stream' && <StreamScreen sdk={sdk} />}
          {tab === 'system' && <SystemScreen sdk={sdk} />}
          {tab === 'console' && <ConsoleScreen sdk={sdk} />}
        </View>
        <TabBar active={tab} onChange={setTab} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  screen: { flex: 1 },
});
