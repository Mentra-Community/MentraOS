import {NativeModule, registerWebModule} from 'expo';

import type {
  MentraPhotoReceiverModuleEvents,
  PhotoReceiverResult,
} from './MentraPhotoReceiver.types';

class MentraPhotoReceiverModule extends NativeModule<MentraPhotoReceiverModuleEvents> {
  async isSupported(): Promise<boolean> {
    return false;
  }

  async startPhotoReceiver(): Promise<PhotoReceiverResult> {
    throw new Error('The photo receiver is only available in the native example app.');
  }

  async stopPhotoReceiver(): Promise<void> {}
}

export default registerWebModule(MentraPhotoReceiverModule, 'MentraPhotoReceiver');
