#import "AppDelegate.h"
#import "ManagerCoreCommsService.h"

#import <React/RCTBundleURLProvider.h>

// for deep linking:
#import <React/RCTLinkingManager.h>


@implementation AppDelegate


// for deep linking:
- (BOOL)application:(UIApplication *)application
   openURL:(NSURL *)url
   options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options
{
  return [RCTLinkingManager application:application openURL:url options:options];
}

- (BOOL)application:(UIApplication *)application continueUserActivity:(nonnull NSUserActivity *)userActivity
 restorationHandler:(nonnull void (^)(NSArray<id<UIUserActivityRestoring>> * _Nullable))restorationHandler
{
 return [RCTLinkingManager application:application continueUserActivity:userActivity restorationHandler:restorationHandler];
}

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"AugmentOS";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  // Initialize the ManagerCoreCommsService
//  [[ManagerCoreCommsService allocWithZone:nil] init];
//  [EvenRealitiesG1Manager sharedInstance];

  // Important: Call super FIRST to initialize the permission handlers properly
  BOOL result = [super application:application didFinishLaunchingWithOptions:launchOptions];
  
  // Add any additional setup after permission handlers have been initialized
  
  return result;
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
