/**
 * @fileoverview The three platform pieces the shared core takes as inputs.
 *
 * A phone and a server differ in exactly three places: how they open a
 * WebSocket, how they send UDP, and where they store tokens. The shared logic
 * only ever touches these interfaces, never a real socket, so the same core code
 * runs on the device and in a Node/Bun test harness. The `react-native` and
 * `node` wrappers each supply concrete implementations.
 *
 * See docs/issues/004-cloud-client/spec.md ("Construction") and design.md.
 */

/**
 * A text WebSocket, reduced to the surface the runtime needs.
 *
 * Callbacks (not an EventEmitter) so the interface is identical across the RN
 * built-in socket, nitro-websockets, and the Node `ws` package, none of which
 * share an event API.
 */
export interface WebSocketLike {
  send(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (info: { code: number; reason: string }) => void): void;
  onError(cb: (err: unknown) => void): void;
}

/**
 * A UDP socket for the audio path.
 *
 * The encrypted audio bytes are built in the shared core and handed here as raw
 * bytes, so this interface stays a thin send/receive with no codec or crypto
 * knowledge. `host`/`port` come from `connection.ack`, not from construction,
 * because they are assigned per session.
 */
export interface UdpSocketLike {
  send(bytes: Uint8Array, host: string, port: number): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  close(): void;
}

/**
 * A tiny key/value store for credentials.
 *
 * Only the refresh token needs to survive a relaunch, so the surface stays at
 * get/set/delete. On the device this is the OS secure store; in tests it is
 * memory or a temp file. Async because the secure store is async.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Fetch-compatible HTTP executor supplied by hosts that need networking to
 * outlive their JavaScript UI lifecycle (for example Android foreground services). */
export type HttpTransport = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

/**
 * The bundle of platform pieces handed to the root `CloudClient`.
 *
 * `ws` and `udp` are factories (not instances) because the runtime opens a fresh
 * socket on every (re)connect and a fresh UDP socket per session, rather than
 * reusing one for the client's whole lifetime.
 */
export interface CloudClientTransports {
  ws: (url: string) => WebSocketLike;
  udp: () => UdpSocketLike;
  storage: KeyValueStore;
  /** Falls back to globalThis.fetch when omitted. */
  http?: HttpTransport;
}
