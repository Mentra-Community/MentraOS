import CoreModule from "core"
import {Alert, Linking, PermissionsAndroid, Platform} from "react-native"
import BleManager from "react-native-ble-manager"
import {check, PERMISSIONS, request, RESULTS} from "react-native-permissions"

import {translate} from "@/i18n"
import {Theme} from "@/theme"
import showAlert, {showBluetoothAlert, showLocationAlert, showLocationServicesAlert} from "@/utils/AlertUtils"
import {checkAndRequestNotificationAccessSpecialPermission} from "@/utils/NotificationServiceUtils"
import {storage} from "@/utils/storage/storage"

import {AppletInterface, AppletPermission} from "@/../../cloud/packages/types/src"

// Define permission features with their required permissions
export const PermissionFeatures: Record<string, string> = {
  BASIC: "basic", // Basic permissions needed for the app to function
  POST_NOTIFICATIONS: "post_notifications",
  READ_NOTIFICATIONS: "read_notifications",
  CAMERA: "camera", // Phone camera permission for mirror mode
  GLASSES_CAMERA: "glasses_camera", // Glasses camera permission for apps
  MICROPHONE: "microphone",
  CALENDAR: "calendar",
  LOCATION: "location",
  BACKGROUND_LOCATION: "background_location",
  BATTERY_OPTIMIZATION: "battery_optimization",
  PHONE_STATE: "phone_state", // Phone state permission for device identification
  BLUETOOTH: "bluetooth", // Bluetooth permission for connecting to glasses
}

// Define permission configuration interface
interface PermissionConfig {
  name: string
  description: string
  ios: any[] // Using any to accommodate various permission types
  android: any[] // Using any to accommodate various permission types
  critical: boolean
}

// Define permission configurations
const PERMISSION_CONFIG: Record<string, PermissionConfig> = {
  [PermissionFeatures.BASIC]: {
    name: "Basic Permissions",
    description: "Basic permissions required for AugmentOS to function",
    ios: [], // Different approach for iOS - we'll handle these individually
    android: [], // Will be set dynamically based on Android version, excluding Bluetooth which is handled in pairing flow
    critical: true, // App can't function without these
  },
  [PermissionFeatures.POST_NOTIFICATIONS]: {
    name: "Notifications",
    description: "Allow AugmentOS to send you notifications",
    ios: ["post_notifications"],
    android:
      typeof Platform.Version === "number" && Platform.Version >= 33
        ? [PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS]
        : [],
    critical: false,
  },
  [PermissionFeatures.READ_NOTIFICATIONS]: {
    name: "Notification Access",
    description: "Allow AugmentOS to forward notifications to your glasses",
    ios: [], // iOS notification permission
    android:
      typeof Platform.Version === "number" && Platform.Version >= 33
        ? [PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS]
        : [],
    critical: false,
  },
  [PermissionFeatures.CAMERA]: {
    name: "Camera",
    description: "Used for the fullscreen mirror mode",
    ios: [PERMISSIONS.IOS.CAMERA],
    android: [PermissionsAndroid.PERMISSIONS.CAMERA],
    critical: false,
  },
  [PermissionFeatures.GLASSES_CAMERA]: {
    name: "Glasses Camera",
    description: "Allows apps to access the smart glasses camera for photo capture and video streaming",
    ios: [], // No OS-level permission required
    android: [], // No OS-level permission required
    critical: false,
  },
  [PermissionFeatures.MICROPHONE]: {
    name: "Microphone",
    description: "Used for audio and voice commands on your glasses",
    ios: [PERMISSIONS.IOS.MICROPHONE],
    android: [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO],
    critical: false,
  },
  [PermissionFeatures.CALENDAR]: {
    name: "Calendar",
    description: "Used to display your events on your glasses",
    ios: [PERMISSIONS.IOS.CALENDARS],
    android: [PermissionsAndroid.PERMISSIONS.READ_CALENDAR, PermissionsAndroid.PERMISSIONS.WRITE_CALENDAR],
    critical: false,
  },
  [PermissionFeatures.LOCATION]: {
    name: "Location",
    description: "Used for navigation and location-based services",
    ios: [PERMISSIONS.IOS.LOCATION_WHEN_IN_USE],
    android: [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION],
    critical: false,
  },
  [PermissionFeatures.BACKGROUND_LOCATION]: {
    name: "Background Location",
    description: "Used to track location when the app is in the background",
    ios: [PERMISSIONS.IOS.LOCATION_WHEN_IN_USE, PERMISSIONS.IOS.LOCATION_ALWAYS],
    // android:
    //   typeof Platform.Version === "number" && Platform.Version >= 29
    //     ? [PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION]
    //     : [],
    // regular location permission is enough for background location on Android
    android: [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION],
    critical: false,
  },
  [PermissionFeatures.BLUETOOTH]: {
    name: "Bluetooth",
    description: "Used to connect to your glasses",
    ios: [PERMISSIONS.IOS.BLUETOOTH], // iOS Bluetooth permission (correct constant)
    android:
      Platform.OS === "android" && typeof Platform.Version === "number" && Platform.Version >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          ]
        : [], // For Android 12+, include the Bluetooth permissions in the normal flow
    critical: true, // Critical for glasses pairing
  },
  [PermissionFeatures.PHONE_STATE]: {
    name: "Phone State",
    description: "Used to identify your device to connect to glasses",
    ios: [], // iOS doesn't use this permission
    android: [PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE],
    critical: true, // Critical for pairing with glasses
  },
}

