import { StreamStatus } from "@mentra/sdk";

type StreamResolvedConfig = NonNullable<StreamStatus["resolvedConfig"]>;
type StreamResolvedVideoConfig = NonNullable<StreamResolvedConfig["video"]>;
type CompatibleStreamResolvedVideoConfig = Omit<StreamResolvedVideoConfig, "frameRate"> & {
  frameRate?: number;
  fps?: number;
};
type CompatibleStreamResolvedConfig = Omit<StreamResolvedConfig, "video"> & {
  video?: CompatibleStreamResolvedVideoConfig;
};

export function normalizeStreamResolvedConfig(
  resolvedConfig?: StreamResolvedConfig | CompatibleStreamResolvedConfig,
): StreamStatus["resolvedConfig"] {
  if (!resolvedConfig?.video) {
    return resolvedConfig;
  }

  const video = resolvedConfig.video as CompatibleStreamResolvedVideoConfig;
  const frameRate = video.frameRate ?? video.fps;
  if (frameRate === undefined) {
    const { video: _video, ...withoutVideo } = resolvedConfig;
    return withoutVideo;
  }

  const { fps: _fps, ...videoWithoutLegacyFps } = video;
  return {
    ...resolvedConfig,
    video: {
      ...videoWithoutLegacyFps,
      frameRate,
    },
  };
}
