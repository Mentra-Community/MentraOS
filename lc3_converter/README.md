# LC3 Audio Converter

Python tools for converting audio files to/from LC3 (Low Complexity Communication Codec) format using the MentraOS LC3 C library.

## Features

- **WAV Support** - Works out of the box with Python standard library (no external dependencies)
- **MP3 Support** - Optional support with pydub + ffmpeg
- **High Quality** - Uses Google's LC3 reference implementation
- **Simple CLI** - Easy command-line interface for batch processing

## Quick Start

### 1. Build the LC3 Library

```bash
./build.sh
```

This compiles the LC3 C library into a shared library (`liblc3.so` on Linux, `liblc3.dylib` on macOS).

### 2. Convert Audio Files

**WAV to LC3 (no dependencies needed):**

```bash
python audio_to_lc3.py input.wav output/lc3/output.lc3
```

**LC3 back to WAV:**

```bash
python lc3_to_audio.py output/lc3/output.lc3 output/decoded/decoded.wav
```

**MP3 to LC3 (requires pydub):**

```bash
# Install optional MP3 support
pip install -r requirements.txt

# Convert MP3
python audio_to_lc3.py music.mp3 output/lc3/music.lc3
python lc3_to_audio.py output/lc3/music.lc3 output/decoded/music.mp3
```

## Installation

### Core Requirements

- **Python 3.7+** - Standard library only for WAV support
- **C Compiler** - gcc or clang to build the LC3 library
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: gcc (`sudo apt-get install build-essential`)

### Optional: MP3 Support

```bash
# Install Python package
pip install -r requirements.txt

# Install ffmpeg (system dependency)
# macOS:
brew install ffmpeg

# Ubuntu/Debian:
sudo apt-get install ffmpeg

# Fedora:
sudo dnf install ffmpeg
```

## Usage

### Encoding: Audio → LC3

```bash
python audio_to_lc3.py [OPTIONS] INPUT OUTPUT
```

**Options:**

- `--frame-bytes N` - LC3 frame size in bytes (default: 20 for ~16kbps)

**Examples:**

```bash
# WAV to LC3 (default 16kbps)
python audio_to_lc3.py speech.wav output/lc3/speech.lc3

# Higher quality (32kbps)
python audio_to_lc3.py music.wav output/lc3/music.lc3 --frame-bytes 40

# MP3 to LC3
python audio_to_lc3.py podcast.mp3 output/lc3/podcast.lc3
```

### Decoding: LC3 → Audio

```bash
python lc3_to_audio.py [OPTIONS] INPUT OUTPUT
```

**Options:**

- `--frame-bytes N` - LC3 frame size in bytes (must match encoding)

**Examples:**

```bash
# LC3 to WAV
python lc3_to_audio.py output/lc3/speech.lc3 output/decoded/speech.wav

# LC3 to MP3
python lc3_to_audio.py output/lc3/music.lc3 output/decoded/music.mp3
```

## Technical Details

### LC3 Parameters

The converter uses parameters matching MentraOS smart glasses:

- **Sample Rate**: 16 kHz (fixed)
- **Channels**: Mono (fixed)
- **Frame Duration**: 10 ms
- **Frame Size**: 20 bytes (default) = ~16 kbps bitrate
- **PCM Format**: 16-bit signed integer

### Bitrate Calculation

Bitrate = (frame_bytes × 8 bits) / (frame_duration_ms / 1000)

Examples:

- 20 bytes/frame @ 10ms = 16 kbps
- 40 bytes/frame @ 10ms = 32 kbps

### LC3 File Format

Custom binary format for testing:

```
Header (16 bytes):
  [0-3]   Magic: "LC3\0"
  [4-7]   Version: 1 (uint32 little-endian)
  [8-11]  Sample Rate: 16000 Hz (uint32 little-endian)
  [12-15] Frame Count: N (uint32 little-endian)

Body:
  [16+]   LC3 frames (frame_bytes × frame_count)
```

## Architecture

### Why Each Component?

**LC3 C Library** (via ctypes):

- Handles only: PCM ⟷ LC3 conversion
- Does NOT handle: MP3 or WAV file formats

**Python `wave` module**:

- Handles: WAV file I/O (header parsing + PCM extraction)
- Built into Python standard library

**pydub + ffmpeg** (optional):

- Handles: MP3 ⟷ PCM conversion
- MP3 is a completely different codec from LC3

### Conversion Pipeline

```
WAV File → [wave module] → PCM → [LC3 C] → LC3 File
LC3 File → [LC3 C] → PCM → [wave module] → WAV File

MP3 File → [pydub] → PCM → [LC3 C] → LC3 File
LC3 File → [LC3 C] → PCM → [pydub] → MP3 File
```

## Testing

### Test the LC3 Wrapper

```bash
python lc3_wrapper.py
```

Should output:

```
LC3 Wrapper Test
--------------------------------------------------
Frame duration: 10000 μs (10.0 ms)
Sample rate: 16000 Hz
Frame samples: 160
Encoder size: XXXX bytes
Decoder size: XXXX bytes

✓ LC3 library loaded successfully!
```

### Rebuild Library

```bash
make clean
make
```

### Test with Sample Audio

```bash
# Create a test tone WAV file
python create_test_wav.py

# Convert WAV → LC3 → WAV
python audio_to_lc3.py test_audio/sample.wav output/lc3/test.lc3
python lc3_to_audio.py output/lc3/test.lc3 output/decoded/decoded.wav

# Compare files (original vs decoded)
ls -lh test_audio/sample.wav output/lc3/test.lc3 output/decoded/decoded.wav
```

## Troubleshooting

### "LC3 library not found"

Make sure you've built the library:

```bash
./build.sh
```

The library should be in `lib/liblc3.so` (Linux) or `lib/liblc3.dylib` (macOS).

### "MP3 support requires pydub"

MP3 is optional. Either:

1. Use WAV files instead (works without dependencies)
2. Install MP3 support: `pip install -r requirements.txt` + install ffmpeg

### "No C compiler found"

Install build tools:

- **macOS**: `xcode-select --install`
- **Ubuntu/Debian**: `sudo apt-get install build-essential`
- **Fedora**: `sudo dnf install gcc make`

## Project Structure

```
lc3_converter/
├── README.md                 # This file
├── Makefile                  # Build LC3 library
├── build.sh                  # Build script
├── requirements.txt          # Optional Python dependencies
│
├── lib/                      # Compiled library output
│   └── liblc3.so / .dylib
│
├── src/                      # LC3 C sources (symlinks)
│   ├── include/
│   │   └── lc3.h
│   └── liblc3/
│       └── *.c
│
├── lc3_wrapper.py           # Python ctypes bindings
├── audio_to_lc3.py          # Encoder (audio → LC3)
├── lc3_to_audio.py          # Decoder (LC3 → audio)
├── create_test_wav.py       # Test WAV generator
│
├── test_audio/              # Input test files
│   └── sample.wav
│
└── output/                  # Output files (git-ignored)
    ├── lc3/                 # Encoded LC3 files
    └── decoded/             # Decoded audio files
```

## Credits

- **LC3 Codec**: Google LLC ([Bluetooth SIG LC3 Specification](https://www.bluetooth.com/specifications/specs/low-complexity-communication-codec-1-0/))
- **MentraOS Integration**: Uses the same LC3 implementation as MentraOS smart glasses

## License

The LC3 codec implementation is licensed under Apache 2.0 by Google LLC.
See the original license in `mobile/modules/core/android/lc3Lib/` of the MentraOS repository.