// Initialize Android basic permissions based on device version
if (Platform.OS === "android") {
  const basicPermissions = []

  // Storage permissions based on Android version
  if (Platform.Version < 29) {
    basicPermissions.push(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE)
  }
  if (Platform.Version < 33) {
    basicPermissions.push(PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE)
  }

  if (Platform.Version >= 31) {
    // Android 12+ (API 31+) requires explicit runtime permission for Bluetooth
    // Android 14+ (API 34+) requires these for foreground services with type "connectedDevice"
    console.log("Adding Bluetooth permissions to basic permissions for Android 12+/14+")

    // These three permissions are required for Bluetooth operations on Android 12+
    basicPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN)
    basicPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT)
    basicPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE)
  }
  // Bluetooth permissions are now handled in the pairing flow
  // NOT requesting here anymore:
  // - BLUETOOTH, BLUETOOTH_ADMIN (Android 11)
  // - BLUETOOTH_SCAN, BLUETOOTH_CONNECT, BLUETOOTH_ADVERTISE (Android 12+)

  // Phone state permission moved to pairing flow

  PERMISSION_CONFIG[PermissionFeatures.BASIC].android = basicPermissions
}

// Track which permission has been requested
export const markPermissionRequested = async (featureKey: string): Promise<void> => {
  const res = await storage.save(`PERMISSION_REQUESTED_${featureKey}`, true)
  if (res.is_error()) {
    console.error("Failed to save permission requested status", res.error)
  }
}

export const markPermissionNotRequested = async (featureKey: string): Promise<void> => {
  const res = await storage.remove(`PERMISSION_REQUESTED_${featureKey}`)
  if (res.is_error()) {
    console.error("Failed to remove permission requested status", res.error)
  }
}

// Check if a permission has been requested before
export const hasPermissionBeenRequested = async (featureKey: string): Promise<boolean> => {
  const res = storage.load<boolean>(`PERMISSION_REQUESTED_${featureKey}`)
  if (res.is_error()) {
    console.error("Failed to get permission requested status", res.error)
    return false
  }
  return true
}

export const markPermissionGranted = async (featureKey: string): Promise<void> => {
  const res = await storage.save(`PERMISSION_GRANTED_${featureKey}`, true)
  if (res.is_error()) {
    console.error("Failed to save permission granted status", res.error)
  }
}

export const hasPermissionBeenGranted = async (featureKey: string): Promise<boolean> => {
  const res = storage.load<boolean>(`PERMISSION_GRANTED_${featureKey}`)
  if (res.is_error()) {
    console.log("Failed to get permission granted status", res.error)
    return false
  }
  return true
}

