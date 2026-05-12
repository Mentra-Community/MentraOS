import {NativeModule, registerWebModule} from 'expo';

import type {
  DirectPhotoReceiverResult,
  DirectWebRtcReceiverResult,
  MentraDirectReceiverModuleEvents,
} from './MentraDirectReceiver.types';

class MentraDirectReceiverModule extends NativeModule<MentraDirectReceiverModuleEvents> {
  async isSupported(): Promise<boolean> {
    return false;
  }

  async startPhotoReceiver(): Promise<DirectPhotoReceiverResult> {
    throw new Error('The direct phone receiver is only available in the native example app.');
  }

  async stopPhotoReceiver(): Promise<void> {}

  async startWebRtcReceiver(): Promise<DirectWebRtcReceiverResult> {
    throw new Error('The direct phone receiver is only available in the native example app.');
  }

  async stopWebRtcReceiver(): Promise<void> {}
}

export default registerWebModule(MentraDirectReceiverModule, 'MentraDirectReceiver');
