import {NativeModule, registerWebModule} from 'expo';

import type {BarcodeScanResult, ImageMetadata, TestBarcodeImage} from './MentraBarcodeScanner.types';

class MentraBarcodeScannerModule extends NativeModule<{}> {
  async createTestBarcodeImage(_value: string): Promise<TestBarcodeImage> {
    throw new Error('The barcode scanner is only available in the native example app.');
  }

  async getImageMetadata(imageUri: string): Promise<ImageMetadata> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({width: image.naturalWidth, height: image.naturalHeight});
      image.onerror = () => reject(new Error('Could not read image metadata.'));
      image.src = imageUri;
    });
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