// Battery optimization permission temporarily disabled
// Function to handle battery optimization permission
export const requestBatteryOptimizationPermission = async (): Promise<boolean> => {
  // Always return true for now since battery optimization is disabled
  return true

  // if (Platform.OS !== 'android') return true;

  // try {
  //   // Check if we need to request battery optimization permission
  //   const PowerManager = (Platform as any).NativeModules.PowerManager;
  //   if (!PowerManager) {
  //     console.log('PowerManager module not available');
  //     return false;
  //   }

  //   const isIgnoringBatteryOptimizations = await PowerManager.isIgnoringBatteryOptimizations();

  //   if (!isIgnoringBatteryOptimizations) {
  //     return new Promise((resolve) => {
  //       Alert.alert(
  //         'Disable Battery Optimization',
  //         'This application needs to remain active in the background to function properly. ' +
  //         'Please disable battery optimization for better performance and reliability.',
  //         [
  //           {
  //             text: 'Go to Settings',
  //             onPress: () => {
  //               // Open battery optimization settings
  //               Linking.openSettings();
  //               resolve(true);
  //             },
  //           },
  //           {
  //             text: 'Skip',
  //             style: 'cancel',
  //             onPress: () => resolve(false),
  //           },
  //         ],
  //         { cancelable: false }
  //       );
  //     });
  //   }

  //   return true;
  // } catch (error) {
  //   console.error('Error checking battery optimization status:', error);
  //   return false;
  // }
}

// Function to request background location
export const requestBackgroundLocationPermission = async (): Promise<boolean> => {
  if (Platform.OS !== "android") {
    // For iOS, we already request background location as part of location
    return true
  }

  if (typeof Platform.Version !== "number" || Platform.Version < 29) {
    // No special handling needed for Android < 10
    return true
  }

  // For Android 10+, need to request separately after other permissions
  try {
    const backgroundLocationPermission = PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION

    // First check if we already have the permission
    const hasPermission = await PermissionsAndroid.check(backgroundLocationPermission)
    if (hasPermission) {
      return true
    }

    // Need to show dialog first explaining why we need background location
    return new Promise(resolve => {
      Alert.alert(
        "Background Location Permission",
        "MentraOS needs access to your location when the app is in the background " +
          "to provide continuous tracking and location-based features. " +
          'On the next screen, please select "Allow all the time".',
        [
          {
            text: "Continue",
            onPress: async () => {
              try {
                const result = await PermissionsAndroid.request(backgroundLocationPermission)
                resolve(result === PermissionsAndroid.RESULTS.GRANTED)
              } catch (error) {
                console.error("Error requesting background location permission:", error)
                resolve(false)
              }
            },
          },
          {
            text: "Skip",
            style: "cancel",
            onPress: () => resolve(false),
          },
        ],
        {cancelable: false},
      )
    })
  } catch (error) {
    console.error("Error in background location permission flow:", error)
    return false
  }
}

// Define a more detailed result type for permission requests
export interface PermissionRequestResult {
  granted: boolean
  previouslyDenied: boolean
}

