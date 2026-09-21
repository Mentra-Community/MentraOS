/**
 * @fileoverview Control payloads: control.ping and control.pong.
 *
 * Mirrors https://github.com/Mentra-Community/Mentra-Specs/blob/main/cloud/runtime/protocol.md ("Control"). Liveness and
 * RTT, separate from the WebSocket ping frame. Pure + isomorphic.
 */
import { z } from "zod";

export const controlPingPayloadSchema = z.object({}).strict();
export type ControlPing = z.infer<typeof controlPingPayloadSchema>;

export const controlPongPayloadSchema = z.object({}).strict();
export type ControlPong = z.infer<typeof controlPongPayloadSchema>;
