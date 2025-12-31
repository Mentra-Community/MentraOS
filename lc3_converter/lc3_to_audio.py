#!/usr/bin/env python3
"""
LC3 to Audio Converter
Converts LC3 files back to WAV or MP3 audio files.

WAV output: Built-in (uses Python standard library)
MP3 output: Optional (requires pydub and ffmpeg)
"""

import argparse
import struct
import sys
import wave
from pathlib import Path

from lc3_wrapper import LC3Decoder, LC3Error


def read_lc3_file(filepath):
    """
    Read LC3 file with custom header format
    
    File format:
        Header (16 bytes):
            - Magic: "LC3\0" (4 bytes)
            - Version: 1 (4 bytes, little-endian)
            - Sample Rate: Hz (4 bytes, little-endian)
            - Frame Count: N (4 bytes, little-endian)
        Body:
            - LC3 frames (variable length)
    
    Args:
        filepath: Input LC3 file path
    
    Returns:
        tuple: (lc3_data, sample_rate, frame_count)
    """
    with open(filepath, 'rb') as f:
        # Read header
        magic = f.read(4)
        if magic != b'LC3\0':
            raise ValueError(f"Invalid LC3 file: bad magic bytes {magic!r}")
        
        version = struct.unpack('<I', f.read(4))[0]
        if version != 1:
            raise ValueError(f"Unsupported LC3 file version: {version}")
        
        sample_rate = struct.unpack('<I', f.read(4))[0]
        frame_count = struct.unpack('<I', f.read(4))[0]
        
        # Read LC3 data
        lc3_data = f.read()
        
        return lc3_data, sample_rate, frame_count


def write_wav(filepath, pcm_data, sample_rate=16000, channels=1, sample_width=2):
    """
    Write PCM data to WAV file
    
    Args:
        filepath: Output WAV file path
        pcm_data: Raw PCM data (bytes)
        sample_rate: Sample rate in Hz (default: 16000)
        channels: Number of channels (default: 1 for mono)
        sample_width: Bytes per sample (default: 2 for 16-bit)
    """
    with wave.open(str(filepath), 'wb') as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm_data)


def write_mp3(filepath, pcm_data, sample_rate=16000):
    """
    Write PCM data to MP3 file
    Requires pydub and ffmpeg
    
    Args:
        filepath: Output MP3 file path
        pcm_data: Raw PCM data (bytes)
        sample_rate: Sample rate in Hz (default: 16000)
    """
    try:
        from pydub import AudioSegment
    except ImportError:
        raise ImportError(
            "MP3 output requires pydub.\n"
            "Install it with: pip install pydub\n"
            "Also install ffmpeg on your system."
        )
    
    # Create AudioSegment from raw PCM
    audio = AudioSegment(
        data=pcm_data,
        sample_width=2,  # 16-bit
        frame_rate=sample_rate,
        channels=1  # mono
    )
    
    # Export as MP3
    audio.export(str(filepath), format='mp3', bitrate='128k')


def main():
    parser = argparse.ArgumentParser(
        description='Convert LC3 files back to audio (WAV/MP3)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s input.lc3 output.wav
  %(prog)s audio.lc3 audio.mp3

Notes:
  - WAV output works out of the box (no dependencies)
  - MP3 output requires: pip install pydub (and ffmpeg installed)
  - Decoded audio is always 16kHz mono
        """
    )
    
    parser.add_argument('input', type=Path, help='Input LC3 file')
    parser.add_argument('output', type=Path, help='Output audio file (WAV or MP3)')
    parser.add_argument('--frame-bytes', type=int, default=20,
                        help='LC3 frame size in bytes (default: 20)')
    
    args = parser.parse_args()
    
    # Check input file exists
    if not args.input.exists():
        print(f"Error: Input file not found: {args.input}")
        return 1
    
    # Determine output format
    out_ext = args.output.suffix.lower()
    
    if out_ext not in ['.wav', '.mp3']:
        print(f"Error: Unsupported output format: {out_ext}")
        print("Supported formats: .wav, .mp3")
        return 1
    
    try:
        # Read LC3 file
        print(f"Reading LC3 file: {args.input}")
        lc3_data, sample_rate, frame_count = read_lc3_file(args.input)
        
        lc3_size_kb = len(lc3_data) / 1024
        print(f"LC3 data: {frame_count} frames, {lc3_size_kb:.2f} KB, {sample_rate}Hz")
        
        # Validate frame count
        expected_size = frame_count * args.frame_bytes
        if len(lc3_data) != expected_size:
            print(f"Warning: LC3 data size mismatch")
            print(f"  Expected: {expected_size} bytes ({frame_count} × {args.frame_bytes})")
            print(f"  Actual: {len(lc3_data)} bytes")
            # Adjust frame count to actual data
            frame_count = len(lc3_data) // args.frame_bytes
            print(f"  Using: {frame_count} frames")
        
        # Initialize LC3 decoder
        print(f"\nInitializing LC3 decoder (10ms frames, {args.frame_bytes} bytes/frame)...")
        decoder = LC3Decoder(dt_us=10000, sr_hz=sample_rate, frame_bytes=args.frame_bytes)
        
        # Decode from LC3
        print("Decoding LC3 to PCM...")
        pcm_data = decoder.decode(lc3_data)
        
        num_samples = len(pcm_data) // 2  # 16-bit = 2 bytes per sample
        duration_sec = num_samples / sample_rate
        
        print(f"Decoded: {num_samples} samples, {duration_sec:.2f} seconds @ {sample_rate}Hz mono")
        
        # Write audio file
        print(f"\nWriting {out_ext.upper()} file: {args.output}")
        
        if out_ext == '.wav':
            write_wav(args.output, pcm_data, sample_rate)
        elif out_ext == '.mp3':
            write_mp3(args.output, pcm_data, sample_rate)
        
        print(f"\n✓ Conversion complete!")
        print(f"  Input:  {args.input} ({args.input.stat().st_size} bytes)")
        print(f"  Output: {args.output} ({out_ext.upper()})")
        
        return 0
        
    except LC3Error as e:
        print(f"\nLC3 Error: {e}")
        return 1
    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    sys.exit(main())

