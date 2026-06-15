import { requireNativeModule } from 'expo';
import BluetoothSdk, {
  type PhotoSuccessResponseEvent,
  type SettingsAckSuccessEvent,
} from '@mentra/bluetooth-sdk';

type PhotoSize = 'low' | 'medium' | 'high' | 'max';

export type ScanButtonPhotoSettings = {
  size?: PhotoSize;
  mfnr?: boolean;
  zsl?: boolean;
  noiseReduction?: boolean;
  edgeEnhancement?: boolean;
  ispDigitalGain?: number;
  ispAnalogGain?: string;
  aeExposureDivisor?: number;
  isoCap?: number;
  compress?: string;
  sound?: boolean;
  resetCaptureTuning?: boolean;
};

export type ScanPhotoRequestParams = {
  requestId: string;
  appId: string;
  webhookUrl: string;
  authToken: string | null;
  size: PhotoSize;
  compress: string;
  sound: boolean;
  save?: boolean;
  exposureTimeNs?: number | null;
  iso?: number | null;
  aeExposureDivisor?: number;
  isoCap?: number;
  noiseReduction?: boolean;
  edgeEnhancement?: boolean;
  mfnr?: boolean;
  zsl?: boolean;
  ispDigitalGain?: number;
  ispAnalogGain?: string;
};

type NativeBluetoothSdkModule = {
  setButtonPhotoCaptureSettings?: (
    settings: ScanButtonPhotoSettings,
  ) => Promise<SettingsAckSuccessEvent>;
  requestPhoto: (params: Record<string, string | number | boolean>) => Promise<PhotoSuccessResponseEvent>;
};

const NativeBluetoothSdkModule = requireNativeModule<NativeBluetoothSdkModule>('BluetoothSdk');

/** Maps unknown/legacy size strings to the current wire format. */
function normalizePhotoSizeTier(size: string | undefined): PhotoSize {
  switch (size) {
    case 'small':
      return 'low';
    case 'large':
      return 'high';
    case 'full':
      return 'max';
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return size;
    default:
      return 'medium';
  }
}

/**
 * Published SDK 0.1.12 omits scan-mode fields from requestPhoto payloads.
 * Build the full native map here so toggling Scan Mode affects app captures.
 */
export function photoRequestParamsForNativeCompat(
  params: ScanPhotoRequestParams,
): Record<string, string | number | boolean> {
  const payload: Record<string, string | number | boolean> = {
    requestId: params.requestId,
    appId: params.appId,
    size: normalizePhotoSizeTier(params.size),
    webhookUrl: params.webhookUrl ?? '',
    compress: params.compress,
    flash: true,
    sound: params.sound,
  };
  if (params.authToken != null && params.authToken.length > 0) {
    payload.authToken = params.authToken;
  }
  if (params.save != null) {
    payload.save = params.save;
  }
  const exposureTimeNs = params.exposureTimeNs;
  const hasManualExposure = exposureTimeNs != null && Number.isFinite(exposureTimeNs) && exposureTimeNs > 0;
  if (hasManualExposure) {
    payload.exposureTimeNs = exposureTimeNs;
  }
  if (hasManualExposure && params.iso != null && Number.isFinite(params.iso) && params.iso > 0) {
    payload.iso = Math.round(params.iso);
  }
  if (params.aeExposureDivisor != null && params.aeExposureDivisor > 1) {
    payload.aeExposureDivisor = Math.round(params.aeExposureDivisor);
  }
  if (params.isoCap != null && params.isoCap > 0) {
    payload.isoCap = Math.round(params.isoCap);
  }
  if (params.noiseReduction != null) {
    payload.noiseReduction = params.noiseReduction;
  }
  if (params.edgeEnhancement != null) {
    payload.edgeEnhancement = params.edgeEnhancement;
  }
  if (params.mfnr != null) {
    payload.mfnr = params.mfnr;
  }
  if (params.zsl != null) {
    payload.zsl = params.zsl;
  }
  if (params.ispDigitalGain != null) {
    payload.ispDigitalGain = Math.round(params.ispDigitalGain);
  }
  if (params.ispAnalogGain != null && params.ispAnalogGain.length > 0) {
    payload.ispAnalogGain = params.ispAnalogGain;
  }
  return payload;
}

/** Route granular presets to the native capture-settings API (SDK 0.1.12 public JS only accepts size strings). */
export async function setButtonPhotoSettingsCompat(
  sizeOrSettings: PhotoSize | ScanButtonPhotoSettings,
): Promise<SettingsAckSuccessEvent> {
  if (typeof sizeOrSettings === 'string') {
    return BluetoothSdk.setButtonPhotoSettings(
      sizeOrSettings as Parameters<typeof BluetoothSdk.setButtonPhotoSettings>[0],
    );
  }
  const native = NativeBluetoothSdkModule.setButtonPhotoCaptureSettings;
  if (typeof native !== 'function') {
    throw new Error(
      'Scan mode requires setButtonPhotoCaptureSettings in the native build. Rebuild with bun android.',
    );
  }
  return native(sizeOrSettings);
}

export async function requestPhotoCompat(params: ScanPhotoRequestParams): Promise<PhotoSuccessResponseEvent> {
  return NativeBluetoothSdkModule.requestPhoto(photoRequestParamsForNativeCompat(params));
}
