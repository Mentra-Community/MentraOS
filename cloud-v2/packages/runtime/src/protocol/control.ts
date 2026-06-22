/**
 * @fileoverview Control payloads: control.ping and control.pong.
 *
 * Mirrors docs/issues/002-cloud-runtime/protocol.md ("Control"). Liveness and
 * RTT, separate from the WebSocket ping frame. Pure + isomorphic.
 */
import { z } from "zod";

export const controlPingPayloadSchema = z.object({}).strict();
export type ControlPing = z.infer<typeof controlPingPayloadSchema>;

export const controlPongPayloadSchema = z.object({}).strict();
export type ControlPong = z.infer<typeof controlPongPayloadSchema>;
