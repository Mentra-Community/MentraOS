/**
 * @fileoverview The UDP audio path: encrypt each frame in the shared core, then
 * hand the raw bytes to the injected UDP socket.
 *
 * Encryption lives here (not in native code) so it is byte-for-byte identical on
 * a phone and a server and therefore testable from a Node/Bun harness. The
 * injected `udp` transport only sends and receives bytes: it has no codec or
 * crypto knowledge.
 *
 * Frame layout (big-endian header, see
 * docs/issues/002-cloud-runtime/audio/wire.md "UDP audio frames"):
 *
 *   offset 0   u32   sessionTag   (routes the datagram to the right session)
 *   offset 4   u16   seq          (per-session packet counter)
 *   offset 6   [24]  nonce        (fresh random per packet)
 *   offset 30  ...   ciphertext   (secretbox(payload): encrypted audio + 16-byte tag)
 *
 * The header is in the clear because the stateless ingress needs `sessionTag` to
 * route the datagram before it can decrypt anything; only the audio payload is
 * encrypted and authenticated (NaCl secretbox, XSalsa20-Poly1305).
 *
 * Security: the per-session key is never logged and never travels over UDP. The
 * cloud delivers it once over the TLS WebSocket in `connection.ack.audio`.
 */
import nacl from "tweetnacl";
import type { UdpSocketLike } from "../../transports";
import { UDP_LIVENESS_PROBE_PREFIX, type ConnectionAck } from "@mentra/cloud-protocol";

/** The audio block of `connection.ack`, present only when UDP audio is offered. */
type AudioConfig = NonNullable<ConnectionAck["audio"]>;

/** Header byte offsets, named so the frame builder reads as the wire spec does. */
const SESSION_TAG_OFFSET = 0;
const SEQ_OFFSET = 4;
const NONCE_OFFSET = 6;
const AUDIO_PACKET_HEADER_SIZE = NONCE_OFFSET;

/** The seq field is a u16, so it wraps at 65536; the cloud expects that wrap. */
const SEQ_MODULO = 0x10000;

export interface UdpAudioDeps {
  udp: () => UdpSocketLike;
}

export type RuntimeAudioTransport = "udp" | "ws" | "none";

/**
 * Holds the live UDP socket plus the per-session crypto/routing material.
 *
 * Gathered into one object so a reconfigure (a fresh session brings a fresh key,
 * tag, and host/port) replaces all of it atomically and an old socket cannot be
 * sent on with a new key.
 */
interface UdpSession {
  socket: UdpSocketLike;
  sessionTag: number;
  host: string;
  port: number;
  key: Uint8Array;
  /** Per-session packet counter; wraps at the u16 boundary. */
  seq: number;
}

export class UdpAudio {
  private readonly udpFactory: () => UdpSocketLike;
  private session: UdpSession | null = null;

  constructor(deps: UdpAudioDeps) {
    this.udpFactory = deps.udp;
  }

  /** The audio transport currently configured for outbound frames. */
  get transport(): RuntimeAudioTransport {
    return this.session ? "udp" : "none";
  }

  get sessionTag(): number | null {
    return this.session?.sessionTag ?? null;
  }

  /**
   * Open the UDP socket and load the session's routing + encryption material
   * from `connection.ack.audio`.
   *
   * Called once per (re)connect. If a previous session's socket is still open we
   * close it first, so a reconnect does not leak the old socket and a stale key
   * can never be used again. The base64 key is decoded once here, not per frame,
   * to keep `sendFrame` allocation-light on the hot audio path.
   */
  configure(audio: AudioConfig): void {
    // Drop any prior session before swapping in the new one.
    this.close();

    this.session = {
      socket: this.udpFactory(),
      sessionTag: audio.sessionTag,
      host: audio.udp.host,
      port: audio.udp.port,
      key: decodeBase64(audio.encryption.key),
      seq: 0,
    };
  }

  /**
   * Encrypt one audio payload (LC3 frame) and send it as a UDP datagram.
   *
   * A fresh random 24-byte nonce is drawn per packet: secretbox is only secure
   * when a (key, nonce) pair is never reused, and a random nonce makes a clash
   * negligibly unlikely across a session. Dropped silently (no throw) when no
   * session is configured, because audio frames arrive continuously and a single
   * frame sent before/after a session is not worth crashing the caller over; the
   * absence is observable through the missing session, not an exception per frame.
   */
  sendFrame(payload: Uint8Array): boolean {
    const session = this.session;
    if (!session) return false;

    session.socket.send(this.buildEncryptedPacket(session, payload), session.host, session.port);
    return true;
  }

  sendProbe(probeId: string): boolean {
    return this.sendFrame(asciiBytes(`${UDP_LIVENESS_PROBE_PREFIX}${probeId}`));
  }

  buildPlainFrame(payload: Uint8Array): Uint8Array | null {
    const session = this.session;
    if (!session) return null;
    return this.buildPacket(session, payload);
  }

  private buildEncryptedPacket(session: UdpSession, payload: Uint8Array): Uint8Array {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    // secretbox returns ciphertext with the 16-byte Poly1305 tag appended.
    const ciphertext = nacl.secretbox(payload, nonce, session.key);
    const encrypted = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
    encrypted.set(nonce, 0);
    encrypted.set(ciphertext, nonce.byteLength);
    return this.buildPacket(session, encrypted);
  }

  private buildPacket(session: UdpSession, payload: Uint8Array): Uint8Array {
    const frame = new Uint8Array(AUDIO_PACKET_HEADER_SIZE + payload.length);
    const view = new DataView(frame.buffer);

    // Header in the clear so the stateless ingress can route before decrypting.
    view.setUint32(SESSION_TAG_OFFSET, session.sessionTag, /* littleEndian */ false);
    view.setUint16(SEQ_OFFSET, session.seq, /* littleEndian */ false);
    frame.set(payload, AUDIO_PACKET_HEADER_SIZE);

    // Advance the per-session counter, wrapping at the u16 boundary the cloud
    // expects, so a long session does not overflow the field.
    session.seq = (session.seq + 1) % SEQ_MODULO;
    return frame;
  }

  /**
   * Close the UDP socket and forget the session.
   *
   * Clearing the session (including the key) on close means a `sendFrame` after
   * close is a no-op rather than a send with stale material.
   */
  close(): void {
    if (!this.session) return;
    this.session.socket.close();
    this.session = null;
  }
}

/**
 * Decode a base64 string to bytes without assuming a platform-specific helper.
 *
 * `atob` exists on a modern phone (Hermes/JSC) and a modern server, so it is the
 * one decoder that works on both without a Node `Buffer` import that would break
 * the React Native bundle.
 */
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0x7f;
  }
  return bytes;
}
