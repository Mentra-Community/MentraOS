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
}

// Frame length 10ms
static const int dtUs = 10000;
// Sampling rate 48K
static const int srHz = 16000;
// Output bytes after encoding a single frame
static const uint16_t outputByteCount = 20;

- (instancetype)init {
    self = [super init];
    if (self) {
        _decoderInitialized = NO;
        _decMem = NULL;
        _outBuf = NULL;
    }
    return self;
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
}
@end
