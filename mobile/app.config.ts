import "tsx/cjs"
import {ExpoConfig, ConfigContext} from "@expo/config"

/**
 * @param config ExpoConfig coming from the static config app.json if it exists
 *
 * You can read more about Expo's Configuration Resolution Rules here:
 * https://docs.expo.dev/workflow/configuration/#configuration-resolution-rules
 */
module.exports = ({config}: ConfigContext): Partial<ExpoConfig> => {
  // Optional build-variant suffix. Set MENTRAOS_BUILD_NAME=stable to produce
  // a parallel-installable build with package com.mentra.mentra.stable and app
  // label "stable". Leave unset for the normal Mentra build.
  const variantName = process.env.MENTRAOS_BUILD_NAME?.trim() || null
  const isValidVariant = variantName && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(variantName)
  if (variantName && !isValidVariant) {
    throw new Error(
      `MENTRAOS_BUILD_NAME="${variantName}" is invalid. Must start with a letter and contain only letters, digits, or underscores.`,
    )
  }
  const appName = isValidVariant ? variantName : "Mentra"
  const baseId = "com.mentra.mentra"
  const androidPackage = isValidVariant ? `${baseId}.${variantName}` : baseId
  const iosBundleId = isValidVariant ? `${baseId}.${variantName}` : baseId

  return {
    ...config,
    name: appName,
    slug: "Mentra",
    version: process.env.EXPO_PUBLIC_MENTRAOS_VERSION || "0.0.1",
    scheme: "com.mentra",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    icon: "./assets/app-icons/ic_launcher.png",
    updates: {
      fallbackToCacheTimeout: 0,
    },
    jsEngine: "hermes",
    assetBundlePatterns: ["**/*"],
    android: {
      // icon: "./assets/app-icons/ic_launcher.png",
      package: androidPackage,
      googleServicesFile: "./google-services.json",
      versionCode: 244,
      adaptiveIcon: {
        foregroundImage: "./assets/app-icons/ic_launcher_foreground.png",
        // backgroundImage: "./assets/app-icons/ic_launcher.png",
        backgroundColor: "#fff",
      },
      allowBackup: false,
      permissions: [
        "ACCESS_FINE_LOCATION",
        "ACCESS_WIFI_STATE",
        "ACCESS_NETWORK_STATE",
        "CHANGE_WIFI_STATE",
        "CHANGE_NETWORK_STATE",
      ],
      intentFilters: [
        {
          action: "VIEW",
          autoVerify: true,
          data: [
            {
              scheme: "https",
              host: "apps.mentra.glass",
              pathPrefix: "/package/",
            },
            {
              scheme: "https",
              host: "apps.mentraglass.com",
              pathPrefix: "/package/",
            },
          ],
          category: ["DEFAULT", "BROWSABLE"],
        },
      ],
    },
    ios: {
      icon: "./assets/app-icons/ic_launcher.png",
      supportsTablet: false,
      requireFullScreen: true,
      buildNumber: "244",
      bundleIdentifier: iosBundleId,
      appleTeamId: "T5XXXL6N36",
      googleServicesFile: "./GoogleService-Info.plist",
      associatedDomains: ["applinks:apps.mentra.glass", "applinks:apps.mentraglass.com"],
      infoPlist: {
        NSCameraUsageDescription: "This app needs access to your camera to capture images.",
        NSMicrophoneUsageDescription:
          "Mentra uses your microphone to enable the 'Hey Mira' AI assistant and provide live captions for deaf and hard-of-hearing users on smart glasses. For example, you can say 'Hey Mira, what's on my calendar today?' or the app can caption conversations in real-time on your glasses display.",
        NSBluetoothAlwaysUsageDescription: "This app needs access to your Bluetooth to connect to your glasses.",
        NSLocationWhenInUseUsageDescription:
          "Mentra uses your location to display nearby points of interest, weather updates, and navigation directions on your smart glasses. For example, when you're walking, the app can show restaurants within 100 meters or provide turn-by-turn directions to your destination on your glasses display.",
        NSBluetoothPeripheralUsageDescription: "This app needs access to your Bluetooth to connect to your glasses.",
        NSCalendarsUsageDescription:
          "Mentra accesses your calendar to display upcoming events and reminders directly on your smart glasses. For example, the app can show 'Meeting with John at 3 PM in Conference Room A' or remind you '15 minutes until dentist appointment' on your glasses display.",
        NSCalendarsFullAccessUsageDescription:
          "Mentra accesses your calendar to display upcoming events and reminders directly on your smart glasses. For example, the app can show 'Meeting with John at 3 PM in Conference Room A' or remind you '15 minutes until dentist appointment' on your glasses display.",
        NSCalendarUsageDescription:
          "Mentra accesses your calendar to display upcoming events and reminders directly on your smart glasses. For example, the app can show 'Meeting with John at 3 PM in Conference Room A' or remind you '15 minutes until dentist appointment' on your glasses display.",
        NSPhotoLibraryUsageDescription:
          "This app needs access to your photo library to provide you with photo based information on your glasses.",
        NSPhotoLibraryAddUsageDescription:
          "Allow Mentra to save photos and videos from your glasses to your camera roll.",
        NSUserNotificationUsageDescription:
          "This app needs access to your notifications to provide you with notifications.",
        NSLocalNetworkUsageDescription:
          "Mentra needs to access your local network to connect to Mentra Live glasses for viewing photos and media stored on the device.",
        NSBonjourServices: ["_mentra-live._tcp", "_http._tcp"],
        NSAppTransportSecurity: {
          NSAllowsLocalNetworking: true,
          NSAllowsArbitraryLoads: true,
          NSExceptionDomains: {
            localhost: {
              NSExceptionAllowsInsecureHTTPLoads: true,
            },
          },
        },
        UIBackgroundModes: ["bluetooth-central", "audio", "location", "processing", "fetch"],
        NSLocationAlwaysAndWhenInUseUsageDescription:
          "Mentra requires background location access to deliver continuous updates for apps like navigation and running, even when the app isn't in the foreground.",
        UIRequiresFullScreen: true,
        UISupportedInterfaceOrientations: [
          "UIInterfaceOrientationPortrait",
          "UIInterfaceOrientationPortraitUpsideDown",
        ],
        BGTaskSchedulerPermittedIdentifiers: ["com.mentra.background-timer"],
      },
      config: {
        usesNonExemptEncryption: false,
      },
      entitlements: {
        "com.apple.developer.networking.wifi-info": true,
        "com.apple.developer.networking.HotspotConfiguration": true,
      },
    },
    plugins: [
      // our custom plugins:
      "./plugins/remove-ipad-orientations.js",
      "./plugins/android.ts",
      [
        "./modules/bluetooth-sdk/app.plugin.js",
        {
          node: true,
        },
      ],
      // "./plugins/withSplashScreen.ts",
      // library plugins:
      "expo-asset",
      "expo-localization",
      "expo-font",
      [
        "expo-media-library",
        {
          photosPermission: "Allow Mentra to save photos from your glasses.",
          savePhotosPermission: "Allow Mentra to save photos from your glasses.",
          // Disabled - we save photos from glasses, we don't need to read EXIF location from user's library
          // Google Play rejects ACCESS_MEDIA_LOCATION for apps without core photo gallery functionality
          isAccessMediaLocationEnabled: false,
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/logo/logo_light.png",
          resizeMode: "cover",
          imageWidth: 100,
          backgroundColor: "#fff",
          dark: {
            // backgroundColor: "#fff",
            backgroundColor: "#171717",
            image: "./assets/logo/logo_dark.png",
          },
        },
      ],
      "expo-router",
      [
        "react-native-permissions",
        {
          iosPermissions: [
            "Camera",
            "Microphone",
            "Calendars",
            "Bluetooth",
            "LocationAccuracy",
            "LocationWhenInUse",
            "LocationAlways",
            "Notifications",
            "PhotoLibrary",
            "PhotoLibraryAddOnly", // For save-only operations (no "select photos" prompt)
          ],
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission: "Allow $(PRODUCT_NAME) to access your camera",
          recordAudioAndroid: true,
        },
      ],
      // "react-native-bottom-tabs",
      [
        "expo-build-properties",
        {
          android: {
            minSdkVersion: 28,
            targetSdkVersion: 35,
            compileSdkVersion: 36,
          },
          ios: {
            deploymentTarget: "15.5", // for react-native-zip-archive
            extraPods: [
              {
                name: "FirebaseCore",
                modular_headers: true,
              },
              {
                name: "FirebaseCoreInternal",
                modular_headers: true,
              },
              {
                name: "FirebaseInstallations",
                modular_headers: true,
              },
              {
                name: "GoogleAppMeasurement",
                modular_headers: true,
              },
              {
                name: "GoogleUtilities",
                modular_headers: true,
              },
              {
                name: "nanopb",
                modular_headers: true,
              },
              {
                name: "SDWebImage",
                modular_headers: true,
              },
              {
                name: "SDWebImageSVGCoder",
                modular_headers: true,
              },
            ],
          },
          // buildReactNativeFromSource: true,
          // useHermesV1: true
        },
      ],
      [
        "@sentry/react-native/expo",
        {
          url: "https://sentry.io/",
          project: "mentra-os",
          organization: "mentra-labs",
          experimental_android: {
            enableAndroidGradlePlugin: false,
            autoUploadProguardMapping: true,
            includeProguardMapping: true,
            dexguardEnabled: true,
            uploadNativeSymbols: true,
            autoUploadNativeSymbols: true,
            includeNativeSources: true,
            includeSourceContext: true,
          },
        },
      ],
      "@livekit/react-native-expo-plugin",
      "@config-plugins/react-native-webrtc",
      [
        "expo-location",
        {
          locationAlwaysAndWhenInUsePermission: "Allow Mentra to use your location.",
        },
      ],
      "@react-native-firebase/app",
      "expo-audio",
      [
        "expo-video",
        {
          supportsBackgroundPlayback: true,
          supportsPictureInPicture: true,
        },
      ],
      "expo-web-browser",
    ],
    experiments: {
      tsconfigPaths: true,
      typedRoutes: true,
    },
  }
}
