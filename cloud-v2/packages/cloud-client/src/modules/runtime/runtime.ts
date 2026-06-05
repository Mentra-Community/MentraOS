/**
 * @fileoverview `cloud.runtime`: the live session module.
 *
 * This is wiring only. It implements the public `RuntimeModule` by delegating to
 * five collaborators and routing messages between them:
 *   - connection: owns the WebSocket, the handshake, reconnect, and liveness.
 *   - emitter: the one typed event emitter the public `on*` methods wrap.
 *   - subscriptions: the REST full-replace writer with the version counter.
 *   - media: managed photo/stream (REST request, await the WebSocket push).
 *   - audio: the UDP audio path (encrypt each frame, hand bytes to the socket).
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
} from "@mentra/cloud-runtime/protocol";
import type { Logger } from "../../logger";
import type { Connection } from "./connection";
import type { RuntimeEmitter, RuntimeEvents } from "./emitter";
import type { Subscriptions } from "./subscriptions";
import type { ManagedMedia, PhotoOptions, StreamOptions, ManagedStream } from "./managed-media";
import type { UdpAudio } from "./audio-udp";

// Re-export the camera option/result types so a host importing the runtime gets
// them from one place alongside the module that produces them.
export type { PhotoOptions, StreamOptions, ManagedStream } from "./managed-media";

/**
 * The public runtime surface, implemented by `Runtime` below.
 *
 * Defined here (rather than in the protocol package) because it is the client's
 * API, not a wire type: it composes the wire types from
 * `@mentra/cloud-runtime/protocol` into the methods a host calls. The per-event
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

  onTranscript(handler: (data: TranscriptionData) => void): () => void;
  onTranslation(handler: (data: TranslationData) => void): () => void;

  requestManagedPhoto(opts: PhotoOptions): Promise<{ requestId: string; readUrl: string }>;
  startManagedStream(opts: StreamOptions): Promise<ManagedStream>;
  stopManagedStream(streamId: string): Promise<void>;

  onConnected(handler: () => void): () => void;
  onDisconnected(handler: (info: { reason: string }) => void): () => void;
  onError(handler: (err: ProtocolError) => void): () => void;

  on<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): () => void;
  off<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): void;
  onAny(handler: (event: keyof RuntimeEvents, data: unknown) => void): () => void;
}

export interface RuntimeDeps {
  connection: Connection;
  emitter: RuntimeEmitter;
  subscriptions: Subscriptions;
  media: ManagedMedia;
  audio: UdpAudio;
  logger: Logger;
}

export class Runtime implements RuntimeModule {
  private readonly connection: Connection;
  private readonly emitter: RuntimeEmitter;
  private readonly subscriptions: Subscriptions;
  private readonly media: ManagedMedia;
  private readonly audio: UdpAudio;
  private readonly logger: Logger;

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
    this.media = deps.media;
    this.audio = deps.audio;
    this.logger = deps.logger;
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
   */
  async connect(): Promise<void> {
    this.wireRouting();
    const ack = await this.connection.open();
    this.onOpened(ack);
  }

  /**
   * Wire the connection's message/state callbacks to the emitter and media.
   *
   * Done once (guarded by `routed`). Inbound routing:
   *   - stream.transcript  -> emitter "transcript"
   *   - stream.translation -> emitter "translation"
   *   - error              -> emitter "error" (the typed ProtocolError payload)
   *   - photo pushes        -> media.handlePush (resolves the pending request)
   *
   * Connection state drives `disconnected` and the subscription re-send on
   * reconnect. We hand every message to `media.handlePush` regardless of type
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
        case "error":
          this.emitter.emit("error", msg.payload);
          break;
        default:
          // Not one of the events this module surfaces directly. It may still be
          // a managed-media push, so hand it on; media ignores anything that is
          // not a photo event.
          break;
      }
      // Managed photo/stream completions are pushes too; let media claim them.
      this.media.handlePush(msg);
    });

    this.connection.onState((state) => {
      if (state === "open") {
        if (!this.opened) {
          // The first open is driven by `connect()` itself; ignore it here so we
          // do not configure audio twice or re-send before the initial set lands.
          return;
        }
        // A reconnect re-opened the socket and redid the handshake. The cloud may
        // have a fresh session with an empty subscription set, so re-send the
        // current set (at the current version) to restore live transcription.
        void this.handleReopen();
      } else if (state === "closed") {
        this.emitter.emit("disconnected", { reason: "socket closed" });
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
    }
  }

  /**
   * Close the session: tear down the UDP audio path and the WebSocket.
   *
   * Audio is closed first so no frame is sent on a socket that is going away.
   */
  close(): void {
    this.audio.close();
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
    this.audio.sendFrame(frame);
  }

  // --- Managed media (delegated) --------------------------------------------

  requestManagedPhoto(opts: PhotoOptions): Promise<{ requestId: string; readUrl: string }> {
    return this.media.requestPhoto(opts);
  }

  startManagedStream(opts: StreamOptions): Promise<ManagedStream> {
    return this.media.startStream(opts);
  }

  stopManagedStream(streamId: string): Promise<void> {
    return this.media.stopStream(streamId);
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
}
