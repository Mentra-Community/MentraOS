/**
 * @fileoverview Audio Redis substrate. Owns three pieces of state in Redis:
 *
 *   1. **Per-user audio streams** (`{user:mentraUserId}:audio`). XADDed by any pod
 *      that receives a UDP packet for that user; XREADGROUPed by the owner
 *      pod (whichever pod holds the WS). Bounded by MAXLEN ~ retained-window.
 *
 *   2. **Session-tag registry** (`sessionTag:{u32}`). Maps the u32 in UDP
 *      packet headers to a Mentra user (and which pod owns the WS). Lets a
 *      pod that received a UDP packet for a session it doesn't own resolve
 *      "who is this for" without coordinating with the owner.
 *
 *   3. **Stream consumer-group name** (constant). All worker pools across
 *      pods join one group so XAUTOCLAIM can rebalance work after pod death.
 *
 * Wire-format and lifecycle decisions live in `docs/issues/003-audio/`.
 */

import nacl from "tweetnacl";
import { getRedis } from "../../clients/redis.client";
import { UDP_LIVENESS_PROBE_PREFIX } from "@mentra/cloud-protocol/audio";

// === Stream constants ===

/** Per-user audio stream key. */
export function audioStreamKey(mentraUserId: string): string {
  return `{user:${mentraUserId}}:audio`;
}

/** 6-byte UDP/WS audio packet header: [sessionTag:u32 BE][sequence:u16 BE]. */
export const AUDIO_PACKET_HEADER_SIZE = 6;

export interface ParsedAudioPacket {
  sessionTag: number;
  sequence: number;
  payload: Uint8Array;
}

/**
 * Parse the shared UDP/WS audio packet wire format:
 *   [sessionTag:u32 BE][sequence:u16 BE][lc3-payload]
 *
 * Returns null if the buffer is too short to contain a header.
 */
export function parseAudioPacket(buf: Uint8Array): ParsedAudioPacket | null {
  if (buf.byteLength < AUDIO_PACKET_HEADER_SIZE) return null;
  const view = Buffer.isBuffer(buf)
    ? buf
    : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    sessionTag: view.readUInt32BE(0),
    sequence: view.readUInt16BE(4),
    payload: view.subarray(AUDIO_PACKET_HEADER_SIZE),
  };
}

export interface LocalSessionLookup {
  mentraUserId: string;
  audioSessionId: string;
  /**
   * The session's UDP frame key (base64). Needed to decrypt UDP frames on the
   * same-pod fast path. Omitted by the WS-binary fallback path, whose frames
   * are not secretbox-encrypted (they ride the TLS WebSocket).
   */
  encryptionKeyB64?: string;
}

export interface IngestResult {
  ok: boolean;
  kind?: "audio" | "probe";
  origin?: "local" | "redis";
  mentraUserId?: string;
  audioSessionId?: string;
  /** Bytes written to the stream (the decrypted length for UDP frames). */
  payloadLen?: number;
  probeId?: string;
}

export interface IngestOptions {
  /**
   * Whether the payload is secretbox-encrypted. UDP frames are (the payload is
   * `[nonce(24)|ciphertext]`); the WS-binary fallback is not. When true we
   * decrypt with the session key and write plaintext to the stream, so the
   * worker only ever sees decode-ready audio.
   */
  encrypted?: boolean;
}

/** secretbox (XSalsa20-Poly1305) nonce length, 24 bytes. */
const UDP_NONCE_BYTES = nacl.secretbox.nonceLength;

/**
 * Decrypt a UDP frame payload `[nonce(24)|ciphertext]` with the session key.
 * Returns the plaintext audio bytes, or null if the key is missing/wrong size,
 * the frame is too short, or the Poly1305 tag does not verify (forged or
 * corrupted packet).
 */
function decryptUdpPayload(
  payload: Uint8Array,
  keyB64: string | undefined,
): Uint8Array | null {
  if (!keyB64) return null;
  if (payload.byteLength <= UDP_NONCE_BYTES) return null;
  const key = Buffer.from(keyB64, "base64");
  if (key.byteLength !== nacl.secretbox.keyLength) return null;
  const nonce = payload.subarray(0, UDP_NONCE_BYTES);
  const ciphertext = payload.subarray(UDP_NONCE_BYTES);
  return nacl.secretbox.open(ciphertext, nonce, key);
}

function decodeProbeId(payload: Uint8Array): string | null {
  const prefix = UDP_LIVENESS_PROBE_PREFIX;
  if (payload.byteLength <= prefix.length) return null;
  for (let i = 0; i < prefix.length; i += 1) {
    if (payload[i] !== prefix.charCodeAt(i)) return null;
  }
  let id = "";
  for (let i = prefix.length; i < payload.byteLength; i += 1) {
    const c = payload[i];
    if (c < 0x20 || c > 0x7e) return null;
    id += String.fromCharCode(c);
  }
  return id || null;
}

/**
 * Resolve a sessionTag → user (local map first, Redis fallback), then XADD
 * the packet to the user's audio stream. Shared by both ingress paths:
 *
 *   - UDP ingress (`udp-ingress.service.ts`)
 *   - WS-binary fallback (`session.service.ts` message handler)
 *
 * Returns `{ ok: false }` when the sessionTag is unknown — typical when a
 * packet arrives just before/after the session's lifetime, not an error.
 *
 * `localLookup` is the same-pod fast path: a callback the caller provides
 * that consults the in-process session map. We accept a callback (rather
 * than importing session.service directly) to keep the dependency direction
 * one-way and avoid a circular import.
 */
