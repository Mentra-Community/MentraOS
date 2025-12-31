"""
LC3 Codec Python Wrapper
Uses ctypes to interface with the LC3 C library for audio encoding/decoding.
"""

import ctypes
import os
import platform
from pathlib import Path


class LC3Error(Exception):
    """Exception raised for LC3 codec errors"""
    pass


class LC3Wrapper:
    """Python wrapper for LC3 C library using ctypes"""
    
    # LC3 PCM format constants (from lc3.h enum lc3_pcm_format)
    LC3_PCM_FORMAT_S16 = 0
    LC3_PCM_FORMAT_S24 = 1
    LC3_PCM_FORMAT_S24_3LE = 2
    LC3_PCM_FORMAT_FLOAT = 3
    
    def __init__(self, lib_path=None):
        """
        Initialize LC3 wrapper and load the shared library
        
        Args:
            lib_path: Optional path to liblc3 shared library
        """
        if lib_path is None:
            lib_path = self._find_library()
        
        self.lib = ctypes.CDLL(lib_path)
        self._setup_functions()
    
    def _find_library(self):
        """Find the LC3 shared library"""
        script_dir = Path(__file__).parent
        lib_dir = script_dir / 'lib'
        
        # Determine library extension based on platform
        if platform.system() == 'Darwin':
            lib_name = 'liblc3.dylib'
        elif platform.system() == 'Linux':
            lib_name = 'liblc3.so'
        else:
            raise LC3Error(f"Unsupported platform: {platform.system()}")
        
        lib_path = lib_dir / lib_name
        
        if not lib_path.exists():
            raise LC3Error(
                f"LC3 library not found at {lib_path}\n"
                f"Please run './build.sh' to build the library first."
            )
        
        return str(lib_path)
    
    def _setup_functions(self):
        """Setup ctypes function signatures for LC3 C API"""
        
        # int lc3_frame_samples(int dt_us, int sr_hz)
        self.lib.lc3_frame_samples.argtypes = [ctypes.c_int, ctypes.c_int]
        self.lib.lc3_frame_samples.restype = ctypes.c_int
        
        # unsigned lc3_encoder_size(int dt_us, int sr_hz)
        self.lib.lc3_encoder_size.argtypes = [ctypes.c_int, ctypes.c_int]
        self.lib.lc3_encoder_size.restype = ctypes.c_uint
        
        # lc3_encoder_t lc3_setup_encoder(int dt_us, int sr_hz, int sr_pcm_hz, void *mem)
        self.lib.lc3_setup_encoder.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p
        ]
        self.lib.lc3_setup_encoder.restype = ctypes.c_void_p
        
        # int lc3_encode(lc3_encoder_t encoder, enum lc3_pcm_format fmt,
        #                const void *pcm, int stride, int nbytes, void *out)
        self.lib.lc3_encode.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
            ctypes.c_int, ctypes.c_int, ctypes.c_void_p
        ]
        self.lib.lc3_encode.restype = ctypes.c_int
        
        # unsigned lc3_decoder_size(int dt_us, int sr_hz)
        self.lib.lc3_decoder_size.argtypes = [ctypes.c_int, ctypes.c_int]
        self.lib.lc3_decoder_size.restype = ctypes.c_uint
        
        # lc3_decoder_t lc3_setup_decoder(int dt_us, int sr_hz, int sr_pcm_hz, void *mem)
        self.lib.lc3_setup_decoder.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p
        ]
        self.lib.lc3_setup_decoder.restype = ctypes.c_void_p
        
        # int lc3_decode(lc3_decoder_t decoder, const void *in, int nbytes,
        #                enum lc3_pcm_format fmt, void *pcm, int stride)
        self.lib.lc3_decode.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int,
            ctypes.c_int, ctypes.c_void_p, ctypes.c_int
        ]
        self.lib.lc3_decode.restype = ctypes.c_int
    
    def frame_samples(self, dt_us, sr_hz):
        """
        Get number of PCM samples in a frame
        
        Args:
            dt_us: Frame duration in microseconds (7500 or 10000)
            sr_hz: Sample rate in Hz (8000, 16000, 24000, 32000, or 48000)
        
        Returns:
            Number of PCM samples per frame
        """
        result = self.lib.lc3_frame_samples(dt_us, sr_hz)
        if result < 0:
            raise LC3Error(f"Invalid parameters: dt_us={dt_us}, sr_hz={sr_hz}")
        return result
    
    def encoder_size(self, dt_us, sr_hz):
        """Get required memory size for encoder"""
        return self.lib.lc3_encoder_size(dt_us, sr_hz)
    
    def decoder_size(self, dt_us, sr_hz):
        """Get required memory size for decoder"""
        return self.lib.lc3_decoder_size(dt_us, sr_hz)


