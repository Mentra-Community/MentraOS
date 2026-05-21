import {NativeModule, requireNativeModule} from 'expo';

import type {
  MentraPhotoReceiverModuleEvents,
  PhotoReceiverResult,
} from './MentraPhotoReceiver.types';

declare class MentraPhotoReceiverModule extends NativeModule<MentraPhotoReceiverModuleEvents> {
  isSupported(): Promise<boolean>;
  startPhotoReceiver(): Promise<PhotoReceiverResult>;
  stopPhotoReceiver(): Promise<void>;
}

export default requireNativeModule<MentraPhotoReceiverModule>('MentraPhotoReceiver');
