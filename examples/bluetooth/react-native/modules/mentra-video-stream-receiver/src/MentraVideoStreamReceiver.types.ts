import type {StyleProp, ViewStyle} from 'react-native';

export type VideoStreamReceiverStatusKind = 'stream' | 'whip';

export type VideoStreamReceiverStatusEvent = {
  kind: VideoStreamReceiverStatusKind;
  message: string;
};

export type VideoStreamFirstFrameEvent = {
  timestamp: number;
};

export type VideoStreamFrameEvent = {
  timestamp: number;
};

export type WebRtcReceiverResult = {
  backendPort: number;
  host: string;
  publicPort: number;
  streamUrl: string;
};

export type MentraVideoStreamReceiverModuleEvents = {
  receiverStatus: (event: VideoStreamReceiverStatusEvent) => void;
  streamFirstFrame: (event: VideoStreamFirstFrameEvent) => void;
  streamFrame: (event: VideoStreamFrameEvent) => void;
};

export type MentraVideoStreamReceiverViewProps = {
  style?: StyleProp<ViewStyle>;
};
