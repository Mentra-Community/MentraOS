/**
 * @fileoverview `cloud.runtime`: the live session module.
 *
 * This is wiring only. It implements the public `RuntimeModule` by delegating to
 * five collaborators and routing messages between them:
 *   - connection: owns the WebSocket, the handshake, reconnect, and liveness.
 *   - emitter: the one typed event emitter the public `on*` methods wrap.
 *   - subscriptions: the REST full-replace writer with the version counter.
 *   - camera: managed photo/stream (REST request, await the WebSocket push).
 *   - audio: the UDP audio path (encrypt each frame, hand bytes to the socket).
 *   - tts: runtime TTS source preparation for host playback.
 *
 * Keeping the orchestration here, and the mechanics in the collaborators, means
 * each piece is testable on its own and this file reads as the protocol flow:
 * connect, route inbound messages to events, re-send subscriptions on reconnect.
 *
 * See docs/issues/004-cloud-client/spec.md ("cloud.runtime") and design.md.
 */
import type {
  AudioSubscription,
  TranscriptionData,
  TranslationData,
  ProtocolError,
  ConnectionAck,
  CloudToClientMessage,
} from "@mentra/cloud-protocol";
import type { Logger } from "../../logger";
import type { Connection } from "./connection";
import { HandshakeRejectedError } from "./connection";
import type { RuntimeEmitter, RuntimeEvents } from "./emitter";
import type { Subscriptions } from "./subscriptions";
import type { Camera, PhotoOptions, StreamOptions, ManagedStream, StreamStatusResult } from "./camera";
import type { Maps, DirectionsRequest, DirectionsResult, LatLng, ReverseGeocodeResult } from "./maps";
import type { Tts, RuntimeTtsSpeakOptions, RuntimeTtsSpeechSource } from "./tts";
import type { UdpAudio } from "./audio-udp";
import type { RuntimeSnapshot } from "./status";

const UDP_PROBE_INTERVAL_MS = 1_000;
const UDP_LIVENESS_TIMEOUT_MS = 3_000;

// Re-export the camera option/result types so a host importing the runtime gets
// them from one place alongside the module that produces them.
export type { PhotoOptions, StreamOptions, ManagedStream, StreamStatusResult } from "./camera";
export type {
  DirectionsRequest,
  DirectionsResult,
  Route,
  RouteStep,
  LatLng,
  TravelMode,
  ManeuverKind,
  RouteAvoidances,
  ReverseGeocodeResult,
} from "./maps";
export type { RuntimeTtsSpeakOptions, RuntimeTtsSpeechSource } from "./tts";
export type { RuntimeAudioTransport } from "./audio-udp";
export type { RuntimeStatus, RuntimeSnapshot } from "./status";

/**
 * The public runtime surface, implemented by `Runtime` below.
 *
 * Defined here (rather than in the protocol package) because it is the client's
 * API, not a wire type: it composes the wire types from
 * `@mentra/cloud-protocol` into the methods a host calls. The per-event
 * `on*` methods are sugar over the generic typed emitter, so there is one source
 * of truth and no event-name strings to mistype. Every subscribe call returns an
 * unsubscribe function.
 */
export interface RuntimeModule {
  connect(): Promise<void>;
  close(): void;

  setSubscriptions(subs: AudioSubscription[]): Promise<void>;

  /**
   * Encrypt and send one captured audio frame over UDP. On the phone the native
   * audio bridge calls this per frame (mic -> codec -> here); the bytes are
   * encrypted in the shared core and handed to the injected UDP socket. A frame
   * sent before the session is configured is dropped, not thrown on.
   */
  sendAudioFrame(frame: Uint8Array): void;

  getStatus(): RuntimeSnapshot;

  onTranscript(handler: (data: TranscriptionData) => void): () => void;
  onTranslation(handler: (data: TranslationData) => void): () => void;

