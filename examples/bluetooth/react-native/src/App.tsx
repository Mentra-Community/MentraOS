import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, View, StyleSheet, StatusBar } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { MentraLiveOtaFlow } from '@mentra/engine/ota';
import { KeyboardVisibleContext } from './components/keyboardLayout';
import { TabBar, TabKey } from './components/TabBar';
import { DeviceScreen } from './screens/DeviceScreen';
import { CameraScreen } from './screens/CameraScreen';
import { StreamScreen } from './screens/StreamScreen';
import { SystemScreen } from './screens/SystemScreen';
import { ConsoleScreen } from './screens/ConsoleScreen';
import { otaFlowAdmission } from './otaFlowAdmission';
import { isGlassesWifiConnected } from './sdkFormat';
import { isMentraLiveRuntime, useBluetoothSdkExample } from './useBluetoothSdkExample';

export default function App() {
  const [tab, setTab] = useState<TabKey>('device');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [otaVisible, setOtaVisible] = useState(false);
  const [waitingForWifi, setWaitingForWifi] = useState(false);
  const otaCompletedGenerationRef = useRef<number | null>(null);
  const sdk = useBluetoothSdkExample({activeTab: tab});
  const mentraLiveConnected = isMentraLiveRuntime(sdk.glasses);
  const connectionGeneration = mentraLiveConnected && sdk.glasses.connected
    ? sdk.glassesConnectionGeneration
    : null;

  useEffect(() => {
    const admission = otaFlowAdmission({
      completedConnectionGeneration: otaCompletedGenerationRef.current,
      connectionGeneration,
      waitingForWifi,
      wifiConnected: isGlassesWifiConnected(sdk.glasses),
    });

    if (admission === 'idle') {
      if (!otaVisible) {
        otaCompletedGenerationRef.current = null;
        setWaitingForWifi(false);
      }
      return;
    }

    if (admission === 'wait_for_wifi' || admission === 'done') {
      return;
    }

    setWaitingForWifi(false);
    setOtaVisible(true);
  }, [connectionGeneration, mentraLiveConnected, otaVisible, sdk.glasses, waitingForWifi]);

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

  const finishOta = () => {
    otaCompletedGenerationRef.current = connectionGeneration;
    setOtaVisible(false);
  };

  const openWifiSetup = () => {
    setWaitingForWifi(true);
    setOtaVisible(false);
    setTab('system');
  };

  const openOta = () => {
    otaCompletedGenerationRef.current = null;
    setWaitingForWifi(false);
    setOtaVisible(true);
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <KeyboardVisibleContext.Provider value={keyboardVisible}>
        {otaVisible ? (
          <MentraLiveOtaFlow
            deviceName="Mentra Live"
            onFinished={finishOta}
            onOpenWifiSetup={openWifiSetup}
          />
        ) : (
          <SafeAreaView style={styles.root} edges={['top']}>
            <View style={styles.screen}>
              {tab === 'device' && <DeviceScreen sdk={sdk} onOpenOta={openOta} />}
              {tab === 'camera' && <CameraScreen sdk={sdk} />}
              {tab === 'stream' && <StreamScreen sdk={sdk} />}
              {tab === 'system' && <SystemScreen sdk={sdk} />}
              {tab === 'console' && <ConsoleScreen sdk={sdk} />}
            </View>
            {!keyboardVisible && <TabBar active={tab} onChange={setTab} />}
          </SafeAreaView>
        )}
      </KeyboardVisibleContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  screen: { flex: 1 },
});