// Request permissions for a specific feature - the main entry point
export const requestFeaturePermissions = async (featureKey: string): Promise<boolean> => {
  const config = PERMISSION_CONFIG[featureKey]
  if (!config) {
    console.error(`Unknown permission feature: ${featureKey}`)
    return false
  }

  let allGranted = true
  let partiallyGranted = false

  // For iOS, check if previously denied before attempting to request
  if (Platform.OS === "ios" && config.ios.length > 0) {
    for (const permission of config.ios) {
      try {
        // Check current status before requesting
        const currentStatus = await check(permission)
        console.log(`Current status for ${permission}:`, currentStatus)

        if (permission === PERMISSIONS.IOS.LOCATION_WHEN_IN_USE && currentStatus === RESULTS.DENIED) {
          // reset the permission request status for background location
          await markPermissionNotRequested(PERMISSIONS.IOS.LOCATION_ALWAYS)
        }

        if (permission === PERMISSIONS.IOS.LOCATION_ALWAYS && currentStatus === RESULTS.BLOCKED) {
          // if we've already requested this permission before, show the dialog to direct user to Settings
          if (await hasPermissionBeenRequested(permission)) {
            await handlePreviouslyDeniedPermission(config.name)
            return false
          }
          await markPermissionRequested(permission)
          // ignore the fact that this reports as blocked, since that's just how the flow for this permission works
          continue
        }

        // If permission is blocked at system level, handle it differently
        if (currentStatus === RESULTS.BLOCKED) {
          console.log(`Permission ${permission} is BLOCKED by system`)
          // Show dialog to direct user to Settings
          await handlePreviouslyDeniedPermission(config.name)
          return false // Just return false since we've handled the alert internally
        }
      } catch (error) {
        console.error(`Error checking permission status: ${error}`)
      }
    }
  }

  // Mark this feature as having been requested
  await markPermissionRequested(featureKey)

  // If this feature does not require any OS-level permissions (e.g., glasses camera),
  // we treat it as granted after recording the grant locally and return early.
  if (config.android.length === 0 && config.ios.length === 0) {
    await markPermissionGranted(featureKey)
    return true
  }

  // For Android
  if (Platform.OS === "android" && config.android.length > 0) {
    try {
      // Filter out any null/undefined permissions before requesting
      console.log(`${featureKey} original permissions:`, config.android)
      console.log(
        `${featureKey} permission values:`,
        config.android.map(p => `${p} (${typeof p})`),
      )

      const validPermissions = config.android.filter(permission => permission != null)
      console.log(`${featureKey} valid permissions after filtering:`, validPermissions)

      if (validPermissions.length === 0) {
        console.warn(`No valid permissions to request for feature: ${featureKey}`)
        return false
      }

      // Request all permissions for this feature
      const results = await PermissionsAndroid.requestMultiple(validPermissions)
      console.log(`${featureKey} permissions results:`, results)

      // Check each permission result
      let hasGranted = false
      let allDenied = true
      let anyNeverAskAgain = false

      Object.entries(results).forEach(([_permission, result]) => {
        if (result === PermissionsAndroid.RESULTS.GRANTED) {
          hasGranted = true
          allDenied = false
        } else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
          anyNeverAskAgain = true
          allDenied = false
        } else if (result !== PermissionsAndroid.RESULTS.DENIED) {
          allDenied = false
        }
      })

      // Handle "Never Ask Again" case similar to iOS previouslyDenied
      if (anyNeverAskAgain) {
        // Handle the previously denied permission by showing the alert
        await handlePreviouslyDeniedPermission(config.name)
        // Just return false, since we've handled the alert internally
        return false
      }

      if (hasGranted && !allDenied) {
        partiallyGranted = true
      }

      if (allDenied && config.critical) {
        // Show critical permission denied message for essential features
        await displayCriticalPermissionDeniedWarning(config.name)
        return false
      }

      if (!hasGranted && config.critical) {
        // Show warning for critical features
        await displayPermissionDeniedWarning(config.name)
        return false
      }

      allGranted = Object.values(results).every(value => value === PermissionsAndroid.RESULTS.GRANTED)
    } catch (error) {
      console.error(`Error requesting ${featureKey} permissions:`, error)
      return false
    }
  }

  // For iOS
  if (Platform.OS === "ios" && config.ios.length > 0) {
    for (const permission of config.ios) {
      try {
        const result = await request(permission)
        if (result === RESULTS.GRANTED) {
          partiallyGranted = true
          await markPermissionGranted(permission)
        } else if (result === RESULTS.LIMITED) {
          partiallyGranted = true
          allGranted = false
        } else if (result === RESULTS.BLOCKED) {
          // Permission is blocked at the system level
          allGranted = false

          // This shouldn't happen as we checked before, but just in case
          if (config.critical) {
            await handlePreviouslyDeniedPermission(config.name)
            return false // Just return false since we've handled the alert internally
          }
        } else {
          allGranted = false

          if (config.critical) {
            await displayPermissionDeniedWarning(config.name)
            return false
          }
        }
      } catch (error) {
        console.error(`Error requesting iOS permission ${permission}:`, error)
        allGranted = false
      }
    }
  }

  // For special case of Android notification access
  if (featureKey === PermissionFeatures.READ_NOTIFICATIONS && Platform.OS === "android") {
    const notificationAccess = await CoreModule.hasNotificationListenerPermission()
    if (!notificationAccess) {
      allGranted = false
    }
  }

  // Simply return boolean indicating if permission was granted
  return allGranted || partiallyGranted
}

