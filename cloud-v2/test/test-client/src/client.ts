/**
 * @fileoverview TestClient — Bun-based reference client for cloud-v2.
 *
 * Drives the full pipeline from auth through audio send / transcript receive,
 * so e2e tests don't need real glasses or a phone. Mirrors what a real mobile
 * SDK does:
 *
 *   1. Get an OEM-signed JWT from TEST OEM
 *   2. Exchange it at core for a Mentra access token
 *   3. Open WS to audio with `Authorization: Bearer <token>`
 *   4. Receive CONNECTION_ACK (sessionTag + UDP host:port)
 *   5. (When sending audio) send UDP packets with the sessionTag header
 *   6. Receive transcripts back over the WS
 *
 * The transport split (REST auth → WS control + transcripts → UDP audio)
 * matches the v1 wire shape exactly.
 */

import type { udp } from "bun";
import { Buffer } from "node:buffer";

// Subscription types duplicated from `packages/runtime/src/services/session/subscriptions.ts`.
// Kept local to the client to preserve the test-client tsconfig's `rootDir`
// boundary; mirrors the cloud-side wire format. Update both if either
// changes (compile-time test below would help — TODO).

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

/**
 * Format an internal subscription to its v1 wire string. Mirror of
 * `packages/runtime/src/wire/phone-protocol.formatPhoneSubscription` (kept local
 * to preserve the test-client tsconfig's `rootDir` boundary; update both if
 * the grammar changes).
 */
function formatPhoneSubscription(sub: AudioSubscription): string {
  if (sub.kind === "transcription") {
    return sub.language.mode === "specific"
      ? `transcription:${sub.language.code}`
      : "transcription:auto";
  }
  const source = sub.source.mode === "specific" ? sub.source.code : "all";
  return `translation:${source}-to-${sub.target}`;
}

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const UDP_HEADER_SIZE = 6;

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
  /** Optional extra claims to put on the OEM JWT (passed through to cloud). */
  extraClaims?: Record<string, unknown>;
  /** Hard timeout for the connect handshake. Default 5s. */
  connectTimeoutMs?: number;
  /**
   * App-level ping/pong liveness. **The client owns connection liveness;
   * the cloud is passive.** When enabled, the client sends
   * `{"type":"ping"}` on `pingIntervalMs`, expects a `{"type":"pong"}`
   * within `pongTimeoutMs` of each ping, and closes the WS if a pong
   * doesn't arrive. Mirrors what the mobile SDK does in v1.
   *
   * Default: disabled. Tests that exercise liveness opt in.
   */
  liveness?: {
    pingIntervalMs: number;
    pongTimeoutMs: number;
  };
}

export interface ConnectionAck {
  type: "CONNECTION_ACK";
  sessionTag: number;
  audioSessionId: string;
  udp: { host: string; port: number };
}

export interface TranscriptStub {
  type: "TRANSCRIPT_STUB";
  mentraUserId: string;
  seq: number;
  /** LC3 payload byte length. */
  payloadLen: number;
  /** Decoded PCM byte length (Int16 samples × 2). 0 if decode skipped. */
  pcmBytesLen: number;
  audioSessionId: string;
  origin: "live" | "replay";
}

/** v1 `data_stream` payload for a `transcription:*` stream. */
export interface TranscriptionData {
  type: "transcription";
  text: string;
  isFinal: boolean;
  transcribeLanguage?: string;
  detectedLanguage?: string;
  startTime: number;
  endTime: number;
  provider?: string;
}

/** v1 `data_stream` payload for a `translation:*` stream. */
export interface TranslationData {
  type: "translation";
  text: string;
  isFinal: boolean;
  transcribeLanguage?: string;
  translateLanguage?: string;
  startTime: number;
  endTime: number;
  provider?: string;
}

/**
 * The v1 envelope real transcripts arrive in. The mobile routes by
 * `streamType` (e.g. `transcription:en-US`). Cloud-v2's audio service
 * produces these via `wire/phone-protocol.transcriptToDataStream`.
 */
