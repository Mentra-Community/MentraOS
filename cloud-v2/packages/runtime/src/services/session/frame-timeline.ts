/**
 * Enable only after every UDP ingress and audio worker supports positioned
 * frames. Handshake negotiation alone cannot protect older cross-pod readers.
 */
export function negotiatedFrameTimeline(requested?: 1): 1 | undefined {
  return requested === 1 && process.env.AUDIO_FRAME_TIMELINE_ENABLED === "true"
    ? 1 : undefined;
}
