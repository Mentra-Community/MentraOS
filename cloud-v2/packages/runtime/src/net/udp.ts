/**
 * @fileoverview UDP audio ingress.
 *
 * Listens on `AUDIO_UDP_PORT`. Every packet starts with a 6-byte header —
 * `[sessionTag:u32 BE][sequence:u16 BE]` — followed by audio payload (LC3
 * frames or PCM). Stateless: any pod can receive any packet.
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
import { getSessionByTag } from "./ws";

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
    result = await ingestAudioPacket(parsed, localLookup);
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
          payloadLen: payload.byteLength,
        }),
      );
    } catch (err) {
      logger.error({ err }, "debug echo failed");
    }
  }
}
