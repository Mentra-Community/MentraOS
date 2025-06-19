//
//  CoreCommsService.m
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/4/25.
//

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(CoreCommsService, RCTEventEmitter)
  RCT_EXTERN_METHOD(supportedEvents)
@end
