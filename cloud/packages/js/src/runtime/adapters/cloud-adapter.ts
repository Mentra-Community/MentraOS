/**
 * cloud-adapter — cloud-hosted runtime
 *
 * Wraps `MentraSession` (from `@mentra/js/runtime/internals`) behind
 * the `MentraRuntime` contract. Used when apps are deployed against a
 * MentraOS cloud.
 *
 * Mostly pass-through. Where contract shape differs from internal
 * shape we synthesize — e.g., `transcription.onFinal` is a contract
 * convenience the internal `TranscriptionManager` doesn't expose, so
 * we filter `.on()` ourselves.
 */

import type { MentraSession } from "../internals";
import type {
  CameraRuntime,
  DeviceRuntime,
  DisplayRuntime,
  LocationRuntime,
  MentraRuntime,
  MentraSessionInfo,
  MicRuntime,
  SpeakerRuntime,
  TranscriptionRuntime,
} from "../contract";
import { MentraRuntimeCapabilityError } from "../contract";

type ReadyHandler = (info: MentraSessionInfo) => void;
type StoppedHandler = (reason: string) => void;
type ReconnectedHandler = () => void;

export class CloudAdapter implements MentraRuntime {
  readonly name = "cloud";

  private session: MentraSession | null = null;

  private readyHandlers: ReadyHandler[] = [];
  private stoppedHandlers: StoppedHandler[] = [];
  private reconnectedHandlers: ReconnectedHandler[] = [];
  private activeUnsubs: Array<() => void> = [];

  // ── Identity ───────────────────────────────────────────────────────────

  get info(): MentraSessionInfo {
    const session = this.requireSession("session.info");
    const sdkUserId = session.userId;
    if (!sdkUserId) {
      throw new Error("[cloud-adapter] MentraSession has no userId — cloud must set one.");
    }
    // Legacy: cloud treats userId as email. We split userId + email
    // per contract. When cloud migrates to UUIDs, email becomes
    // undefined — no app code changes.
    const looksLikeEmail = sdkUserId.includes("@");
    return {
      userId: sdkUserId,
      email: looksLikeEmail ? sdkUserId : undefined,
      sessionId: session.sessionId,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  onReady(handler: ReadyHandler): void {
    this.readyHandlers.push(handler);
    if (this.session) {
      try {
        handler(this.info);
      } catch (e) {
        console.error("[cloud-adapter] onReady handler threw:", e);
      }
    }
  }

  onStopped(handler: StoppedHandler): void {
    this.stoppedHandlers.push(handler);
  }

  onReconnected(handler: ReconnectedHandler): void {
    this.reconnectedHandlers.push(handler);
  }

  // ── Managers ───────────────────────────────────────────────────────────
  // Each is a thin object that forwards to the current session's manager.
  // Written as contract-typed objects so TS verifies shape conformance.

  readonly display: DisplayRuntime = {
    showText: (text: string) => this.requireSession("display").display.showText(text),
    showTextWall: (text: string) => this.requireSession("display").display.showTextWall(text),
    clear: () => this.requireSession("display").display.clear(),
  };

  readonly transcription: TranscriptionRuntime = {
    on: (handler) => this.requireSession("transcription").transcription.on(handler),
    onFinal: (handler) =>
      this.requireSession("transcription").transcription.on((data) => {
        if (data.isFinal) handler(data);
      }),
    forLanguage: (lang, handler) => this.requireSession("transcription").transcription.forLanguage(lang, handler),
  };

  readonly mic: MicRuntime = {
    onChunk: (handler) =>
      // SDK `AudioChunk` is a BaseMessage with extra `type` and
      // `arrayBuffer` fields; contract `MicChunk` is the exact same
      // runtime shape but TS sees different nominal types. Cast is
      // safe — they're aliases of the same underlying message.
      this.requireSession("mic").mic.onChunk(handler as any),
    onVoiceActivity: (handler) => this.requireSession("mic").mic.onVoiceActivity(handler),
    get hasPermission(): boolean {
      throw new Error("unreachable — replaced in constructor");
    },
  };

  readonly speaker: SpeakerRuntime = {
    createStream: (options) =>
      // SDK `AudioOutputStream` satisfies contract `SpeakerStream`
      // structurally, but nominal typing complains. Cast is safe.
      this.requireSession("speaker").speaker.createStream(options) as any,
  };

  readonly camera: CameraRuntime = {
    takePhoto: (opts) => this.requireSession("camera").camera.takePhoto(opts),
    startStream: (opts) => this.requireSession("camera").camera.startStream(opts),
    stopStream: () => this.requireSession("camera").camera.stopStream(),
    onStreamStatus: (handler) =>
      this.requireSession("camera").camera.onStreamStatus(
        // SDK StreamStatus is a BaseMessage; contract StreamStatus is
        // the index-signature shape. Same runtime, nominal mismatch.
        handler as unknown as (status: any) => void,
      ),
    checkExistingStream: () => this.requireSession("camera").camera.checkExistingStream(),
  };

  readonly device: DeviceRuntime = {
    get state(): DeviceRuntime["state"] {
      throw new Error("unreachable — replaced in constructor");
    },
  };

  readonly location: LocationRuntime = {
    requestUpdate: () => this.requireSession("location").location.requestUpdate(),
    onUpdate: (handler) => this.requireSession("location").location.onUpdate(handler),
  };

  constructor() {
    // Object-literal getters above can't see CloudAdapter's `this`.
    // Replace them with getters bound via Object.defineProperty that
    // capture `this` via closure.
    Object.defineProperty(this.mic, "hasPermission", {
      get: () => this.requireSession("mic").mic.hasPermission,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(this.device, "state", {
      get: () => this.requireSession("device").device.state,
      enumerable: true,
      configurable: true,
    });
  }

  // ── Binding ────────────────────────────────────────────────────────────

  bind(session: MentraSession): void {
    if (this.session) this.unbind("resurrected");
    this.session = session;

    try {
      const cleanup = session.onReconnected(() => {
        for (const h of this.reconnectedHandlers) {
          try {
            h();
          } catch (e) {
            console.error("[cloud-adapter] onReconnected handler:", e);
          }
        }
      });
      if (typeof cleanup === "function") this.activeUnsubs.push(cleanup);
    } catch (e) {
      console.warn("[cloud-adapter] couldn't subscribe to onReconnected:", e);
    }

    const info = this.info;
    for (const h of this.readyHandlers) {
      try {
        h(info);
      } catch (e) {
        console.error("[cloud-adapter] onReady:", e);
      }
    }
  }

  unbind(reason: string): void {
    for (const u of this.activeUnsubs) {
      try {
        u();
      } catch {
        /* swallow */
      }
    }
    this.activeUnsubs = [];
    this.session = null;
    for (const h of this.stoppedHandlers) {
      try {
        h(reason);
      } catch (e) {
        console.error("[cloud-adapter] onStopped:", e);
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private requireSession(manager: string): MentraSession {
    if (!this.session) {
      throw new MentraRuntimeCapabilityError(`${manager} (no active session)`, this.name);
    }
    return this.session;
  }
}
