import type { RuntimeAudioTransport } from "./audio-udp";

export type RuntimeStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  audioTransport: RuntimeAudioTransport;
}
