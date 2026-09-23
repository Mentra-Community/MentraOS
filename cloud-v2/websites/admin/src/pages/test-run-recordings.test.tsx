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
  const primary = { ...peer, currentTime: 15, duration: 30, playbackRate: 2, paused: false, readyState: 4, seeking: false, ended: false };
  await synchronizeRecordingPeer(primary, peer, 12.5, true);
  expect(peer.currentTime).toBe(2.5);
  expect(peer.playbackRate).toBe(2);
  expect(plays).toBe(1);
  primary.paused = true;
  synchronizeRecordingPeer(primary, peer, 12.5, true);
  expect(peer.paused).toBe(true);
  primary.paused = false;
  primary.currentTime = 2;
  synchronizeRecordingPeer(primary, peer, 12.5, true);
  expect(peer.currentTime).toBe(2.5); // Do not clamp to a misleading frame zero.
  expect(peer.paused).toBe(true);
  expect(plays).toBe(1);
  primary.currentTime = 29;
  synchronizeRecordingPeer(primary, peer, 12.5, true);
  expect(plays).toBe(1);
  expect(pauses).toBe(3);
});

test("buffering holds the peer until primary playback resumes at the shared time", async () => {
  let plays = 0;
  const peer = { currentTime: 2.5, duration: 10, playbackRate: 1, paused: false,
    async play() { plays++; this.paused = false; }, pause() { this.paused = true; } };
  const primary = { ...peer, currentTime: 15, duration: 30, readyState: 2, seeking: false, ended: false };
  // A buffering video still reports paused=false, even before waiting is handled.
  synchronizeRecordingPeer(primary, peer, 12.5, true);
  expect(primary.paused).toBe(false);
  expect(peer.paused).toBe(true);
  expect(plays).toBe(0);

  primary.readyState = 4;
  primary.currentTime = 15.5;
  // Metadata/time updates cannot release the hold established by waiting.
  synchronizeRecordingPeer(primary, peer, 12.5, false);
  expect(peer.paused).toBe(true);
  expect(plays).toBe(0);
  await synchronizeRecordingPeer(primary, peer, 12.5, true);
  expect(peer.currentTime).toBe(3);
  expect(peer.paused).toBe(false);
  expect(plays).toBe(1);
});

test("seeking holds the peer and seek completion requires an advancing primary", async () => {
  let plays = 0;
  const peer = { currentTime: 2.5, duration: 10, playbackRate: 1, paused: false,
    async play() { plays++; this.paused = false; }, pause() { this.paused = true; } };
  const primary = { ...peer, currentTime: 18, duration: 30, readyState: 4, seeking: true, ended: false };
  synchronizeRecordingPeer(primary, peer, 12.5, true);
  expect(peer.currentTime).toBe(5.5);
  expect(peer.paused).toBe(true);
  primary.seeking = false;
  for (const state of [
    { readyState: 2, paused: false, ended: false },
    { readyState: 4, paused: true, ended: false },
    { readyState: 4, paused: false, ended: true },
  ]) {
    Object.assign(primary, state);
    synchronizeRecordingPeer(primary, peer, 12.5, true);
    expect(peer.paused).toBe(true);
    expect(plays).toBe(0);
  }
  Object.assign(primary, { readyState: 3, paused: false, ended: false, currentTime: 19 });
  await synchronizeRecordingPeer(primary, peer, 12.5, true);
  expect(peer.currentTime).toBe(6.5);
  expect(peer.paused).toBe(false);
  expect(plays).toBe(1);
});

test("holding a pending peer play tolerates cancellation but preserves playback errors", async () => {
  let rejectPlay: (error: Error) => void = () => {};
  const peer = { currentTime: 2.5, duration: 10, playbackRate: 1, paused: true,
    play() { this.paused = false; return new Promise<void>((_resolve, reject) => { rejectPlay = reject; }); },
    pause() { this.paused = true; rejectPlay(new DOMException("Playback was paused", "AbortError")); } };
  const primary = { ...peer, currentTime: 15, duration: 30, paused: false, readyState: 4, seeking: false, ended: false };
  const pending = synchronizeRecordingPeer(primary, peer, 12.5, true);
  primary.readyState = 2;
  synchronizeRecordingPeer(primary, peer, 12.5, false);
  await pending;
  expect(peer.paused).toBe(true);

  primary.readyState = 4;
  const denied = synchronizeRecordingPeer(primary, peer, 12.5, true);
  rejectPlay(new DOMException("Playback was denied", "NotAllowedError"));
  await expect(denied).rejects.toMatchObject({ name: "NotAllowedError" });
});
