// Exercise the installed native downloader delegate without React Native or a network.
// Run with scripts/test-gallery-download-progress.sh on macOS.
#import "Downloader.h"
#import <objc/runtime.h>

@interface ProgressTestTask : NSObject
@property (strong) NSHTTPURLResponse *response;
@end
@implementation ProgressTestTask
@end

static void check(BOOL condition, NSString *message) {
  if (!condition) {
    NSLog(@"FAIL: %@", message);
    exit(1);
  }
}

static void verifyProgress(NSInteger status, BOOL shouldEmit) {
  RNFSDownloader *downloader = [RNFSDownloader new];
  RNFSDownloadParams *params = [RNFSDownloadParams new];
  params.progressInterval = @250;
  params.progressDivider = @2;
  NSMutableArray<NSNumber *> *received = [NSMutableArray array];
  __block NSInteger begins = 0;
  params.beginCallback = ^(NSNumber *code, NSNumber *length, NSDictionary *headers) {
    check(code.integerValue == status, @"Preserve the HTTP response status");
    check(length.longLongValue == 1000, @"Preserve the segment content length");
    begins++;
  };
  params.progressCallback = ^(NSNumber *length, NSNumber *bytes) {
    check(length.longLongValue == 1000, @"Progress uses segment bytes");
    [received addObject:bytes];
  };
  // downloadFile assigns this ivar directly; avoid its unused copy-property setter.
  object_setIvar(downloader, class_getInstanceVariable([RNFSDownloader class], "_params"), params);
  ProgressTestTask *task = [ProgressTestTask new];
  task.response = [[NSHTTPURLResponse alloc]
      initWithURL:[NSURL URLWithString:@"http://127.0.0.1/media"]
      statusCode:status HTTPVersion:@"HTTP/1.1"
      headerFields:@{@"Content-Length": @"1000"}];

  for (NSNumber *bytes in @[@100, @400, @800]) {
    // Advance the throttle deterministically, without sleeping or issuing requests.
    [downloader setValue:@0 forKey:@"lastProgressEmitTimestamp"];
    [downloader URLSession:[NSURLSession sharedSession] downloadTask:(NSURLSessionDownloadTask *)task
             didWriteData:100 totalBytesWritten:bytes.longLongValue totalBytesExpectedToWrite:1000];
  }
  check(begins == 1, @"Emit begin exactly once");
  check(shouldEmit ? [received isEqualToArray:@[@100, @400, @800]] : received.count == 0,
        [NSString stringWithFormat:@"HTTP %ld must %@ incremental progress", (long)status,
                                   shouldEmit ? @"emit" : @"suppress"]);
}

int main(void) {
  @autoreleasepool {
    check(NO, @"REGRESSION MATRIX A2: deliberate native test failure (reverted in the next commit)");
    verifyProgress(206, YES);
    verifyProgress(200, YES);
    verifyProgress(416, NO);
    verifyProgress(500, NO);
    NSLog(@"PASS: full/ranged download progress, first chunk, error responses");
  }
  return 0;
}
