/**
 * @fileoverview The transport envelope shared by every WebSocket message.
 *
 * Mirrors docs/issues/002-cloud-runtime/protocol.md ("Envelope"). Pure +
 * isomorphic: no server imports.
 */
import { z } from "zod";

/** Protocol major. A mismatched major is rejected at the handshake. */
export const PROTOCOL_MAJOR = 2 as const;

/**
 * Wraps a payload schema in the protocol envelope with a literal `type`, so a
 * set of message schemas can be combined into a discriminated union on `type`.
 *
 *   const connectionAck = envelope("connection.ack", connectionAckPayloadSchema)
 */
export function envelope<Type extends string, Payload extends z.ZodTypeAny>(
  type: Type,
  payload: Payload,
) {
  return z.object({
    v: z.literal(PROTOCOL_MAJOR),
    type: z.literal(type),
    // present only when a message needs request/ack correlation
    id: z.string().optional(),
    // epoch milliseconds (Unix time)
    timestamp: z.number().int(),
    payload,
  });
}

/** The structural envelope, payload left open. Useful for a first-pass parse. */
export const envelopeSchema = z.object({
  v: z.literal(PROTOCOL_MAJOR),
  type: z.string(),
  id: z.string().optional(),
  timestamp: z.number().int(),
  payload: z.unknown(),
});

export interface Envelope<T = unknown> {
  v: typeof PROTOCOL_MAJOR;
  type: string;
  id?: string;
  timestamp: number;
  payload: T;
}
