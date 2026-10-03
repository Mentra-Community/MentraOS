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
      expect(nacl.secretbox.open(packet.subarray(30), packet.subarray(6, 30), key)).toEqual(
        payload,
      );
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
