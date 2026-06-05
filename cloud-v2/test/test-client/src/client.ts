/**
 * @fileoverview TestClient — Bun-based reference client for cloud-v2.
 *
 * Drives the full pipeline from auth through audio send / transcript receive,
 * so e2e tests don't need real glasses or a phone. Mirrors what a real mobile
 * SDK does, speaking the v2 protocol end to end:
 *
 *   1. Get an OEM-signed JWT from TEST OEM
 *   2. Exchange it at core for a Mentra access token
 *   3. Open WS to audio with `Authorization: Bearer <token>`
 *   4. Send `connection.init` (codec + initial subscriptions), receive
 *      `connection.ack` (sessionTag + UDP host:port)
 *   5. (When sending audio) send UDP packets with the sessionTag header
 *   6. Receive `stream.transcript` / `stream.translation` back over the WS
 *
 * Transport split: REST auth → WS control + transcripts → UDP audio.
 */

import type { udp } from "bun";
import { Buffer } from "node:buffer";

// Subscription types duplicated from `packages/runtime/src/protocol/audio.ts`.
// Kept local to the client to preserve the test-client tsconfig's `rootDir`
// boundary; the shapes are the canonical v2 wire types. Update both if either
// changes.

export type LanguageSource =
  | { mode: "specific"; code: string }
  | { mode: "auto"; hints?: string[] };

export interface TranscriptionSubscription {
  kind: "transcription";
  language: LanguageSource;
}

export interface TranslationSubscription {
  kind: "translation";
  source: LanguageSource;
  target: string;
}

export type AudioSubscription =
  | TranscriptionSubscription
  | TranslationSubscription;

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const UDP_HEADER_SIZE = 6;
const PROTOCOL_MAJOR = 2 as const;
const PROTOCOL_VERSION = "2.0.0";

type UdpSocket = udp.Socket<"buffer">;

export interface TestClientOptions {
  /** Where TEST OEM runs. e.g. `http://localhost:3100`. */
  testOemUrl: string;
  /** Where cloud-core runs (REST). e.g. `http://localhost:3000`. */
  coreUrl: string;
  /** Where cloud-audio's WS endpoint runs. e.g. `ws://localhost:3001/ws/session`. */
  audioWsUrl: string;
  /** OEM's user identifier — passed as `sub` in the OEM JWT. */
  oemUserId: string;
  /** Audio codec advertised in `connection.init`. Default `"lc3"`. */
  codec?: "lc3" | "pcm";
  /** Sample rate advertised in `connection.init`. Default `16000`. */
  sampleRate?: number;
  /** Optional extra claims to put on the OEM JWT (passed through to cloud). */
  extraClaims?: Record<string, unknown>;
  /** Hard timeout for the connect handshake. Default 5s. */
  connectTimeoutMs?: number;
  /**
   * App-level ping/pong liveness. **The client owns connection liveness;
   * the cloud is passive.** When enabled, the client sends a `control.ping`
   * on `pingIntervalMs`, expects a `control.pong` within `pongTimeoutMs`,
   * and closes the WS if one doesn't arrive. Mirrors the mobile SDK.
   *
   * Default: disabled. Tests that exercise liveness opt in.
   */
  liveness?: {
    pingIntervalMs: number;
    pongTimeoutMs: number;
  };
}

// === v2 wire message shapes (subset the client cares about) ===

interface Envelope<T> {
  v: 2;
  type: string;
  id?: string;
  timestamp: number;
  payload: T;
}

export interface ConnectionAck
  extends Envelope<{
    sessionId: string;
    negotiatedVersion: string;
    audio?: {
      sessionTag: number;
      udp: { host: string; port: number };
      encryption: { algorithm: string; key: string };
    };
  }> {
  type: "connection.ack";
}

export interface TranscriptStub {
  type: "TRANSCRIPT_STUB";
  mentraUserId: string;
  seq: number;
  payloadLen: number;
  pcmBytesLen: number;
  audioSessionId: string;
  origin: "live" | "replay";
}

