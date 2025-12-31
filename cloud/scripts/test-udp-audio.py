#!/usr/bin/env python3
"""
UDP Audio Test Script

Sends mock sine wave audio data to the UDP LoadBalancer to test the audio path.
Uses the same packet format as the mobile client.

Usage:
    python3 cloud/scripts/test-udp-audio.py
    python3 cloud/scripts/test-udp-audio.py --user "someone@example.com"
    python3 cloud/scripts/test-udp-audio.py --host 172.168.226.103 --chunks 20
"""

import argparse
import math
import socket
import struct
import time


def fnv1a_hash(s: str) -> int:
    """
    Compute FNV-1a hash of a string (32-bit, unsigned)
    Uses UTF-8 byte encoding to match server-side implementation
    """
    FNV_PRIME = 0x01000193
    hash_val = 0x811C9DC5

    for byte in s.encode("utf-8"):
        hash_val ^= byte
        hash_val = (hash_val * FNV_PRIME) & 0xFFFFFFFF

    return hash_val


def generate_sine_wave(
    freq: float,
    sample_rate: int,
    num_samples: int,
    amplitude: int,
    start_sample: int = 0,
) -> bytes:
    """
    Generate PCM16 sine wave samples
    """
    samples = []
    for i in range(num_samples):
        t = (start_sample + i) / sample_rate
        sample = int(amplitude * math.sin(2 * math.pi * freq * t))
        # Clamp to int16 range
        sample = max(-32768, min(32767, sample))
        samples.append(sample)

    # Pack as PCM16 little-endian (standard for audio)
    return struct.pack(f"<{len(samples)}h", *samples)


def send_audio_packet(
    sock: socket.socket,
    host: str,
    port: int,
    user_id_hash: int,
    seq: int,
    pcm_data: bytes,
) -> None:
    """
    Send a UDP audio packet with the expected format:
    - Bytes 0-3: userIdHash (big-endian)
    - Bytes 4-5: sequence number (big-endian)
    - Bytes 6+: PCM audio data
    """
    header = struct.pack(">I", user_id_hash) + struct.pack(">H", seq & 0xFFFF)
    packet = header + pcm_data
    sock.sendto(packet, (host, port))


def send_ping(sock: socket.socket, host: str, port: int, user_id_hash: int) -> None:
    """
    Send a UDP ping packet
    """
    header = struct.pack(">I", user_id_hash) + struct.pack(">H", 0)
    packet = header + b"PING"
    sock.sendto(packet, (host, port))


def main():
    parser = argparse.ArgumentParser(description="Test UDP audio path")
    parser.add_argument(
        "--host",
        default="172.168.226.103",
        help="UDP LoadBalancer host (default: 172.168.226.103)",
    )
    parser.add_argument(
        "--port", type=int, default=8000, help="UDP port (default: 8000)"
    )
    parser.add_argument(
        "--user",
        default="israelov+test68@mentra.glass",
        help="User ID to simulate (default: israelov+test68@mentra.glass)",
    )
    parser.add_argument(
        "--chunks",
        type=int,
        default=50,
        help="Number of audio chunks to send (default: 50, ~1 second of audio at 20ms chunks)",
    )
    parser.add_argument(
        "--freq",
        type=float,
        default=440.0,
        help="Sine wave frequency in Hz (default: 440)",
    )
    parser.add_argument(
        "--ping-only", action="store_true", help="Only send ping, no audio"
    )
    parser.add_argument("--no-ping", action="store_true", help="Skip initial ping")

    args = parser.parse_args()

    # Config
    SAMPLE_RATE = 16000  # 16kHz
    # Use 20ms chunks (320 samples = 640 bytes PCM) to stay well under MTU (~1472 bytes)
    # Larger packets (e.g., 100ms = 3200 bytes) get fragmented and may be lost
    CHUNK_DURATION_MS = 20  # 20ms chunks
    SAMPLES_PER_CHUNK = int(SAMPLE_RATE * CHUNK_DURATION_MS / 1000)  # 320 samples
    AMPLITUDE = 16000  # ~50% of int16 max

    user_id_hash = fnv1a_hash(args.user)

    print("=" * 60)
    print("UDP Audio Test")
    print("=" * 60)
    print(f"User ID:       {args.user}")
    print(f"User ID Hash:  {user_id_hash} (0x{user_id_hash:08x})")
    print(f"UDP Target:    {args.host}:{args.port}")
    print(f"Sample Rate:   {SAMPLE_RATE} Hz")
    print(
        f"Chunk Size:    {SAMPLES_PER_CHUNK} samples ({CHUNK_DURATION_MS}ms, {SAMPLES_PER_CHUNK * 2} bytes)"
    )
    print(f"Frequency:     {args.freq} Hz")
    print(f"Chunks:        {args.chunks}")
    print("=" * 60)
    print()

    # Create UDP socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2.0)

    try:
        # Send ping first (unless --no-ping)
        if not args.no_ping:
            print("Sending ping...")
            send_ping(sock, args.host, args.port, user_id_hash)
            print("  Ping sent!")
            time.sleep(0.1)

        if args.ping_only:
            print("\n--ping-only specified, skipping audio.")
            return

        # Send audio chunks
        print(f"\nSending {args.chunks} audio chunks...")

        for seq in range(args.chunks):
            # Generate sine wave for this chunk
            start_sample = seq * SAMPLES_PER_CHUNK
            pcm_data = generate_sine_wave(
                freq=args.freq,
                sample_rate=SAMPLE_RATE,
                num_samples=SAMPLES_PER_CHUNK,
                amplitude=AMPLITUDE,
                start_sample=start_sample,
            )

            # Send packet
            send_audio_packet(sock, args.host, args.port, user_id_hash, seq, pcm_data)

            packet_size = 6 + len(pcm_data)  # header + pcm
            print(
                f"  Chunk {seq:3d}: {packet_size} bytes (seq={seq}, pcm={len(pcm_data)} bytes)"
            )

            # Wait between chunks (simulate real-time)
            time.sleep(CHUNK_DURATION_MS / 1000.0)

        print()
        print("=" * 60)
        print("Done!")
        print()
        print("Check server health endpoint:")
        print(f"  curl -s https://debug.augmentos.cloud/health | python3 -m json.tool")
        print()
        print("Expected: 'received' count should increase by", args.chunks)
        print("=" * 60)

    finally:
        sock.close()


if __name__ == "__main__":
    main()
