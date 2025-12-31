# Output Directory

This directory contains the output files from LC3 conversion operations.

## Directory Structure

- `lc3/` - Encoded LC3 files (compressed audio)
- `decoded/` - Decoded audio files (WAV/MP3 from LC3)

## Usage

When running the converter scripts, save outputs to these directories:

```bash
# Encode to LC3
python3 audio_to_lc3.py input.wav output/lc3/output.lc3

# Decode to WAV
python3 lc3_to_audio.py output/lc3/output.lc3 output/decoded/decoded.wav
```

Files in these directories are git-ignored.
