import type { StreamStatus } from "@mentra/sdk";

type RawTelemetryMessage = StreamStatus & Record<string, any>;

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalize compact BLE telemetry aliases from glasses into the full SDK shape
 * used inside cloud and app-facing messages.
 */
export function normalizeStreamTelemetry(status: RawTelemetryMessage): Pick<StreamStatus, "stats"> {
  const compactStats = status.m;
  const rawStats = status.stats ?? compactStats;

  const bitrate = toNumber(rawStats?.bitrate ?? rawStats?.b);
  const fps = toNumber(rawStats?.fps ?? rawStats?.f);
  const width = toNumber(rawStats?.width ?? rawStats?.w);
  const height = toNumber(rawStats?.height ?? rawStats?.h);
  const droppedFrames = toNumber(rawStats?.droppedFrames ?? rawStats?.d);
  const duration = toNumber(rawStats?.duration ?? rawStats?.u);
  const temperatureC = toNumber(rawStats?.temperatureC ?? rawStats?.tp ?? status.temperatureC ?? status.tp);

  const statsShapeComplete =
    bitrate !== undefined &&
    fps !== undefined &&
    width !== undefined &&
    height !== undefined &&
    droppedFrames !== undefined &&
    duration !== undefined;

  return {
    stats: statsShapeComplete
      ? {
          bitrate,
          fps,
          width,
          height,
          droppedFrames,
          duration,
          temperatureC,
        }
      : undefined,
  };
}
