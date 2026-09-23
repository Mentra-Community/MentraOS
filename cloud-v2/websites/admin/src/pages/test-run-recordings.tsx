import { useEffect, useRef, useState } from "react";
import { testRunAssetPath } from "../lib/test-run-links";
import { chapterSeekTime, type TestRunAsset, type TestRunChapter } from "./test-runs-data";

interface RecordingTrack { assetId: string; label: string; offsetSeconds: number }
export interface RecordingTimeline {
  schemaVersion: 1;
  clock: "native-video";
  uncertaintyMs: number;
  tracks: RecordingTrack[];
}

/** Data only; never accept a media URL, script, or unregistered asset from provenance. */
export function readRecordingTimeline(value: unknown, assets: TestRunAsset[]): RecordingTimeline | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const row = JSON.parse(value);
    if (!row || Object.keys(row).sort().join() !== "clock,schemaVersion,tracks,uncertaintyMs" ||
      row.schemaVersion !== 1 || row.clock !== "native-video" || !Number.isFinite(row.uncertaintyMs) ||
      row.uncertaintyMs < 0 || row.uncertaintyMs > 300 || !Array.isArray(row.tracks) || row.tracks.length !== 2) return null;
    for (const track of row.tracks) {
      if (!track || Object.keys(track).sort().join() !== "assetId,label,offsetSeconds" ||
        typeof track.assetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(track.assetId) ||
        typeof track.label !== "string" || !track.label.trim() || track.label.length > 80 ||
        !Number.isFinite(track.offsetSeconds) || track.offsetSeconds < 0 ||
        !assets.some(asset => asset.assetId === track.assetId && asset.kind === "video")) return null;
    }
    if (row.tracks[0].offsetSeconds !== 0 || row.tracks[0].assetId === row.tracks[1].assetId) return null;
    return row;
  } catch { return null; }
}

export function recordingTimeAt(sharedSeconds: number, offsetSeconds: number, duration: number): number | null {
  if (![sharedSeconds, offsetSeconds, duration].every(Number.isFinite) || sharedSeconds < 0 || offsetSeconds < 0 || duration <= 0)
    return null;
  const local = sharedSeconds - offsetSeconds;
  return local >= 0 && local <= duration ? local : null;
}

type Playback = Pick<HTMLVideoElement, "currentTime" | "duration" | "playbackRate" | "paused" | "play" | "pause">;
export function synchronizeRecordingPeer(primary: Playback, peer: Playback, offsetSeconds: number): Promise<void> | null {
  const local = recordingTimeAt(primary.currentTime, offsetSeconds, peer.duration);
  if (local === null) { peer.pause(); return null; }
  if (Math.abs(peer.currentTime - local) > 0.1) peer.currentTime = local;
  peer.playbackRate = primary.playbackRate;
  if (primary.paused) peer.pause();
  else if (peer.paused) return peer.play();
  return null;
}

export function TestRunRecordings({ runId, assets, timeline, selected, seekSequence }: {
  runId: string;
  assets: TestRunAsset[];
  timeline: RecordingTimeline;
  selected?: TestRunChapter;
  seekSequence: number;
}) {
  const media = useRef<Record<string, HTMLVideoElement | null>>({});
  const lastSeek = useRef<string | null>(null);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [sharedSeconds, setSharedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const primaryId = timeline.tracks[0].assetId;

  function sync() {
    const primary = media.current[primaryId];
    if (!primary) return;
    const shared = primary.currentTime;
    setSharedSeconds(shared);
    for (const track of timeline.tracks.slice(1)) {
      const video = media.current[track.assetId];
      if (!video) continue;
      try {
        void synchronizeRecordingPeer(primary, video, track.offsetSeconds)?.catch(() => setError("The browser recording could not start playback."));
      } catch { setError("The recordings could not synchronize at this moment."); }
    }
  }

  useEffect(() => {
    setError(null);
    if (!selected?.videoAssetId) return;
    const key = JSON.stringify([selected.id, selected.videoAssetId, selected.videoStart, selected.videoEnd, seekSequence]);
    if (lastSeek.current === key) return;
    const asset = assets.find(asset => asset.assetId === selected.videoAssetId);
    const track = timeline.tracks.find(track => track.assetId === selected.videoAssetId);
    const primary = media.current[primaryId];
    if (!asset || !track || !primary || durations[asset.assetId] === undefined || durations[primaryId] === undefined) return;
    const local = chapterSeekTime(selected, asset, durations[asset.assetId]);
    const shared = local === null ? null : local + track.offsetSeconds;
    if (shared === null || recordingTimeAt(shared, 0, durations[primaryId]) === null) {
      setError("This step is outside the synchronized recordings.");
      return;
    }
    try { primary.currentTime = shared; lastSeek.current = key; sync(); }
    catch { setError("The recording could not seek to this step."); }
  }, [selected?.id, selected?.videoAssetId, selected?.videoStart, selected?.videoEnd, seekSequence, durations]);

  return <section aria-label="Synchronized routine recordings">
    <p className="mb-3 text-sm text-[#68746d]">Shared timeline · measured uncertainty ±{Math.ceil(timeline.uncertaintyMs)} ms. Use the Mentra App recording controls for both views.</p>
    <div className="grid gap-4 xl:grid-cols-2">
      {timeline.tracks.map((track, index) => {
        const asset = assets.find(asset => asset.assetId === track.assetId)!;
        const playable = asset.uploaded && ["video/mp4", "video/webm", "video/quicktime"].includes(asset.contentType.split(";")[0].toLowerCase());
        const loaded = durations[track.assetId] !== undefined;
        const covered = index === 0 || (loaded && recordingTimeAt(sharedSeconds, track.offsetSeconds, durations[track.assetId]) !== null);
        return <div key={track.assetId}>
          <h4 className="mb-2 text-sm font-semibold">{track.label}</h4>
          {playable ? <>
            <video ref={node => { media.current[track.assetId] = node; }} src={testRunAssetPath(runId, track.assetId)}
              controls={index === 0} muted={index !== 0} playsInline preload="metadata" hidden={!covered}
              aria-label={`${track.label} recording`} className="w-full rounded-xl bg-[#111217]"
              onLoadedMetadata={event => { const duration = event.currentTarget.duration; setDurations(current => ({ ...current, [track.assetId]: duration })); sync(); }}
              onTimeUpdate={index === 0 ? sync : undefined} onSeeking={index === 0 ? sync : undefined}
              onPlay={index === 0 ? sync : undefined} onPause={index === 0 ? sync : undefined}
              onRateChange={index === 0 ? sync : undefined}
              onError={() => { for (const item of Object.values(media.current)) item?.pause(); setError("A recording is unavailable or the admin session has expired."); }} />
            {!covered ? <p role="status" className="rounded-xl bg-[#f5f7f4] p-5 text-sm">{loaded ? "No recording covers this moment." : "Loading recording metadata."}</p> : null}
            <a href={testRunAssetPath(runId, track.assetId)} download className="mt-2 inline-block text-xs font-semibold text-[#087d50]">Download {track.label} recording</a>
          </> : <p role="status">Recording upload is incomplete or unavailable.</p>}
        </div>;
      })}
    </div>
    {error ? <p role="alert" className="mt-3 text-sm text-[#a64235]">{error}</p> : null}
  </section>;
}
