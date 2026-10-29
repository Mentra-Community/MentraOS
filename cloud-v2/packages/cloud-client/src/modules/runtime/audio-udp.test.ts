import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { UdpAudio } from "./audio-udp";
import type { ConnectionAck } from "@mentra/cloud-protocol";

const key = new Uint8Array(32).fill(7);
const config: NonNullable<ConnectionAck["audio"]> = {
  sessionTag: 123,
  udp: { host: "audio.example.test", port: 8000 },
  encryption: { key: Buffer.from(key).toString("base64"), algorithm: "xsalsa20-poly1305" },
};

describe("UDP route reset", () => {
  test("negotiated audio positions are encrypted, survive WS fallback and exclude probes", () => {
    const packets: Uint8Array[] = [];
    const audio = new UdpAudio({
      audio: { codec: "lc3", sampleRate: 16000, frameSizeBytes: 20 },
      udp: () => ({
        send: (bytes) => {
          packets.push(bytes);
        },
        close() {},
        onMessage() {},
      }),
    });
    audio.configure({ ...config, frameTimelineVersion: 1 });
    audio.sendFrame(new Uint8Array(20).fill(4));
    const packet = packets[0]!;
    const plain = nacl.secretbox.open(
      packet.subarray(30),
      packet.subarray(6, 30),
      key,
    )!;
    expect(
      new DataView(plain.buffer, plain.byteOffset).getFloat64(0, false),
    ).toBe(0);
    expect(plain.subarray(8)).toEqual(new Uint8Array(20).fill(4));
    audio.sendProbe("test");
    expect(audio.audioPosition).toEqual({ sessionTag: 123, offsetMs: 10 });
    audio.resetSocket();
    const wsPacket = audio.buildPlainFrame(new Uint8Array(40))!;
    expect(new DataView(wsPacket.buffer).getFloat64(6, false)).toBe(10);
    expect(audio.audioPosition?.offsetMs).toBe(30);
    audio.configure({ ...config, sessionTag: 456, frameTimelineVersion: 1 });
    expect(audio.audioPosition).toEqual({ sessionTag: 456, offsetMs: 0 });
  });

  test("an older server retains the original audio packet layout", () => {
    const audio = new UdpAudio({
      udp: () => ({ send() {}, close() {}, onMessage() {} }),
    });
    audio.configure(config);
    const payload = new Uint8Array([1, 2, 3]);
    expect(audio.buildPlainFrame(payload)?.subarray(6)).toEqual(payload);
    expect(audio.audioPosition).toBeNull();
  });
  test("replaces only the socket and preserves encrypted payload, session tag and sequence", () => {
    const sockets: { packets: Uint8Array[]; closed: number }[] = [];
    const audio = new UdpAudio({
      udp: () => {
        const state = { packets: [] as Uint8Array[], closed: 0 };
        sockets.push(state);
        return {
          send(bytes, host, port) {
            expect(host).toBe(config.udp.host);
            expect(port).toBe(config.udp.port);
            state.packets.push(bytes);
          },
          close() {
            state.closed++;
          },
          onMessage() {},
        };
      },
    });
    audio.resetSocket();
    expect(sockets).toHaveLength(0);
    audio.configure(config);
    const payload = new Uint8Array([0, 255, 128, 42]);
    audio.sendFrame(payload);
    audio.resetSocket();
    audio.sendFrame(payload);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(1);
    expect(sockets.map((socket) => socket.packets.length)).toEqual([1, 1]);
    for (let i = 0; i < 2; i++) {
      const packet = sockets[i]!.packets[0]!;
      const header = new DataView(packet.buffer, packet.byteOffset);
      expect(header.getUint32(0)).toBe(config.sessionTag);
      expect(header.getUint16(4)).toBe(i);
      expect(
        nacl.secretbox.open(packet.subarray(30), packet.subarray(6, 30), key),
      ).toEqual(payload);
    }
    expect(sockets[0]!.packets[0]!.subarray(6, 30)).not.toEqual(
      sockets[1]!.packets[0]!.subarray(6, 30),
    );
    audio.close();
    audio.resetSocket();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.closed).toBe(1);
    expect(audio.sendFrame(payload)).toBe(false);
  });
});
