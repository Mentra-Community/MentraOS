import type {StyleProp, ViewStyle} from 'react-native';

export type DirectReceiverStatusKind = 'photo' | 'stream' | 'whip';

export type DirectPhotoUploadEvent = {
  byteCount: number;
  fileUri: string;
  requestId?: string | null;
};

export type DirectReceiverStatusEvent = {
  kind: DirectReceiverStatusKind;
  message: string;
};

export type DirectStreamFirstFrameEvent = {
  timestamp: number;
};

export type DirectPhotoReceiverResult = {
  host: string;
  port: number;
  uploadUrl: string;
};

export type DirectWebRtcReceiverResult = {
  backendPort: number;
  host: string;
  publicPort: number;
  streamUrl: string;
};

export type MentraDirectReceiverModuleEvents = {
  photoUpload: (event: DirectPhotoUploadEvent) => void;
  receiverStatus: (event: DirectReceiverStatusEvent) => void;
  streamFirstFrame: (event: DirectStreamFirstFrameEvent) => void;
};

export type MentraDirectReceiverViewProps = {
  style?: StyleProp<ViewStyle>;
};
