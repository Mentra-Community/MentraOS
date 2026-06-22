/**
 * @fileoverview Node/Bun implementations of the three platform transports.
 *
 * This is one of the two platform-specific files for a server (the test harness
 * and the dev stack import it). It maps the abstract transport interfaces the
 * shared core depends on onto concrete server primitives: the `ws` package for
 * the WebSocket, Node's `dgram` for UDP audio, and an in-memory Map for token
 * storage. Nothing here knows about the protocol or the modules above; it only
 * adapts socket and storage shapes.
 *
 * See docs/issues/004-cloud-client/design.md ("node/transports.ts" and "The
 * pieces passed in per platform").
 */
import WebSocket from "ws";
import { createSocket } from "node:dgram";
import type {
  CloudClientTransports,
  WebSocketLike,
  UdpSocketLike,
  KeyValueStore,
} from "@mentra/cloud-client";

/**
 * Adapt the `ws` package to `WebSocketLike`.
 *
 * The shared core expects callback registration (onOpen/onMessage/...), not the
 * EventEmitter that `ws` exposes, so each registrar forwards to a `ws` event.
 * We force every inbound frame to a string because the runtime protocol is text
 * JSON: `ws` hands binary frames as Buffer/ArrayBuffer, so we normalise to a
 * UTF-8 string rather than leaking a Buffer up into the protocol layer.
 */
function nodeWebSocket(url: string): WebSocketLike {
  const socket = new WebSocket(url);

  return {
    send(data: string): void {
      socket.send(data);
    },
    sendBinary(data: Uint8Array): void {
      socket.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
    close(): void {
      socket.close();
    },
    onOpen(cb: () => void): void {
      socket.on("open", cb);
    },
    onMessage(cb: (data: string) => void): void {
      socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        // The protocol is always text JSON. `ws` still surfaces frames as
        // Buffer; decode to a UTF-8 string so the runtime never sees raw bytes.
        cb(isBinary ? data.toString("utf8") : data.toString());
      });
    },
    onClose(cb: (info: { code: number; reason: string }) => void): void {
      socket.on("close", (code: number, reason: Buffer) => {
        cb({ code, reason: reason.toString("utf8") });
      });
    },
    onError(cb: (err: unknown) => void): void {
      socket.on("error", (err: unknown) => {
        cb(err);
      });
    },
  };
}

/**
 * Adapt Node `dgram` to `UdpSocketLike` for the audio path.
 *
 * The encrypted frame is built in the shared core, so this adapter only moves
 * bytes: `send` targets the per-session host/port from `connection.ack`, and
 * inbound datagrams are handed up as raw bytes. We open an IPv4 UDP socket
 * because the audio host/port the cloud assigns is an IPv4 endpoint.
 */
function nodeUdpSocket(): UdpSocketLike {
  const socket = createSocket("udp4");

  return {
    send(bytes: Uint8Array, host: string, port: number): void {
      socket.send(bytes, port, host);
    },
    onMessage(cb: (bytes: Uint8Array) => void): void {
      socket.on("message", (msg: Buffer) => {
        cb(msg);
      });
    },
    close(): void {
      socket.close();
    },
  };
}

/**
 * An in-memory `KeyValueStore`.
 *
 * A server has no OS secure store and usually does not need credentials to
 * survive a process restart (the test harness re-exchanges on each run), so a
 * plain Map is enough. Each call returns a resolved promise to match the async
 * interface the device's secure store requires.
 */
function memoryStorage(): KeyValueStore {
  const map = new Map<string, string>();

  return {
    get(key: string): Promise<string | null> {
      return Promise.resolve(map.has(key) ? (map.get(key) as string) : null);
    },
    set(key: string, value: string): Promise<void> {
      map.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

/**
 * Build the Node transport bundle handed to the root `CloudClient`.
 *
 * `ws` and `udp` are factories because the runtime opens a fresh socket on every
 * (re)connect and a fresh UDP socket per session; `storage` is a single instance
 * because the token state is shared for the client's whole lifetime.
 */
export function nodeTransports(): CloudClientTransports {
  return {
    ws: nodeWebSocket,
    udp: nodeUdpSocket,
    storage: memoryStorage(),
  };
}
