/**
 * @fileoverview UDP audio ingress.
 *
 * Listens on `AUDIO_UDP_PORT`. Every packet is
 * `[sessionTag:u32 BE][sequence:u16 BE][nonce:24][ciphertext]`: the 6-byte header
 * stays in the clear so the stateless ingress can route it and pick the session
 * key; the audio payload is secretbox-encrypted and decrypted at ingest. Any pod
 * can receive any packet.
 *
 * Per-packet flow:
 *   1. Validate header.
 *   2. Resolve sessionTag → user (local map fast-path, Redis on miss).
 *   3. XADD the payload to `audio:{mentraUserId}` Redis Stream.
 *   4. (debug mode only) Echo `UDP_PACKET_RECEIVED` back over the WS so
 *      integration tests can assert receipt without a worker pipeline.
 *
 * Cross-pod packets are an explicit goal: if a UDP packet arrives at pod B
 * but the WS is on pod A, pod B still resolves the tag via Redis and writes
 * to the user's stream. Pod A's dispatch loop will then consume it (when
 * dispatch lands).
 *
 * Spec: docs/issues/003-audio/design.md ("UDP ingress")
 */

import type { udp } from "bun";
import { createLogger } from "@mentra/cloud-shared";
import {
  ingestAudioPacket,
  parseAudioPacket,
} from "../services/session/stream";
import { publishUdpLivenessAck } from "../services/session/control-stream";
import { getSessionByTag } from "./ws";
import { PROTOCOL_MAJOR } from "@mentra/cloud-protocol/envelope";

const logger = createLogger("audio").child({ service: "udp-ingress" });

type UdpSocket = udp.Socket<"buffer">;

let socket: UdpSocket | null = null;

/**
 * Debug-echo toggle. Read fresh per packet (rather than cached at module
 * load) so integration tests can flip it via env without rebuilding.
 */
function debugEchoEnabled(): boolean {
  return process.env.AUDIO_DEBUG_ECHO === "true";
}

/** Start the UDP listener. Idempotent within a process. */
export async function startUdpIngress(port: number): Promise<void> {
  if (socket) {
    logger.warn("startUdpIngress called twice; ignoring");
    return;
  }

  socket = await Bun.udpSocket({
    port,
    socket: {
      data(_s, data, _port, _addr) {
        // handlePacket is async; we deliberately don't await it on the hot
        // path. Errors are caught inside.
        handlePacket(data).catch((err) => {
          logger.error({ err }, "udp handler threw");
        });
      },
      error(_s, err) {
        logger.error({ err }, "udp socket error");
      },
    },
  });

  logger.info({ port }, "udp ingress listening");
}

export async function stopUdpIngress(): Promise<void> {
  socket?.close();
  socket = null;
}

// === Internals ===

function localLookup(tag: number) {
  const e = getSessionByTag(tag);
  if (!e) return undefined;
  return {
    mentraUserId: e.data.mentraUserId,
    audioSessionId: e.data.audioSessionId,
    encryptionKeyB64: e.data.encryptionKeyB64,
  };
}

async function handlePacket(data: Buffer | Uint8Array): Promise<void> {
  const parsed = parseAudioPacket(data);
  if (!parsed) {
    logger.warn({ len: data.byteLength }, "udp packet too small for header");
    return;
  }
  const { sessionTag, sequence, payload } = parsed;

  let result;
  try {
    // UDP frames are secretbox-encrypted; ingest decrypts with the session key.
    result = await ingestAudioPacket(parsed, localLookup, { encrypted: true });
  } catch (err) {
    logger.error({ err, sessionTag, sequence }, "audio ingest failed");
    return;
  }
  if (!result.ok) {
    logger.debug(
      { sessionTag, sequence, payloadLen: payload.byteLength },
      "udp packet for unknown sessionTag",
    );
    return;
  }
  const { origin, mentraUserId } = result;
  const localEntry = origin === "local" ? getSessionByTag(sessionTag) : undefined;

  if (result.kind === "probe") {
    const receivedAt = Date.now();
    if (localEntry) {
      localEntry.ws.send(
        JSON.stringify({
          v: PROTOCOL_MAJOR,
          type: "audio.udp_liveness_ack",
          timestamp: receivedAt,
          payload: {
            sessionId: localEntry.data.audioSessionId,
            sessionTag,
            probeId: result.probeId ?? "",
            receivedAt,
          },
        }),
      );
    } else if (mentraUserId && result.audioSessionId) {
      await publishUdpLivenessAck(mentraUserId, {
        sessionTag,
        audioSessionId: result.audioSessionId,
        probeId: result.probeId ?? "",
        receivedAt,
      });
      logger.debug(
        {
          sessionTag,
          sequence,
          mentraUserId,
          origin,
          probeId: result.probeId,
        },
        "udp liveness ack published to owner control stream",
      );
    }
    logger.debug(
      {
        sessionTag,
        sequence,
        mentraUserId,
        origin,
        probeId: result.probeId,
      },
      "udp liveness probe received",
    );
    return;
  }

  logger.debug(
    {
      sessionTag,
      sequence,
      payloadLen: payload.byteLength,
      mentraUserId,
      origin: localEntry ? "local" : "redis",
    },
    "udp packet appended to stream",
  );

  // Debug echo is same-pod only — it sends back over the WS we hold locally.
  // Cross-pod packets (resolved via Redis) skip the echo even when the env
  // flag is on, because the WS lives elsewhere.
  if (debugEchoEnabled() && localEntry) {
    try {
      localEntry.ws.send(
        JSON.stringify({
          type: "UDP_PACKET_RECEIVED",
          sequence,
          // The decrypted audio length (what the worker will see), not the
          // larger encrypted frame, so tests assert against the bytes they sent.
          payloadLen: result.payloadLen ?? payload.byteLength,
        }),
      );
    } catch (err) {
      logger.error({ err }, "debug echo failed");
    }
  }
}