// Display appropriate warning messages
export const displayPermissionDeniedWarning = (permissionName: string): Promise<boolean> => {
  return new Promise(resolve => {
    Alert.alert(
      `${permissionName} Permission Limited`,
      `Some features related to ${permissionName.toLowerCase()} may be limited or unavailable. You can enable full access in your device settings.`,
      [
        {
          text: "Settings",
          onPress: () => {
            Linking.openSettings()
            resolve(false)
          },
        },
        {
          text: "Continue Anyway",
          style: "default",
          onPress: () => resolve(true),
        },
      ],
    )
  })
}

export const displayCriticalPermissionDeniedWarning = (permissionName: string): Promise<boolean> => {
  return new Promise(resolve => {
    showAlert(
      `${permissionName} Required`,
      `AugmentOS needs ${permissionName.toLowerCase()} permissions to function properly. Please grant these permissions to continue.`,
      [
        {
          text: "Try Again",
          style: "default",
          onPress: () => resolve(true),
        },
      ],
    )
  })
}

// Helper function to handle permissions that were previously denied at the system level
export const handlePreviouslyDeniedPermission = (permissionName: string): Promise<boolean> => {
  return new Promise(resolve => {
    showAlert(
      "Permission Required",
      `${permissionName} permission is required but has been denied previously. Please enable it in your device settings.`,
      [
        {
          text: "Cancel",
          style: "cancel",
          onPress: () => resolve(false),
        },
        {
          text: "Open Settings",
          onPress: () => {
            Linking.openSettings()
            // Return false since we don't know if the user actually changed the setting
            resolve(false)
          },
        },
      ],
    )
  })
}

// Check if a feature has the permissions it needs
export const checkFeaturePermissions = async (featureKey: string): Promise<boolean> => {
  const config = PERMISSION_CONFIG[featureKey]
  if (!config) {
    console.error(`Unknown permission feature: ${featureKey}`)
    return false
  }

  // If this permission has no underlying OS-level mapping (e.g., glasses camera),
  // rely on our internal flag to determine if the user has already accepted it.
  if (config.android.length === 0 && config.ios.length === 0) {
    return await hasPermissionBeenGranted(featureKey)
  }

  // For Android
  if (Platform.OS === "android" && config.android.length > 0) {
    // Check if we have any required permissions for this feature
    for (const permission of config.android) {
      try {
        const hasPermission = await PermissionsAndroid.check(permission)
        if (hasPermission) {
          return true // We have at least one permission, feature can work
        }
      } catch (error) {
        console.error(`Error checking Android permission ${permission}:`, error)
      }
    }
  }

  // For iOS
  if (Platform.OS === "ios" && config.ios.length > 0) {
    let allGranted = true
    for (const permission of config.ios) {
      try {
        if (permission === "post_notifications" || permission === "notifications") {
          // const result = await checkNotifications();
          // if (result.status === RESULTS.GRANTED) {
          //   return true
          // }
          // return false
          // skip checking this permission on iOS for now as currently no App needs it
          return true
        }

        const status = await check(permission)
        if (status != RESULTS.GRANTED && status != RESULTS.LIMITED) {
          allGranted = false
        }

        if (permission === PERMISSIONS.IOS.CALENDARS) {
          // this permission is wierd and we should assume it's granted if we've been granted it before, but check for sure by requesting it:
          if (await hasPermissionBeenGranted(permission)) {
            // request the permission again to be sure (will do nothing if already granted)
            const result = await request(permission)
            if (result === RESULTS.GRANTED) {
              return true
            }
          }
        }
      } catch (error) {
        console.error(`Error checking iOS permission ${permission}:`, error)
      }
    }
    return allGranted
  }

  // Special case for notifications on Android
  if (featureKey === PermissionFeatures.READ_NOTIFICATIONS && Platform.OS === "android") {
    return await CoreModule.hasNotificationListenerPermission()
  }

  return false
}

