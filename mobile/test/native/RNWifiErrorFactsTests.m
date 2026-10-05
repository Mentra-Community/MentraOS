// Exercise the installed native diagnostic formatter without joining a network.
#import "RNWifiErrorFacts.h"

static void check(BOOL condition, NSString *message) {
  if (!condition) {
    NSLog(@"FAIL: %@", message);
    exit(1);
  }
}

int main(void) {
  @autoreleasepool {
    NSError *underlying = [NSError errorWithDomain:NSPOSIXErrorDomain code:22
        userInfo:@{NSLocalizedDescriptionKey: @"private underlying text"}];
    NSError *error = [NSError errorWithDomain:@"NEHotspotConfigurationErrorDomain" code:8
        userInfo:@{NSUnderlyingErrorKey: underlying, @"SSID": @"private network",
                   @"password": @"private passphrase", NSLocalizedDescriptionKey: @"private error text"}];
    NSString *facts = RNWifiErrorFacts(error);
    check([facts isEqualToString:@"domain=NEHotspotConfigurationErrorDomain code=8 underlying_domain=NSPOSIXErrorDomain underlying_code=22"],
          @"Preserve original numeric error and one underlying numeric error");
    check([facts rangeOfString:@"private"].location == NSNotFound,
          @"Exclude credentials, descriptions and other userInfo");
    NSError *unknown = [NSError errorWithDomain:@"NEHotspotConfigurationErrorDomain" code:107 userInfo:nil];
    check([RNWifiErrorFacts(unknown) isEqualToString:@"domain=NEHotspotConfigurationErrorDomain code=107 underlying_domain=none underlying_code=none"],
          @"Keep unknown numeric codes rather than remapping them");
    NSError *unsafe = [NSError errorWithDomain:@"private network\nsecret" code:-1
        userInfo:@{NSUnderlyingErrorKey: @"private malformed underlying error"}];
    check([RNWifiErrorFacts(unsafe) isEqualToString:@"domain=unavailable code=-1 underlying_domain=none underlying_code=none"],
          @"Reject malformed underlying values and non-identifier domains");
    NSError *longDomain = [NSError errorWithDomain:[@"x" stringByPaddingToLength:129 withString:@"x" startingAtIndex:0]
        code:NSIntegerMax userInfo:@{NSUnderlyingErrorKey: underlying}];
    check([RNWifiErrorFacts(longDomain) hasPrefix:@"domain=unavailable code="],
          @"Reject oversized domains");
    check(RNWifiErrorFacts(longDomain).length < 400, @"Keep the summary bounded");
    NSString *maximumDomain = [@"x" stringByPaddingToLength:128 withString:@"x" startingAtIndex:0];
    NSError *maximumUnderlying = [NSError errorWithDomain:maximumDomain code:NSIntegerMin userInfo:nil];
    NSError *maximum = [NSError errorWithDomain:maximumDomain code:NSIntegerMax
        userInfo:@{NSUnderlyingErrorKey: maximumUnderlying}];
    check(RNWifiErrorFacts(maximum).length < 400, @"Bound both maximum identifier/code fields together");
    NSError *nested = [NSError errorWithDomain:@"Nested" code:7 userInfo:@{NSUnderlyingErrorKey: error}];
    check([RNWifiErrorFacts(nested) isEqualToString:@"domain=Nested code=7 underlying_domain=NEHotspotConfigurationErrorDomain underlying_code=8"],
          @"Never recursively print an underlying chain");
    NSLog(@"PASS: original native codes, bounded identifiers, private data exclusion");
  }
  return 0;
}
