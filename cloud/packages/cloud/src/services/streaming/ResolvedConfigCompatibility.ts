import { StreamStatus } from "@mentra/sdk";

type StreamResolvedConfig = NonNullable<StreamStatus["resolvedConfig"]>;
type StreamResolvedVideoConfig = NonNullable<StreamResolvedConfig["video"]>;
type CompatibleStreamResolvedVideoConfig = Omit<StreamResolvedVideoConfig, "frameRate"> &
  Partial<Pick<StreamResolvedVideoConfig, "frameRate">> & {
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

  const frameRate = resolvedConfig.video.frameRate ?? resolvedConfig.video.fps;
  if (frameRate === undefined) {
    return resolvedConfig as StreamStatus["resolvedConfig"];
  }

  const { fps: _fps, ...video } = resolvedConfig.video;
  return {
    ...resolvedConfig,
    video: {
      ...video,
      frameRate,
    },
  };
}
