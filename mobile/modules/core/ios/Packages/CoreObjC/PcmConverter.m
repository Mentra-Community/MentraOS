//
//  PcmConverter.m
//  Runner
//
//  Created by Hawk on 2024/3/14.
//

#import "PcmConverter.h"
#import "lc3.h"

@implementation PcmConverter {
    // Instance variables for persistent decoder
    lc3_decoder_t _lc3_decoder;
    void* _decMem;
    unsigned char* _outBuf;
    BOOL _decoderInitialized;

    // Decoder parameters
    unsigned _decodeSize;
    uint16_t _sampleOfFrames;
    uint16_t _bytesOfFrames;

    // Instance variables for persistent encoder
    lc3_encoder_t _lc3_encoder;
    void* _encMem;
    unsigned char* _encOutBuf;
    BOOL _encoderInitialized;
    unsigned _encodeSize;

    // Sample accumulation buffer for encoder
    // LC3 requires exactly 160 samples (320 bytes) per frame at 16kHz/10ms
    // iOS audio callbacks may not align with frame boundaries, so we accumulate samples
    NSMutableData* _encAccumulationBuffer;

    // Configurable output frame size (determines bitrate)
    // 20 bytes = 16kbps, 40 bytes = 32kbps, 60 bytes = 48kbps
    uint16_t _outputFrameSize;
}

// Frame length 10ms
static const int dtUs = 10000;
// Sampling rate 16kHz
static const int srHz = 16000;
// Default output bytes after encoding a single frame (can be changed via setOutputFrameSize)
static const uint16_t defaultOutputByteCount = 20;

- (instancetype)init {
    self = [super init];
    if (self) {
        _decoderInitialized = NO;
        _decMem = NULL;
        _outBuf = NULL;
        _encoderInitialized = NO;
        _encMem = NULL;
        _encOutBuf = NULL;
        _encAccumulationBuffer = [[NSMutableData alloc] init];
        _outputFrameSize = defaultOutputByteCount;
    }
    return self;
}

- (void)setOutputFrameSize:(NSInteger)frameSize {
    // Validate frame size (20, 40, or 60 bytes)
    if (frameSize != 20 && frameSize != 40 && frameSize != 60) {
        printf("Invalid frame size %ld, must be 20, 40, or 60. Using default.\n", (long)frameSize);
        _outputFrameSize = defaultOutputByteCount;
        return;
    }

    // If encoder is already initialized and frame size is changing, we need to reallocate output buffer
    if (_encoderInitialized && _outputFrameSize != frameSize) {
        if (_encOutBuf) {
            free(_encOutBuf);
        }
        _encOutBuf = malloc(frameSize);
        if (_encOutBuf == NULL) {
            printf("Failed to reallocate encoder output buffer for new frame size\n");
            _encoderInitialized = NO;
            return;
        }
    }

    _outputFrameSize = (uint16_t)frameSize;
}

- (NSInteger)getOutputFrameSize {
    return (NSInteger)_outputFrameSize;
}

- (void)setupDecoder {
    if (_decoderInitialized) {
        return; // Already initialized
    }
    
    _decodeSize = lc3_decoder_size(dtUs, srHz);
    _sampleOfFrames = lc3_frame_samples(dtUs, srHz);
    _bytesOfFrames = _sampleOfFrames * 2;
    
    _decMem = malloc(_decodeSize);
    if (_decMem == NULL) {
        printf("Failed to allocate memory for decoder\n");
        return;
    }
    
    _lc3_decoder = lc3_setup_decoder(dtUs, srHz, 0, _decMem);
    
    _outBuf = malloc(_bytesOfFrames);
    if (_outBuf == NULL) {
        printf("Failed to allocate memory for outBuf\n");
        free(_decMem);
        _decMem = NULL;
        return;
    }
    
    _decoderInitialized = YES;
}

