import {expect, test} from "bun:test";
import {negotiatedFrameTimeline} from "./frame-timeline";

test("frame negotiation is default off until all ingress/worker readers are upgraded", () => {
  const previous = process.env.AUDIO_FRAME_TIMELINE_ENABLED;
  try {
    delete process.env.AUDIO_FRAME_TIMELINE_ENABLED;
    expect(negotiatedFrameTimeline(1)).toBeUndefined();
    process.env.AUDIO_FRAME_TIMELINE_ENABLED = "false";
    expect(negotiatedFrameTimeline(1)).toBeUndefined();
    process.env.AUDIO_FRAME_TIMELINE_ENABLED = "true";
    expect(negotiatedFrameTimeline(1)).toBe(1);
    expect(negotiatedFrameTimeline()).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.AUDIO_FRAME_TIMELINE_ENABLED;
    else process.env.AUDIO_FRAME_TIMELINE_ENABLED = previous;
  }
});