  requestManagedPhoto(opts: PhotoOptions): Promise<{ requestId: string; readUrl: string }>;
  startManagedPhoto(opts: PhotoOptions): Promise<{ requestId: string; uploadUrl: string; readUrl: string }>;
  awaitManagedPhotoReady(requestId: string): Promise<{ requestId: string; readUrl: string }>;
  startManagedStream(opts: StreamOptions): Promise<ManagedStream>;
  getManagedStreamStatus(streamId: string): Promise<StreamStatusResult>;
  stopManagedStream(streamId: string): Promise<void>;
  tts: {
    speak(text: string, options?: RuntimeTtsSpeakOptions): Promise<RuntimeTtsSpeechSource>;
  };
  maps: {
    directions(req: DirectionsRequest): Promise<DirectionsResult>;
    reverseGeocode(coord: LatLng): Promise<ReverseGeocodeResult>;
  };

  onConnected(handler: () => void): () => void;
  onDisconnected(handler: (info: { reason: string }) => void): () => void;
  onStatusChanged(handler: (status: RuntimeSnapshot) => void): () => void;
  onError(handler: (err: ProtocolError) => void): () => void;

  on<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): () => void;
  off<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): void;
  onAny(handler: (event: keyof RuntimeEvents, data: unknown) => void): () => void;
}

export interface RuntimeDeps {
  connection: Connection;
  emitter: RuntimeEmitter;
  subscriptions: Subscriptions;
  camera: Camera;
  tts: Tts;
  maps: Maps;
  audio: UdpAudio;
  logger: Logger;
  /**
   * Force `cloud.auth` to drop its cached access token and refresh now.
   *
   * Called when the cloud rejects the handshake with `AUTH_EXPIRED` even though
   * the client thought its token was fresh (clock skew or a mid-session revoke).
   * The connection re-reads the token through its own `getToken` on the next
   * open, so this only has to invalidate-and-refresh; it returns the new token
   * but the runtime ignores it (the reopen picks it up).
   */
  forceRefreshToken: () => Promise<string>;
}

/** Protocol error code the cloud sends when the handshake token is expired. */
const AUTH_EXPIRED_CODE = "AUTH_EXPIRED";

export class Runtime implements RuntimeModule {
  private readonly connection: Connection;
  private readonly emitter: RuntimeEmitter;
  private readonly subscriptions: Subscriptions;
  private readonly camera: Camera;
  public readonly tts: Tts;
  public readonly maps: Maps;
  private readonly audio: UdpAudio;
  private readonly logger: Logger;
  private readonly forceRefreshToken: () => Promise<string>;
  private status: RuntimeSnapshot = {
    status: "disconnected",
    audioTransport: "none",
  };
  private hostClosed = true;
  private udpProbeTimer: ReturnType<typeof setInterval> | null = null;
  private udpProbeStartedAt = 0;
  private lastUdpAckAt = 0;

  /**
   * Whether the inbound-message routing has been wired to the connection yet.
   *
   * Wiring happens lazily on the first `connect()` so a re-`connect()` (after a
   * `close()`) does not register the same routing twice and double-emit events.
   */
  private routed = false;

  /**
   * Whether the first successful open has been handled by `connect()`.
   *
   * The connection fires `onState("open")` on every open, including the first.
   * `connect()` already handles the first open directly (configure audio, emit
   * connected), so this flag lets the state callback treat only *subsequent*
   * opens as reconnects, avoiding a double audio-configure and a re-send on the
   * very first connect.
   */
  private opened = false;

  constructor(deps: RuntimeDeps) {
    this.connection = deps.connection;
    this.emitter = deps.emitter;
    this.subscriptions = deps.subscriptions;
    this.camera = deps.camera;
    this.tts = deps.tts;
    this.maps = deps.maps;
    this.audio = deps.audio;
    this.logger = deps.logger;
    this.forceRefreshToken = deps.forceRefreshToken;
  }