export const askPermissionsUI = async (app: AppletInterface, theme: Theme): Promise<number> => {
  const neededPermissions = await checkPermissionsUI(app)

  if (neededPermissions.length == 0) {
    return 1
  }

  // Create a promise that resolves based on user action
  return new Promise<number>(resolve => {
    showAlert(
      neededPermissions.length > 1
        ? translate("home:permissionsRequiredTitle")
        : translate("home:permissionRequiredTitle"),
      translate("home:permissionMessage", {
        permissions: neededPermissions.map(perm => PERMISSION_CONFIG[perm]?.name || perm).join(", "),
      }),
      [
        {
          text: translate("common:cancel"),
          onPress: () => {
            resolve(-1)
          },
          style: "cancel",
        },
        {
          text: translate("common:next"),
          onPress: async () => {
            await requestPermissionsUI(neededPermissions)

            // Check if permissions were actually granted
            const stillNeededPermissions = await checkPermissionsUI(app)

            // If we still need READ_NOTIFICATIONS, don't auto-retry
            if (stillNeededPermissions.includes(PermissionFeatures.READ_NOTIFICATIONS) && Platform.OS === "android") {
              // Permission flow is in progress, user needs to complete it manually
              resolve(-1) // Return 0 to indicate "in progress" state
              return
            }

            // For other permissions that were granted, proceed
            if (stillNeededPermissions.length === 0) {
              resolve(1) // Success
            } else {
              // Still have missing permissions (other than READ_NOTIFICATIONS)
              resolve(0) // Failed to get all permissions
            }
          },
        },
      ],
      {
        iconName: "information-outline",
        iconColor: theme.colors.textDim,
      },
    )
  })
}

export const checkPermissionsUI = async (app: AppletInterface) => {
  let permissions = app.permissions || []
  const neededPermissions: string[] = []

  if (permissions.length == 1 && permissions[0].type == "ALL") {
    permissions = [
      {type: "MICROPHONE", required: true},
      {type: "CALENDAR", required: true},
      {type: "POST_NOTIFICATIONS", required: true},
      {type: "READ_NOTIFICATIONS", required: true},
      {type: "LOCATION", required: true},
      {type: "BACKGROUND_LOCATION", required: true},
    ] as AppletPermission[]
  }

  for (const permission of permissions) {
    if (!(permission["required"] ?? true)) {
      continue
    }
    switch (permission.type) {
      case "MICROPHONE":
        const hasMicrophone = await checkFeaturePermissions(PermissionFeatures.MICROPHONE)
        if (!hasMicrophone) {
          neededPermissions.push(PermissionFeatures.MICROPHONE)
        }
        break
      case "CAMERA":
        const hasCamera = await checkFeaturePermissions(PermissionFeatures.GLASSES_CAMERA)
        if (!hasCamera) {
          neededPermissions.push(PermissionFeatures.GLASSES_CAMERA)
        }
        break
      case "CALENDAR":
        const hasCalendar = await checkFeaturePermissions(PermissionFeatures.CALENDAR)
        if (!hasCalendar) {
          neededPermissions.push(PermissionFeatures.CALENDAR)
        }
        break
      case "LOCATION":
        const hasLocation = await checkFeaturePermissions(PermissionFeatures.LOCATION)
        if (!hasLocation) {
          neededPermissions.push(PermissionFeatures.LOCATION)
        }
        break
      case "BACKGROUND_LOCATION":
        const hasBackgroundLocation = await checkFeaturePermissions(PermissionFeatures.BACKGROUND_LOCATION)
        if (!hasBackgroundLocation) {
          neededPermissions.push(PermissionFeatures.BACKGROUND_LOCATION)
        }
        break
      case "POST_NOTIFICATIONS":
        const hasNotificationPermission = await checkFeaturePermissions(PermissionFeatures.POST_NOTIFICATIONS)
        if (!hasNotificationPermission) {
          neededPermissions.push(PermissionFeatures.POST_NOTIFICATIONS)
        }
        break
      case "READ_NOTIFICATIONS":
        if (Platform.OS == "ios") {
          break
        }
        const hasNotificationAccess = await CoreModule.hasNotificationListenerPermission()
        if (!hasNotificationAccess) {
          neededPermissions.push(PermissionFeatures.READ_NOTIFICATIONS)
        }
        break
    }
  }

  return neededPermissions
}

export const requestPermissionsUI = async (permissions: string[]) => {
  for (const permission of permissions) {
    await requestFeaturePermissions(permission)
  }

  if (permissions.includes(PermissionFeatures.READ_NOTIFICATIONS) && Platform.OS === "android") {
    await checkAndRequestNotificationAccessSpecialPermission()
  }
}

