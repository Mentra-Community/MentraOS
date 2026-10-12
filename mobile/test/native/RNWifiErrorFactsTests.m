// Exercise the installed native diagnostic formatter without joining a network.
#import "RNWifiErrorFacts.h"
#import "RNWifiApplyDiagnostics.h"

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
    NSError *bridged = RNWifiErrorWithNativeFacts(error);
    NSDictionary *native = bridged.userInfo[@"RNWifiNativeError"];
    check([native[@"domain"] isEqual:@"NEHotspotConfigurationErrorDomain"] &&
          [native[@"code"] isEqual:@8] && [native[@"completed"] isEqual:@YES],
          @"Preserve answered original error8 through the mapped React Native code");
    NSData *json = [NSJSONSerialization dataWithJSONObject:native options:0 error:nil];
    NSString *serialized = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    check([serialized rangeOfString:@"private"].location == NSNotFound && serialized.length < 400,
          @"Bridge only numeric identifiers, never credentials or descriptions");
    check(bridged.code == error.code && [bridged.domain isEqual:error.domain] &&
          [bridged.userInfo[@"SSID"] isEqual:error.userInfo[@"SSID"]],
          @"Preserve original NSError fields without rewriting the mapped rejection");
    NSString *facts = RNWifiErrorFacts(error);
    check([facts isEqualToString:@"domain=NEHotspotConfigurationErrorDomain code=8 underlying_domain=NSPOSIXErrorDomain underlying_code=22"],
          @"Preserve original numeric error and one underlying numeric error");
    check([facts rangeOfString:@"private"].location == NSNotFound,
          @"Exclude credentials, descriptions and other userInfo");
    NSError *denied = [NSError errorWithDomain:@"NEHotspotConfigurationErrorDomain" code:7 userInfo:nil];
    check([RNWifiErrorWithNativeFacts(denied).userInfo[@"RNWifiNativeError"][@"code"] isEqual:@7],
          @"Preserve user-denied code so it is never retried as internal");
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
    check([bridged.domain isEqual:error.domain] && bridged.code == error.code &&
          bridged.userInfo[NSUnderlyingErrorKey] == underlying &&
          [bridged.localizedDescription isEqual:error.localizedDescription], @"Keep the original error and underlying error unchanged");

    __block NSTimeInterval now = 100;
    RNWifiApplyDiagnostics *apply = [[RNWifiApplyDiagnostics alloc] initWithClock:^{ return now; }];
    NSTimeInterval request = apply.now;
    now += 0.01; [apply applyStarted];
    now += 0.05; [apply applyCompleted];
    now += 0.01;
    NSDictionary *lateBefore = [apply factsForKind:@"target_configuration" phase:@"apply_admission"
        requestedAt:request state:RNWifiTargetConfigurationState(@"private target", @[@"private other", @"private target"])];
    check([lateBefore[@"state"] isEqual:@"present"] && [lateBefore[@"callback_observed"] boolValue],
          @"A pre-admission request answered after callback is not a pre-apply snapshot");
    check([lateBefore[@"requested_elapsed_ms"] doubleValue] == 0 &&
          [lateBefore[@"observed_elapsed_ms"] doubleValue] > [lateBefore[@"callback_elapsed_ms"] doubleValue],
          @"Keep request, apply, callback and observed timing separate");
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:lateBefore options:0 error:nil];
    check([[[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding] rangeOfString:@"private"].location == NSNotFound,
          @"Configuration names never reach emitted facts");
    check([RNWifiTargetConfigurationState(@"private target", @[]) isEqual:@"absent"] &&
          [RNWifiTargetConfigurationState(@"private target", nil) isEqual:@"absent"] &&
          [RNWifiTargetConfigurationState(@"private target", @[@1]) isEqual:@"unavailable"], @"Validate configured-name observation");
    check([RNWifiAssociationState(@"private target", @"private target") isEqual:@"matched"] &&
          [RNWifiAssociationState(@"private target", @"private other") isEqual:@"different"] &&
          [RNWifiAssociationState(@"private target", nil) isEqual:@"unavailable"] &&
          [RNWifiAssociationState(@"private target", @"") isEqual:@"unavailable"], @"Privacy-redacted association is unavailable, not disconnected");
    request = now;
    now += 2.001;
    check(![apply factsForKind:@"association" phase:@"after_callback" requestedAt:request state:@"matched"],
          @"Drop an OS reply after its bounded diagnostic window");
    RNWifiApplyDiagnostics *current = [[RNWifiApplyDiagnostics alloc] initWithClock:^{ return now; }];
    check(![apply factsForKind:@"association" phase:@"after_callback" requestedAt:now state:@"matched"],
          @"Superseded replies cannot describe the current invocation");
    check([current factsForKind:@"association" phase:@"before_apply" requestedAt:now state:@"unavailable"] != nil,
          @"Current invocation accepts a bounded unavailable observation");
    check(![current factsForKind:@"association" phase:@"before_apply" requestedAt:now state:@"private target"] &&
          ![current factsForKind:@"private target" phase:@"before_apply" requestedAt:now state:@"matched"],
          @"Only fixed diagnostic fields can be emitted");
    now -= 1;
    check(![current factsForKind:@"association" phase:@"after_callback" requestedAt:now + 1 state:@"matched"],
          @"Reject backwards or future observation timestamps");
    NSLog(@"PASS: native error facts, asynchronous diagnostic ordering, late/superseded replies, private data exclusion");
  }
  return 0;
}
