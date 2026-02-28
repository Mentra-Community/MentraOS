//
//  PcmConverter.h
//  Runner
//
//  Created by Hawk on 2024/3/14.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface PcmConverter : NSObject
+ (void)setupStaticEncoderAndDecoder;
-(NSMutableData *)decode: (NSData *)lc3data frameSize:(NSInteger)frameSize;
-(NSMutableData *)encode: (NSData *)pcmdata frameSize:(NSInteger)frameSize;
-(void)setOutputFrameSize:(NSInteger)frameSize;
-(NSInteger)getOutputFrameSize;
-(void)resetEncoder;
-(void)resetDecoder;
@end

NS_ASSUME_NONNULL_END