export async function ingestAudioPacket(
  packet: ParsedAudioPacket,
  localLookup: (tag: number) => LocalSessionLookup | undefined,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  let mentraUserId: string;
  let audioSessionId: string;
  let encryptionKeyB64: string | undefined;
  let origin: "local" | "redis";

  const local = localLookup(packet.sessionTag);
  if (local) {
    mentraUserId = local.mentraUserId;
    audioSessionId = local.audioSessionId;
    encryptionKeyB64 = local.encryptionKeyB64;
    origin = "local";
  } else {
    const remote = await lookupSessionTagInRedis(packet.sessionTag);
    if (!remote) return { ok: false };
    mentraUserId = remote.mentraUserId;
    audioSessionId = remote.audioSessionId;
    encryptionKeyB64 = remote.encryptionKeyB64;
    origin = "redis";
  }

  // UDP frames are encrypted; decrypt before the stream so the worker only sees
  // plaintext. A frame that fails the Poly1305 tag check (forged, corrupted, or
  // wrong key) is dropped rather than stored.
  let payload = packet.payload;
  if (opts.encrypted) {
    const plaintext = decryptUdpPayload(payload, encryptionKeyB64);
    if (!plaintext) return { ok: false, origin, mentraUserId };
    payload = plaintext;
  }

  const probeId = opts.encrypted ? decodeProbeId(payload) : null;
  if (probeId) {
    return {
      ok: true,
      kind: "probe",
      origin,
      mentraUserId,
      audioSessionId,
      payloadLen: payload.byteLength,
      probeId,
    };
  }

  await appendAudioPacket(mentraUserId, {
    seq: packet.sequence,
    payload,
    sessionTag: packet.sessionTag,
    audioSessionId,
  });

  return {
    ok: true,
    kind: "audio",
    origin,
    mentraUserId,
    audioSessionId,
    payloadLen: payload.byteLength,
  };
}

/**
 * Stream length cap. ~10 seconds at typical packet rates (≈100 pkt/s).
 * The `~` (approximate) trimming lets Redis trim in efficient bulk —
 * MAXLEN is enforced only loosely.
 */
export const AUDIO_STREAM_MAXLEN = 1000;

/** Consumer group all worker dispatch loops join. Created lazily on first read. */
export const AUDIO_STREAM_GROUP = "audio-workers";

// === Stream operations ===

export interface AudioPacket {
  seq: number;
  /** The raw audio payload (LC3 frames or PCM bytes). */
  payload: Uint8Array;
  /** Useful for tracing — which u32 tag generated this entry. */
  sessionTag: number;
  /** Useful for tracing — which audio-session this entry belongs to. */
  audioSessionId: string;
}

/**
 * XADD an audio packet to a user's stream. Idempotent in the sense that
 * "same user, different sequence" produces distinct entries; we do not
 * de-dupe on `seq` (the producer is responsible for monotonicity).
 *
 * Payload is base64-encoded on write — ioredis returns stream values as
 * strings by default, which corrupts binary bytes outside ASCII via UTF-8
 * decoding. Base64 is binary-safe at the cost of ~33% storage overhead.
 * Workers `Buffer.from(payload, "base64")` to recover the original bytes.
 *
 * Returns the Redis-assigned stream entry ID (`<ms>-<seq>`).
 */
export async function appendAudioPacket(
  mentraUserId: string,
  packet: AudioPacket,
): Promise<string> {
  const redis = getRedis();
  const id = await redis.xadd(
    audioStreamKey(mentraUserId),
    "MAXLEN",
    "~",
    String(AUDIO_STREAM_MAXLEN),
    "*",
    "seq",
    String(packet.seq),
    "sessionTag",
    String(packet.sessionTag),
    "audioSessionId",
    packet.audioSessionId,
    "payload",
    Buffer.from(packet.payload).toString("base64"),
  );
  return id ?? "";
}

// === Session-tag registry ===

/**
 * How long a sessionTag registration is valid in Redis without a refresh.
 * Owners refresh on a timer (well inside the TTL) and on clean WS close
 * delete the key outright. The TTL is the recovery guarantee — if a pod
 * crashes without releasing, abandoned tag mappings vanish within this
 * window so the next reconnect's mapping can take over.
 */
export const SESSION_TAG_TTL_SEC = 60;

/** Owner refreshes at this cadence — well inside the TTL. */
export const SESSION_TAG_REFRESH_INTERVAL_MS = 20_000;

export interface SessionTagRecord {
  mentraUserId: string;
  tenantId: string;
  audioSessionId: string;
  authSessionId: string;
  /** Which pod's WebSocket owns this session. Used by dispatch later. */
  podId: string;
  /**
   * The session's audio frame encryption key (base64). Carried so a UDP packet
   * that lands on any pod can fetch this session's key by sessionTag and
   * decrypt the frame.
   */
  encryptionKeyB64: string;
}

function sessionTagKey(tag: number): string {
  return `sessionTag:${tag}`;
}

export async function registerSessionTag(
  tag: number,
  record: SessionTagRecord,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(
    sessionTagKey(tag),
    JSON.stringify(record),
    "EX",
    SESSION_TAG_TTL_SEC,
    "NX",
  );
  return result === "OK";
}

export async function refreshSessionTag(tag: number): Promise<void> {
  const redis = getRedis();
  await redis.expire(sessionTagKey(tag), SESSION_TAG_TTL_SEC);
}

export async function unregisterSessionTag(tag: number): Promise<void> {
  const redis = getRedis();
  await redis.del(sessionTagKey(tag));
}

/** Returns null if the tag is unknown or has TTL'd out. */
export async function lookupSessionTagInRedis(
  tag: number,
): Promise<SessionTagRecord | null> {
  const redis = getRedis();
  const raw = await redis.get(sessionTagKey(tag));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionTagRecord;
  } catch {
    return null;
  }
}
