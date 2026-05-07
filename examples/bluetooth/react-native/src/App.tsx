import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, View, StyleSheet, StatusBar } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardVisibleContext } from './components/keyboardLayout';
import { TabBar, TabKey } from './components/TabBar';
import { DeviceScreen } from './screens/DeviceScreen';
import { CameraScreen } from './screens/CameraScreen';
import { StreamScreen } from './screens/StreamScreen';
import { SystemScreen } from './screens/SystemScreen';
import { ConsoleScreen } from './screens/ConsoleScreen';
import { useMentraSdk } from './useMentraSdk';

export default function App() {
  const [tab, setTab] = useState<TabKey>('device');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const sdk = useMentraSdk();

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <KeyboardVisibleContext.Provider value={keyboardVisible}>
        <SafeAreaView style={styles.root} edges={['top']}>
          <View style={styles.screen}>
            {tab === 'device' && <DeviceScreen sdk={sdk} />}
            {tab === 'camera' && <CameraScreen sdk={sdk} />}
            {tab === 'stream' && <StreamScreen sdk={sdk} />}
            {tab === 'system' && <SystemScreen sdk={sdk} />}
            {tab === 'console' && <ConsoleScreen sdk={sdk} />}
          </View>
          {!keyboardVisible && <TabBar active={tab} onChange={setTab} />}
        </SafeAreaView>
      </KeyboardVisibleContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  screen: { flex: 1 },
});
