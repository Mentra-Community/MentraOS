import {NativeModule, requireNativeModule} from 'expo';

import type {BarcodeScanResult, TestBarcodeImage} from './MentraBarcodeScanner.types';

declare class MentraBarcodeScannerModule extends NativeModule<{}> {
  createTestBarcodeImage(value: string): Promise<TestBarcodeImage>;
  isSupported(): Promise<boolean>;
  openImage(imageUri: string): Promise<void>;
  scanImage(imageUri: string): Promise<BarcodeScanResult[]>;
}

export default requireNativeModule<MentraBarcodeScannerModule>('MentraBarcodeScanner');