// Utility methods for checking permissions and device capabilities
async function isBluetoothEnabled(): Promise<boolean> {
  try {
    console.log("Checking Bluetooth state...")
    await BleManager.start({showAlert: false})

    // Poll for Bluetooth state every 50ms, up to 10 times (max 500ms)
    for (let attempt = 0; attempt < 10; attempt++) {
      const state = await BleManager.checkState()
      console.log(`Bluetooth state check ${attempt + 1}:`, state)

      if (state !== "unknown") {
        console.log("Bluetooth state determined:", state)
        return state === "on"
      }

      // Wait 50ms before next check
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    // If still unknown after 10 attempts, assume it's available
    console.log("Bluetooth state still unknown after 500ms, assuming available")
    return true
  } catch (error) {
    console.error("Error checking Bluetooth state:", error)
    return false
  }
}

async function isLocationPermissionGranted(): Promise<boolean> {
  try {
    if (Platform.OS === "android") {
      const result = await check(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION)
      return result === RESULTS.GRANTED
    } else if (Platform.OS === "ios") {
      // iOS doesn't require location permission for BLE scanning since iOS 13
      return true
    }
    return false
  } catch (error) {
    console.error("Error checking location permission:", error)
    return false
  }
}

async function isLocationServicesEnabled(): Promise<boolean> {
  try {
    if (Platform.OS === "android") {
      // // Use our native module to check if location services are enabled
      // const locationServicesEnabled = await checkLocationServices()
      // console.log("Location services enabled (native check):", locationServicesEnabled)
      // return locationServicesEnabled
      return true // TODO: fix this!
    } else if (Platform.OS === "ios") {
      // iOS doesn't require location for BLE scanning since iOS 13
      return true
    }
    return true
  } catch (error) {
    console.error("Error checking if location services are enabled:", error)
    return false
  }
}

async function checkConnectivityRequirements(): Promise<{
  isReady: boolean
  message?: string
  requirement?: "bluetooth" | "location" | "locationServices" | "permissions"
}> {
  console.log("Checking connectivity requirements")

  // Check Bluetooth state on both iOS and Android
  const isBtEnabled = await isBluetoothEnabled()
  console.log("Is Bluetooth enabled:", isBtEnabled)
  if (!isBtEnabled) {
    console.log("Bluetooth is disabled, showing error")
    return {
      isReady: false,
      message: "Bluetooth is required to connect to glasses. Please enable Bluetooth and try again.",
      requirement: "bluetooth",
    }
  }

  // Only check location on Android
  if (Platform.OS === "android") {
    // First check if location permission is granted
    const locationPermissionGranted = await isLocationPermissionGranted()
    console.log("Is Location permission granted:", locationPermissionGranted)
    if (!locationPermissionGranted) {
      console.log("Location permission missing, showing error")
      return {
        isReady: false,
        message:
          "Location permission is required to scan for glasses on Android. Please grant location permission and try again.",
        requirement: "location",
      }
    }

    // Then check if location services are enabled
    const locationServicesEnabled = await isLocationServicesEnabled()
    console.log("Are Location services enabled:", locationServicesEnabled)
    if (!locationServicesEnabled) {
      console.log("Location services disabled, showing error")
      return {
        isReady: false,
        message:
          "Location services are disabled. Please enable location services in your device settings and try again.",
        requirement: "locationServices",
      }
    }
  }

  console.log("All requirements met")
  return {isReady: true}
}

export async function checkConnectivityRequirementsUI() {
  const requirementsCheck = await checkConnectivityRequirements()
  if (!requirementsCheck.isReady) {
    switch (requirementsCheck.requirement) {
      case "bluetooth":
        showBluetoothAlert(
          translate("pairing:connectionIssueTitle"),
          requirementsCheck.message || translate("pairing:connectionIssueMessage"),
        )
        break
      case "location":
        showLocationAlert(
          translate("pairing:connectionIssueTitle"),
          requirementsCheck.message || translate("pairing:connectionIssueMessage"),
        )
        break
      case "locationServices":
        showLocationServicesAlert(
          translate("pairing:connectionIssueTitle"),
          requirementsCheck.message || translate("pairing:connectionIssueMessage"),
        )
        break
      default:
        showAlert(
          translate("pairing:connectionIssueTitle"),
          requirementsCheck.message || translate("pairing:connectionIssueMessage"),
          [{text: translate("common:ok")}],
        )
    }
    return false
  }
  return true
}

export {PERMISSION_CONFIG}
