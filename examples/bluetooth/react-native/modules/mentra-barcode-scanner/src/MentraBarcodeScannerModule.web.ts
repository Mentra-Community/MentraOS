import {NativeModule, registerWebModule} from 'expo';

import type {BarcodeScanResult, TestBarcodeImage} from './MentraBarcodeScanner.types';

class MentraBarcodeScannerModule extends NativeModule<{}> {
  async createTestBarcodeImage(_value: string): Promise<TestBarcodeImage> {
    throw new Error('The barcode scanner is only available in the native example app.');
  }

  async isSupported(): Promise<boolean> {
    return false;
  }

  async openImage(imageUri: string): Promise<void> {
    window.open(imageUri, '_blank', 'noopener,noreferrer');
  }

  async scanImage(_imageUri: string): Promise<BarcodeScanResult[]> {
    throw new Error('The barcode scanner is only available in the native example app.');
  }
}

export default registerWebModule(MentraBarcodeScannerModule, 'MentraBarcodeScanner');
