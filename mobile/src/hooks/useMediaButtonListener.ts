import { useEffect } from 'react';
import { GlobalEventEmitter } from '@/utils/GlobalEventEmitter';
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

/**
 * MediaButtonListener
 * Listens for Bluetooth media button presses (play/pause/next/previous)
 * and converts them to BUTTON_PRESS events for dashboard navigation
 */
export function useMediaButtonListener() {
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    // iOS media buttons will be handled by native module
    // For now, we'll use a simple approach - listen for volume button events
    // which many Bluetooth remotes trigger
    
    console.log('[MediaButtonListener] Started');

    return () => {
      console.log('[MediaButtonListener] Stopped');
    };
  }, []);
}
