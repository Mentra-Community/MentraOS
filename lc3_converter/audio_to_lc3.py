#!/usr/bin/env python3
"""
Audio to LC3 Converter
Converts WAV or MP3 audio files to LC3 format.

WAV support: Built-in (uses Python standard library)
MP3 support: Optional (requires pydub and ffmpeg)
"""

import argparse
import struct
import sys
import wave
from pathlib import Path

from lc3_wrapper import LC3Encoder, LC3Error


def load_wav(filepath):
    """
    Load WAV file and convert to 16kHz mono PCM
    
    Args:
        filepath: Path to WAV file
    
    Returns:
        tuple: (pcm_data as bytes, original_sample_rate)
    """
    with wave.open(str(filepath), 'rb') as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        framerate = wav.getframerate()
        n_frames = wav.getnframes()
        
        print(f"Input WAV: {channels}ch, {framerate}Hz, {sample_width*8}bit, {n_frames} frames")
        
        # Read all frames
        audio_data = wav.readframes(n_frames)
        
        # Convert to 16-bit samples
        if sample_width == 2:
            # Already 16-bit
            samples = list(struct.unpack(f'<{n_frames * channels}h', audio_data))
        elif sample_width == 1:
            # 8-bit to 16-bit
            samples = [(b - 128) * 256 for b in audio_data]
        elif sample_width == 3:
            # 24-bit to 16-bit (take upper 16 bits)
            samples = []
            for i in range(0, len(audio_data), 3):
                val = int.from_bytes(audio_data[i:i+3], 'little', signed=True)
                samples.append(val >> 8)
        else:
            raise ValueError(f"Unsupported sample width: {sample_width} bytes")
        
        # Convert to mono if stereo
        if channels == 2:
            mono_samples = []
            for i in range(0, len(samples), 2):
                # Average left and right channels
                mono_samples.append((samples[i] + samples[i+1]) // 2)
            samples = mono_samples
        elif channels > 2:
            # Take first channel only for multi-channel
            samples = samples[::channels]
        
        # Resample to 16kHz if needed
        if framerate != 16000:
            samples = simple_resample(samples, framerate, 16000)
            print(f"Resampled: {framerate}Hz → 16000Hz")
        
        # Convert back to bytes
        pcm_data = struct.pack(f'<{len(samples)}h', *samples)
        
        return pcm_data, framerate


def simple_resample(samples, old_rate, new_rate):
    """
    Simple linear interpolation resampling
    
    Args:
        samples: List of audio samples
        old_rate: Original sample rate
        new_rate: Target sample rate
    
    Returns:
        List of resampled samples
    """
    if old_rate == new_rate:
        return samples
    
    ratio = old_rate / new_rate
    new_length = int(len(samples) / ratio)
    resampled = []
    
    for i in range(new_length):
        # Linear interpolation
        pos = i * ratio
        idx = int(pos)
        frac = pos - idx
        
        if idx + 1 < len(samples):
            sample = int(samples[idx] * (1 - frac) + samples[idx + 1] * frac)
        else:
            sample = samples[idx]
        
        resampled.append(sample)
    
    return resampled


def load_mp3(filepath):
    """
    Load MP3 file and convert to 16kHz mono PCM
    Requires pydub and ffmpeg
    
    Args:
        filepath: Path to MP3 file
    
    Returns:
        tuple: (pcm_data as bytes, original_sample_rate)
    """
    try:
        from pydub import AudioSegment
    except ImportError:
        raise ImportError(
            "MP3 support requires pydub.\n"
            "Install it with: pip install pydub\n"
            "Also install ffmpeg on your system."
        )
    
    # Load MP3
    audio = AudioSegment.from_mp3(str(filepath))
    
    print(f"Input MP3: {audio.channels}ch, {audio.frame_rate}Hz, {len(audio)}ms")
    
    # Convert to mono 16kHz 16-bit
    audio = audio.set_channels(1)  # mono
    audio = audio.set_frame_rate(16000)  # 16kHz
    audio = audio.set_sample_width(2)  # 16-bit
    
    # Get raw PCM data
    pcm_data = audio.raw_data
    
    return pcm_data, audio.frame_rate


def write_lc3_file(filepath, lc3_data, sample_rate, num_frames):
    """
    Write LC3 file with custom header format
    
    File format:
        Header (16 bytes):
            - Magic: "LC3\0" (4 bytes)
            - Version: 1 (4 bytes, little-endian)
            - Sample Rate: Hz (4 bytes, little-endian)
            - Frame Count: N (4 bytes, little-endian)
        Body:
            - LC3 frames (variable length)
    
    Args:
        filepath: Output file path
        lc3_data: Encoded LC3 data (bytes)
        sample_rate: Audio sample rate
        num_frames: Number of LC3 frames
    """
    with open(filepath, 'wb') as f:
        # Write header
        f.write(b'LC3\0')  # Magic
        f.write(struct.pack('<I', 1))  # Version
        f.write(struct.pack('<I', sample_rate))  # Sample rate
        f.write(struct.pack('<I', num_frames))  # Frame count
        
        # Write LC3 data
        f.write(lc3_data)


def main():
    parser = argparse.ArgumentParser(
        description='Convert audio files (WAV/MP3) to LC3 format',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s input.wav output.lc3
  %(prog)s music.mp3 music.lc3

Notes:
  - WAV files work out of the box (no dependencies)
  - MP3 files require: pip install pydub (and ffmpeg installed)
  - Output is always 16kHz mono LC3 at ~16kbps
        """
    )
    
    parser.add_argument('input', type=Path, help='Input audio file (WAV or MP3)')
    parser.add_argument('output', type=Path, help='Output LC3 file')
    parser.add_argument('--frame-bytes', type=int, default=20,
                        help='LC3 frame size in bytes (default: 20 for 16kbps)')
    
    args = parser.parse_args()
    
    # Check input file exists
    if not args.input.exists():
        print(f"Error: Input file not found: {args.input}")
        return 1
    
    # Determine input format
    ext = args.input.suffix.lower()
    
    try:
        # Load audio file
        print(f"Loading {ext.upper()} file: {args.input}")
        
        if ext == '.wav':
            pcm_data, orig_rate = load_wav(args.input)
        elif ext == '.mp3':
            pcm_data, orig_rate = load_mp3(args.input)
        else:
            print(f"Error: Unsupported file format: {ext}")
            print("Supported formats: .wav, .mp3")
            return 1
        
        # Show PCM stats
        num_samples = len(pcm_data) // 2  # 16-bit = 2 bytes per sample
        duration_sec = num_samples / 16000
        print(f"PCM data: {num_samples} samples, {duration_sec:.2f} seconds @ 16kHz mono")
        
        # Initialize LC3 encoder
        print(f"\nInitializing LC3 encoder (10ms frames, {args.frame_bytes} bytes/frame)...")
        encoder = LC3Encoder(dt_us=10000, sr_hz=16000, frame_bytes=args.frame_bytes)
        
        # Encode to LC3
        print("Encoding to LC3...")
        lc3_data = encoder.encode(pcm_data)
        
        num_frames = len(lc3_data) // args.frame_bytes
        lc3_size_kb = len(lc3_data) / 1024
        bitrate_kbps = (len(lc3_data) * 8) / duration_sec / 1000
        
        print(f"Encoded: {num_frames} frames, {lc3_size_kb:.2f} KB, {bitrate_kbps:.1f} kbps")
        
        # Write LC3 file
        print(f"\nWriting LC3 file: {args.output}")
        write_lc3_file(args.output, lc3_data, 16000, num_frames)
        
        print(f"\n✓ Conversion complete!")
        print(f"  Input:  {args.input} ({ext.upper()})")
        print(f"  Output: {args.output} ({args.output.stat().st_size} bytes)")
        
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

