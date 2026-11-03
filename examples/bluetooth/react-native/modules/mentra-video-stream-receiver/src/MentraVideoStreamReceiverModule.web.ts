import {NativeModule, registerWebModule} from 'expo';

import type {
  MentraVideoStreamReceiverModuleEvents,
  WebRtcReceiverResult,
} from './MentraVideoStreamReceiver.types';

class MentraVideoStreamReceiverModule extends NativeModule<MentraVideoStreamReceiverModuleEvents> {
  async isSupported(): Promise<boolean> {
    return false;
  }

  async startWebRtcReceiver(): Promise<WebRtcReceiverResult> {
    throw new Error('The video stream receiver is only available in the native example app.');
  }

  async stopWebRtcReceiver(): Promise<void> {}
}

export default registerWebModule(MentraVideoStreamReceiverModule, 'MentraVideoStreamReceiver');