/** `stream.transcript` payload — a transcription result. */
export interface TranscriptionData {
  userId: string;
  subscription: TranscriptionSubscription;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  resolvedLanguage: string;
  languageDetected: boolean;
  tokens: unknown[];
  provider: string;
  timestamp: number;
}

/** `stream.translation` payload — a translation result. */
export interface TranslationData {
  userId: string;
  subscription: TranslationSubscription;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  source: { language: string; detected: boolean };
  target: { language: string };
  provider: string;
  timestamp: number;
}

export interface StreamTranscript extends Envelope<TranscriptionData> {
  type: "stream.transcript";
}
export interface StreamTranslation extends Envelope<TranslationData> {
  type: "stream.translation";
}

export type AnyServerMessage =
  | ConnectionAck
  | { type: "UDP_PACKET_RECEIVED"; sequence: number; payloadLen: number }
  | TranscriptStub
  | StreamTranscript
  | StreamTranslation
  | { type: string; [k: string]: unknown };

export type MessageHandler = (msg: AnyServerMessage) => void;

export class TestClient {
  private accessToken: string | null = null;
  private ws: WebSocket | null = null;
  private ack: ConnectionAck | null = null;
  private udpSocket: UdpSocket | null = null;
  private udpSeq = 0;
  private messageHandlers: MessageHandler[] = [];
  private receivedMessages: AnyServerMessage[] = [];
  /** Subscriptions queued before connect — seeded into `connection.init`. */
  private initialSubscriptions: AudioSubscription[] = [];

  /** Liveness state. Populated only when `opts.liveness` is set. */
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessClosedCallback: (() => void) | null = null;

  constructor(private readonly opts: TestClientOptions) {}

  /** True if connect() has completed and we hold a sessionTag. */
  get connected(): boolean {
    return this.ack !== null;
  }

  /** The sessionTag the cloud assigned to this session. Available after connect(). */
  get sessionTag(): number {
    const tag = this.ack?.payload.audio?.sessionTag;
    if (tag == null) throw new Error("not connected");
    return tag;
  }

  /** Mentra access token. Available after connect(). */
  get token(): string {
    if (!this.accessToken) throw new Error("not connected");
    return this.accessToken;
  }

  /**
   * Run the full handshake: mint OEM JWT → exchange for access token →
   * open WS → send connection.init → receive connection.ack → open UDP
   * socket. Throws on any step.
   */
  async connect(): Promise<void> {
    this.accessToken = await this.exchangeForAccessToken();
    await this.openWebSocket(this.accessToken);
    this.udpSocket = await Bun.udpSocket({});
    if (this.opts.liveness) this.startLiveness();
  }

  /**
   * Notify when the liveness watchdog closes the WS for missed pongs.
   * Used in tests to assert "the client closed the connection, not the cloud."
   */
  onLivenessClose(cb: () => void): void {
    this.livenessClosedCallback = cb;
  }

  /**
   * Set the subscription list. The cloud opens transcription / translation
   * provider streams matching this list and closes any that disappear.
   *
   * Called BEFORE connect(): the list is seeded into `connection.init` so it
   * applies atomically with the session. Called AFTER connect(): the list is
   * sent to the audio REST subscriptions endpoint (a fresh PUT replaces the
   * prior set). Idempotent — resending the same list is a cloud-side no-op.
   *
   * Without any subscription, the cloud still receives + decodes audio but
   * won't run transcription (you won't see transcript messages).
   */
  subscribe(subs: AudioSubscription[]): void {
    if (!this.connected) {
      this.initialSubscriptions = subs;
      return;
    }
    this.putSubscriptions(subs).catch((err) => {
      // Fire-and-forget from the caller's perspective; surface failures on
      // stderr rather than as an unhandled rejection.
      console.error("[test-client] subscriptions PUT failed:", err);
    });
  }

  /**
   * Send an audio payload over UDP to the cloud-advertised UDP address (the
   * one returned in connection.ack). Default for normal client use.
   *
   * Packet shape: [sessionTag:u32 BE][seq:u16 BE][payload]. Sequence wraps at
   * 65535 (matches v1).
   */
  sendAudio(payload: Uint8Array): void {
    const udpInfo = this.ack?.payload.audio?.udp;
    if (!udpInfo) throw new Error("not connected");
    this.sendAudioTo({ host: udpInfo.host, port: udpInfo.port }, payload);
  }