  /**
   * Open the live session and start routing inbound messages to events.
   *
   * The connection owns the handshake (init/ack), reconnect with backoff, and
   * liveness; this method wires the routing once, then opens it. On the ack we
   * configure the UDP audio path (the ack carries the sessionTag, host/port, and
   * key) and announce `connected`. A later reconnect re-runs the handshake inside
   * the connection and re-fires the open path through the wired callbacks, so the
   * subscription re-send below is what restores a fresh session's audio set.
   *
   * If the cloud rejects the handshake with a fatal `AUTH_EXPIRED` (the token the
   * client presented was expired or revoked despite the client thinking it was
   * fresh), we force `cloud.auth` to refresh and reopen ONCE. The connection
   * re-reads the freshly refreshed token through its own `getToken` on the
   * reopen. We retry only once: if the second open also fails, the original error
   * surfaces, because a second failure means refresh did not fix it and looping
   * would not help.
   */
  async connect(): Promise<void> {
    this.hostClosed = false;
    this.wireRouting();
    const ack = await this.openWithAuthRetry();
    if (!this.opened) {
      this.onOpened(ack);
    }
  }

  /**
   * Open the connection, retrying exactly once on a fatal `AUTH_EXPIRED`.
   *
   * Only `AUTH_EXPIRED` triggers the retry; any other handshake rejection (a bad
   * protocol version, a hard auth failure) is surfaced as-is, since refreshing
   * the token would not change the outcome. The retry forces a token refresh
   * first, then reopens; if that reopen also rejects, the reopen's error
   * propagates so the host sees the real, post-refresh failure.
   */
  private async openWithAuthRetry(): Promise<ConnectionAck> {
    try {
      return await this.connection.open();
    } catch (err) {
      if (!(err instanceof HandshakeRejectedError) || err.code !== AUTH_EXPIRED_CODE) {
        throw err;
      }
      // The cloud says the token is expired even though we believed it fresh.
      // Refresh once (the reopen re-reads the new token via getToken) and retry.
      this.logger.warn("handshake rejected AUTH_EXPIRED; refreshing token and reopening once");
      await this.forceRefreshToken();
      return this.connection.open();
    }
  }

  /**
   * Wire the connection's message/state callbacks to the emitter and camera.
   *
   * Done once (guarded by `routed`). Inbound routing:
   *   - stream.transcript  -> emitter "transcript"
   *   - stream.translation -> emitter "translation"
   *   - error              -> emitter "error" (the typed ProtocolError payload)
   *   - photo pushes        -> camera.handlePush (resolves the pending request)
   *
   * Connection state drives `disconnected` and the subscription re-send on
   * reconnect. We hand every message to `camera.handlePush` regardless of type
   * because it self-filters to photo pushes, which keeps the routing switch here
   * about the events this module owns.
   */
  private wireRouting(): void {
    if (this.routed) return;
    this.routed = true;

    this.connection.onMessage((msg: CloudToClientMessage) => {
      switch (msg.type) {
        case "stream.transcript":
          // The discriminated union narrows `msg.payload` to TranscriptionData
          // here, so the emit is fully typed with no cast.
          this.emitter.emit("transcript", msg.payload);
          break;
        case "stream.translation":
          this.emitter.emit("translation", msg.payload);
          break;
        case "audio.udp_liveness_ack":
          this.handleUdpLivenessAck(msg.payload);
          break;
        case "error":
          this.emitter.emit("error", msg.payload);
          break;
        default:
          // Not one of the events this module surfaces directly. It may still be
          // a camera push, so hand it on; camera ignores anything that is not a
          // photo event.
          break;
      }
      // Managed photo/stream completions are pushes too; let camera claim them.
      this.camera.handlePush(msg);
    });

    this.connection.onState((state) => {
      if (state === "connecting") {
        this.updateStatus({
          status: this.opened ? "reconnecting" : "connecting",
        });
        return;
      }

      if (state === "open") {
        if (!this.opened) {
          // Usually the first open is handled by connect() directly. If that
          // initial attempt failed, Connection still keeps retrying underneath;
          // the first later successful retry reaches us only through this state
          // callback, so it must become the initial open instead of being
          // ignored.
          const ack = this.connection.ack;
          if (ack) this.onOpened(ack);
          return;
        }
        // A reconnect re-opened the socket and redid the handshake. The cloud may
        // have a fresh session with an empty subscription set, so re-send the
        // current set (at the current version) to restore live transcription.
        void this.handleReopen();
      } else if (state === "closed") {
        const superseded = this.connection.isReplacedByNewerSession;
        const reason = superseded
          ? "superseded by newer session"
          : "socket closed";
        this.logger.debug("ws-session-debug runtime closed", {
          superseded,
          hostClosed: this.hostClosed,
          reason,
        });
        this.stopUdpLiveness();
        this.updateStatus({
          status: this.hostClosed || superseded
            ? "disconnected"
            : this.opened
              ? "reconnecting"
              : "connecting",
          audioTransport: "none",
        });
        this.emitter.emit("disconnected", { reason });
      }
    });
  }

