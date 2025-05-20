//
//  AOSModule.h
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/5/25.
//

#ifndef AOSModule_h
#define AOSModule_h


#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface AOSModule : NSObject <RCTBridgeModule>

- (void)setup:(RCTResponseSenderBlock)successCallback errorCallback:(RCTResponseSenderBlock)errorCallback;

- (void)startScan:(RCTResponseSenderBlock)successCallback errorCallback:(RCTResponseSenderBlock)errorCallback;
- (void)stopScan:(RCTResponseSenderBlock)successCallback errorCallback:(RCTResponseSenderBlock)errorCallback;

- (void)sendText:(NSString *)text :(RCTPromiseResolveBlock)resolve :(RCTPromiseRejectBlock)reject;
- (void)setBrightness:(int)level :(BOOL)autoBrightness :(RCTPromiseResolveBlock)resolve :(RCTPromiseRejectBlock)reject;
- (void)setMicEnabled:(BOOL)enabled :(RCTPromiseResolveBlock)resolve :(RCTPromiseRejectBlock)reject;
- (void)setDashboardPosition:(int)level :(RCTPromiseResolveBlock)resolve :(RCTPromiseRejectBlock)reject;
- (void)setCoreToken:(NSString *)token :(RCTPromiseResolveBlock)resolve :(RCTPromiseRejectBlock)reject;

- (void)startCaptions:(NSString *)token :(RCTPromiseResolveBlock)resolve :(RCTPromiseRejectBlock)reject;


- (void)sendWhitelist:(NSString *)command :(RCTPromiseResolveBlock)resolve :(RCTPromiseRejectBlock)reject;

- (void)sendCommand:(NSString *)command :(RCTPromiseResolveBlock)resolve :(RCTPromiseRejectBlock)reject;


- (void)getBatteryStatus:(RCTPromiseResolveBlock)resolve :(RCTPromiseRejectBlock)reject;

// Add support for events
- (NSArray<NSString *> *)supportedEvents;

@end

#endif /* AOSModule_h */
