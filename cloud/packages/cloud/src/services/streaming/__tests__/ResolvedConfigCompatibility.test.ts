import { describe, expect, it } from "bun:test";

import { normalizeStreamResolvedConfig } from "../ResolvedConfigCompatibility";

describe("normalizeStreamResolvedConfig", () => {
  it("keeps frameRate and strips legacy fps when both are present", () => {
    const resolvedConfig = normalizeStreamResolvedConfig({
      transport: "whip",
      video: {
        width: 1280,
        height: 720,
        bitrate: 1_000_000,
        frameRate: 24,
        fps: 15,
      },
    });

    expect(resolvedConfig?.video).toEqual({
      width: 1280,
      height: 720,
      bitrate: 1_000_000,
      frameRate: 24,
    });
  });

  it("converts legacy fps from dev ASG/mobile status into app-facing frameRate", () => {
    const resolvedConfig = normalizeStreamResolvedConfig({
      transport: "rtmp",
      video: {
        width: 854,
        height: 480,
        bitrate: 1_000_000,
        fps: 15,
      },
      audio: {
        echoCancellation: false,
      },
    });

    expect(resolvedConfig?.video).toEqual({
      width: 854,
      height: 480,
      bitrate: 1_000_000,
      frameRate: 15,
    });
    expect(resolvedConfig?.audio?.echoCancellation).toBe(false);
  });
});
