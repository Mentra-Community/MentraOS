/**
 * @fileoverview The error payload and transport-level error codes.
 *
 * Mirrors docs/issues/002-cloud-runtime/protocol.md ("Errors"). Services may
 * define additional codes for their own payloads (documented in the service
 * doc). Pure + isomorphic.
 */
import { z } from "zod";

/** Transport-level error codes shared by every runtime service. */
export const PROTOCOL_ERROR_CODES = {
  AUTH_FAILED: { fatal: true }, // token missing or invalid
  AUTH_EXPIRED: { fatal: true }, // token expired; client should refresh and reopen
  UNSUPPORTED_VERSION: { fatal: true }, // protocol major mismatch
  BAD_REQUEST: { fatal: false }, // malformed payload for a known type
  UNKNOWN_TYPE: { fatal: false }, // unrecognized `type`
  INTERNAL: { fatal: false }, // server-side failure
} as const;

export type ProtocolErrorCode = keyof typeof PROTOCOL_ERROR_CODES;

export const protocolErrorPayloadSchema = z.object({
  code: z.string(), // a ProtocolErrorCode or a service-defined code
  message: z.string(),
  fatal: z.boolean(), // if true, the server closes the socket after sending
});
export type ProtocolError = z.infer<typeof protocolErrorPayloadSchema>;
