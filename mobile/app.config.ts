import "tsx/cjs"
import {ExpoConfig, ConfigContext} from "@expo/config"

/**
 * @param config ExpoConfig coming from the static config app.json if it exists
 *
 * You can read more about Expo's Configuration Resolution Rules here:
 * https://docs.expo.dev/workflow/configuration/#configuration-resolution-rules
 */
module.exports = ({config}: ConfigContext): Partial<ExpoConfig> => {
  return {
    ...config,
    name: "MentraOS",
    slug: "MentraOS",
    version: process.env.EXPO_PUBLIC_MENTRAOS_VERSION || "0.0.1",
    scheme: "com.mentra",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    icon: "./assets/app-icons/ic_launcher.png",
    updates: {
      fallbackToCacheTimeout: 0,
    },
    newArchEnabled: true,
    jsEngine: "hermes",
    assetBundlePatterns: ["**/*"],
    android: {
      icon: "./assets/app-icons/ic_launcher.png",
      package: "com.mentra.mentra",
      versionCode: 64,
      adaptiveIcon: {
        foregroundImage: "./assets/app-icons/ic_launcher_foreground.png",
        backgroundImage: "./assets/app-icons/ic_launcher.png",
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
          ],
          category: ["DEFAULT", "BROWSABLE"],
        },
      ],
    },
    ios: {
      icon: "./assets/app-icons/ic_launcher.png",
      supportsTablet: false,
      requireFullScreen: true,
      bundleIdentifier: "com.mentra.mentra",
      associatedDomains: ["applinks:apps.mentra.glass"],
      infoPlist: {
        NSCameraUsageDescription: "This app needs access to your camera to capture images.",
        NSMicrophoneUsageDescription:
          "MentraOS uses your microphone to enable the 'Hey Mira' AI assistant and provide live captions for deaf and hard-of-hearing users on smart glasses. For example, you can say 'Hey Mira, what's on my calendar today?' or the app can caption conversations in real-time on your glasses display.",
        NSBluetoothAlwaysUsageDescription: "This app needs access to your Bluetooth to connect to your glasses.",
        NSLocationWhenInUseUsageDescription:
          "MentraOS uses your location to display nearby points of interest, weather updates, and navigation directions on your smart glasses. For example, when you're walking, the app can show restaurants within 100 meters or provide turn-by-turn directions to your destination on your glasses display.",
        NSBluetoothPeripheralUsageDescription: "This app needs access to your Bluetooth to connect to your glasses.",
        NSCalendarsUsageDescription:
          "MentraOS accesses your calendar to display upcoming events and reminders directly on your smart glasses. For example, the app can show 'Meeting with John at 3 PM in Conference Room A' or remind you '15 minutes until dentist appointment' on your glasses display.",
        NSCalendarsFullAccessUsageDescription:
          "MentraOS accesses your calendar to display upcoming events and reminders directly on your smart glasses. For example, the app can show 'Meeting with John at 3 PM in Conference Room A' or remind you '15 minutes until dentist appointment' on your glasses display.",
        NSCalendarUsageDescription:
          "MentraOS accesses your calendar to display upcoming events and reminders directly on your smart glasses. For example, the app can show 'Meeting with John at 3 PM in Conference Room A' or remind you '15 minutes until dentist appointment' on your glasses display.",
        NSPhotoLibraryUsageDescription:
          "This app needs access to your photo library to provide you with photo based information on your glasses.",
        NSPhotoLibraryAddUsageDescription:
          "Allow MentraOS to save photos and videos from your glasses to your camera roll.",
        NSUserNotificationUsageDescription:
          "This app needs access to your notifications to provide you with notifications.",
        NSLocalNetworkUsageDescription:
          "MentraOS needs to access your local network to connect to Mentra Live glasses for viewing photos and media stored on the device.",
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
        UIBackgroundModes: ["bluetooth-central", "audio", "location"],
        NSLocationAlwaysAndWhenInUseUsageDescription:
          "MentraOS requires background location access to deliver continuous updates for apps like navigation and running, even when the app isn't in the foreground.",
        UIRequiresFullScreen: true,
        UISupportedInterfaceOrientations: [
          "UIInterfaceOrientationPortrait",
          "UIInterfaceOrientationPortraitUpsideDown",
        ],
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
        "./modules/core/app.plugin.js",
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
          photosPermission: "Allow MentraOS to save photos from your glasses.",
          savePhotosPermission: "Allow MentraOS to save photos from your glasses.",
          isAccessMediaLocationEnabled: true,
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/splash/splash.png",
          resizeMode: "contain",
          backgroundColor: "#fffaf0",
          dark: {
            backgroundColor: "#2D2C2F",
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
            extraPods: [
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
          locationAlwaysAndWhenInUsePermission: "Allow MentraOS to use your location.",
        },
      ],
      "expo-audio",
      "expo-av",
    ],
    experiments: {
      tsconfigPaths: true,
      typedRoutes: true,
    },
  }
}