- (NSMutableData *)decode:(NSData *)lc3data frameSize:(NSInteger)frameSize {
    if (lc3data == nil) {
        printf("Failed to decode Base64 data\n");
        return [[NSMutableData alloc] init];
    }

    // Setup decoder on first use
    [self setupDecoder];

    if (!_decoderInitialized) {
        printf("Decoder not initialized\n");
        return [[NSMutableData alloc] init];
    }

    int totalBytes = (int)lc3data.length;
    int bytesRead = 0;

    NSMutableData *pcmData = [[NSMutableData alloc] init];

    while (bytesRead < totalBytes) {
        int bytesToRead = MIN(frameSize, totalBytes - bytesRead);
        NSRange range = NSMakeRange(bytesRead, bytesToRead);
        NSData *subdata = [lc3data subdataWithRange:range];
        unsigned char *inBuf = (unsigned char *)subdata.bytes;

        lc3_decode(_lc3_decoder, inBuf, frameSize, LC3_PCM_FORMAT_S16, _outBuf, 1);

        NSData *data = [NSData dataWithBytes:_outBuf length:_bytesOfFrames];
        [pcmData appendData:data];
        bytesRead += bytesToRead;
    }

    return pcmData;
}

- (void)resetDecoder {
    // Call this if you need to reset the decoder state
    if (_decoderInitialized && _decMem) {
        _lc3_decoder = lc3_setup_decoder(dtUs, srHz, 0, _decMem);
    }
}

- (void)resetEncoder {
    // Call this when starting a new recording session to clear accumulated samples
    // and reset encoder state for clean audio
    [_encAccumulationBuffer setLength:0];
    if (_encoderInitialized && _encMem) {
        _lc3_encoder = lc3_setup_encoder(dtUs, srHz, 0, _encMem);
    }
}

- (void)setupEncoder {
    if (_encoderInitialized) {
        return; // Already initialized
    }

    _encodeSize = lc3_encoder_size(dtUs, srHz);

    _encMem = malloc(_encodeSize);
    if (_encMem == NULL) {
        printf("Failed to allocate memory for encoder\n");
        return;
    }

    _lc3_encoder = lc3_setup_encoder(dtUs, srHz, 0, _encMem);

    _encOutBuf = malloc(_outputFrameSize);
    if (_encOutBuf == NULL) {
        printf("Failed to allocate memory for encoder output buffer\n");
        free(_encMem);
        _encMem = NULL;
        return;
    }

    _encoderInitialized = YES;
}

- (NSMutableData *)encode:(NSData *)pcmdata {
    if (pcmdata == nil || pcmdata.length == 0) {
        return [[NSMutableData alloc] init];
    }

    // Setup encoder on first use
    [self setupEncoder];

    if (!_encoderInitialized) {
        printf("Encoder not initialized\n");
        return [[NSMutableData alloc] init];
    }

    // LC3 frame size: 160 samples * 2 bytes = 320 bytes per frame
    uint16_t bytesPerFrame = lc3_frame_samples(dtUs, srHz) * 2;

    // Append new PCM data to accumulation buffer
    [_encAccumulationBuffer appendData:pcmdata];

    NSMutableData *lc3Data = [[NSMutableData alloc] init];
    const int16_t *pcmSamples = (const int16_t *)_encAccumulationBuffer.bytes;
    int totalBytes = (int)_encAccumulationBuffer.length;
    int bytesRead = 0;

    // Encode complete frames from the accumulation buffer
    while (totalBytes - bytesRead >= bytesPerFrame) {
        const int16_t *currentSamples = pcmSamples + (bytesRead / 2);
        int result = lc3_encode(_lc3_encoder, LC3_PCM_FORMAT_S16, currentSamples, 1, _outputFrameSize, _encOutBuf);

        if (result == 0) {
            [lc3Data appendBytes:_encOutBuf length:_outputFrameSize];
        }
        bytesRead += bytesPerFrame;
    }

    // Keep leftover samples in the accumulation buffer for next call
    if (bytesRead > 0) {
        NSData *leftover = [_encAccumulationBuffer subdataWithRange:NSMakeRange(bytesRead, totalBytes - bytesRead)];
        [_encAccumulationBuffer setLength:0];
        [_encAccumulationBuffer appendData:leftover];
    }

    return lc3Data;
}

- (void)dealloc {
    if (_decMem) {
        free(_decMem);
        _decMem = NULL;
    }
    if (_outBuf) {
        free(_outBuf);
        _outBuf = NULL;
    }
    _decoderInitialized = NO;

    if (_encMem) {
        free(_encMem);
        _encMem = NULL;
    }
    if (_encOutBuf) {
        free(_encOutBuf);
        _encOutBuf = NULL;
    }
    if (_encAccumulationBuffer) {
        [_encAccumulationBuffer setLength:0];
        _encAccumulationBuffer = nil;
    }
    _encoderInitialized = NO;
}
@end
