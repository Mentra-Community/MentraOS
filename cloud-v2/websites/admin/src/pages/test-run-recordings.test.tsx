import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readRecordingTimeline, recordingTimeAt, synchronizeRecordingPeer, TestRunRecordings, type RecordingTimeline } from "./test-run-recordings";
import type { TestRunAsset } from "./test-runs-data";

const assets: TestRunAsset[] = ["recording", "browser-recording"].map(assetId => ({
  assetId, kind: "video", filename: `${assetId}.mp4`, contentType: "video/mp4", sizeBytes: 100,
  sha256: "a".repeat(64), uploaded: true,
}));
const mapping: RecordingTimeline = { schemaVersion: 1, clock: "native-video", uncertaintyMs: 60,
  tracks: [{ assetId: "recording", label: "Mentra App", offsetSeconds: 0 },
    { assetId: "browser-recording", label: "Browser peer", offsetSeconds: 12.5 }] };

test("a strict mapping references existing recordings without accepting arbitrary media URLs", () => {
  expect(readRecordingTimeline(JSON.stringify(mapping), assets)).toEqual(mapping);
  for (const changed of [
    { ...mapping, clock: "wall-clock" }, { ...mapping, uncertaintyMs: 301 }, { ...mapping, uncertaintyMs: -1 },
    { ...mapping, extra: "ignored authority" }, { ...mapping, tracks: [mapping.tracks[0]] },
    { ...mapping, tracks: [mapping.tracks[0], mapping.tracks[0]] },
    { ...mapping, tracks: [{ ...mapping.tracks[0], offsetSeconds: 1 }, mapping.tracks[1]] },
    { ...mapping, tracks: [mapping.tracks[0], { ...mapping.tracks[1], assetId: "https://evil.invalid/media" }] },
    { ...mapping, tracks: [mapping.tracks[0], { ...mapping.tracks[1], url: "https://evil.invalid/media" }] },
    { ...mapping, tracks: [mapping.tracks[0], { ...mapping.tracks[1], offsetSeconds: -1 }] },
  ]) expect(readRecordingTimeline(JSON.stringify(changed), assets)).toBeNull();
  expect(readRecordingTimeline(JSON.stringify(mapping), assets.slice(0, 1))).toBeNull();
  expect(readRecordingTimeline("{broken", assets)).toBeNull();
});

test("shared time seeks each original recording and never clamps unrecorded intervals to a fake frame", () => {
  expect(recordingTimeAt(15, 12.5, 10)).toBe(2.5);
  expect(recordingTimeAt(15, 0, 30)).toBe(15);
  expect(recordingTimeAt(12, 12.5, 10)).toBeNull();
  expect(recordingTimeAt(23, 12.5, 10)).toBeNull();
  for (const duration of [NaN, Infinity, 0, -1]) expect(recordingTimeAt(15, 12.5, duration)).toBeNull();
  expect(recordingTimeAt(-1, 0, 30)).toBeNull();
});

test("paired renderer exposes only authenticated asset routes and one set of shared playback controls", () => {
  const timeline = readRecordingTimeline(JSON.stringify(mapping), assets)!;
  const markup = renderToStaticMarkup(<TestRunRecordings runId="synthetic-call" assets={assets} timeline={timeline} seekSequence={0} />);
  expect(markup.match(/<video /g)).toHaveLength(2);
  expect(markup.match(/controls=""/g)).toHaveLength(1);
  expect(markup).toContain('/api/admin/test-runs/synthetic-call/assets/browser-recording');
  expect(markup).toContain("Loading recording metadata.");
  expect(markup).toContain("±60 ms");
  expect(markup).not.toContain("<iframe");
  const missing = renderToStaticMarkup(<TestRunRecordings runId="synthetic-call" assets={assets.map(asset => ({ ...asset, uploaded: false }))} timeline={timeline} seekSequence={0} />);
  expect(missing).not.toContain("<video");
  expect(missing).toContain("Recording upload is incomplete");
});

test("playback follows seek, rate and pause without playing a frame outside peer coverage", async () => {
  let plays = 0, pauses = 0;
  const peer = { currentTime: 0, duration: 10, playbackRate: 1, paused: true,
    async play() { plays++; this.paused = false; }, pause() { pauses++; this.paused = true; } };
  const primary = { ...peer, currentTime: 15, duration: 30, playbackRate: 2, paused: false };
  await synchronizeRecordingPeer(primary, peer, 12.5);
  expect(peer.currentTime).toBe(2.5);
  expect(peer.playbackRate).toBe(2);
  expect(plays).toBe(1);
  primary.paused = true;
  synchronizeRecordingPeer(primary, peer, 12.5);
  expect(peer.paused).toBe(true);
  primary.paused = false;
  primary.currentTime = 2;
  synchronizeRecordingPeer(primary, peer, 12.5);
  expect(peer.currentTime).toBe(2.5); // Do not clamp to a misleading frame zero.
  expect(peer.paused).toBe(true);
  expect(plays).toBe(1);
  primary.currentTime = 29;
  synchronizeRecordingPeer(primary, peer, 12.5);
  expect(plays).toBe(1);
  expect(pauses).toBe(3);
});
