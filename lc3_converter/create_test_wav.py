#!/usr/bin/env python3
"""
Create a simple test WAV file for testing LC3 conversion
Generates a 3-second 440Hz sine wave (A note) at 16kHz mono
"""

import math
import struct
import wave


def create_test_tone(output_path, frequency=440, duration=3, sample_rate=16000):
    """
    Create a simple sine wave test tone
    
    Args:
        output_path: Output WAV file path
        frequency: Tone frequency in Hz (default: 440 = A note)
        duration: Duration in seconds (default: 3)
        sample_rate: Sample rate in Hz (default: 16000)
    """
    num_samples = int(sample_rate * duration)
    
    # Generate sine wave samples
    samples = []
    for i in range(num_samples):
        # Calculate sample value (16-bit range: -32768 to 32767)
        t = i / sample_rate
        value = int(32767 * 0.5 * math.sin(2 * math.pi * frequency * t))
        samples.append(value)
    
    # Convert to bytes
    audio_data = struct.pack(f'<{len(samples)}h', *samples)
    
    # Write WAV file
    with wave.open(output_path, 'wb') as wav:
        wav.setnchannels(1)  # mono
        wav.setsampwidth(2)  # 16-bit
        wav.setframerate(sample_rate)
        wav.writeframes(audio_data)
    
    print(f"Created test WAV: {output_path}")
    print(f"  Frequency: {frequency} Hz")
    print(f"  Duration: {duration} seconds")
    print(f"  Sample rate: {sample_rate} Hz")
    print(f"  Samples: {num_samples}")


if __name__ == '__main__':
    import sys
    from pathlib import Path
    
    # Create test_audio directory if it doesn't exist
    test_dir = Path('test_audio')
    test_dir.mkdir(exist_ok=True)
    
    output_file = test_dir / 'sample.wav'
    create_test_tone(str(output_file))
    
    print(f"\nTest with:")
    print(f"  python audio_to_lc3.py {output_file} test.lc3")
    print(f"  python lc3_to_audio.py test.lc3 decoded.wav")

