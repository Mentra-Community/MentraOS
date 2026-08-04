/**
 * @fileoverview The React Native transports: WebSocket, native UDP, secure store.
 *
 * This is the phone-side wiring for the three platform pieces the shared core
 * takes as inputs (see src/transports.ts). It deliberately imports NOTHING from
 * "react-native" or any native module, so the package still typechecks in CI
 * (which runs on Node/Bun, where those modules do not exist). The phone-specific
 * pieces are reached two ways:
 *
 *   - WebSocket: through the RN global `WebSocket`, which React Native provides
 *     on `globalThis` (same shape as the browser one). We feature-detect it and
 *     adapt it to WebSocketLike, so no import is needed.
 *   - UDP and secure storage: through host-injected adapters. React Native has no
 *     built-in UDP socket or secure key/value store, so the host app supplies the
 *     real implementations (for example react-native-udp and expo-secure-store)
 *     and wires them in via the setters below at startup. Until the host wires
 *     them, calling these throws a clear error instead of failing silently.
 *
 * Security: tokens and keys flow through `storage` and the UDP frames, so the
 * adapters here never log their values.
 *
 * See docs/issues/004-cloud-client/design.md ("react-native/transports.ts").
 */
import type {
  CloudClientTransports,
  WebSocketLike,
  UdpSocketLike,
  KeyValueStore,
  HttpTransport,
} from "../src/transports";

/**
 * The minimal shape of the global `WebSocket` we rely on, declared locally.
 *
 * We cannot use the DOM lib's `WebSocket` type because this package compiles
 * with `lib: ["ES2022"]` (no DOM), so we describe just the members we touch.
 * React Native's built-in `WebSocket` and the browser's both satisfy this.
 */