export interface DataStream {
  type: "data_stream";
  streamType: string;
  data: TranscriptionData | TranslationData;
}

export type AnyServerMessage =
  | ConnectionAck
  | { type: "UDP_PACKET_RECEIVED"; sequence: number; payloadLen: number }
  | TranscriptStub
  | DataStream
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
    if (!this.ack) throw new Error("not connected");
    return this.ack.sessionTag;
  }

  /** Mentra access token. Available after connect(). */
  get token(): string {
    if (!this.accessToken) throw new Error("not connected");
    return this.accessToken;
  }

  /**
   * Run the full handshake: mint OEM JWT → exchange for access token →
   * open WS → receive CONNECTION_ACK → open UDP socket. Throws on any step.
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
   * Send a subscription list. The cloud opens transcription / translation
   * provider streams matching this list and closes any that disappear.
   * Idempotent — sending the same list is a no-op cloud-side.
   *
   * Without a SUBSCRIBE, the cloud will still receive + decode audio but
   * won't run transcription (you won't see TRANSCRIPT messages).
   */
  subscribe(subs: AudioSubscription[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WS not open");
    }
    // Emit the v1 wire contract the real mobile uses: a flat list of
    // subscription strings under `phone_subscription_update`. We accept the
    // typed `AudioSubscription[]` for ergonomics and format to strings here.
    this.ws.send(
      JSON.stringify({
        type: "phone_subscription_update",
        subscriptions: subs.map(formatPhoneSubscription),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  /**
   * Send an audio payload over UDP to the cloud-advertised UDP address (the
   * one returned in CONNECTION_ACK). Default for normal client use.
   *
   * Packet shape: [sessionTag:u32 BE][seq:u16 BE][payload]. Sequence wraps at
   * 65535 (matches v1).
   */
  sendAudio(payload: Uint8Array): void {
    if (!this.ack) throw new Error("not connected");
    this.sendAudioTo({ host: this.ack.udp.host, port: this.ack.udp.port }, payload);
  }

  /**
   * Send the same packet shape to an explicit host:port. Used by multi-pod
   * tests to deliberately deliver a packet to a pod that doesn't own the
   * session, exercising the stateless-ingress path.
   */
  sendAudioTo(target: { host: string; port: number }, payload: Uint8Array): void {
    if (!this.ack || !this.udpSocket) throw new Error("not connected");
    const packet = Buffer.alloc(UDP_HEADER_SIZE + payload.byteLength);
    packet.writeUInt32BE(this.ack.sessionTag, 0);
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
    packet.writeUInt32BE(this.ack.sessionTag, 0);
    packet.writeUInt16BE(this.udpSeq & 0xffff, 4);
    this.udpSeq = (this.udpSeq + 1) & 0xffff;
    packet.set(payload, UDP_HEADER_SIZE);
    this.ws.send(packet);
  }

  /** Subscribe to inbound WS messages (CONNECTION_ACK, transcripts, debug). */
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
   * Useful in tests: `await client.waitFor("UDP_PACKET_RECEIVED")`.
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
        reject(new Error("CONNECTION_ACK not received within timeout"));
      }, timeoutMs);

      ws.onerror = (ev) => {
        clearTimeout(timer);
        reject(new Error(`ws error: ${(ev as ErrorEvent).message ?? "unknown"}`));
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
        if (parsed.type === "pong") {
          this.onPongReceived();
          return;
        }

        this.receivedMessages.push(parsed);
        for (const h of this.messageHandlers) h(parsed);

        if (parsed.type === "CONNECTION_ACK") {
          this.ack = parsed as ConnectionAck;
          clearTimeout(timer);
          resolve();
        }
      };

      ws.onclose = () => {
        if (!this.ack) {
          clearTimeout(timer);
          reject(new Error("ws closed before CONNECTION_ACK"));
        }
      };
    });
  }

  // === Liveness ===

  private startLiveness(): void {
    if (!this.opts.liveness || !this.ws) return;
    const { pingIntervalMs, pongTimeoutMs } = this.opts.liveness;

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ type: "ping" }));

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