  /**
   * React to a (re)opened socket after the handshake completed.
   *
   * Reconfigures the UDP audio path against the new ack (a fresh session brings a
   * fresh key and tag) and re-sends the subscription set so the new session is
   * not left transcribing against an empty set. Guarded on the ack being present
   * because a reconnect's `open` state can briefly precede the new ack being
   * recorded; the next `open` (or an explicit setSubscriptions) then covers it.
   */
  private async handleReopen(): Promise<void> {
    const ack = this.connection.ack;
    if (!ack) return;
    this.configureAudio(ack);
    this.updateStatus({ status: "connected" });
    // Announce the reconnection the same way the first open does. Without this,
    // a host that tracks liveness via `onConnected`/`onDisconnected` would stay
    // stuck "disconnected" after every reconnect (its flag never flips back),
    // even though the socket is live and transcription has resumed.
    this.emitter.emit("connected", undefined);
    try {
      await this.subscriptions.resend(ack.sessionId);
    } catch (err) {
      // A failed re-send is not fatal to the connection: log and let the next
      // explicit setSubscriptions or reconnect retry. Never log token material.
      this.logger.warn("subscription resend failed after reconnect", {
        sessionId: ack.sessionId,
      });
      void err;
    }
  }

  /**
   * Handle the first successful open from `connect()`.
   *
   * Configures audio from the ack and announces `connected`. Subscriptions are
   * not re-sent here because the initial set rides in `connection.init` (seeded
   * with the session); the re-send path is specifically for reconnects.
   */
  private onOpened(ack: ConnectionAck): void {
    this.opened = true;
    this.configureAudio(ack);
    this.updateStatus({ status: "connected" });
    this.emitter.emit("connected", undefined);
  }

  /**
   * Configure the UDP audio path from an ack, when the cloud offered UDP audio.
   *
   * The ack's `audio` block is optional: on the WebSocket audio fallback there is
   * no UDP and no key, so there is nothing to configure and we leave the audio
   * path idle.
   */
  private configureAudio(ack: ConnectionAck): void {
    if (ack.audio) {
      this.audio.configure(ack.audio);
      this.updateStatus({ audioTransport: "udp" });
      this.startUdpLiveness();
      return;
    }
    this.audio.close();
    this.stopUdpLiveness();
    this.updateStatus({ audioTransport: "none" });
  }

  /**
   * Close the session: tear down the UDP audio path and the WebSocket.
   *
   * Audio is closed first so no frame is sent on a socket that is going away.
   */
  close(): void {
    this.hostClosed = true;
    this.opened = false;
    this.stopUdpLiveness();
    this.audio.close();
    this.updateStatus({ status: "disconnected", audioTransport: "none" });
    this.connection.close();
  }

  /**
   * Replace the cloud's subscription set for the current session.
   *
   * Uses the `sessionId` from the current ack so the cloud ties the write to this
   * session. Throws if there is no live session (no ack), because a subscription
   * write without a session would be silently ignored by the cloud and a silent
   * no-op is worse than a clear error here.
   */
  async setSubscriptions(subs: AudioSubscription[]): Promise<void> {
    const ack = this.connection.ack;
    if (!ack) {
      throw new Error("Cannot set subscriptions before the session is connected");
    }
    await this.subscriptions.set(subs, ack.sessionId);
  }

  /** Encrypt and send one audio frame over the UDP path (see RuntimeModule). */
  sendAudioFrame(frame: Uint8Array): void {
    if (this.status.audioTransport === "ws") {
      const packet = this.audio.buildPlainFrame(frame);
      if (packet) {
        this.connection.sendBinary(packet);
      }
      return;
    }

    if (this.status.audioTransport === "udp") {
      this.audio.sendFrame(frame);
    }
  }

  getStatus(): RuntimeSnapshot {
    return { ...this.status };
  }