  /**
   * Send the same packet shape to an explicit host:port. Used by multi-pod
   * tests to deliberately deliver a packet to a pod that doesn't own the
   * session, exercising the stateless-ingress path.
   */
  sendAudioTo(target: { host: string; port: number }, payload: Uint8Array): void {
    if (!this.ack || !this.udpSocket) throw new Error("not connected");
    const packet = Buffer.alloc(UDP_HEADER_SIZE + payload.byteLength);
    packet.writeUInt32BE(this.sessionTag, 0);
    packet.writeUInt16BE(this.udpSeq & 0xffff, 4);
    this.udpSeq = (this.udpSeq + 1) & 0xffff;
    packet.set(payload, UDP_HEADER_SIZE);
    this.udpSocket.send(packet, target.port, target.host);
  }

  /**
   * Send the audio payload as a WS binary frame (fallback path used when
   * UDP can't get through — corp firewalls, strict NAT, etc.).
   *
   * Same 6-byte header + payload wire format as the UDP path so cloud-side
   * dispatch is transport-agnostic. The cloud verifies the sessionTag in
   * the header matches this WS's session.
   */
  sendAudioWs(payload: Uint8Array): void {
    if (!this.ack || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WS not open");
    }
    const packet = Buffer.alloc(UDP_HEADER_SIZE + payload.byteLength);
    packet.writeUInt32BE(this.sessionTag, 0);
    packet.writeUInt16BE(this.udpSeq & 0xffff, 4);
    this.udpSeq = (this.udpSeq + 1) & 0xffff;
    packet.set(payload, UDP_HEADER_SIZE);
    this.ws.send(packet);
  }

  /** Subscribe to inbound WS messages (connection.ack, transcripts, debug). */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  /** Snapshot of every message received since connect(). Cleared on close(). */
  get messages(): readonly AnyServerMessage[] {
    return this.receivedMessages;
  }

  /**
   * Wait for a specific message type to arrive. Throws on timeout.
   * Useful in tests: `await client.waitFor("stream.transcript")`.
   */
  waitFor<T extends AnyServerMessage["type"]>(
    type: T,
    timeoutMs = 2000,
  ): Promise<AnyServerMessage> {
    return new Promise((resolve, reject) => {
      const already = this.receivedMessages.find((m) => m.type === type);
      if (already) return resolve(already);
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      const unsub = this.onMessage((m) => {
        if (m.type === type) {
          clearTimeout(timer);
          unsub();
          resolve(m);
        }
      });
    });
  }

  async close(): Promise<void> {
    this.stopLiveness();
    this.ws?.close();
    this.udpSocket?.close();
    this.ws = null;
    this.udpSocket = null;
    this.ack = null;
    this.accessToken = null;
    this.messageHandlers = [];
    this.receivedMessages = [];
    this.livenessClosedCallback = null;
    this.initialSubscriptions = [];
  }

  // === Internals ===

