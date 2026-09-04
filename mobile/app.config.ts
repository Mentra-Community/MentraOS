import "tsx/cjs"
import {ExpoConfig, ConfigContext} from "@expo/config"
import {getBuildNumber} from "./scripts/build-number.mjs"

const familyBaseVersion = require("../package.json").version as string

const VARIANTS = {
  default: {
    appName: "Mentra",
    packageName: "com.mentra.mentra",
    includeFirebase: true,
    googleServicesFile: "./google-services.json",
    googleServicesPlist: "./GoogleService-Info.plist",
    icon: "./assets/app-icons/ic_launcher.png",
    adaptiveIcon: "./assets/app-icons/ic_launcher_foreground.png",
  },
  cn: {
    appName: "Mentra",
    packageName: "com.mentra.mentra.cn",
    includeFirebase: false,
    googleServicesFile: null,
    googleServicesPlist: null,
    icon: "./assets/app-icons/ic_launcher_china.png",
    adaptiveIcon: "./assets/app-icons/ic_launcher_foreground_china.png",
  },
  stable: {
    appName: "Mentra Stable",
    packageName: "com.mentra.mentra.stable",
    includeFirebase: true,
    googleServicesFile: "./google-services.json",
    googleServicesPlist: "./GoogleService-Info.plist",
    icon: "./assets/app-icons/ic_launcher.png",
    adaptiveIcon: "./assets/app-icons/ic_launcher_foreground.png",
  },
} as const

