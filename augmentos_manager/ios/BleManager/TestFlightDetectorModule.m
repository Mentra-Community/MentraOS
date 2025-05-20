//
//  TestFlightDetectorModule.m
//  AugmentOS_Manager
//

#import <Foundation/Foundation.h>
#import "TestFlightDetectorModule.h"
#import "AugmentOS_Manager-Swift.h"

@interface TestFlightDetectorModule ()
@property (nonatomic, strong) TestFlightDetector *testFlightDetector;
@end

@implementation TestFlightDetectorModule

// Export the module for React Native
RCT_EXPORT_MODULE(TestFlightDetectorModule);

- (instancetype)init {
    self = [super init];
    if (self) {
        _testFlightDetector = [[TestFlightDetector alloc] init];
    }
    return self;
}

RCT_EXPORT_METHOD(isTestFlight:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
    @try {
        BOOL isTestFlight = [self.testFlightDetector isRunningOnTestFlight];
        resolve(@(isTestFlight));
    }
    @catch(NSException *exception) {
        reject(@"error", exception.description, nil);
    }
}

// Required for Swift interop
+ (BOOL)requiresMainQueueSetup {
    return NO;
}

@end