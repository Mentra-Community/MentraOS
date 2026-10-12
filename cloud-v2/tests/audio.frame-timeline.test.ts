import {expect, spyOn, test} from "bun:test";
import * as redisClient from "../packages/runtime/src/clients/redis.client";
import {UdpAudio} from "../packages/cloud-client/src/modules/runtime/audio-udp";
import {enableSessionFrameTimeline, ingestAudioPacket, parseAudioPacket} from "../packages/runtime/src/services/session/stream";
import {negotiatedFrameTimeline} from "../packages/runtime/src/services/session/frame-timeline";

test("negotiated positions survive encrypted UDP, remote Redis ingress and WS fallback", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const record = {mentraUserId: "u", audioSessionId: "a", encryptionKeyB64: key};
  let stored = JSON.stringify(record);
  const writes: string[][] = [];
  const fake = {
    get: async () => stored,
    set: async (_key: string, value: string) => {stored = value; return "OK"},
    xadd: async (...fields: string[]) => {writes.push(fields); return "1-0"},
  };
  const mock = spyOn(redisClient, "getRedis").mockReturnValue(fake as never);
  const sent: Uint8Array[] = [];
  const audio = new UdpAudio({
    audio: {codec: "pcm", sampleRate: 16000},
    udp: () => ({send: (packet) => {sent.push(packet)}, close() {}, onMessage() {}}),
  });
  try {
    await enableSessionFrameTimeline(9, "a");
    audio.configure({sessionTag: 9, frameTimelineVersion: 1,
      udp: {host: "test", port: 1}, encryption: {key, algorithm: "xsalsa20-poly1305"}});
    audio.sendFrame(new Uint8Array(320).fill(4));
    expect(await ingestAudioPacket(parseAudioPacket(sent[0]!)!, () => undefined, {encrypted: true}))
      .toMatchObject({ok: true, origin: "redis", payloadLen: 320});
    const ws = audio.buildPlainFrame(new Uint8Array(320).fill(5))!;
    expect(await ingestAudioPacket(parseAudioPacket(ws)!, () => ({...record, frameTimelineVersion: 1})))
      .toMatchObject({ok: true, origin: "local", payloadLen: 320});
    const fields = writes.map((args) => Object.fromEntries(Array.from({length: (args.length - 5) / 2}, (_, i) => [args[5 + i * 2], args[6 + i * 2]])));
    expect(fields.map((f) => f.offsetMs)).toEqual(["0", "10"]);
    expect(fields.map((f) => Buffer.from(f.payload!, "base64"))).toEqual([Buffer.alloc(320, 4), Buffer.alloc(320, 5)]);
    audio.sendProbe("probe");
    expect(await ingestAudioPacket(parseAudioPacket(sent[1]!)!, () => undefined, {encrypted: true}))
      .toMatchObject({kind: "probe", probeId: "probe"});
    expect(writes).toHaveLength(2);
    expect(await ingestAudioPacket({sessionTag: 9, sequence: 4, payload: new Uint8Array(7)}, () => ({...record, frameTimelineVersion: 1})))
      .toMatchObject({ok: false});
    fake.set = async () => null as never;
    await expect(enableSessionFrameTimeline(9, "a")).rejects.toThrow("expired during init");
  } finally {
    audio.close();
    mock.mockRestore();
  }
});

test("legacy audio ingress keeps payload bytes and does not invent a position", async () => {
  const writes: string[][] = [];
  const mock = spyOn(redisClient, "getRedis").mockReturnValue({xadd: async (...fields: string[]) => {writes.push(fields); return "1-0"}} as never);
  try {
    const payload = new Uint8Array(20).fill(3);
    expect(await ingestAudioPacket({sessionTag: 1, sequence: 0, payload}, () => ({mentraUserId: "u", audioSessionId: "a"})))
      .toMatchObject({ok: true, payloadLen: 20});
    expect(writes[0]?.at(-3)).toBe("");
    expect(Buffer.from(writes[0]!.at(-1)!, "base64")).toEqual(Buffer.from(payload));
  } finally {mock.mockRestore()}
});

test("mixed-version rollout keeps old ingress and workers on legacy PCM until activation", async () => {
  const previous = process.env.AUDIO_FRAME_TIMELINE_ENABLED;
  delete process.env.AUDIO_FRAME_TIMELINE_ENABLED;
  const sent: Uint8Array[] = [];
  const audio = new UdpAudio({udp: () => ({send: (packet) => {sent.push(packet)}, close() {}, onMessage() {}})});
  try {
    audio.configure({sessionTag: 1, frameTimelineVersion: negotiatedFrameTimeline(1), udp: {host: "test", port: 1},
      encryption: {key: Buffer.alloc(32).toString("base64"), algorithm: "xsalsa20-poly1305"}});
    const pcm = new Uint8Array(320).fill(2);
    const packet = audio.buildPlainFrame(pcm)!;
    // The prior reader treats everything after the six-byte header as audio.
    expect(parseAudioPacket(packet)?.payload).toEqual(pcm);
    expect(audio.audioPosition).toBeNull();
  } finally {
    audio.close();
    if (previous === undefined) delete process.env.AUDIO_FRAME_TIMELINE_ENABLED;
    else process.env.AUDIO_FRAME_TIMELINE_ENABLED = previous;
  }
});