const variant = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china" ? VARIANTS.cn : VARIANTS.default

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
  const isValidVariant = variantName && /^[a-zA-Z][a-zA-Z0-9_ ]*$/.test(variantName)
  if (variantName && !isValidVariant) {
    throw new Error(
      `MENTRAOS_BUILD_NAME="${variantName}" is invalid. Must start with a letter and contain only letters, digits, spaces, or underscores.`,
    )
  }
  const appName = isValidVariant ? variantName : variant.appName
  const baseId = variant.packageName
  // replace non-alphanumeric characters with underscores:
  const normalizedVariantId = variantName?.toLowerCase().replace(/[^a-zA-Z0-9_]/g, "")
  const androidPackage = isValidVariant ? `${baseId}.${normalizedVariantId}` : baseId
  const iosBundleId = isValidVariant ? `${baseId}.${normalizedVariantId}` : baseId

  // Mapbox runtime token (pk.…) — boots the Mapbox Navigation SDK v3 on BOTH
  // platforms now (iOS migrated off Google Nav to match Android). Injected as:
  //   • Android: AndroidManifest meta-data `com.mapbox.token` (read by
  //     NavigationManager.kt → MapboxOptions.accessToken).
  //   • iOS: Info.plist `MBXAccessToken` (read by the Mapbox iOS SDK at boot).
  // Public token, safe to ship; the secret Downloads:Read token (sk.…) is
  // build-time-only and lives in ~/.gradle/gradle.properties (Android) / the
  // CocoaPods netrc (iOS), never here. Fail loudly in CI/EAS, warn in local
  // dev. See issues/mapbox-navigation-migration.md.
  // The China build (cn variant) ships without Mentra Map, so it has no nav
  const isChinaBuild = variant === VARIANTS.cn
  const mapboxAccessToken = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN ?? ""
  if (!mapboxAccessToken && !isChinaBuild) {
    const isCiOrEas =
      process.env.CI === "true" ||
      process.env.CI === "1" ||
      process.env.EAS_BUILD === "true" ||
      process.env.NODE_ENV === "production"
    const msg =
      "EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN is not set. Navigation (iOS + Android) will fail at " +
      "runtime — set it in mobile/.env (see mobile/.env.example) before building."
    if (isCiOrEas) {
      throw new Error(msg)
    }
    console.warn(`[mobile/app.config] ${msg}`)
  }

  const buildNumber = getBuildNumber()

  return {
    ...config,
    name: appName,
    slug: "Mentra",
    // Coordinated prereleases expose their full identity (for example,
    // 3.1.0-beta.57) to shipped JavaScript while stores retain the plain
    // marketing version so the exact tested binary can be promoted.
    version: process.env.MENTRAOS_NATIVE_MARKETING_VERSION || familyBaseVersion,
    scheme: "com.mentra",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    icon: variant.icon,
    updates: {
      fallbackToCacheTimeout: 0,
    },
    jsEngine: "hermes",
    assetBundlePatterns: ["**/*"],
    android: {
      // icon: "./assets/app-icons/ic_launcher.png",
      package: androidPackage,
      ...(variant.googleServicesFile ? {googleServicesFile: variant.googleServicesFile} : {}),
      versionCode: buildNumber,
      adaptiveIcon: {
        foregroundImage: variant.adaptiveIcon,
        // backgroundImage: "./assets/app-icons/ic_launcher.png",
        backgroundColor: "#fff",
      },
      allowBackup: false,
      permissions: [
        "ACCESS_FINE_LOCATION",
        "NEARBY_WIFI_DEVICES",
        "ACCESS_WIFI_STATE",
        "ACCESS_NETWORK_STATE",
        "CHANGE_WIFI_STATE",
        "CHANGE_NETWORK_STATE",
      ],
      // The Google Navigation SDK manifest merges in ACCESS_BACKGROUND_LOCATION,
      // but navigation runs in a location foreground service and works with
      // while-in-use permission only. Blocking it avoids the Play Store
      // background-location declaration/video review.
      blockedPermissions: ["android.permission.ACCESS_BACKGROUND_LOCATION"],
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
      icon: variant.icon,
      supportsTablet: false,
      requireFullScreen: true,
      buildNumber: String(buildNumber),
      bundleIdentifier: iosBundleId,
      appleTeamId: "T5XXXL6N36",
      ...(variant.googleServicesPlist ? {googleServicesFile: variant.googleServicesPlist} : {}),
      associatedDomains: ["applinks:apps.mentra.glass", "applinks:apps.mentraglass.com"],
      infoPlist: {
        // Native collection must remain off until the deployment profile has
        // been restored. FirebaseAnalyticsSetup enables it for consumer or
        // explicitly opted-in workspace deployments.
        FIREBASE_ANALYTICS_COLLECTION_ENABLED: false,
        CFBundleURLTypes: [
          {
            CFBundleURLSchemes: ["com.mentra"],
          },
          {
            CFBundleURLSchemes: [`msauth.${iosBundleId}`],
          },
        ],
        LSApplicationQueriesSchemes: ["msauthv2", "msauthv3"],
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
        NSCalendarsWriteOnlyAccessUsageDescription:
          "Mentra uses write-only calendar access to add events requested by miniapps to your calendar.",
        NSCalendarUsageDescription:
          "Mentra accesses your calendar to display upcoming events and reminders directly on your smart glasses. For example, the app can show 'Meeting with John at 3 PM in Conference Room A' or remind you '15 minutes until dentist appointment' on your glasses display.",
        NSPhotoLibraryUsageDescription:
          "This app needs access to your photo library to provide you with photo based information on your glasses.",
        NSPhotoLibraryAddUsageDescription:
          "Allow Mentra to save photos and videos from your glasses to your camera roll.",
        NSUserNotificationUsageDescription:
          "This app needs access to your notifications to provide you with notifications.",
        NSLocalNetworkUsageDescription:
          "Mentra uses your local network to exchange photos, media, and verified software updates with Mentra Live glasses.",
        // Required because miniapps subscribed to `heading_update` cause
        // the host's HeadingService to read the device compass via
        // CoreMotion. iOS hard-crashes any access to motion sensors
        // without this usage string declared.
        NSMotionUsageDescription:
          "Mentra reads your device compass to show heading direction in navigation and similar miniapps on your glasses.",
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
        // Mapbox Navigation SDK v3 (iOS) reads its public access token from
        // Info.plist under `MBXAccessToken` at boot. Replaces the old
        // GOOGLE_NAV_API_KEY now that iOS nav is Mapbox (matching Android,
        // which injects the same pk.… token as AndroidManifest meta-data).
        // Public token, safe to ship.
        MBXAccessToken: mapboxAccessToken,
      },
      config: {
        usesNonExemptEncryption: false,
      },
      entitlements: {
        // Preserve the app's default keychain namespace while adding MSAL's
        // shared cache group. Replacing the default group makes existing app
        // credentials unreadable after an upgrade.
        "keychain-access-groups": [
          `$(AppIdentifierPrefix)${iosBundleId}`,
          "$(AppIdentifierPrefix)com.microsoft.adalcache",
        ],
        "com.apple.developer.networking.wifi-info": true,
        "com.apple.developer.networking.HotspotConfiguration": true,
      },
    },
    plugins: [
      // our custom plugins:
      "./plugins/remove-ipad-orientations.js",
      // crust's own config plugin carries its Android build contract (Mapbox
      // downloads repo, protobuf-javalite exclusion, core-library desugaring).
      "@mentra/crust",
      "./plugins/android.ts",
      // Mapbox Navigation SDK v3 for iOS — added as a Swift Package (SPM is the
      // ONLY supported v3 install path; CocoaPods can't resolve it). The
      // mapbox-navigation-ios package transitively brings MapboxMaps,
      // MapboxCommon, MapboxCoreMaps, and Turf, so SPM is the SOLE Mapbox
      // provider. We intentionally do NOT use @rnmapbox/maps — its CocoaPods
      // copies of those same frameworks collided with SPM's at the build-graph
      // level ("Multiple commands produce …MapboxCommon.framework"). The runtime
      // pk. token is injected into Info.plist as MBXAccessToken (above); the
      // secret Downloads:Read token is read from ~/.netrc at build time.
      "./plugins/mapbox-nav-ios.ts",
      // Crust is a CocoaPods target; SPM products linked to the app project
      // aren't visible to it. This links the Mapbox products into the Crust
      // pod target (via Podfile post_install) so its Swift can import them.
      "./plugins/mapbox-nav-crust-link.ts",
      // Xcode 26 rejects pod resource-bundle targets still pinned to iOS 11.
      "./plugins/ios-pod-min-deployment-target.ts",
      [
        "./modules/bluetooth-sdk/app.plugin.js",
        {
          node: true,
          // The Mentra App sends identified support telemetry through Cloud V2.
          // Keep the SDK's anonymous analytics enabled by default for standalone
          // integrators, but disable the duplicate embedded copy in this host.
          analytics: false,
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
            "CalendarsWriteOnly",
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
            enableCoreLibraryDesugaring: true,
          },
          ios: {
            deploymentTarget: "15.5", // for react-native-zip-archive
            extraPods: [
              {
                // AzureCommunicationCalling is a dynamic binary framework and
                // links AzureCommunicationCommon as another dynamic framework.
                // The public Common CocoaPod builds a static library unless the
                // entire React Native project enables use_frameworks!, which is
                // incompatible with other binary dependencies in this app. Use
                // Microsoft's official Common XCFramework (the same artifact its
                // SwiftPM package consumes) through our small local podspec.
                name: "AzureCommunicationCommon",
                podspec: "../podspecs/AzureCommunicationCommon.podspec",
              },
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
      ...(variant.includeFirebase ? ["@react-native-firebase/app"] : []),
      "expo-audio",
      [
        "expo-video",
        {
          supportsBackgroundPlayback: true,
          supportsPictureInPicture: true,
        },
      ],
      "expo-web-browser",
      "expo-image",
    ],
    experiments: {
      tsconfigPaths: true,
      typedRoutes: true,
    },
  }
}