  private async exchangeForAccessToken(): Promise<string> {
    // 1. Mint OEM JWT from TEST OEM.
    const mintRes = await fetch(`${this.opts.testOemUrl}/test-oem/mint-jwt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oemUserId: this.opts.oemUserId,
        extraClaims: this.opts.extraClaims,
      }),
    });
    if (!mintRes.ok) {
      throw new Error(
        `test-oem mint-jwt failed: ${mintRes.status} ${await mintRes.text()}`,
      );
    }
    const { jwt: oemJwt } = (await mintRes.json()) as { jwt: string };

    // 2. Exchange via core's token endpoint.
    const exchangeRes = await fetch(`${this.opts.coreUrl}/api/oem/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: oemJwt,
        subject_token_type: JWT_TOKEN_TYPE,
      }),
    });
    if (!exchangeRes.ok) {
      throw new Error(
        `token exchange failed: ${exchangeRes.status} ${await exchangeRes.text()}`,
      );
    }
    const tokens = (await exchangeRes.json()) as { access_token: string };
    return tokens.access_token;
  }

  private openWebSocket(accessToken: string): Promise<void> {
    const timeoutMs = this.opts.connectTimeoutMs ?? 5000;

    // Bun's WebSocket accepts a `headers` option; lib.dom types don't know
    // about it. Cast to keep typecheck quiet without disabling it globally.
    this.ws = new WebSocket(this.opts.audioWsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    } as unknown as string[]);

    return new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const timer = setTimeout(() => {
        reject(new Error("connection.ack not received within timeout"));
      }, timeoutMs);

      ws.onerror = (ev) => {
        clearTimeout(timer);
        reject(new Error(`ws error: ${(ev as ErrorEvent).message ?? "unknown"}`));
      };

      ws.onopen = () => {
        // v2 handshake: the client opens the conversation with connection.init.
        ws.send(
          JSON.stringify({
            v: PROTOCOL_MAJOR,
            type: "connection.init",
            timestamp: Date.now(),
            payload: {
              protocolVersion: PROTOCOL_VERSION,
              audio: {
                codec: this.opts.codec ?? "lc3",
                sampleRate: this.opts.sampleRate ?? 16000,
                initialSubscriptions:
                  this.initialSubscriptions.length > 0
                    ? this.initialSubscriptions
                    : undefined,
              },
            },
          }),
        );
      };

      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : null;
        if (!raw) return; // binary frame — only expected after ack, ignore here
        let parsed: AnyServerMessage;
        try {
          parsed = JSON.parse(raw) as AnyServerMessage;
        } catch {
          return;
        }

        // Pong messages are consumed by the liveness watchdog only — don't
        // surface them in `messages` / handlers (would clutter test logs).
        if (parsed.type === "control.pong") {
          this.onPongReceived();
          return;
        }

        this.receivedMessages.push(parsed);
        for (const h of this.messageHandlers) h(parsed);

        if (parsed.type === "connection.ack") {
          this.ack = parsed as ConnectionAck;
          clearTimeout(timer);
          resolve();
        }
      };

      ws.onclose = () => {
        if (!this.ack) {
          clearTimeout(timer);
          reject(new Error("ws closed before connection.ack"));
        }
      };
    });
  }

  /** PUT the subscription set to the audio REST endpoint (mid-session change). */
  private async putSubscriptions(subs: AudioSubscription[]): Promise<void> {
    const res = await fetch(`${this.audioHttpBase()}/api/audio/subscriptions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ subscriptions: subs }),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(
        `subscriptions PUT failed: ${res.status} ${await res.text()}`,
      );
    }
  }

  /** Derive the audio service HTTP base from its WS URL. */
  private audioHttpBase(): string {
    return this.opts.audioWsUrl
      .replace(/^ws/, "http")
      .replace(/\/ws\/session$/, "");
  }

  // === Liveness ===

  private startLiveness(): void {
    if (!this.opts.liveness || !this.ws) return;
    const { pingIntervalMs, pongTimeoutMs } = this.opts.liveness;

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(
        JSON.stringify({
          v: PROTOCOL_MAJOR,
          type: "control.ping",
          timestamp: Date.now(),
          payload: {},
        }),
      );

      // Each ping arms a deadline. The first ping that goes unanswered
      // closes the WS — we don't accumulate multiple deadlines.
      if (this.pongDeadlineTimer) return;
      this.pongDeadlineTimer = setTimeout(() => {
        // Pong didn't arrive in time. Client closes the WS — server's
        // close handler will release the ownership claim. This is the
        // *only* place anything in this client closes the connection
        // due to inactivity. The cloud never does it.
        this.pongDeadlineTimer = null;
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        this.livenessClosedCallback?.();
      }, pongTimeoutMs);
    }, pingIntervalMs);
  }

  private onPongReceived(): void {
    if (this.pongDeadlineTimer) {
      clearTimeout(this.pongDeadlineTimer);
      this.pongDeadlineTimer = null;
    }
  }

  private stopLiveness(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongDeadlineTimer) {
      clearTimeout(this.pongDeadlineTimer);
      this.pongDeadlineTimer = null;
    }
  }
}