class LC3Encoder:
    """LC3 audio encoder"""
    
    def __init__(self, dt_us=10000, sr_hz=16000, frame_bytes=20):
        """
        Initialize LC3 encoder
        
        Args:
            dt_us: Frame duration in microseconds (default: 10000 = 10ms)
            sr_hz: Sample rate in Hz (default: 16000)
            frame_bytes: Target frame size in bytes (default: 20)
        """
        self.wrapper = LC3Wrapper()
        self.dt_us = dt_us
        self.sr_hz = sr_hz
        self.frame_bytes = frame_bytes
        
        # Get encoder parameters
        self.frame_samples = self.wrapper.frame_samples(dt_us, sr_hz)
        encoder_size = self.wrapper.encoder_size(dt_us, sr_hz)
        
        # Allocate encoder memory
        self.encoder_mem = ctypes.create_string_buffer(encoder_size)
        
        # Setup encoder (sr_pcm_hz=0 means use sr_hz)
        self.encoder = self.wrapper.lib.lc3_setup_encoder(
            dt_us, sr_hz, 0, ctypes.cast(self.encoder_mem, ctypes.c_void_p)
        )
        
        if not self.encoder:
            raise LC3Error("Failed to setup LC3 encoder")
    
    def encode_frame(self, pcm_data):
        """
        Encode a single frame of PCM data to LC3
        
        Args:
            pcm_data: bytes object containing 16-bit PCM samples
                      Must be exactly frame_samples * 2 bytes
        
        Returns:
            bytes object containing encoded LC3 frame (frame_bytes long)
        """
        expected_size = self.frame_samples * 2  # 16-bit = 2 bytes per sample
        if len(pcm_data) != expected_size:
            raise LC3Error(
                f"PCM data size mismatch: expected {expected_size} bytes, "
                f"got {len(pcm_data)} bytes"
            )
        
        # Create output buffer
        output = ctypes.create_string_buffer(self.frame_bytes)
        
        # Encode
        result = self.wrapper.lib.lc3_encode(
            self.encoder,
            LC3Wrapper.LC3_PCM_FORMAT_S16,
            pcm_data,
            1,  # stride
            self.frame_bytes,
            output
        )
        
        if result != 0:
            raise LC3Error(f"Encoding failed with code {result}")
        
        return bytes(output)
    
    def encode(self, pcm_data):
        """
        Encode PCM data to LC3 (multiple frames)
        
        Args:
            pcm_data: bytes object containing 16-bit PCM samples
        
        Returns:
            bytes object containing all encoded LC3 frames
        """
        frame_size = self.frame_samples * 2
        num_frames = len(pcm_data) // frame_size
        
        # Pad if needed
        if len(pcm_data) % frame_size != 0:
            padding_needed = frame_size - (len(pcm_data) % frame_size)
            pcm_data = pcm_data + b'\x00' * padding_needed
            num_frames += 1
        
        # Encode all frames
        lc3_data = b''
        for i in range(num_frames):
            start = i * frame_size
            end = start + frame_size
            frame = pcm_data[start:end]
            lc3_data += self.encode_frame(frame)
        
        return lc3_data


