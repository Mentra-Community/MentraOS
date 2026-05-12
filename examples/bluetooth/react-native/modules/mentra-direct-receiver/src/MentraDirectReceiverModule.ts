import {NativeModule, requireNativeModule} from 'expo';

import type {
  DirectPhotoReceiverResult,
  DirectWebRtcReceiverResult,
  MentraDirectReceiverModuleEvents,
} from './MentraDirectReceiver.types';

declare class MentraDirectReceiverModule extends NativeModule<MentraDirectReceiverModuleEvents> {
  isSupported(): Promise<boolean>;
  startPhotoReceiver(): Promise<DirectPhotoReceiverResult>;
  stopPhotoReceiver(): Promise<void>;
  startWebRtcReceiver(): Promise<DirectWebRtcReceiverResult>;
  stopWebRtcReceiver(): Promise<void>;
}

export default requireNativeModule<MentraDirectReceiverModule>('MentraDirectReceiver');
