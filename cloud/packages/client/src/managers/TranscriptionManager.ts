import { EventBus } from "../EventBus";
import type { TranscriptionEvent } from "../types";

export interface TranscriptionCapabilities {
  languageDetection: boolean;
  diarization: boolean;
  wordTimestamps: boolean;
  confidence: boolean;
  supportedLanguages: string[];
  local: boolean;
}

const DEFAULT_CAPABILITIES: TranscriptionCapabilities = {
  languageDetection: false,
  diarization: false,
  wordTimestamps: false,
  confidence: false,
  supportedLanguages: ["en"],
  local: false,
};

export class TranscriptionManager {
  private bus = new EventBus();
  private _latest: TranscriptionEvent | null = null;
  private _active = false;
  private _capabilities: TranscriptionCapabilities = { ...DEFAULT_CAPABILITIES };

  get latest(): TranscriptionEvent | null { return this._latest; }
  get active(): boolean { return this._active; }
  get capabilities(): TranscriptionCapabilities { return { ...this._capabilities }; }

  /** Called internally when a transcription event arrives */
  handleEvent(event: TranscriptionEvent): void {
    this._latest = event;
    this._active = true;
    this.bus.emit("transcription", event);
    if (event.isFinal) {
      this.bus.emit("final", event);
    }
  }

  setCapabilities(caps: Partial<TranscriptionCapabilities>): void {
    Object.assign(this._capabilities, caps);
    this.bus.emit("capabilities_changed", this.capabilities);
  }

  setActive(active: boolean): void {
    this._active = active;
  }

  /** Subscribe to all transcription events (interim + final). */
  on(handler: (event: TranscriptionEvent) => void): () => void;
  on(event: "final", handler: (event: TranscriptionEvent) => void): () => void;
  on(event: "capabilities_changed", handler: (caps: TranscriptionCapabilities) => void): () => void;
  on(eventOrHandler: string | ((event: TranscriptionEvent) => void), handler?: (...args: any[]) => void): () => void {
    if (typeof eventOrHandler === "function") {
      // Primary form: on(handler) — subscribe to all transcription events
      return this.bus.on("transcription", eventOrHandler);
    }
    return this.bus.on(eventOrHandler, handler!);
  }

  onFinal(handler: (event: TranscriptionEvent) => void): () => void {
    return this.bus.on("final", handler);
  }

  onCapabilitiesChange(handler: (caps: TranscriptionCapabilities) => void): () => void {
    return this.bus.on("capabilities_changed", handler);
  }

  destroy(): void { this.bus.removeAll(); }
}
