import {NativeModule, requireNativeModule} from 'expo';

import type {
  MentraVideoStreamReceiverModuleEvents,
  WebRtcReceiverResult,
} from './MentraVideoStreamReceiver.types';

declare class MentraVideoStreamReceiverModule extends NativeModule<MentraVideoStreamReceiverModuleEvents> {
  isSupported(): Promise<boolean>;
  startWebRtcReceiver(): Promise<WebRtcReceiverResult>;
  stopWebRtcReceiver(): Promise<void>;
}

export default requireNativeModule<MentraVideoStreamReceiverModule>('MentraVideoStreamReceiver');