  // --- Camera: managed photo/stream (delegated) -----------------------------

  requestManagedPhoto(opts: PhotoOptions): Promise<{ requestId: string; readUrl: string }> {
    return this.camera.requestPhoto(opts);
  }

  /** Device-side managed photo: presign now, deliver bytes yourself, then await ready. */
  startManagedPhoto(opts: PhotoOptions): Promise<{ requestId: string; uploadUrl: string; readUrl: string }> {
    return this.camera.startPhoto(opts);
  }

  awaitManagedPhotoReady(requestId: string): Promise<{ requestId: string; readUrl: string }> {
    return this.camera.awaitPhotoReady(requestId);
  }

  startManagedStream(opts: StreamOptions): Promise<ManagedStream> {
    return this.camera.startStream(opts);
  }

  getManagedStreamStatus(streamId: string): Promise<StreamStatusResult> {
    return this.camera.streamStatus(streamId);
  }

  stopManagedStream(streamId: string): Promise<void> {
    return this.camera.stopStream(streamId);
  }

  // --- Events (delegated to the one typed emitter) --------------------------

  onTranscript(handler: (data: TranscriptionData) => void): () => void {
    return this.emitter.on("transcript", handler);
  }

  onTranslation(handler: (data: TranslationData) => void): () => void {
    return this.emitter.on("translation", handler);
  }

  onConnected(handler: () => void): () => void {
    // The "connected" event carries no payload; adapt the void payload to the
    // caller's zero-arg handler.
    return this.emitter.on("connected", () => handler());
  }

  onDisconnected(handler: (info: { reason: string }) => void): () => void {
    return this.emitter.on("disconnected", handler);
  }

  onStatusChanged(handler: (status: RuntimeSnapshot) => void): () => void {
    return this.emitter.on("status", handler);
  }

  onError(handler: (err: ProtocolError) => void): () => void {
    return this.emitter.on("error", handler);
  }

  on<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): () => void {
    return this.emitter.on(event, handler);
  }

  off<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): void {
    this.emitter.off(event, handler);
  }

  onAny(handler: (event: keyof RuntimeEvents, data: unknown) => void): () => void {
    return this.emitter.onAny(handler);
  }

  private updateStatus(next: Partial<RuntimeSnapshot>): void {
    const snapshot = { ...this.status, ...next };
    if (
      snapshot.status === this.status.status &&
      snapshot.audioTransport === this.status.audioTransport
    ) {
      return;
    }
    this.status = snapshot;
    this.emitter.emit("status", { ...snapshot });
  }

  private startUdpLiveness(): void {
    this.stopUdpLiveness();
    this.udpProbeStartedAt = Date.now();
    this.lastUdpAckAt = 0;
    this.sendUdpProbe();
    this.udpProbeTimer = setInterval(() => {
      this.sendUdpProbe();
      this.checkUdpLiveness();
    }, UDP_PROBE_INTERVAL_MS);
  }

  private stopUdpLiveness(): void {
    if (this.udpProbeTimer) {
      clearInterval(this.udpProbeTimer);
      this.udpProbeTimer = null;
    }
    this.udpProbeStartedAt = 0;
    this.lastUdpAckAt = 0;
  }

  private sendUdpProbe(): void {
    const tag = this.audio.sessionTag;
    if (tag === null) return;
    const probeId = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    this.audio.sendProbe(probeId);
  }

  private checkUdpLiveness(): void {
    if (this.status.status !== "connected") return;
    const since = this.lastUdpAckAt || this.udpProbeStartedAt;
    if (since === 0 || Date.now() - since < UDP_LIVENESS_TIMEOUT_MS) return;
    this.updateStatus({ audioTransport: this.connection.isOpen ? "ws" : "none" });
  }

  private handleUdpLivenessAck(payload: {
    sessionId: string;
    sessionTag: number;
    probeId: string;
    receivedAt: number;
  }): void {
    if (payload.sessionTag !== this.audio.sessionTag) return;
    this.lastUdpAckAt = Date.now();
    if (this.status.status === "connected") {
      this.updateStatus({ audioTransport: "udp" });
    }
  }
}
