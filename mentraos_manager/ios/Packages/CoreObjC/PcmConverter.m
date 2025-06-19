//
//  PcmConverter.m
//  Runner
//
//  Created by Hawk on 2024/3/14.
//

#import "PcmConverter.h"
#import "lc3.h"

@implementation PcmConverter

// Frame length 10ms
static const int dtUs = 10000;
// Sampling rate 48K
static const int srHz = 16000;
// Output bytes after encoding a single frame
static const uint16_t outputByteCount = 20;  // 40
// Buffer size required by the encoder
static unsigned encodeSize;
// Buffer size required by the decoder
static unsigned decodeSize;
// Number of samples in a single frame
static uint16_t sampleOfFrames;
// Number of bytes in a single frame, 16Bits takes up two bytes for the next sample
static uint16_t bytesOfFrames;
// Encoder buffer
static void* encMem = NULL;
// Decoder buffer
static void* decMem = NULL;
// File descriptor of the input file
static int inFd = -1;
// File descriptor of output file
static int outFd = -1;
// Input frame buffer
static unsigned char *inBuf;
// Output frame buffer
static unsigned char *outBuf;

-(NSMutableData *)decode: (NSData *)lc3data {
    
    encodeSize = lc3_encoder_size(dtUs, srHz);
    decodeSize = lc3_decoder_size(dtUs, srHz);
    sampleOfFrames = lc3_frame_samples(dtUs, srHz);
    bytesOfFrames = sampleOfFrames*2;

    if (lc3data == nil) {
        printf("Failed to decode Base64 data\n");
        return [[NSMutableData alloc] init];
    }
    
    decMem = malloc(decodeSize);
    lc3_decoder_t lc3_decoder = lc3_setup_decoder(dtUs, srHz, 0, decMem);
    if ((outBuf = malloc(bytesOfFrames)) == NULL) {
        printf("Failed to allocate memory for outBuf\n");
        return [[NSMutableData alloc] init];
    }
    
    int totalBytes = (int)lc3data.length;
    int bytesRead = 0;
    
    NSMutableData *pcmData = [[NSMutableData alloc] init];
    
    while (bytesRead < totalBytes) {
        int bytesToRead = MIN(outputByteCount, totalBytes - bytesRead);
        NSRange range = NSMakeRange(bytesRead, bytesToRead);
        NSData *subdata = [lc3data subdataWithRange:range];
        inBuf = (unsigned char *)subdata.bytes;
        
        NSUInteger length = subdata.length;
        for (NSUInteger i = 0; i < length; ++i) {
           // printf("%02X ", inBuf[i]);
        }
        lc3_decode(lc3_decoder, inBuf, outputByteCount, LC3_PCM_FORMAT_S16, outBuf, 1);
        
        NSMutableString *hexString = [NSMutableString stringWithCapacity:bytesOfFrames * 2];
        for (int i = 0; i < bytesOfFrames; i++) {
            
            [hexString appendFormat:@"%02X ", outBuf[i]];
        }
         
        NSData *data = [NSData dataWithBytes:outBuf length:bytesOfFrames];
        [pcmData appendData:data];
        bytesRead += bytesToRead;
    }
    
    free(decMem);
    free(outBuf);
    
    return pcmData;
}
@end

