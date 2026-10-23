import {NativeModule, requireNativeModule} from 'expo';

import type {BarcodeScanResult, ImageMetadata, TestBarcodeImage} from './MentraBarcodeScanner.types';

declare class MentraBarcodeScannerModule extends NativeModule<{}> {
  createTestBarcodeImage(value: string): Promise<TestBarcodeImage>;
  getImageMetadata(imageUri: string): Promise<ImageMetadata>;
  isSupported(): Promise<boolean>;
  openImage(imageUri: string): Promise<void>;
  scanImage(imageUri: string): Promise<BarcodeScanResult[]>;
}

export default requireNativeModule<MentraBarcodeScannerModule>('MentraBarcodeScanner');
