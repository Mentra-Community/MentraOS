//
//  AOSModule.m
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/5/25.
//

#import <Foundation/Foundation.h>
#import "./AOSModule.h"
#import "AugmentOS-Swift.h"

@interface AOSModule ()
@property (nonatomic, strong) AOSManager *aosManager;
@end

@implementation AOSModule

// Export the module for React Native
RCT_EXPORT_MODULE(AOSModule);

- (instancetype)init {
    self = [super init];
    if (self) {
        _aosManager = [[AOSManager alloc] init];
    }
    return self;
}

// Start scanning for devices
RCT_EXPORT_METHOD(startScan:(RCTResponseSenderBlock)successCallback errorCallback:(RCTResponseSenderBlock)errorCallback) {
    @try {
        // Call the Swift startScan method
        [self.aosManager.g1Manager RN_startScan];
        successCallback(@[@"scanning_started"]);
        
        // Schedule to stop scan after 10 seconds
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self stopScan:nil errorCallback:nil];
        });
    }
    @catch(NSException *exception) {
        errorCallback(@[exception.description]);
    }
}

// Stop scanning for devices
RCT_EXPORT_METHOD(stopScan:(RCTResponseSenderBlock)successCallback errorCallback:(RCTResponseSenderBlock)errorCallback) {
    @try {
        // Call the Swift stopScan method
        [self.aosManager.g1Manager RN_stopScan];
        
        if (successCallback) {
            successCallback(@[@"Scanning stopped"]);
        }
    }
    @catch(NSException *exception) {
        if (errorCallback) {
            errorCallback(@[exception.description]);
        }
    }
}

// connect to glasses we've already paired with:
RCT_EXPORT_METHOD(
  connectGlasses:
  (RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
) {
  if ([self.aosManager.g1Manager RN_connectGlasses]) {
    resolve(@"connected");
  } else {
    reject(@"0", @"glasses_not_paired", nil);
  }
}

// Disconnect from the connected device
RCT_EXPORT_METHOD(disconnect:(RCTResponseSenderBlock)successCallback errorCallback:(RCTResponseSenderBlock)errorCallback) {
    @try {
        successCallback(@[@"Disconnecting not implemented in Swift class"]);
    }
    @catch(NSException *exception) {
        errorCallback(@[exception.description]);
    }
}

// send text to the glasses
RCT_EXPORT_METHOD(
  sendText:
  (NSString *)text
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  @try {
    [self.aosManager.g1Manager RN_sendText:text];
    resolve(@[@"Sent text"]);
  }
  @catch(NSException *exception) {
    reject(@"0", exception.description, nil);
  }
}


RCT_EXPORT_METHOD(
  setBrightness:
  (NSInteger)brightnessValue// first param is special and doesn't get a name
  autoBrightness:(BOOL)autoBrightness
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  @try {
    [self.aosManager.g1Manager RN_setBrightness:brightnessValue autoMode:autoBrightness];
    resolve(@[@"Set brightness"]);
  }
  @catch(NSException *exception) {
    reject(@"0", exception.description, nil);
  }
}


RCT_EXPORT_METHOD(
  setMicEnabled:
  (BOOL)enabled
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  @try {
    [self.aosManager.g1Manager RN_setMicEnabled:enabled];
    resolve(@[@"Set mic enabled"]);
  }
  @catch(NSException *exception) {
    reject(@"0", exception.description, nil);
  }
}

RCT_EXPORT_METHOD(
  getBatteryStatus:
  (RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  @try {
    [self.aosManager.g1Manager RN_getBatteryStatus];
    resolve(@[@"Got battery status!"]);
  }
  @catch(NSException *exception) {
    reject(@"0", exception.description, nil);
  }
}

RCT_EXPORT_METHOD(
  setCoreToken:
  (NSString *)token
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  @try {
    [self.aosManager setCoreToken:token];
    resolve(@[@"Set core token!"]);
  }
  @catch(NSException *exception) {
    reject(@"0", exception.description, nil);
  }
}


RCT_EXPORT_METHOD(
  sendWhitelist:
  (NSString *)command
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  @try {
    [self.aosManager.g1Manager RN_sendWhitelist];
    resolve(@[@"Whitelist sent!"]);
  }
  @catch(NSException *exception) {
    reject(@"0", exception.description, nil);
  }
}

RCT_EXPORT_METHOD(
  sendCommand:
  (NSString *)command
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  @try {
    [self.aosManager handleCommand:command];
    resolve(@[@"Command sent!"]);
  }
  @catch(NSException *exception) {
    reject(@"0", exception.description, nil);
  }
}


RCT_EXPORT_METHOD(
  setup:
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  @try {
    [self.aosManager setup];
    resolve(@[@"called setup!"]);
  }
  @catch(NSException *exception) {
    reject(@"0", exception.description, nil);
  }
}

// Required for Swift interop
+ (BOOL)requiresMainQueueSetup {
    return YES;
}

@end