class LC3Decoder:
    """LC3 audio decoder"""
    
    def __init__(self, dt_us=10000, sr_hz=16000, frame_bytes=20):
        """
        Initialize LC3 decoder
        
        Args:
            dt_us: Frame duration in microseconds (default: 10000 = 10ms)
            sr_hz: Sample rate in Hz (default: 16000)
            frame_bytes: Frame size in bytes (default: 20)
        """
        self.wrapper = LC3Wrapper()
        self.dt_us = dt_us
        self.sr_hz = sr_hz
        self.frame_bytes = frame_bytes
        
        # Get decoder parameters
        self.frame_samples = self.wrapper.frame_samples(dt_us, sr_hz)
        decoder_size = self.wrapper.decoder_size(dt_us, sr_hz)
        
        # Allocate decoder memory
        self.decoder_mem = ctypes.create_string_buffer(decoder_size)
        
        # Setup decoder (sr_pcm_hz=0 means use sr_hz)
        self.decoder = self.wrapper.lib.lc3_setup_decoder(
            dt_us, sr_hz, 0, ctypes.cast(self.decoder_mem, ctypes.c_void_p)
        )
        
        if not self.decoder:
            raise LC3Error("Failed to setup LC3 decoder")
    
    def decode_frame(self, lc3_data):
        """
        Decode a single LC3 frame to PCM
        
        Args:
            lc3_data: bytes object containing encoded LC3 frame
                      Must be exactly frame_bytes long
        
        Returns:
            bytes object containing 16-bit PCM samples (frame_samples * 2 bytes)
        """
        if len(lc3_data) != self.frame_bytes:
            raise LC3Error(
                f"LC3 frame size mismatch: expected {self.frame_bytes} bytes, "
                f"got {len(lc3_data)} bytes"
            )
        
        # Create output buffer
        output_size = self.frame_samples * 2  # 16-bit samples
        output = ctypes.create_string_buffer(output_size)
        
        # Decode
        result = self.wrapper.lib.lc3_decode(
            self.decoder,
            lc3_data,
            self.frame_bytes,
            LC3Wrapper.LC3_PCM_FORMAT_S16,
            output,
            1  # stride
        )
        
        if result < 0:
            raise LC3Error(f"Decoding failed with code {result}")
        
        return bytes(output)
    
    def decode(self, lc3_data):
        """
        Decode LC3 data to PCM (multiple frames)
        
        Args:
            lc3_data: bytes object containing encoded LC3 frames
        
        Returns:
            bytes object containing 16-bit PCM samples
        """
        if len(lc3_data) % self.frame_bytes != 0:
            raise LC3Error(
                f"LC3 data size must be multiple of {self.frame_bytes} bytes"
            )
        
        num_frames = len(lc3_data) // self.frame_bytes
        
        # Decode all frames
        pcm_data = b''
        for i in range(num_frames):
            start = i * self.frame_bytes
            end = start + self.frame_bytes
            frame = lc3_data[start:end]
            pcm_data += self.decode_frame(frame)
        
        return pcm_data


if __name__ == '__main__':
    # Simple test
    print("LC3 Wrapper Test")
    print("-" * 50)
    
    try:
        wrapper = LC3Wrapper()
        
        # Test parameters (matching MentraOS defaults)
        dt_us = 10000  # 10ms
        sr_hz = 16000  # 16kHz
        
        frame_samples = wrapper.frame_samples(dt_us, sr_hz)
        encoder_size = wrapper.encoder_size(dt_us, sr_hz)
        decoder_size = wrapper.decoder_size(dt_us, sr_hz)
        
        print(f"Frame duration: {dt_us} μs ({dt_us/1000} ms)")
        print(f"Sample rate: {sr_hz} Hz")
        print(f"Frame samples: {frame_samples}")
        print(f"Encoder size: {encoder_size} bytes")
        print(f"Decoder size: {decoder_size} bytes")
        print("\n✓ LC3 library loaded successfully!")
        
    except LC3Error as e:
        print(f"\n✗ Error: {e}")