interface GlobalWebSocket {
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
interface GlobalWebSocketCtor {
  new (url: string): GlobalWebSocket;
}

/**
 * Wrap RN's global `WebSocket` (a browser-style event-property socket) into the
 * callback-based WebSocketLike the runtime expects.
 *
 * The runtime registers each callback exactly once and opens a fresh socket per
 * (re)connect, so a plain property assignment per event is enough; there is no
 * need for an add/removeEventListener registry here.
 */
function adaptWebSocket(raw: GlobalWebSocket): WebSocketLike {
  return {
    send(data: string): void {
      raw.send(data);
    },
    sendBinary(data: Uint8Array): void {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      raw.send(copy.buffer);
    },
    close(): void {
      raw.close();
    },
    onOpen(cb: () => void): void {
      raw.onopen = () => cb();
    },
    onMessage(cb: (data: string) => void): void {
      // RN delivers text frames as a string in `ev.data`; we only use text
      // frames (the wire protocol is JSON), so coerce defensively to string.
      raw.onmessage = (ev: { data: unknown }) => cb(String(ev.data));
    },
    onClose(cb: (info: { code: number; reason: string }) => void): void {
      raw.onclose = (ev: { code: number; reason: string }) => cb({ code: ev.code, reason: ev.reason });
    },
    onError(cb: (err: unknown) => void): void {
      raw.onerror = (ev: unknown) => cb(ev);
    },
  };
}

/**
 * Build the WebSocket factory from the RN global, failing clearly if absent.
 *
 * We read the constructor off `globalThis` at call time (not module load) so a
 * missing global only matters once a socket is actually opened, and the package
 * still imports cleanly on a server where no global `WebSocket` exists.
 */
function makeWsFactory(): (url: string) => WebSocketLike {
  return (url: string): WebSocketLike => {
    const Ctor = (globalThis as { WebSocket?: GlobalWebSocketCtor }).WebSocket;
    if (!Ctor) {
      throw new Error(
        "reactNativeTransports: global WebSocket is not available. " +
          "Use @mentra/cloud-client/node off-device, or run on React Native.",
      );
    }
    return adaptWebSocket(new Ctor(url));
  };
}

/**
 * The UDP socket the host wires in. React Native ships no UDP, so the host app
 * provides one (for example backed by react-native-udp) via `setNativeUdp`.
 */
export type NativeUdpFactory = () => UdpSocketLike;

/**
 * The host-supplied UDP factory, or null until `setNativeUdp` is called.
 *
 * Module-level state is intentional: there is one phone process and one native
 * UDP capability, so a single injected factory shared by every CloudClient in
 * the process is the right granularity.
 */
let nativeUdpFactory: NativeUdpFactory | null = null;

/**
 * Wire in the platform's native UDP socket factory.
 *
 * The host calls this once during app startup, before constructing a CloudClient
 * that uses UDP audio. Passing the factory (not a socket) matches UdpSocketLike's
 * contract that a fresh socket is created per session.
 */
export function setNativeUdp(factory: NativeUdpFactory): void {
  nativeUdpFactory = factory;
}

/**
 * The secure key/value store the host wires in. React Native has no built-in
 * persistent store, so the host provides one (for example expo-secure-store or
 * react-native-keychain) via `setSecureStorage`.
 */
let secureStorage: KeyValueStore | null = null;

let nativeHttp: HttpTransport | null = null;

/** Wire a background-capable native HTTP executor into the phone client. */
export function setNativeHttp(http: HttpTransport): void {
  nativeHttp = http;
}

function makeHttpTransport(): HttpTransport {
  return (input, init) => {
    const execute = nativeHttp ?? globalThis.fetch;
    return execute(input, init);
  };
}

/**
 * Wire in the platform's secure storage.
 *
 * The host calls this once at startup so the refresh token survives relaunches.
 * It must be a secure store (Keychain / Keystore-backed), not plain storage,
 * because it holds the long-lived refresh token.
 */
export function setSecureStorage(store: KeyValueStore): void {
  secureStorage = store;
}

/**
 * A UDP factory that defers to whatever the host injected via `setNativeUdp`.
 *
 * It resolves the injected factory lazily, on each `udp()` call, so the host can
 * wire UDP in any time before the first audio session, not strictly before the
 * CloudClient is constructed.
 */
function makeUdpFactory(): () => UdpSocketLike {
  return (): UdpSocketLike => {
    if (!nativeUdpFactory) {
      throw new Error(
        "reactNativeTransports: native UDP is not wired. " +
          "Call setNativeUdp(factory) at app startup before using UDP audio.",
      );
    }
    return nativeUdpFactory();
  };
}

/**
 * A KeyValueStore that defers every call to the host-injected secure store.
 *
 * We return a stable wrapper (rather than the injected store directly) so the
 * host may call `setSecureStorage` after `reactNativeTransports()` has already
 * been handed to a CloudClient; each operation resolves the store at call time.
 */
function makeSecureStorage(): KeyValueStore {
  function require(): KeyValueStore {
    if (!secureStorage) {
      throw new Error(
        "reactNativeTransports: secure storage is not wired. " +
          "Call setSecureStorage(store) at app startup (for example expo-secure-store).",
      );
    }
    return secureStorage;
  }
  return {
    get(key: string): Promise<string | null> {
      return require().get(key);
    },
    set(key: string, value: string): Promise<void> {
      return require().set(key, value);
    },
    delete(key: string): Promise<void> {
      return require().delete(key);
    },
  };
}

/**
 * Build the React Native transport bundle for `CloudClient`.
 *
 * WebSocket comes from the RN global; UDP and secure storage come from the
 * host-injected adapters (`setNativeUdp` / `setSecureStorage`). The returned
 * adapters resolve those injections lazily, so the host can wire them at startup
 * independently of when this bundle is constructed.
 */
export function reactNativeTransports(): CloudClientTransports {
  return {
    ws: makeWsFactory(),
    udp: makeUdpFactory(),
    storage: makeSecureStorage(),
    http: makeHttpTransport(),
  };
}
