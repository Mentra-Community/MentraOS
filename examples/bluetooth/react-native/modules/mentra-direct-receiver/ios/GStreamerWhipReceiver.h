#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface GStreamerWhipReceiver : NSObject

@property (nonatomic, strong, readonly) UIView *videoView;
@property (nonatomic, copy, readonly, nullable) NSString *whipURL;
@property (nonatomic, copy, nullable) void (^onStateChanged)(NSString *message);

- (BOOL)startWithAdvertisedHost:(NSString *)advertisedHost
                           port:(NSInteger)port
                          error:(NSError **)error;
- (void)stop;

@end

NS_ASSUME_NONNULL_END
